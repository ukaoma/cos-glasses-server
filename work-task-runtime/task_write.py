#!/usr/bin/env python3
"""Canonical tasks.md writers. One file_lock, one _guarded_write (v19 §1b)."""

from __future__ import annotations
from runtime_io import safe_read_text

import os
import re
import signal
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional
from uuid import uuid4

from task_work_metadata import WorkMetadataError, decode_source, write_source, reject_reserved, validate_meeting, phase_for, PHASES, LEGACY_STAGE, DEFAULT_PHASE
from cos_atomic import atomic_write_text
from task_checkout import LockStoreCorrupt, TaskCheckoutManager
from task_rows import (
    full_domains,
    MARKER_ANYWHERE_RE,
    SHORT_TO_FULL,
    classify_heading,
    domain_path,
    parse_path,
    split_source,
    split_done_when,
    STAGES,
    strip_markers,
)

TASK_LOCK_TTL_MINUTES = 1
TASK_LOCK_WRITE_BUDGET_S = 5
_STALE_TMP_S = 5 * 60
_CHECKOUT = TaskCheckoutManager()
_first_lock = False
_DAY_RE = re.compile(r"^today:(\d{4}-\d{2}-\d{2})$")
_TODAY_HEADING = re.compile(r"^#{1,3}\s*TODAY\s+(\d{4}-\d{2}-\d{2})\s*$")
SECTIONS = ("inbox", "today", "urgent", "this_week", "backlog")


class LockLost(Exception):
    """TTL remaining is below the write budget, or identity mismatch."""


class TaskFileLocked(Exception):
    """file:<domain> is held; fail fast, no wait."""


class TaskRunning(Exception):
    """Row shows [agent running]; refuse re-arm."""


def _arm_sigterm() -> None:
    signal.signal(signal.SIGTERM, lambda *_: os._exit(1))


def _sweep_stale_tmps(directory: Path) -> None:
    now = time.time()
    for tmp in directory.glob("*.tmp.*"):
        try:
            if now - tmp.stat().st_mtime > _STALE_TMP_S:
                tmp.unlink()
        except OSError:
            pass


def _is_safe_domain(name: str) -> bool:
    """Safe as a path component. A SAFETY check, not a naming policy."""
    if not name or len(name) > 64 or name != name.strip():
        return False
    if name in (".", "..") or name.startswith("."):
        return False
    return not any(c in name for c in ("/", "\\", "\0")) and not any(ord(c) < 32 or ord(c) == 127 for c in name)


def _full_domain(domain: str) -> str:
    full = SHORT_TO_FULL.get(domain, domain)
    # Writes must not require the domain to already exist: creating the first
    # task in a new domain is exactly how its tasks.md comes into being, so
    # gating on full_domains() here made a new domain uncreatable. Safety is
    # still enforced, because this name becomes a path component.
    if not _is_safe_domain(full):
        raise ValueError(f"invalid domain: {domain}")
    return full


def domain_from_path(path: Path) -> str:
    return _full_domain(path.parent.name)


@contextmanager
def file_lock(domain: str) -> Iterator[str]:
    """Exclusive file:<domain> lock. Fail fast → TaskFileLocked. No nesting."""
    global _first_lock
    full = _full_domain(domain)
    if not _first_lock:
        _arm_sigterm()
        _sweep_stale_tmps(domain_path(full).parent)
        _first_lock = True
    identity = f"python:{os.getpid()}:{uuid4()}"
    result = _CHECKOUT.checkout(
        f"file:{full}",
        identity,
        exclusive=True,
        timeout_minutes=TASK_LOCK_TTL_MINUTES,
    )
    if result.conflict:
        raise TaskFileLocked(result.message)
    try:
        yield result.user
    finally:
        _CHECKOUT.release(f"file:{full}", identity)


def _guarded_write(domain: str, identity: str, path: Path, text: str) -> None:
    entry = _CHECKOUT.is_locked(f"file:{_full_domain(domain)}")
    if entry is None or entry.user != identity:
        raise LockLost("lock identity mismatch")
    expires = datetime.fromisoformat(entry.expires_at)
    remaining = (expires - datetime.now(timezone.utc)).total_seconds()
    if remaining < TASK_LOCK_WRITE_BUDGET_S:
        raise LockLost(f"write budget exhausted ({remaining:.1f}s left)")
    atomic_write_text(path, text, encoding="utf-8", durable=True)


def locked_replace(path: Path, text: str) -> None:
    """Run-boundary helper for legacy writers."""
    domain = domain_from_path(path)
    with file_lock(domain) as identity:
        _guarded_write(domain, identity, path, text)


def _parse_section(token: str) -> tuple[str, Optional[str]]:
    today = _DAY_RE.match(token)
    if today:
        return "today", today.group(1)
    if token in SECTIONS and token != "today":
        return token, None
    raise ValueError(f"invalid section: {token}")


def _heading_depth(line: str) -> Optional[int]:
    stripped = line.lstrip()
    if not stripped.startswith("#"):
        return None
    return len(stripped) - len(stripped.lstrip("#"))


def _section_end(lines: list[str], start: int, depth: int) -> int:
    idx = start + 1
    while idx < len(lines):
        stripped = lines[idx].strip()
        if stripped.startswith("---"):
            return idx
        other = _heading_depth(lines[idx])
        if other is not None and other <= depth:
            return idx
        idx += 1
    return len(lines)


def _find_heading(lines: list[str], want: str, day: Optional[str] = None) -> Optional[int]:
    for idx, line in enumerate(lines):
        kind, heading_day = classify_heading(line.strip())
        if kind != want:
            continue
        if want == "today" and day and heading_day != day:
            continue
        return idx
    return None


def _insert_heading(lines: list[str], idx: int, heading: str) -> int:
    block = ["", heading, ""]
    lines[idx:idx] = block
    return idx + 1


def _locked_ensure_section(
    lines: list[str], token: str, *, purge_before: Optional[str] = None
) -> tuple[list[str], int, bool]:
    """Return (lines, heading_index, fell_to_inbox)."""
    kind, day = _parse_section(token)
    if purge_before:
        lines = _purge_empty_today(lines, purge_before)

    if kind == "inbox":
        found = _find_heading(lines, "inbox")
        if found is not None:
            return lines, found, False
        first_h2 = next(
            (i for i, line in enumerate(lines) if line.startswith("## ")),
            len(lines),
        )
        return lines, _insert_heading(lines, first_h2, "## INBOX"), False

    if kind == "today":
        assert day
        found = _find_heading(lines, "today", day)
        if found is not None:
            return lines, found, False
        lines, inbox_idx, _ = _locked_ensure_section(lines, "inbox")
        search_from = inbox_idx + 1
        insert_at = len(lines)
        for idx in range(search_from, len(lines)):
            stripped = lines[idx].strip()
            if stripped.startswith("## ") or stripped.startswith("---"):
                insert_at = idx
                break
        return lines, _insert_heading(lines, insert_at, f"## TODAY {day}"), False

    found = _find_heading(lines, kind)
    if found is not None:
        return lines, found, False
    lines, inbox_idx, _ = _locked_ensure_section(lines, "inbox")
    return lines, inbox_idx, True


def _purge_empty_today(lines: list[str], purge_before: str) -> list[str]:
    keep: list[str] = []
    idx = 0
    while idx < len(lines):
        match = _TODAY_HEADING.match(lines[idx].strip())
        if match and match.group(1) < purge_before:
            depth = _heading_depth(lines[idx]) or 2
            end = _section_end(lines, idx, depth)
            body = [line for line in lines[idx + 1:end] if line.strip() and not line.strip().startswith("---")]
            has_task = any(line.startswith("- [") for line in lines[idx + 1:end])
            if not has_task and not any(classify_heading(b.strip())[0] for b in body):
                idx = end
                continue
        keep.append(lines[idx])
        idx += 1
    return keep


def _top_insert(lines: list[str], heading_idx: int, task_line: str) -> None:
    depth = _heading_depth(lines[heading_idx]) or 2
    insert_at = heading_idx + 1
    while insert_at < len(lines) and not lines[insert_at].strip():
        insert_at += 1
    end = _section_end(lines, heading_idx, depth)
    insert_at = min(insert_at, end)
    lines.insert(insert_at, task_line)


def _rebuild_line(description: str, source: Optional[str], run_at, agent_state, agent_no, checked: bool, archived: bool, stage=None, done_when=None) -> str:
    mark = "~" if archived else ("x" if checked else " ")
    body = description
    if source:
        body = f"{body} — **Source:** {source}"
    if done_when:
        body = f"{body} — **Done when:** {done_when}"
    parts = []
    if run_at:
        parts.append(f"[run {run_at}]")
    if agent_state == "running":
        parts.append("[agent running]")
    elif agent_state == "done" and agent_no is not None:
        parts.append(f"[agent #{agent_no} done]")
    elif agent_state == "failed":
        if agent_no is not None:
            parts.append(f"[agent #{agent_no} failed]")
        else:
            parts.append("[agent failed]")
    if stage:
        parts.append(f"[stage {stage}]")
    if parts:
        body = f"{body} {' '.join(parts)}"
    return f"- [{mark}] {body}"


def _match_row(row, task_id: str, domain: str) -> bool:
    if row.id == task_id or row.ref == task_id:
        return True
    short = {"sprocket_rocket": "sr", "hermit_crabs": "hc"}.get(domain, domain)
    ordinal = row.ref.rsplit("-", 1)[-1]
    return task_id == f"{short}-{ordinal}"


def _rewrite_row(path: Path, domain: str, task_id: str, mutator):
    rows = parse_path(path, domain)
    target = next((row for row in rows if _match_row(row, task_id, domain)), None)
    if target is None:
        return False
    lines = safe_read_text(path).splitlines()
    idx = target.line_number - 1
    raw = lines[idx]
    prefix = raw[: raw.index("- [")] if "- [" in raw else ""
    desc, source = split_source(raw.split("]", 1)[-1].lstrip())
    desc, markers = strip_markers(desc)
    if source:
        source, src_m = strip_markers(source)
        if src_m.get("run_at"):
            markers["run_at"] = src_m["run_at"]
        if src_m.get("agent_state"):
            markers["agent_state"] = src_m["agent_state"]
            markers["agent_no"] = src_m.get("agent_no")
    desc, dw_desc = split_done_when(desc)
    if source:
        source, dw_src = split_done_when(source)
    else:
        dw_src = None
    state = {
        "description": desc,
        "source": source,
        "stage": markers.get("stage") or target.stage,
        "done_when": dw_desc or dw_src or target.done_when,
        "run_at": markers.get("run_at") or target.run_at,
        "agent_state": markers.get("agent_state") or target.agent_state,
        "agent_no": markers.get("agent_no") if markers.get("agent_no") is not None else target.agent_no,
        "checked": target.is_checked,
        "archived": target.archived,
    }
    mutator(state)
    lines[idx] = prefix + _rebuild_line(**state)
    return True, "\n".join(lines) + "\n"


def capture(domain: str, text: str, *, section: str, run_at=None, purge_before=None) -> dict:
    reject_marker_text(text, "task text")
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        return _locked_capture(
            full, path, identity, text, section=section,
            run_at=run_at, purge_before=purge_before,
        )


def _locked_capture(domain, path, identity, text, *, section, run_at, purge_before) -> dict:
    lines = safe_read_text(path).splitlines() if path.exists() else []
    lines, heading_idx, fell = _locked_ensure_section(
        lines, section, purge_before=purge_before
    )
    stamp = datetime.now().strftime("%Y-%m-%d")
    line = _rebuild_line(text, f"Manual entry {stamp}", run_at, None, None, False, False)
    _top_insert(lines, heading_idx, line)
    _guarded_write(domain, identity, path, "\n".join(lines) + "\n")
    landed = "inbox" if fell else section
    return {"ok": True, "fell_to_inbox": fell, "section": landed}


def ensure_section(domain: str, token: str, *, purge_before=None) -> None:
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        lines = safe_read_text(path).splitlines() if path.exists() else []
        lines, _, _ = _locked_ensure_section(lines, token, purge_before=purge_before)
        _guarded_write(full, identity, path, "\n".join(lines) + "\n")


def reject_marker_text(value: str, field: str) -> None:
    """User text may never contain a marker. This is the only gate.

    _rebuild_line appends the marker blob AFTER the description and the
    **Done when:** segment, so any marker inside user text becomes part of the
    line's trailing syntax and is claimed by MARKER_RE on the next read. The
    typed words vanish and the row changes state silently.

    Reproduced before this guard existed: set_done_when(id, "[run 2026-12-25
    09:00]") cleared a live finish line AND armed a scheduled run, on the field
    labelled "What does finished look like?". set_text(id, "... [stage
    planning]") moved a row out of ACTIVE and dropped the words.

    Both writers pass through here because it is the one layer every client
    (phone, lens, COS Control, CLI) reaches.
    """
    reject_reserved(value)
    if "**source:**" in value.lower():
        raise WorkMetadataError("reserved_source_delimiter", "Source fields may only be written through source-link controls.")
    if "**done when:**" in value.lower():
        raise WorkMetadataError("reserved_done_when_delimiter", "Done when fields may only be written through finish-line controls.")
    hit = MARKER_ANYWHERE_RE.search(value)
    if hit:
        raise ValueError(
            f"{field} may not contain {hit.group(0)}: square-bracket run, agent "
            "and stage markers are reserved for the task line itself"
        )


def set_run_at(domain: str, task_id: str, run_at: Optional[str]) -> bool:
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        rows = parse_path(path, full) if path.exists() else []
        target = next((row for row in rows if _match_row(row, task_id, full)), None)
        if target is None:
            return False
        if target.agent_state == "running":
            raise TaskRunning(f"task {task_id} is already running")
        result = _rewrite_row(path, full, task_id, lambda s: s.update(run_at=run_at))
        if result is False:
            return False
        _, text = result
        _guarded_write(full, identity, path, text)
        return True


def set_text(domain: str, task_id: str, text: str) -> bool:
    """Rewrite a task's description, preserving its source block and markers.

    Only the description changes. The `**Source:**` block, the `[run ...]`
    schedule and any agent marker are rebuilt from the parsed state, so editing
    the words of a task never silently drops its provenance or its schedule.
    """
    clean = " ".join(text.split()).strip()
    if not clean:
        raise ValueError("task text required")
    if "\n" in text or "\r" in text:
        raise ValueError("task text must be a single line")
    reject_marker_text(clean, "task text")
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        rows = parse_path(path, full) if path.exists() else []
        target = next((row for row in rows if _match_row(row, task_id, full)), None)
        if target is None:
            return False
        # A running agent owns the line; rewriting it underneath would change the
        # task the agent was dispatched against.
        if target.agent_state == "running":
            raise TaskRunning(f"task {task_id} is already running")
        if target.work_metadata_error:
            raise WorkMetadataError("work_metadata_invalid", target.work_metadata_error)
        def rename(state):
            _, metadata, error = decode_source(state["source"])
            if error:
                raise WorkMetadataError("work_metadata_invalid", error)
            metadata.setdefault("workIdentity", target.work_identity or target.id)
            state.update(description=clean, source=write_source(state["source"], metadata))
        result = _rewrite_row(path, full, task_id, rename)
        if result is False:
            return False
        _, rebuilt = result
        _guarded_write(full, identity, path, rebuilt)
        return True


def set_marker(domain: str, task_id: str, marker: Optional[str]) -> bool:
    def mutate(state):
        if marker is None or marker == "--clear":
            state["agent_state"] = None
            state["agent_no"] = None
            return
        if marker == "running":
            state["agent_state"] = "running"
            state["agent_no"] = None
            return
        if marker == "failed":
            state["agent_state"] = "failed"
            state["agent_no"] = None
            return
        kind, _, number = marker.partition(":")
        state["agent_state"] = kind
        state["agent_no"] = int(number) if number else None

    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        result = _rewrite_row(path, full, task_id, mutate)
        if result is False:
            return False
        _, text = result
        _guarded_write(full, identity, path, text)
        return True


def set_stage(domain: str, task_id: str, stage: Optional[str]) -> bool:
    """Write the workflow stage. None or --clear returns the row to planning,
    which is the unmarked default, so clearing removes the marker entirely."""
    if stage in (None, "", "--clear", "planning"):
        wanted = None
    elif stage in STAGES:
        wanted = stage
    else:
        raise ValueError(f"invalid stage: {stage}")

    def mutate(state):
        _, metadata, error = decode_source(state["source"])
        if error:
            raise WorkMetadataError("work_metadata_invalid", error)
        if metadata:
            metadata["workflowPhase"] = DEFAULT_PHASE[wanted or 'planning']
            state["source"] = write_source(state["source"], metadata)
        state["stage"] = wanted

    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        result = _rewrite_row(path, full, task_id, mutate)
        if result is False:
            return False
        _, text = result
        _guarded_write(full, identity, path, text)
        return True


def set_done_when(domain: str, task_id: str, text: Optional[str]) -> bool:
    """Set or clear the finish line. A run is refused until this is non-empty."""
    wanted = (text or "").strip() or None
    if wanted and ("\n" in wanted or "**" in wanted):
        raise ValueError("done_when must be a single line without ** markup")
    if wanted:
        reject_marker_text(wanted, "done_when")

    def mutate(state):
        state["done_when"] = wanted

    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        result = _rewrite_row(path, full, task_id, mutate)
        if result is False:
            return False
        _, text2 = result
        _guarded_write(full, identity, path, text2)
        return True


def move(domain: str, task_id: str, section: str, *, purge_before=None) -> bool:
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        rows = parse_path(path, full)
        target = next((row for row in rows if _match_row(row, task_id, full)), None)
        if target is None:
            return False
        lines = safe_read_text(path).splitlines()
        idx = target.line_number - 1
        task_line = lines.pop(idx)
        lines, heading_idx, _ = _locked_ensure_section(
            lines, section, purge_before=purge_before
        )
        _top_insert(lines, heading_idx, task_line)
        _guarded_write(full, identity, path, "\n".join(lines) + "\n")
        return True


def check(domain: str, task_id: Optional[str] = None, *, text: Optional[str] = None, uncheck: bool = False) -> str:
    """Returns 'ok' | 'task_not_found' | 'ambiguous_text'."""
    full = _full_domain(domain)
    path = domain_path(full)
    rows = parse_path(path, full)
    if task_id:
        matches = [row for row in rows if _match_row(row, task_id, full)]
    else:
        needle = (text or "").lower()
        matches = [
            row for row in rows
            if needle and (
                needle[:50] in row.description.lower()
                or row.description.lower()[:50] in needle
            )
        ]
    if not matches:
        return "task_not_found"
    if len(matches) > 1 and text and not task_id:
        return "ambiguous_text"
    target = matches[0]
    with file_lock(full) as identity:
        result = _rewrite_row(
            path, full, target.id,
            lambda s: s.update(checked=not uncheck),
        )
        if result is False:
            return "task_not_found"
        _, body = result
        _guarded_write(full, identity, path, body)
        return "ok"


# Re-export for tests / writers
LockStoreCorrupt = LockStoreCorrupt


def _probe_rows(full: str, line: str) -> list:
    """Parse one rebuilt line exactly as parse_path will, in a scratch file, before it touches tasks.md."""
    import tempfile
    with tempfile.TemporaryDirectory() as scratch:
        probe = Path(scratch) / "tasks.md"
        probe.write_text("## INBOX\n" + line + "\n")
        return parse_path(probe, full)


def capture_work_item(domain: str, text: str, *, meeting, phase: str = "mentioned") -> dict:
    """Create one Work card from a meeting action item, linked to that meeting, in ONE locked write.

    The row lands at the top of INBOX as `<text> — **Source:** <meeting title> [<date>]` carrying
    `workflowPhase` and the exact meeting reference, so no second write is needed to link it.

    Never a second copy. Task ids are sha256(domain|normalized text|ordinal), so a copy inserted
    above an existing row would silently shift that row's id; and a renamed card keeps its first id
    as its Work identity, so recapturing the old wording would duplicate that identity and lock both
    rows. Either kind of match returns the existing row instead: `created` False, `linked` says
    whether it already carries this meeting, and checked/archived/delegated describe its state.
    The rebuilt line is parsed in isolation first and refused unless it reads back as exactly this
    text, meeting and phase (the parser drops leading owners, [REVIEW], a trailing dash, comments).
    """
    from task_dedup import TaskDeduplicator

    text = " ".join(text.split()) if isinstance(text, str) else ""
    if not text or len(text) > 2000:
        raise WorkMetadataError("invalid_task_text", "Card text must be 1 to 2,000 characters.")
    try:
        reject_marker_text(text, "task text")
    except WorkMetadataError:
        raise
    except ValueError as exc:
        raise WorkMetadataError("invalid_task_text", str(exc)) from exc
    meeting = validate_meeting(meeting)
    if phase not in PHASES:
        raise WorkMetadataError("invalid_work_stage", "Unknown Work phase.")
    full = _full_domain(domain)
    path = domain_path(full)
    date = meeting["filename"][:10] if re.match(r"\d{4}-\d{2}-\d{2}_", meeting["filename"]) else datetime.now().strftime("%Y-%m-%d")
    title = re.sub(r"[\[\]*]", "", meeting["title"]).strip() or "Meeting"
    line = _rebuild_line(text, write_source(f"{title} [{date}]", {"workflowPhase": phase, "meetingRefs": [meeting]}),
                         None, None, None, False, False)
    probe = _probe_rows(full, line)
    if (len(probe) != 1 or probe[0].description != text or probe[0].work_metadata_error
            or probe[0].meeting_refs != [meeting] or probe[0].work_stage != phase):
        raise WorkMetadataError("invalid_task_text", "This text would not read back as the same card.")
    norm, candidate = TaskDeduplicator.normalize(text), probe[0].id
    if not norm:
        raise WorkMetadataError("invalid_task_text", "Card text has no words.")
    with file_lock(full) as identity:
        same = [r for r in parse_path(path, full)
                if TaskDeduplicator.normalize(r.description) == norm or candidate in (r.id, r.work_identity)]
        if same:
            row = next((r for r in same if any(ref["recordId"] == meeting["recordId"] for ref in r.meeting_refs)), same[0])
            return {"ok": True, "created": False, "id": row.id,
                    "linked": any(ref["recordId"] == meeting["recordId"] for ref in row.meeting_refs),
                    "checked": row.is_checked, "archived": row.archived, "delegated": row.delegated}
        lines = safe_read_text(path).splitlines() if path.exists() else []
        lines, heading_idx, _ = _locked_ensure_section(lines, "inbox")
        _top_insert(lines, heading_idx, line)
        _guarded_write(full, identity, path, "\n".join(lines) + "\n")
        created = [r for r in parse_path(path, full) if r.id == candidate]
    if len(created) != 1 or created[0].meeting_refs != [meeting]:
        raise WorkMetadataError("capture_unverified", "The new card could not be read back exactly once.")
    return {"ok": True, "created": True, "id": candidate, "linked": True,
            "checked": False, "archived": False, "delegated": created[0].delegated}


def archive_work_item(domain: str, task_id: str, *, record_id: str, expected_text: Optional[str] = None) -> str:
    """Undo for capture_work_item: archive ([~]) the card only while it is still untouched.

    Untouched means open and still Mentioned (so not completed or moved to another stage), no run or agent
    marker, no finish line, linked to exactly the one meeting it was created from, and, when `expected_text`
    is given, still worded as written. Anything else is left alone. A move between sections is not checked.
    Returns archived | already_archived | changed | absent.
    """
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-f0-9]{12}", task_id):
        raise WorkMetadataError("invalid_task_id", "An exact canonical task ID is required.")
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        matches = [r for r in parse_path(path, full) if r.id == task_id]
        if len(matches) != 1:
            return "absent"
        row = matches[0]
        if row.archived:
            return "already_archived"
        if (row.work_stage != "mentioned" or row.run_at or row.agent_state or row.done_when
                or [ref["recordId"] for ref in row.meeting_refs] != [record_id]
                or (expected_text is not None and row.description != expected_text)):
            return "changed"
        result = _rewrite_row(path, full, task_id, lambda state: state.update(archived=True))
        if result is False:
            return "absent"
        _guarded_write(full, identity, path, result[1])
        return "archived"


def _work_mutation(domain: str, task_id: str, expected_text: str, expected_revision: str, change, *, return_row=False):
    if not isinstance(expected_text, str) or not expected_text or len(expected_text) > 20_000:
        raise WorkMetadataError("expected_text_required", "Full current task text is required.")
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-f0-9]{12}", task_id):
        raise WorkMetadataError("invalid_task_id", "An exact canonical task ID is required.")
    if not isinstance(expected_revision, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_revision):
        raise WorkMetadataError("expected_revision_required", "The current Work revision is required.")
    full = _full_domain(domain)
    path = domain_path(full)
    with file_lock(full) as identity:
        matches = [r for r in parse_path(path, full) if r.id == task_id]
        if not matches:
            return False
        if len(matches) != 1:
            raise WorkMetadataError("ambiguous_task_id", "Task ID is not unique in this domain.")
        target = matches[0]
        if target.archived:
            raise WorkMetadataError("task_archived", "Restore the archived task before changing its Work details.")
        if target.work_revision != expected_revision:
            raise WorkMetadataError("task_revision_changed", "Task file changed. Refresh before editing Work details.")
        if target.description != expected_text:
            raise WorkMetadataError("task_text_changed", "Task text changed. Refresh before editing its Work details.")
        if target.work_metadata_error:
            raise WorkMetadataError("work_metadata_invalid", target.work_metadata_error)
        def mutate(state):
            _, metadata, error = decode_source(state["source"])
            if error:
                raise WorkMetadataError("work_metadata_invalid", error)
            metadata.setdefault("workIdentity", target.work_identity or target.id)
            change(state, metadata)
            state["source"] = write_source(state["source"], metadata)
        result = _rewrite_row(path, full, task_id, mutate)
        if result is False:
            return False
        _, contents = result
        _guarded_write(full, identity, path, contents)
        if return_row:
            # Still under the file lock: the response describes this exact commit.
            row = next(r for r in parse_path(path, full) if r.line_number == target.line_number)
            return {"ok": True, "id": row.id, "workIdentity": row.work_identity,
                    "workRevision": row.work_revision, "text": row.description,
                    "doneWhen": row.done_when or ""}
        return True


def edit_work_task(domain: str, task_id: str, text: str, done_when: str, *, expected_text: str, expected_revision: str):
    """One guarded replacement for task name and finish line; preserve Work identity."""
    if not isinstance(text, str) or not isinstance(done_when, str):
        raise ValueError("Task name and finish line must be text")
    clean = " ".join(text.split())
    finish = " ".join(done_when.split())
    if not clean or len(clean.encode("utf-16-le")) // 2 > 2000:
        raise ValueError("Task name must contain 1 to 2,000 characters")
    if len(finish.encode("utf-16-le")) // 2 > 500 or "**" in finish:
        raise ValueError("Finish line must be at most 500 characters without ** markup")
    reject_marker_text(clean, "task text")
    reject_marker_text(finish, "done_when")

    def change(state, metadata):
        if state["agent_state"] == "running":
            raise TaskRunning("This task is already running; its name cannot change during the run")
        state["description"] = clean
        state["done_when"] = finish or None

    return _work_mutation(domain, task_id, expected_text, expected_revision, change, return_row=True)


def set_work_stage(domain: str, task_id: str, phase: str, *, expected_text: str, expected_revision: str) -> bool:
    if phase not in (*PHASES, 'complete'):
        raise WorkMetadataError("invalid_work_stage", "Unknown Work phase.")
    def change(state, metadata):
        if phase == 'complete':
            metadata['workflowPhase'] = phase_for(state['stage'], False, metadata)
            state['checked'] = True
        else:
            metadata['workflowPhase'] = phase
            state['stage'] = None if LEGACY_STAGE[phase] == 'planning' else LEGACY_STAGE[phase]
            state['checked'] = False
    return _work_mutation(domain, task_id, expected_text, expected_revision, change)


def link_meeting(domain: str, task_id: str, *, expected_text: str, expected_revision: str, meeting=None, remove_record_id=None) -> bool:
    if (meeting is None) == (remove_record_id is None):
        raise WorkMetadataError("invalid_meeting_ref", "Provide one meeting reference or one record ID to unlink.")
    if meeting is not None:
        meeting = validate_meeting(meeting)
    elif not isinstance(remove_record_id, str) or not remove_record_id or len(remove_record_id) > 512:
        raise WorkMetadataError("invalid_meeting_ref", "Invalid record ID to unlink.")
    def change(state, metadata):
        key = meeting['recordId'] if meeting is not None else remove_record_id
        refs = [ref for ref in metadata.get('meetingRefs', []) if ref['recordId'] != key]
        if meeting is not None:
            refs.append(meeting)
        metadata['meetingRefs'] = refs
    return _work_mutation(domain, task_id, expected_text, expected_revision, change)

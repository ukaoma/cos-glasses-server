#!/usr/bin/env python3
"""Canonical tasks.md row parser (plan v19 §0.2 / §1)."""

from __future__ import annotations
from runtime_io import safe_read_text

import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator, Optional

SCRIPT_DIR = Path(__file__).parent.resolve()
OPERATIONS_DIR = SCRIPT_DIR.parent

# Domains are DISCOVERED, not baked in. This was a hardcoded four-tuple of one
# user's business units, and because every gate below tests membership in it, the
# Python layer refused any other domain outright — including domains the server
# had just resolved from the same folders. `cos_api_bridge.py task-rows work`
# answered `invalid_domain` while `quilt` returned 156 rows.
#
# The signal is `tasks.md`, matching discoveredTaskDomains() on the server side,
# so the two layers cannot disagree about which domains exist.
def full_domains() -> tuple[str, ...]:
    root = Path(os.environ.get("COS_TASK_ROOT") or OPERATIONS_DIR)
    try:
        found = sorted(
            d.name for d in root.iterdir()
            if d.is_dir() and not d.name.startswith(".") and (d / "tasks.md").is_file()
        )
    except OSError:
        found = []
    # A tree we cannot read must not silently become "no domains"; the legacy
    # four keep an existing install working exactly as before.
    return tuple(found) if found else LEGACY_DOMAINS


LEGACY_DOMAINS = ("quilt", "personal", "hermit_crabs", "sprocket_rocket")

# Convenience aliases only. `SHORT_TO_FULL.get(name, name)` passes anything
# unknown through untouched, so these never gate which domains exist.
SHORT_TO_FULL = {
    "sr": "sprocket_rocket",
    "hc": "hermit_crabs",
}
FULL_TO_SHORT = {
    "quilt": "quilt",
    "personal": "personal",
    "sprocket_rocket": "sr",
    "hermit_crabs": "hc",
}

# ONE marker vocabulary, two uses. MARKER_RE strips a trailing marker blob off
# the end of a line; MARKER_ANYWHERE_RE finds a marker wherever it sits. The
# writers use the second to REFUSE user text that would be re-read as a marker.
# They are built from the same string so a new marker type cannot be taught to
# the reader and forgotten by the writer.
_MARKER_BODY = (
    r"\[(?:run \d{4}-\d{2}-\d{2} \d{2}:\d{2}|agent running|"
    r"agent #\d+ (?:done|failed)|agent failed|"
    r"stage (?:planning|active|review))\]"
)
MARKER_RE = re.compile(r"\s*(?:" + _MARKER_BODY + r"\s*)+$")
MARKER_ANYWHERE_RE = re.compile(_MARKER_BODY)
# Workflow stage. An UNMARKED row is planning, so the 80 open rows need no
# migration. Lives in the line, not a sidecar: the task id is a hash of the
# description, so any id-keyed store orphans itself on the first text edit.
# NOTE: the trailing \s* sits INSIDE the repeat group. The writer joins markers
# with spaces (_rebuild_line), but the old regex allowed none between groups, so
# "[run ...] [agent running]" stripped only the last one and silently dropped the
# run time on every read. Pre-existing; stage makes that pairing the common case.
# STAGE_RE only reads a value out of a blob MARKER_RE has already validated, so
# its own alternation was a second, unreachable copy: mutating it changed nothing
# under test BECAUSE MARKER_RE's `$`-anchored match rejects "[stage bogus]" first.
# That is true of the READ path only. The WRITE path is gated separately by
# STAGES below (task_write.set_stage) and by cos_api_bridge's own literal tuple,
# so there are three stage vocabularies in this system, not one. Widening the set
# means editing MARKER_RE, STAGES, and the bridge tuple together.
STAGE_RE = re.compile(r"\[stage (\w+)\]")
STAGES = ("planning", "active", "review")
RUN_AT_RE = re.compile(r"\[run (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]")
AGENT_NUM_RE = re.compile(r"\[agent #(\d+) (done|failed)\]")
INBOX_RE = re.compile(r"^#{1,3}\s*INBOX\s*$", re.IGNORECASE)
TODAY_RE = re.compile(r"^#{1,3}\s*TODAY\s+(\d{4}-\d{2}-\d{2})\s*$", re.IGNORECASE)
DELEGATED_HEADING_RE = re.compile(r"^#{1,2}\s*Delegated\b", re.IGNORECASE)
BOLD_OWNER_RE = re.compile(r"^\*\*(?P<body>(?!Owner:)[^*]+)\*\*:\s*")
BRACKET_OWNER_RE = re.compile(r"^\[(?P<body>[^\]]+)\]\s+")
CHECK_RE = re.compile(r"^- \[([ xX~])\]\s*(.*)$")
PRIORITY_SECTIONS = frozenset(
    {"inbox", "today", "urgent", "this_week", "backlog", "completed"}
)


@dataclass
class TaskRow:
    ref: str
    id: str
    domain: str
    description: str
    priority: str
    is_checked: bool
    archived: bool
    line_number: int
    source: Optional[str]
    owner: Optional[str]
    delegated: bool
    needs_review: bool
    thread: None
    run_at: Optional[str]
    agent_state: Optional[str]
    agent_no: Optional[int]
    section: str
    section_day: Optional[str]
    stage: Optional[str] = None
    done_when: Optional[str] = None
    work_stage: str = "planned"
    work_identity: str = ""
    work_revision: str = ""
    meeting_refs: list[dict] = field(default_factory=list)
    work_metadata_error: Optional[str] = None


def domain_path(domain: str) -> Path:
    root = Path(os.environ.get("COS_TASK_ROOT") or OPERATIONS_DIR)
    return root / domain / "tasks.md"


def split_source(line: str) -> tuple[str, Optional[str]]:
    if "**Source:**" not in line:
        return line.strip(), None
    left, right = line.split("**Source:**", 1)
    return left.strip().rstrip("—").strip(), right.strip()


DONE_WHEN_LABEL = "**Done when:**"


def split_done_when(text):
    """Peel a **Done when:** segment off a description or source part.

    Same convention as **Source:** so tasks.md stays readable by hand, and the
    finish line travels with the row when the text is edited.
    """
    if not text or DONE_WHEN_LABEL not in text:
        return text, None
    left, right = text.split(DONE_WHEN_LABEL, 1)
    return left.strip().rstrip("\u2014").strip(), (right.strip() or None)


def strip_markers(text: str) -> tuple[str, dict]:
    """Remove end-of-line agent/run markers. Returns (text, fields)."""
    fields: dict = {"run_at": None, "agent_state": None, "agent_no": None, "stage": None}
    if not text:
        return text, fields
    match = MARKER_RE.search(text)
    if not match:
        return text, fields
    blob = match.group(0)
    run = RUN_AT_RE.search(blob)
    if run:
        fields["run_at"] = run.group(1)
    stage = STAGE_RE.search(blob)
    if stage:
        fields["stage"] = stage.group(1)
    numbered = AGENT_NUM_RE.search(blob)
    if numbered:
        fields["agent_no"] = int(numbered.group(1))
        fields["agent_state"] = numbered.group(2)
    elif "[agent running]" in blob:
        fields["agent_state"] = "running"
    elif "[agent failed]" in blob:
        fields["agent_state"] = "failed"
    return text[: match.start()].rstrip(), fields


def _merge_marker_fields(primary: dict, secondary: dict) -> dict:
    out = dict(primary)
    for key, value in secondary.items():
        if value is not None:
            out[key] = value
    return out


def classify_heading(stripped: str) -> tuple[Optional[str], Optional[str]]:
    """Return (section, section_day) for a heading, else (None, None)."""
    if not stripped.startswith("#"):
        return None, None
    inbox = INBOX_RE.match(stripped)
    if inbox:
        return "inbox", None
    today = TODAY_RE.match(stripped)
    if today:
        return "today", today.group(1)
    upper = stripped.upper()
    if "🔴 URGENT" in stripped or "URGENT" in upper:
        return "urgent", None
    if "🟡 THIS WEEK" in stripped or "THIS WEEK" in upper:
        return "this_week", None
    if "🟢 BACKLOG" in stripped or "BACKLOG" in upper:
        return "backlog", None
    if "✅ COMPLETED" in stripped or "COMPLETED" in upper:
        return "completed", None
    return "other", None


def _heading_depth(stripped: str) -> int:
    i = 0
    while i < len(stripped) and stripped[i] == "#":
        i += 1
    return i


def parse_owner(text: str) -> tuple[Optional[str], str]:
    bold = BOLD_OWNER_RE.match(text)
    if bold:
        return bold.group("body").strip(), text[bold.end():]
    bracket = BRACKET_OWNER_RE.match(text)
    if bracket:
        return bracket.group("body").strip(), text[bracket.end():]
    return None, text


def owner_tokens(owner: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s*\+\s*|/", owner) if part.strip()]


def owner_includes_miles(owner: Optional[str]) -> bool:
    if not owner:
        return False
    for token in owner_tokens(owner):
        head = token.split("(")[0].strip().split()[0].casefold()
        if head == os.environ.get("COS_TASK_OPERATOR", "").casefold():
            return True
    return False


def ends_delegated_zone(stripped: str) -> bool:
    if stripped.startswith("---"):
        return True
    return stripped.startswith("#") and _heading_depth(stripped) <= 2


def parse_path(filepath: Path, domain: str) -> list[TaskRow]:
    # No membership gate here on purpose. The caller has already chosen the FILE;
    # re-deciding whether its domain "exists" by scanning a root that may not be
    # the one this path came from turns a valid parse into silence. Discovery
    # belongs where a NAME is resolved to a path, which is parse_domain and the
    # cmd_* entry points below.
    if not filepath.exists():
        return []

    rows: list[TaskRow] = []
    current_priority = "backlog"
    current_section = "other"
    current_day: Optional[str] = None
    in_comment = False
    delegated_zone = False
    counter = 0

    contents = safe_read_text(filepath)
    for line_number, line in enumerate(contents.splitlines(), 1):
        stripped = line.strip()
        if "<!--" in stripped:
            in_comment = True
        if "-->" in stripped:
            in_comment = False
            continue
        if in_comment:
            continue

        if ends_delegated_zone(stripped):
            delegated_zone = False
        if DELEGATED_HEADING_RE.match(stripped):
            delegated_zone = True

        heading, heading_day = classify_heading(stripped)
        if heading is not None:
            current_section = heading
            if heading != "other":
                current_priority = heading
                current_day = heading_day
            else:
                current_day = None
            continue

        checked = CHECK_RE.match(line)
        if not checked:
            continue

        mark, raw = checked.group(1), checked.group(2)
        archived = mark == "~"
        is_checked = mark.lower() == "x"
        description, source = split_source(raw)
        description, desc_markers = strip_markers(description)
        if source is not None:
            source, src_markers = strip_markers(source)
            markers = _merge_marker_fields(desc_markers, src_markers)
        else:
            markers = desc_markers

        description, dw_desc = split_done_when(description)
        if source is not None:
            source, dw_src = split_done_when(source)
        else:
            dw_src = None
        done_when = dw_desc or dw_src

        needs_review = "[REVIEW]" in description
        if needs_review:
            description = description.replace("[REVIEW]", "").strip()

        owner, description = parse_owner(description)
        description = description.strip()
        delegated = delegated_zone or (
            owner is not None and not owner_includes_miles(owner)
        )
        priority = "completed" if is_checked else (
            current_section if current_section in PRIORITY_SECTIONS
            else current_priority
        )
        counter += 1
        rows.append(TaskRow(
            ref=f"{domain}-{counter}",
            id="",
            domain=domain,
            description=description,
            priority=priority,
            is_checked=is_checked,
            archived=archived,
            line_number=line_number,
            source=source,
            owner=owner,
            delegated=delegated,
            needs_review=needs_review,
            thread=None,
            run_at=markers["run_at"],
            agent_state=markers["agent_state"],
            agent_no=markers["agent_no"],
            section=current_section,
            section_day=current_day if current_section == "today" else None,
            stage=markers["stage"],
            done_when=done_when,
        ))

    _assign_ids(filepath, domain, rows)
    from task_work_metadata import decode_source, phase_for
    identities: dict[str, list[TaskRow]] = {}
    for row in rows:
        row.source, metadata, row.work_metadata_error = decode_source(row.source)
        row.work_stage = phase_for(row.stage, row.is_checked, metadata)
        row.work_identity = metadata.get("workIdentity", row.id)
        row.work_revision = hashlib.sha256((domain + "\0" + row.id + "\0" + contents).encode()).hexdigest()
        row.meeting_refs = metadata.get("meetingRefs", [])
        identities.setdefault(row.work_identity, []).append(row)
    for matches in identities.values():
        if len(matches) > 1:
            for row in matches:
                row.work_metadata_error = "Duplicate Work identity; repair the copied task metadata before linking or moving it."
                row.work_identity = row.id
    return rows


def _assign_ids(_filepath: Path, domain: str, rows: list[TaskRow]) -> None:
    from task_dedup import TaskDeduplicator

    seen: dict[str, int] = {}
    for row in rows:
        norm = TaskDeduplicator.normalize(row.description)
        ordinal = seen.get(norm, 0)
        seen[norm] = ordinal + 1
        row.id = hashlib.sha256(
            f"{domain}/tasks.md|{norm}|{ordinal}".encode()
        ).hexdigest()[:12]


def parse_domain(domain: str) -> list[TaskRow]:
    if domain not in full_domains():
        return []
    return parse_path(domain_path(domain), domain)


def iter_domain_rows() -> Iterator[tuple[str, list[TaskRow]]]:
    for domain in full_domains():
        yield domain, parse_domain(domain)


def cmd_task_rows(domain: str, day: str) -> list[dict]:
    del day  # server column math; required on the wire
    return [asdict(row) for row in parse_domain(domain)]


def _cli(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] in {"-h", "--help"}:
        print("usage: task_rows.py <domain> --day YYYY-MM-DD", file=sys.stderr)
        return 2
    domain = argv[0]
    day = None
    if "--day" in argv:
        idx = argv.index("--day")
        if idx + 1 < len(argv):
            day = argv[idx + 1]
    if domain not in full_domains():
        print(json.dumps({
            "error": {"code": "invalid_domain", "message": f"full domain required, got {domain!r}"}
        }))
        return 0
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        print(json.dumps({
            "error": {"code": "day_required", "message": "--day YYYY-MM-DD is required"}
        }))
        return 0
    print(json.dumps(cmd_task_rows(domain, day)))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))

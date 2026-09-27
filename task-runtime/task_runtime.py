#!/usr/bin/env python3
"""Portable read-only task protocol candidate. No production dispatch or writes.

Parser adapted from COS task_rows.py at MU snapshot 1dac83bd; see manifest.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import stat
import string
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

PROTOCOL = "cos-control-task-read/1"
VERSION = "0.1.0"
MAX_BYTES = 8 * 1024 * 1024

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


def owner_includes_operator(owner: Optional[str], operator: Optional[str]) -> bool:
    if not owner or not operator:
        return False
    for token in owner_tokens(owner):
        parts = token.split("(")[0].strip().split()
        if parts and parts[0].casefold() == operator.casefold():
            return True
    return False


def ends_delegated_zone(stripped: str) -> bool:
    if stripped.startswith("---"):
        return True
    return stripped.startswith("#") and _heading_depth(stripped) <= 2


def parse_text(text: str, domain: str, operator: Optional[str] = None) -> list[TaskRow]:
    rows: list[TaskRow] = []
    current_priority = "backlog"
    current_section = "other"
    current_day: Optional[str] = None
    in_comment = False
    delegated_zone = False
    counter = 0

    for line_number, line in enumerate(text.splitlines(), 1):
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
            owner is not None and not owner_includes_operator(owner, operator)
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

    _assign_ids(domain, rows)
    return rows


def _assign_ids(domain: str, rows: list[TaskRow]) -> None:

    seen: dict[str, int] = {}
    for row in rows:
        norm = normalize(row.description)
        ordinal = seen.get(norm, 0)
        seen[norm] = ordinal + 1
        row.id = hashlib.sha256(
            f"{domain}/tasks.md|{norm}|{ordinal}".encode()
        ).hexdigest()[:12]


def normalize(text: str) -> str:
    text, _ = strip_markers(text)
    return " ".join(text.lower().translate(str.maketrans("", "", string.punctuation)).split())


def capabilities() -> dict:
    return {"protocol": PROTOCOL, "version": VERSION, "commands": ["capabilities", "domains", "task-rows"],
            "readOnly": True, "writes": False, "dispatch": False, "migration": False,
            "identity": {"kind": "legacy-description-hash", "stable": False},
            "limits": {"maxTaskFileBytes": MAX_BYTES}, "requiresPrivateCheckout": False}


def read_domain(root_fd: int, domain: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", domain):
        raise ValueError("invalid_domain")
    dfd = os.open(domain, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        fd = os.open("tasks.md", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode): raise ValueError("not_regular_file")
            if before.st_size > MAX_BYTES: raise ValueError("task_file_too_large")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(MAX_BYTES + 1)
            after = os.fstat(fd)
            if len(data) > MAX_BYTES: raise ValueError("task_file_too_large")
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError("source_changed_retry")
            return data.decode("utf-8")
        finally: os.close(fd)
    finally: os.close(dfd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["capabilities", "domains", "task-rows"])
    parser.add_argument("--root")
    parser.add_argument("--domain")
    parser.add_argument("--operator", help="Optional first-name owner match; absence conservatively marks named owners delegated")
    args = parser.parse_args()
    try:
        if args.command == "capabilities":
            out = capabilities()
        else:
            if not args.root or not Path(args.root).is_absolute(): raise ValueError("absolute_root_required")
            # Explicit root only. No env fallback, home discovery or private checkout.
            root_fd = os.open(args.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                if args.command == "domains":
                    domains = []
                    for domain in sorted(os.listdir(root_fd)):
                        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", domain): continue
                        try: read_domain(root_fd, domain)
                        except (OSError, ValueError, UnicodeError): continue
                        domains.append(domain)
                    out = {"protocol": PROTOCOL, "domains": domains}
                else:
                    if not args.domain: raise ValueError("domain_required")
                    source = read_domain(root_fd, args.domain)
                    out = {"protocol": PROTOCOL, "domain": args.domain,
                           "sourceRevision": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                           "identity": capabilities()["identity"],
                           "rows": [asdict(row) for row in parse_text(source, args.domain, args.operator)]}
            finally: os.close(root_fd)
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except (OSError, ValueError, UnicodeError) as error:
        code = str(error) if isinstance(error, ValueError) and not isinstance(error, UnicodeError) else "source_unavailable"
        print(json.dumps({"protocol": PROTOCOL, "error": {"code": code}}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

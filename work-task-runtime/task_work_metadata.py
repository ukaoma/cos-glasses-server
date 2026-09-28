"""Bounded Work metadata inside Source; legacy task marker grammar stays unchanged."""
from __future__ import annotations

import base64
import json
import re

PHASES = ("mentioned", "planned", "draft", "built", "qa")
LEGACY_STAGE = {"mentioned": "planning", "planned": "planning", "draft": "active", "built": "active", "qa": "review"}
DEFAULT_PHASE = {"planning": "planned", "active": "draft", "review": "qa"}
PROTOCOL = "cos-work://"
MAX_BYTES = 16_384
MAX_REFS = 8
LINK = re.compile(r"\[Work details\]\(cos-work://v1/([A-Za-z0-9_-]+)\)")


class WorkMetadataError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def reject_reserved(value: str) -> None:
    if PROTOCOL in value.lower():
        raise WorkMetadataError("reserved_work_metadata", "Work metadata links may only be written through Work controls.")


def validate_meeting(raw) -> dict:
    if not isinstance(raw, dict) or set(raw) != {"recordId", "domain", "month", "filename", "title"}:
        raise WorkMetadataError("invalid_meeting_ref", "A complete saved meeting reference is required.")
    limits = {"recordId": 512, "domain": 64, "month": 7, "filename": 255, "title": 300}
    if any(not isinstance(raw.get(k), str) or not raw[k].strip() or len(raw[k]) > n or any(ord(c) < 32 or ord(c) == 127 for c in raw[k]) for k, n in limits.items()):
        raise WorkMetadataError("invalid_meeting_ref", "Meeting reference fields are invalid or too long.")
    domain = raw["domain"]
    if domain != domain.strip() or domain.startswith('.') or '/' in domain or '\\' in domain or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", raw["month"]):
        raise WorkMetadataError("invalid_meeting_ref", "Meeting domain or month is invalid.")
    if "/" in raw["filename"] or "\\" in raw["filename"] or not raw["filename"].endswith(".md") or raw["filename"] in (".md", "..md"):
        raise WorkMetadataError("invalid_meeting_ref", "Meeting filename must be a saved Markdown basename.")
    return dict(raw)


def validate_metadata(raw) -> dict:
    if not isinstance(raw, dict) or set(raw) - {"workflowPhase", "workIdentity", "meetingRefs"}:
        raise ValueError("Unknown metadata fields")
    if "workflowPhase" in raw and raw["workflowPhase"] not in PHASES:
        raise ValueError("Invalid workflow phase")
    if "workIdentity" in raw and (not isinstance(raw["workIdentity"], str) or not re.fullmatch(r"[a-f0-9]{12}", raw["workIdentity"])):
        raise ValueError("Invalid work identity")
    refs = raw.get("meetingRefs", [])
    if not isinstance(refs, list) or len(refs) > MAX_REFS:
        raise ValueError("Too many meeting references")
    cleaned = [validate_meeting(ref) for ref in refs]
    if len({ref["recordId"] for ref in cleaned}) != len(cleaned):
        raise ValueError("Duplicate meeting references")
    return {**raw, **({"meetingRefs": cleaned} if "meetingRefs" in raw else {})}


def _unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("Duplicate JSON key")
        out[key] = value
    return out


def decode_source(source: str | None) -> tuple[str | None, dict, str | None]:
    """Invalid metadata stays visible/preserved and never contributes authority."""
    if not source or PROTOCOL not in source.lower():
        return source, {}, None
    try:
        matches = list(LINK.finditer(source))
        if len(matches) != 1 or source.lower().count(PROTOCOL) != 1:
            raise ValueError("Missing, duplicate, or unsupported metadata link")
        token = matches[0].group(1)
        if len(token) > (MAX_BYTES * 4 // 3 + 4):
            raise ValueError("Metadata too large")
        data = base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_', validate=True)
        if len(data) > MAX_BYTES or base64.urlsafe_b64encode(data).decode().rstrip('=') != token:
            raise ValueError("Noncanonical encoding")
        metadata = validate_metadata(json.loads(data, object_pairs_hook=_unique_object))
        clean = (source[:matches[0].start()] + source[matches[0].end():]).strip()
        return clean or None, metadata, None
    except (ValueError, TypeError, UnicodeError):
        return source, {}, "Invalid Work metadata; preserved without applying its phase or meeting links."


def write_source(source: str | None, metadata: dict) -> str:
    clean, _, error = decode_source(source)
    if error:
        raise WorkMetadataError("work_metadata_invalid", error)
    try:
        data = json.dumps(validate_metadata(metadata), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        if len(data) > MAX_BYTES:
            raise ValueError("Metadata too large")
    except (ValueError, TypeError) as exc:
        raise WorkMetadataError("work_metadata_invalid", "Work metadata exceeds its schema or size limits.") from exc
    token = base64.urlsafe_b64encode(data).decode().rstrip('=')
    return ((clean + ' ') if clean else '') + '[Work details](cos-work://v1/' + token + ')'


def phase_for(stage: str | None, checked: bool, metadata: dict) -> str:
    if checked:
        return 'complete'
    legacy = stage or 'planning'
    phase = metadata.get('workflowPhase')
    return phase if LEGACY_STAGE.get(phase) == legacy else DEFAULT_PHASE.get(legacy, 'planned')

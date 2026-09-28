"""Atomic file write helpers.

All COS state files that use JSON/JSONL must write atomically: write to a
temp sibling, then `os.replace` into place. A torn write (truncated file
after an open-write-close that crashed mid-way) is the Jan-31 incident
class — vector_state.json lost 744 entries because a crash hit between
truncate and final write.

Use `atomic_write_text` for text/JSON payloads and `atomic_write_json` as
a thin convenience wrapper. Both hold no lock — callers that need
cross-process serialization must layer their own locking around the call
(see lightrag_indexer._queue_lock for an example).
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any


def atomic_write_text(
    path: Path,
    text: str,
    encoding: str = "utf-8",
    *,
    durable: bool = False,
) -> None:
    """Write `text` to `path` via tmp + os.replace.

    On POSIX, `os.replace` is atomic within a filesystem — the destination
    either contains the old content or the new, never a torn in-between.

    The tmp filename is suffixed with pid+uuid so concurrent callers on
    the same path do not clobber each other's tmp content before replace.
    If the write raises, the orphan tmp is best-effort deleted so failed
    runs do not leave litter behind.

    `durable=True` fsyncs the tmp fd before replace and the parent directory
    after. Default stays the historical no-fsync path.
    """
    tmp = path.with_suffix(f"{path.suffix}.tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    try:
        data = text.encode(encoding)
        if durable:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            try:
                offset = 0
                while offset < len(data):
                    try:
                        written = os.write(fd, data[offset:])
                    except InterruptedError:
                        continue
                    if written <= 0:
                        raise OSError("atomic write made no progress")
                    offset += written
                os.fsync(fd)
            finally:
                os.close(fd)
        else:
            tmp.write_text(text, encoding=encoding)
        os.replace(tmp, path)
        if durable:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def atomic_write_json(
    path: Path,
    data: Any,
    indent: int | None = 2,
    encoding: str = "utf-8",
    *,
    durable: bool = False,
) -> None:
    """Serialize `data` to JSON and write atomically."""
    atomic_write_text(
        path, json.dumps(data, indent=indent), encoding=encoding, durable=durable
    )

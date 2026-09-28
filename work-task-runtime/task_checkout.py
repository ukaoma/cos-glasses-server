#!/usr/bin/env python3
"""Atomic task / file lock manager. Store: COS/.task_locks.json (v19 §1b.2)."""

from __future__ import annotations
from runtime_io import open_lock

import argparse
import fcntl
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

SCRIPT_DIR = Path(__file__).parent.resolve()
DEFAULT_LOCKS_FILE = (
    Path.home() / "Library" / "Application Support" / "COS" / ".task_locks.json"
)
LOCKS_FILE = Path(os.environ.get("COS_TASK_LOCK_STORE") or DEFAULT_LOCKS_FILE)
DEFAULT_TIMEOUT_MINUTES = 30
CORRUPT_NAME = ".task_locks.json.corrupt"


class LockStoreCorrupt(Exception):
    """Lock file has no recoverable JSON object prefix."""


@dataclass
class CheckoutResult:
    success: bool
    task_id: str
    user: str
    conflict: bool = False
    locked_by: Optional[str] = None
    locked_at: Optional[str] = None
    expires_at: Optional[str] = None
    message: str = ""


@dataclass
class LockEntry:
    task_id: str
    user: str
    locked_at: str
    expires_at: str

    def is_expired(self) -> bool:
        # Unknown expiry is unknown ownership, never permission to steal a lock.
        try:
            locked = datetime.fromisoformat(self.locked_at)
            expires = datetime.fromisoformat(self.expires_at)
            if locked.tzinfo is None or expires.tzinfo is None or expires < locked:
                raise ValueError("Invalid lock timestamp ordering or timezone")
            return datetime.now(timezone.utc) > expires
        except (ValueError, TypeError) as exc:
            raise LockStoreCorrupt("Lock timestamps are invalid; repair required") from exc

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "LockEntry":
        known = {"task_id", "user", "locked_at", "expires_at"}
        if not isinstance(d, dict) or set(d) != known or any(not isinstance(d[k], str) or not d[k].strip() for k in known):
            raise LockStoreCorrupt("Lock entry schema is invalid; repair required")
        return cls(**d)


def _entries_from_payload(data: dict) -> Dict[str, LockEntry]:
    if not isinstance(data, dict):
        raise LockStoreCorrupt("Lock store must be an object")
    locks: Dict[str, LockEntry] = {}
    for key, value in data.items():
        entry = LockEntry.from_dict(value)
        if not isinstance(key, str) or not key or entry.task_id != key:
            raise LockStoreCorrupt("Lock key and task identity disagree; repair required")
        if not entry.is_expired():
            locks[key] = entry
    return locks


def _unique_lock_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise LockStoreCorrupt("Duplicate lock JSON key; repair required")
        result[key] = value
    return result


def _decode_store(raw: bytes) -> tuple[Optional[dict], bool]:
    """Return (payload, corrupt). Empty bytes are a fresh store, not corrupt."""
    if not raw:
        return {}, False
    text = raw.decode("utf-8", errors="surrogateescape")
    stripped = text.lstrip()
    if "{" not in stripped:
        return None, True
    try:
        obj, _end = json.JSONDecoder(object_pairs_hook=_unique_lock_object).raw_decode(stripped)
    except json.JSONDecodeError:
        return None, True
    if not isinstance(obj, dict):
        return None, True
    return obj, False


class TaskCheckoutManager:
    """Manages atomic task checkouts with file-based locking."""

    def __init__(
        self,
        locks_file: Path = LOCKS_FILE,
        timeout_minutes: int = DEFAULT_TIMEOUT_MINUTES,
    ):
        self.locks_file = Path(locks_file)
        self.timeout_minutes = timeout_minutes
        self._quarantined: set[tuple[int, int]] = set()

    def _ensure_parent(self) -> None:
        pass  # Parent was securely opened by the portable wrapper

    def _quarantine(self, raw: bytes) -> None:
        dest = self.locks_file.parent / CORRUPT_NAME
        raise LockStoreCorrupt("Portable lock store is corrupt; repair required")

    def _persist(self, f, locks: Dict[str, LockEntry]) -> None:
        out = {k: v.to_dict() for k, v in locks.items()}
        encoded = json.dumps(out, indent=2).encode("utf-8") + b"\n"
        f.seek(0)
        f.write(encoded)
        f.flush()
        os.fsync(f.fileno())
        f.truncate(len(encoded))

    def _with_file_lock(
        self,
        fn: Callable,
        *,
        fail_closed: bool = False,
        readonly: bool = False,
    ):
        """Same-fd flock. See plan v19 §1b.2.

        Write path creates the store. Readonly never creates. Empty size is
        a fresh map. A torn UTF-8 tail with a dict prefix is kept; only a
        missing dict prefix quarantines.
        """
        if not readonly:
            self._ensure_parent()

        if readonly:
            try:
                fd = open_lock(self.locks_file, os.O_RDONLY)
            except FileNotFoundError:
                return fn({})
        else:
            fd = open_lock(self.locks_file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)

        f = os.fdopen(fd, "rb+")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            raw = f.read(1_048_577)
            if len(raw) > 1_048_576: raise LockStoreCorrupt("Lock store exceeds supported size")
            payload, corrupt = _decode_store(raw)
            if corrupt:
                stamp = (0, 0)
                try:
                    st = os.fstat(f.fileno())
                    stamp = (st.st_mtime_ns, st.st_size)
                except OSError:
                    pass
                if stamp not in self._quarantined:
                    self._quarantine(raw)
                    self._quarantined.add(stamp)
                locks = {}
                if fail_closed or not readonly:
                    # Never clear unknown ownership as a side effect of admission.
                    # Otherwise the next retry steals every lock in the corrupt store.
                    raise LockStoreCorrupt(str(self.locks_file))
            else:
                locks = _entries_from_payload(payload or {})

            result = fn(locks)

            if not readonly:
                self._persist(f, locks)
            return result
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()

    def _purge_expired(self, locks: Dict[str, LockEntry]) -> int:
        expired = [k for k, v in locks.items() if v.is_expired()]
        for key in expired:
            del locks[key]
        return len(expired)

    def _ttl(self, timeout_minutes: Optional[int]) -> int:
        return self.timeout_minutes if timeout_minutes is None else timeout_minutes

    def checkout(
        self,
        task_id: str,
        user: str,
        *,
        exclusive: bool = False,
        timeout_minutes: Optional[int] = None,
    ) -> CheckoutResult:
        ttl = self._ttl(timeout_minutes)

        def _do_checkout(locks: Dict[str, LockEntry]) -> CheckoutResult:
            self._purge_expired(locks)

            if task_id in locks:
                existing = locks[task_id]
                if existing.user == user and not exclusive:
                    now = datetime.now(timezone.utc)
                    existing.locked_at = now.isoformat()
                    existing.expires_at = (now + timedelta(minutes=ttl)).isoformat()
                    return CheckoutResult(
                        success=True, task_id=task_id, user=user,
                        message=f"Lock extended for {user}",
                    )
                return CheckoutResult(
                    success=False, task_id=task_id, user=user,
                    conflict=True,
                    locked_by=existing.user,
                    locked_at=existing.locked_at,
                    expires_at=existing.expires_at,
                    message=f"Task {task_id} is checked out by {existing.user}",
                )

            now = datetime.now(timezone.utc)
            locks[task_id] = LockEntry(
                task_id=task_id,
                user=user,
                locked_at=now.isoformat(),
                expires_at=(now + timedelta(minutes=ttl)).isoformat(),
            )
            return CheckoutResult(
                success=True, task_id=task_id, user=user,
                message=f"Checked out {task_id} for {user}",
            )

        return self._with_file_lock(
            _do_checkout, fail_closed=task_id.startswith("file:")
        )

    def release(self, task_id: str, user: str) -> CheckoutResult:
        def _do_release(locks: Dict[str, LockEntry]) -> CheckoutResult:
            self._purge_expired(locks)
            if task_id not in locks:
                return CheckoutResult(
                    success=True, task_id=task_id, user=user,
                    message=f"Task {task_id} was not locked",
                )
            existing = locks[task_id]
            if existing.user != user:
                return CheckoutResult(
                    success=False, task_id=task_id, user=user,
                    conflict=True, locked_by=existing.user,
                    message=f"Cannot release — locked by {existing.user}, not {user}",
                )
            del locks[task_id]
            return CheckoutResult(
                success=True, task_id=task_id, user=user,
                message=f"Released {task_id}",
            )

        return self._with_file_lock(
            _do_release, fail_closed=task_id.startswith("file:")
        )

    def force_release(self, task_id: str) -> CheckoutResult:
        def _do_force(locks: Dict[str, LockEntry]) -> CheckoutResult:
            self._purge_expired(locks)
            if task_id in locks:
                old_user = locks[task_id].user
                del locks[task_id]
                return CheckoutResult(
                    success=True, task_id=task_id, user="admin",
                    message=f"Force-released {task_id} (was held by {old_user})",
                )
            return CheckoutResult(
                success=True, task_id=task_id, user="admin",
                message=f"Task {task_id} was not locked",
            )

        return self._with_file_lock(_do_force)

    def status(self) -> List[LockEntry]:
        def _do_status(locks: Dict[str, LockEntry]):
            self._purge_expired(locks)
            return list(locks.values())

        return self._with_file_lock(_do_status, readonly=True)

    def is_locked(self, task_id: str) -> Optional[LockEntry]:
        def _do_check(locks: Dict[str, LockEntry]):
            self._purge_expired(locks)
            return locks.get(task_id)

        return self._with_file_lock(_do_check, readonly=True)


def doctor(locks_file: Path, *, confirm: bool) -> int:
    corrupt = locks_file.parent / CORRUPT_NAME
    print(f"store: {locks_file}")
    print(f"corrupt: {corrupt}")
    if not confirm:
        print("pass --confirm to recreate an empty store")
        return 0
    locks_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    locks_file.write_text("{}\n")
    print("rewrote empty store")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Task Checkout Manager")
    subparsers = parser.add_subparsers(dest="command")

    co = subparsers.add_parser("checkout", help="Check out a task")
    co.add_argument("task_id")
    co.add_argument("user")

    rel = subparsers.add_parser("release", help="Release a checkout")
    rel.add_argument("task_id")
    rel.add_argument("user")

    fr = subparsers.add_parser("force-release", help="Force release (admin)")
    fr.add_argument("task_id")

    subparsers.add_parser("status", help="Show all active locks")

    doc = subparsers.add_parser("doctor", help="Inspect / recreate the lock store")
    doc.add_argument("--confirm", action="store_true")

    args = parser.parse_args()
    mgr = TaskCheckoutManager()

    if args.command == "checkout":
        result = mgr.checkout(args.task_id, args.user)
        if result.conflict:
            print(f"CONFLICT: {result.message}")
            print(f"  Locked by: {result.locked_by}")
            print(f"  Since: {result.locked_at}")
            print(f"  Expires: {result.expires_at}")
            sys.exit(1)
        print(f"OK: {result.message}")
    elif args.command == "release":
        result = mgr.release(args.task_id, args.user)
        if result.success:
            print(f"OK: {result.message}")
        else:
            print(f"DENIED: {result.message}")
            sys.exit(1)
    elif args.command == "force-release":
        print(f"OK: {mgr.force_release(args.task_id).message}")
    elif args.command == "status":
        locks = mgr.status()
        if not locks:
            print("No active locks.")
            return
        print(f"\n{'Task ID':<20} {'User':<15} {'Locked At':<25} {'Expires At'}")
        print("-" * 80)
        for lock in locks:
            print(f"{lock.task_id:<20} {lock.user:<15} {lock.locked_at:<25} {lock.expires_at}")
        print()
    elif args.command == "doctor":
        sys.exit(doctor(LOCKS_FILE, confirm=args.confirm))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

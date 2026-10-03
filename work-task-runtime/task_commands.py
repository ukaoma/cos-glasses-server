"""Extracted canonical task handlers only; see manifest provenance."""
import json, re, sys

def cmd_task_rows(args):
    from task_rows import full_domains, cmd_task_rows as emit_rows

    domain = args[0] if args and not args[0].startswith("-") else None
    day = None
    if "--day" in args:
        idx = args.index("--day")
        if idx + 1 < len(args):
            day = args[idx + 1]
    if domain not in full_domains():
        print(json.dumps({
            "error": {
                "code": "invalid_domain",
                "message": f"full domain required, got {domain!r}",
            }
        }))
        return
    if not day or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        print(json.dumps({
            "error": {
                "code": "day_required",
                "message": "--day YYYY-MM-DD is required",
            }
        }))
        return
    print(json.dumps(emit_rows(domain, day)))

def _bridge_error(code: str, message: str) -> None:
    print(json.dumps({"error": {"code": code, "message": message}}))

def _bridge_flag(args, name: str):
    if name in args:
        idx = args.index(name)
        if idx + 1 < len(args):
            return args[idx + 1]
    return None

def _bridge_domain(args):
    from task_rows import full_domains

    domain = args[0] if args and not args[0].startswith("-") else None
    if domain not in full_domains():
        _bridge_error("invalid_domain", f"full domain required, got {domain!r}")
        return None
    return domain

def _bridge_write(fn):
    from task_write import LockLost, TaskFileLocked, TaskRunning
    from task_work_metadata import WorkMetadataError

    try:
        return fn()
    except TaskFileLocked as exc:
        _bridge_error("task_file_locked", str(exc))
    except TaskRunning as exc:
        _bridge_error("task_running", str(exc))
    except LockLost as exc:
        _bridge_error("lock_lost", str(exc))
    except WorkMetadataError as exc:
        _bridge_error(exc.code, str(exc))
    except ValueError as exc:
        _bridge_error("invalid_section", str(exc))
    return None

def cmd_task_capture(args):
    from task_write import capture

    domain = _bridge_domain(args)
    if domain is None:
        return
    section = _bridge_flag(args, "--section")
    if not section:
        _bridge_error("section_required", "--section is required")
        return
    text = sys.stdin.read().strip()
    if not text:
        _bridge_error("text_required", "task text required on STDIN")
        return
    result = _bridge_write(lambda: capture(
        domain,
        text,
        section=section,
        run_at=_bridge_flag(args, "--run-at"),
        purge_before=_bridge_flag(args, "--purge-before"),
    ))
    if result is not None:
        print(json.dumps(result))

def cmd_task_set_run_at(args):
    from task_write import set_run_at

    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) < 3:
        _bridge_error("argv_required", "usage: task-set-run-at <domain> <id> <YYYY-MM-DD HH:MM>|--clear")
        return
    task_id = args[1]
    raw = args[2]
    run_at = None if raw == "--clear" else raw
    ok = _bridge_write(lambda: set_run_at(domain, task_id, run_at))
    if ok is None:
        return
    if ok is False:
        _bridge_error("task_not_found", f"no task {task_id} in {domain}")
        return
    print(json.dumps({"ok": True}))

def cmd_task_set_text(args):
    """Rewrite a task's words. Text arrives on STDIN so it needs no quoting."""
    from task_write import set_text

    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) < 2:
        _bridge_error("argv_required", "usage: task-set-text <domain> <id>  (text on STDIN)")
        return
    task_id = args[1]
    text = sys.stdin.read().strip()
    if not text:
        _bridge_error("text_required", "task text required on STDIN")
        return
    ok = _bridge_write(lambda: set_text(domain, task_id, text))
    if ok is None:
        return
    if ok is False:
        _bridge_error("task_not_found", f"no task {task_id} in {domain}")
        return
    print(json.dumps({"ok": True}))

def cmd_task_work_write(args, *, linking=False, editing=False):
    from task_write import set_work_stage, link_meeting, edit_work_task
    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) != (2 if linking or editing else 3):
        _bridge_error("argv_required", "Expected domain, task ID, and phase for stage writes.")
        return
    try:
        raw = sys.stdin.read(32_769)
        if len(raw.encode()) > 32_768:
            raise ValueError()
        body = json.loads(raw)
        if not isinstance(body, dict) or not isinstance(body.get("expectedText"), str) or not isinstance(body.get("expectedRevision"), str):
            raise ValueError()
        allowed = {"expectedText", "expectedRevision", "text", "doneWhen"} if editing else {"expectedText", "expectedRevision", "meeting", "removeRecordId"} if linking else {"expectedText", "expectedRevision"}
        if set(body) - allowed:
            raise ValueError()
        if editing and (not isinstance(body.get("text"), str) or not isinstance(body.get("doneWhen"), str)):
            raise ValueError()
    except (ValueError, TypeError):
        _bridge_error("invalid_work_request", "Bounded JSON with expectedText and expectedRevision is required.")
        return
    if editing:
        ok = _bridge_write(lambda: edit_work_task(domain, args[1], body["text"], body["doneWhen"], expected_text=body["expectedText"], expected_revision=body["expectedRevision"]))
    elif linking:
        ok = _bridge_write(lambda: link_meeting(domain, args[1], expected_text=body["expectedText"], expected_revision=body["expectedRevision"], meeting=body.get("meeting"), remove_record_id=body.get("removeRecordId")))
    else:
        ok = _bridge_write(lambda: set_work_stage(domain, args[1], args[2], expected_text=body["expectedText"], expected_revision=body["expectedRevision"]))
    if ok is False:
        _bridge_error("task_not_found", "Task not found in this domain.")
    elif ok is not None:
        print(json.dumps(ok if editing else {"ok": True}))

def cmd_task_set_stage(args):
    """Move a task between board stages. Clearing returns it to planning, which
    is the unmarked default, so the marker is removed rather than written."""
    from task_write import set_stage

    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) < 3:
        _bridge_error("argv_required", "usage: task-set-stage <domain> <id> planning|active|review|--clear")
        return
    # Validated HERE, not via except: _bridge_write catches ValueError itself and
    # reports it as invalid_section, so a try/except around it never fires.
    stage = args[2]
    if stage not in ("--clear", "planning", "active", "review"):
        _bridge_error("invalid_stage", f"invalid stage: {stage}")
        return
    ok = _bridge_write(lambda: set_stage(domain, task_id=args[1], stage=stage))
    if ok is None:
        return
    if ok is False:
        _bridge_error("task_not_found", f"no task {args[1]} in {domain}")
        return
    print(json.dumps({"ok": True}))

def cmd_task_set_done_when(args):
    """Set or clear the finish line. Text arrives on STDIN so it needs no
    quoting; an empty body clears it. A dispatch is refused while it is empty."""
    from task_write import set_done_when

    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) < 2:
        _bridge_error("argv_required", "usage: task-set-done-when <domain> <id>  (text on STDIN, empty clears)")
        return
    text = sys.stdin.read().strip()
    if "\n" in text or "**" in text:
        _bridge_error("invalid_done_when", "done_when must be a single line without ** markup")
        return
    ok = _bridge_write(lambda: set_done_when(domain, task_id=args[1], text=text))
    if ok is None:
        return
    if ok is False:
        _bridge_error("task_not_found", f"no task {args[1]} in {domain}")
        return
    print(json.dumps({"ok": True}))

def cmd_task_set_marker(args):
    from task_write import set_marker

    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) < 3:
        _bridge_error("argv_required", "usage: task-set-marker <domain> <id> running|done:<N>|failed:<N>|failed|--clear")
        return
    marker = None if args[2] == "--clear" else args[2]
    ok = _bridge_write(lambda: set_marker(domain, task_id=args[1], marker=marker))
    if ok is None:
        return
    if ok is False:
        _bridge_error("task_not_found", f"no task {args[1]} in {domain}")
        return
    print(json.dumps({"ok": True}))

def cmd_task_move(args):
    from task_write import move

    domain = _bridge_domain(args)
    if domain is None:
        return
    if len(args) < 2:
        _bridge_error("argv_required", "usage: task-move <domain> <id> --section <section>")
        return
    section = _bridge_flag(args, "--section")
    if not section:
        _bridge_error("section_required", "--section is required")
        return
    ok = _bridge_write(lambda: move(
        domain, args[1], section, purge_before=_bridge_flag(args, "--purge-before")
    ))
    if ok is None:
        return
    if ok is False:
        _bridge_error("task_not_found", f"no task {args[1]} in {domain}")
        return
    print(json.dumps({"ok": True}))

def cmd_task_check(args):
    from task_write import check

    domain = _bridge_domain(args)
    if domain is None:
        return
    text = _bridge_flag(args, "--text")
    task_id = None
    if len(args) >= 2 and not args[1].startswith("-"):
        task_id = args[1]
    if not task_id and not text:
        _bridge_error("argv_required", "usage: task-check <domain> <id>|--text <…> [--uncheck]")
        return
    status = _bridge_write(lambda: check(
        domain, task_id, text=text, uncheck="--uncheck" in args
    ))
    if status is None:
        return
    if status != "ok":
        _bridge_error(status, status.replace("_", " "))
        return
    print(json.dumps({"ok": True}))

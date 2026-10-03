#!/usr/bin/env python3
"""Portable bridge over canonical tasks.md; no provider invocation or second store."""
import argparse, io, json, os, stat, sys
from pathlib import Path
# -I excludes cwd/site configuration. Add only our installed, hash-verified code.
sys.path.insert(0,str(Path(__file__).resolve().parent))
from runtime_io import safe_read_text

def safe_name(name):
    return isinstance(name,str) and 0<len(name)<=64 and name==name.strip() and not name.startswith('.') and not any(c in name for c in '/\\\0') and not any(ord(c)<32 or ord(c)==127 for c in name)

def directory(path, create=False):
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts: raise ValueError('Absolute canonical root required')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if create:
                try: os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError: pass
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        return fd
    except BaseException: os.close(fd);raise

def main():
    if sys.version_info<(3,10): raise ValueError("Python 3.10 or later required")
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--lock-store',required=True);parser.add_argument('--domains',required=True);parser.add_argument('--operator',default='');parser.add_argument('command');parser.add_argument('args',nargs=argparse.REMAINDER)
    opts=parser.parse_args(); domains=json.loads(opts.domains)
    if not isinstance(domains,list) or not domains or len(domains)>256 or not all(safe_name(d) for d in domains): raise ValueError('Invalid domain inventory')
    raw=sys.stdin.buffer.read(32769)
    if len(raw)>32768: raise ValueError('Task input exceeds supported limit')
    sys.stdin=io.StringIO(raw.decode('utf-8'))
    commands={'task-rows':'cmd_task_rows','task-capture':'cmd_task_capture','task-set-text':'cmd_task_set_text','task-set-run-at':'cmd_task_set_run_at','task-set-marker':'cmd_task_set_marker','task-set-stage':'cmd_task_set_stage','task-set-done-when':'cmd_task_set_done_when','task-move':'cmd_task_move','task-check':'cmd_task_check','task-set-work-stage':'cmd_task_work_write','task-link-meeting':'cmd_task_work_write','task-edit-work':'cmd_task_work_write'}
    if opts.command not in commands and opts.command!='task-work-capabilities': raise ValueError('Unsupported task command')
    rootfd=directory(opts.root,create=True); domainfds={}; lockfd=None
    try:
        # Descriptor pinning prevents ancestor rename/symlink replacement from
        # redirecting canonical source reads or atomic replacement writes.
        def domain_path(domain):
            if domain not in domains or not safe_name(domain): raise ValueError('Unknown task domain')
            if domain not in domainfds:
                try: os.mkdir(domain,0o700,dir_fd=rootfd)
                except FileExistsError: pass
                domainfds[domain]=os.open(domain,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=rootfd)
            os.fchdir(domainfds[domain])
            return Path('tasks.md')
        lock=Path(opts.lock_store)
        if not lock.is_absolute() or not safe_name(lock.name.lstrip('.')): raise ValueError('Invalid lock path')
        lockfd=directory(lock.parent,create=True)
        lockpath=lock
        import runtime_io
        runtime_io.LOCK_FD=lockfd
        try:
            info=os.stat(lock.name,dir_fd=lockfd,follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_size>1048576: raise ValueError('Unsafe lock store')
        except FileNotFoundError: pass
        os.environ['COS_TASK_LOCK_STORE']=str(lockpath);os.environ['COS_TASK_OPERATOR']=opts.operator
        import task_rows
        task_rows.full_domains=lambda:tuple(domains);task_rows.domain_path=domain_path
        # Canonical aliases should not re-route a custom domain named sr or hc.
        task_rows.SHORT_TO_FULL={k:v for k,v in task_rows.SHORT_TO_FULL.items() if k not in domains}
        import task_write
        task_write.domain_path=domain_path
        original_write=task_write._guarded_write
        def guarded(domain,identity,path,text):
            if len(text.encode())>8*1024*1024: raise ValueError('Task source exceeds supported limit')
            original_write(domain,identity,path,text)
        task_write._guarded_write=guarded
        import task_commands
        if opts.command=='task-work-capabilities': print(json.dumps({'version':1,'protocol':'cos-control-task-write/1','editTasks':1}));return
        if not opts.args or opts.args[0] not in domains: raise ValueError('Unknown task domain')
        path=domain_path(opts.args[0])
        try: safe_read_text(path)
        except FileNotFoundError: pass
        fn=getattr(task_commands,commands[opts.command])
        if opts.command=='task-link-meeting':fn(opts.args,linking=True)
        elif opts.command=='task-edit-work':fn(opts.args,editing=True)
        else:fn(opts.args)
    finally:
        for fd in domainfds.values():os.close(fd)
        if lockfd is not None:os.close(lockfd)
        os.close(rootfd)

if __name__=='__main__':
    try: main()
    except Exception:
        print(json.dumps({'error':{'code':'task_runtime_unavailable','message':'Task source or portable runtime is unavailable. Check configuration before retrying.'}}))

"""Bounded, no-follow source I/O used by the portable canonical parser/writer."""
import os, stat
MAX_SOURCE=8*1024*1024

def safe_read_text(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size>MAX_SOURCE: raise ValueError('Unsafe or oversized task source')
        parts=[]; count=0
        while count<=MAX_SOURCE:
            chunk=os.read(fd,min(65536,MAX_SOURCE+1-count))
            if not chunk: break
            parts.append(chunk); count+=len(chunk)
        after=os.fstat(fd)
        if count>MAX_SOURCE or count!=before.st_size or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns): raise ValueError('Task source changed while reading')
        return b''.join(parts).decode('utf-8')
    finally: os.close(fd)

LOCK_FD=None
def open_lock(path, flags, mode=0o600):
    if LOCK_FD is None: raise ValueError('No pinned lock directory')
    fd=os.open(path.name,flags|os.O_NOFOLLOW|os.O_NONBLOCK,mode,dir_fd=LOCK_FD)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size>1048576:
        os.close(fd); raise ValueError('Unsafe lock store')
    return fd

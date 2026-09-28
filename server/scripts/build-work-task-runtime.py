#!/usr/bin/env python3
"""Regenerate the portable canonical task runtime from an explicit COS checkout.
No private data/config or unrelated bridge commands are copied.
"""
import argparse, ast, hashlib, json, subprocess
from pathlib import Path
parser=argparse.ArgumentParser(); parser.add_argument('--source',type=Path,required=True); args=parser.parse_args()
source=args.source.resolve(); out=Path(__file__).resolve().parents[2]/'work-task-runtime'; out.mkdir(exist_ok=True)
inventory={}
for name in ['task_rows.py','task_write.py','task_work_metadata.py','task_checkout.py','cos_atomic.py']:
 raw=(source/name).read_text(); inventory[name]=hashlib.sha256(raw.encode()).hexdigest()
 if name in ['task_rows.py','task_write.py']:
  raw=raw.replace('from __future__ import annotations','from __future__ import annotations\nfrom runtime_io import safe_read_text')
  raw=raw.replace('filepath.read_text()', 'safe_read_text(filepath)').replace('path.read_text()', 'safe_read_text(path)')
 if name=='task_rows.py': raw=raw.replace('if head == "miles":','if head == os.environ.get("COS_TASK_OPERATOR", "").casefold():')
 if name=='cos_atomic.py': raw=raw.replace('os.O_WRONLY | os.O_CREAT | os.O_TRUNC', 'os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW')
 if name=='task_checkout.py':
  raw=raw.replace('from __future__ import annotations','from __future__ import annotations\nfrom runtime_io import open_lock')
  raw=raw.replace('os.open(self.locks_file,', 'open_lock(self.locks_file,')
  raw=raw.replace('self.locks_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)', 'pass  # Parent was securely opened by the portable wrapper')
  raw=raw.replace('dest.write_bytes(raw)', 'raise LockStoreCorrupt("Portable lock store is corrupt; repair required")')
  raw=raw.replace('os.open(self.locks_file, os.O_RDONLY)', 'os.open(self.locks_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)')
  raw=raw.replace('os.O_RDWR | os.O_CREAT, 0o600', 'os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600')
  raw=raw.replace('raw = f.read()', 'raw = f.read(1_048_577)\n            if len(raw) > 1_048_576: raise LockStoreCorrupt("Lock store exceeds supported size")')
 (out/name).write_text(raw)
bridge=(source/'cos_api_bridge.py').read_text(); tree=ast.parse(bridge)
names={'cmd_task_rows','_bridge_error','_bridge_flag','_bridge_domain','_bridge_write','cmd_task_capture','cmd_task_set_run_at','cmd_task_set_text','cmd_task_work_write','cmd_task_set_stage','cmd_task_set_done_when','cmd_task_set_marker','cmd_task_move','cmd_task_check'}
functions=[ast.get_source_segment(bridge,n) for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(functions)==len(names)
(out/'task_commands.py').write_text('"""Extracted canonical task handlers only; see manifest provenance."""\nimport json, re, sys\n\n'+'\n\n'.join(functions)+'\n')
inventory['cos_api_bridge.py']=hashlib.sha256(bridge.encode()).hexdigest()
dedup=(source/'task_dedup.py').read_text(); tree=ast.parse(dedup)
method=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='normalize')
body=ast.get_source_segment(dedup,method)
(out/'task_dedup.py').write_text('import string\nclass TaskDeduplicator:\n    @staticmethod\n'+'\n'.join('    '+line for line in body.splitlines())+'\n')
inventory['task_dedup.py']=hashlib.sha256(dedup.encode()).hexdigest()
commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
manifest={'version':1,'protocol':'cos-control-task-write/1','pythonMinimum':'3.10','sourceCommit':commit,'sourceHashes':inventory,'adaptations':['Only canonical task command handlers extracted; no private bridge imports','Exact canonical normalization extracted without LLM dependencies','Generic configured operator replaces author-specific owner match','Bounded no-follow source reads and lock opens','Descriptor-pinned domain working directory and lock opens supplied by task_bridge.py'],'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.glob('*.py'))}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

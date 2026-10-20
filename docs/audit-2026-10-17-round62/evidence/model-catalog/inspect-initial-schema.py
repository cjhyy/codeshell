from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
initial=json.loads((out/'initial-pins.json').read_text())
print('initial-pins structure',type(initial).__name__,list(initial) if isinstance(initial,dict) else len(initial))

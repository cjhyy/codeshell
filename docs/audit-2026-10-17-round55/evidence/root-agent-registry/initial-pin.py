from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round125-agent-registry')
paths=['packages/core/src/agent/agent-definition-registry.ts','packages/core/src/agent/agent-definition.ts']
rows=[]
for n in paths:
 b=(R/n).read_bytes();rows.append(dict(path=n,bytes=len(b),lines=len(b.splitlines()),sha256=hashlib.sha256(b).hexdigest(),beforeBodyOrLineNavigation=True))
(D/'initial-pins.json').write_text(json.dumps(dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),files=rows,productExecution=0),indent=2)+'\n');print(json.dumps(rows))

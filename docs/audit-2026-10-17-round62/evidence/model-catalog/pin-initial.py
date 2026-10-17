from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,subprocess
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');OUT=Path('/tmp/codeshell-audit-round164-model-catalog');cmd=['rg','--files','packages/core/src/model-catalog'];r=subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True)
(OUT/'filename-navigation.first.stdout.txt').write_text(r.stdout);(OUT/'filename-navigation.first.stderr.txt').write_text(r.stderr);(OUT/'filename-navigation.first.exit.json').write_text(json.dumps({'command':cmd,'exitCode':r.returncode})+'\n')
paths=['CODESHELL.md','AGENTS.md']+[p for p in r.stdout.splitlines() if p.rsplit('/',1)[-1] in ['resolve.ts','gen-connections.ts','upsert.ts']];assert len(paths)==5,paths
rows=[]
for p in paths:
 b=(ROOT/p).read_bytes();rows.append({'path':p,'bytes':len(b),'lines':len(b.splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAt':datetime.now(timezone.utc).isoformat(),'coverage':'hash-only before product body/line-navigation'})
x={'root':str(ROOT),'rootReportedHead':'d195788bc2c18cd85c81aea4a431ab29074df5cf','GitVerified':False,'branchReported':62,'files':rows,'instructionScope':'Previously read same-SHA CODESHELL/AGENTS reused without new semantic reading.'}
(OUT/'initial-pins.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n');print(json.dumps(rows,ensure_ascii=False))

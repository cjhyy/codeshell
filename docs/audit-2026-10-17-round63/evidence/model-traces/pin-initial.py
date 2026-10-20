from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
r=subprocess.run(['rg','--files','packages/core/src/model-traces'],cwd=root,capture_output=True,text=True)
(out/'filenames.first.stdout.txt').write_text(r.stdout);(out/'filenames.first.stderr.txt').write_text(r.stderr);(out/'filenames.first.exit.json').write_text(json.dumps({'exitCode':r.returncode})+'\n')
assert r.returncode==0
available=set(r.stdout.splitlines());paths=['CODESHELL.md','AGENTS.md']+['packages/core/src/model-traces/'+n+'.ts' for n in ['native-frames','sanitize','classification']]
rows=[]
for p in paths:
 if p not in ['CODESHELL.md','AGENTS.md']:assert p in available
 b=(root/p).read_bytes();rows.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'coverage':'hash-only before body/navigation'})
(out/'initial-pins.json').write_text(json.dumps({'root':str(root),'rootReportedHead':'9874f8abdfce0ade5bb058d26e026b10f173a129','GitVerified':False,'files':rows,'instructionReuse':'Same-SHA prior reading reused; no new instruction semantic read','sourceBodyRead':0,'productExecutions':0},indent=2)+'\n')
for r in rows:print(json.dumps(r))

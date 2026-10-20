from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
r=subprocess.run(['rg','--files','packages/server/src/hub'],cwd=root,capture_output=True,text=True)
(out/'filenames.first.stdout.txt').write_text(r.stdout);(out/'filenames.first.stderr.txt').write_text(r.stderr);(out/'filenames.first.exit.json').write_text(json.dumps({'exitCode':r.returncode})+'\n')
assert r.returncode==0
available=set(r.stdout.splitlines());paths=['CODESHELL.md','AGENTS.md','packages/server/src/hub/auth-http.ts','packages/server/src/hub/auth-store.ts'];rows=[]
for p in paths:
 if p not in ['CODESHELL.md','AGENTS.md']:assert p in available
 b=(root/p).read_bytes();rows.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endsWithNewline':b.endswith(b'\n'),'coverage':'hash-only before body/navigation'})
assert rows[0]['sha256']=='56d9ffdd81b6f6f615ed7a7392ddfa60ec4338c0ccb88eef20c4b73ad8dad5a2'
assert rows[1]['sha256']=='2980647020f0ae72522f7f717ffa89f4c5ec7fb1efe48066e881b864cd428917'
(out/'initial-pins.json').write_text(json.dumps({'root':str(root),'rootReportedHead':'5fa6a076db90682733c33fd46e1f473f9214d196','rootReportedBranch':'codex/audit/auth-panel-attachments-round64-20261018','GitVerified':False,'files':rows,'instructionReuse':'Same-SHA prior reading reused, no new instruction semantic read','sourceBodyRead':0,'productExecutions':0},indent=2)+'\n')
for row in rows:print(json.dumps(row))

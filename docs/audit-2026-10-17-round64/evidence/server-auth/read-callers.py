from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
plan=[('packages/server/src/serve/headless-server.ts',[[185,215],[255,280],[775,820],[842,887]],'product'),('packages/web/app/auth.ts',[[61,141],[196,205]],'product'),('packages/web/app/AuthGate.tsx',[[114,145],[192,224],[289,348]],'product'),('packages/server/src/hub/auth-store.test.ts',[[21,97]],'test-declaration'),('packages/server/src/hub/auth-http.test.ts',[[92,148]],'test-declaration')]
pins=[]
for p,rs,kind in plan:
 b=(root/p).read_bytes();lines=b.decode().splitlines();assert all(1<=a<=z<=len(lines) for a,z in rs)
 pins.append({'path':p,'bytes':len(b),'lines':len(lines),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ranges':rs,'sourceKind':kind})
(out/'caller-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs,kind in plan:
 lines=(root/p).read_text().splitlines(keepends=True);print('\nSOURCE',p,'KIND',kind)
 for a,z in rs:
  text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'caller-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')

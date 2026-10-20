from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
plan=[('packages/server/src/hub/auth-http.ts',[[146,290]]),('packages/server/src/hub/auth-store.ts',[[1,208]])]
pins=[]
for p,rs in plan:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ranges':rs})
(out/'source-part2-before-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs in plan:
 lines=(root/p).read_text().splitlines(keepends=True);print('\nSOURCE',p)
 for a,z in rs:
  assert 1<=a<=z<=len(lines);text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'source-part2-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')

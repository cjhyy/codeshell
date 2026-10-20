from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
p='packages/server/src/serve/headless-server.ts';b=(root/p).read_bytes();pin={'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'range':[281,294]};(out/'reaper-before-pin.json').write_text(json.dumps(pin,indent=2)+'\n')
lines=b.decode().splitlines(keepends=True);text=''.join(lines[280:294]);(out/'reaper-excerpt.json').write_text(json.dumps({'path':p,'range':[281,294],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()},ensure_ascii=False,indent=2)+'\n')
for i in range(280,294):print(str(i+1)+': '+lines[i].rstrip('\n'))

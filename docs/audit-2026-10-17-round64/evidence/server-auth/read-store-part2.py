from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
p='packages/server/src/hub/auth-store.ts';b=(root/p).read_bytes();pin={'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'range':[209,415]};(out/'store-part2-before-pin.json').write_text(json.dumps(pin,indent=2)+'\n')
lines=b.decode().splitlines(keepends=True);text=''.join(lines[208:]);assert len(lines)==415
(out/'store-part2-excerpt.json').write_text(json.dumps({'path':p,'range':[209,415],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()},ensure_ascii=False,indent=2)+'\n')
for i in range(208,415):print(str(i+1)+': '+lines[i].rstrip('\n'))

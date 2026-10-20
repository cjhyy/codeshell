from pathlib import Path
import hashlib,json,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
plan=[('packages/core/src/model-catalog/resolve.ts',1,113),('packages/core/src/model-catalog/gen-connections.ts',1,43),('packages/core/src/model-catalog/upsert.ts',1,25)]
pins=[]
for p,a,z in plan:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'product','coverage':'full','selectedLineRanges':[[a,z]]})
(out/'leaf-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,a,z in plan:
 b=(root/p).read_bytes();lines=b.decode().splitlines(keepends=True);text=''.join(lines[a-1:z]);ex.append({'path':p,'selectedLineRanges':[[a,z]],'text':text,'selectedTextSha256':hashlib.sha256(text.encode()).hexdigest(),'bytes':len(text.encode())})
 print('\nSOURCE',p)
 for i in range(a-1,z): print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'leaf-source-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')

from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
old={x['path']:x for x in json.loads((out/'chain-before-read-pins.json').read_text())}
test='packages/core/src/model-catalog/upsert.test.ts';testend=old[test]['lines'];assert 77<=testend<=85
plan=[('packages/core/src/tool-system/builtin/generate-image.ts',[[55,105]],'product'),('packages/core/src/model-catalog/types.ts',[[113,118]],'product'),('packages/core/src/model-catalog/index.ts',[[107,113]],'product'),(test,[[77,testend]],'test-declaration')]
pins=[]
for p,rs,kind in plan:
 b=(root/p).read_bytes();lines=b.decode().splitlines();assert all(1<=a<=z<=len(lines) for a,z in rs)
 pins.append({'path':p,'bytes':len(b),'lines':len(lines),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,'coverage':'selected','selectedLineRanges':rs})
(out/'supplement-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs,kind in plan:
 lines=(root/p).read_text().splitlines(keepends=True);print('\nSOURCE',p)
 for a,z in rs:
  text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'selectedTextSha256':hashlib.sha256(text.encode()).hexdigest(),'bytes':len(text.encode())})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'supplement-source-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')

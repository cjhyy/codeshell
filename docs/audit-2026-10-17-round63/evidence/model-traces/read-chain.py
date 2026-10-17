from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
plan=[('packages/core/src/model-traces/context.ts',[[199,240],[740,775]],'product'),('packages/core/src/model-traces/native-process.ts',[[1,80],[140,163]],'product'),('packages/core/src/model-traces/types.ts',[[1,5]],'product'),('packages/core/src/model-traces/native-frames.test.ts',[[1,60]],'test-declaration')]
pins=[]
for p,rs,kind in plan:
 b=(root/p).read_bytes();lines=b.decode().splitlines();assert all(1<=a<=z<=len(lines) for a,z in rs),(p,len(lines),rs)
 pins.append({'path':p,'bytes':len(b),'lines':len(lines),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selectedLineRanges':rs,'coverage':'selected','sourceKind':kind})
(out/'chain-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs,kind in plan:
 lines=(root/p).read_text().splitlines(keepends=True);print('\nSOURCE',p,'KIND',kind)
 for a,z in rs:
  text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'chain-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')

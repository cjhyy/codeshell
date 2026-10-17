from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
old={r['path']:r for r in json.loads((out/'chain-before-read-pins.json').read_text())}
p='packages/core/src/model-traces/native-process.ts';end=old[p]['lines'];assert 164<=end<=300
plan=[(p,[[81,139],[164,end]],'product'),('packages/core/src/model-traces/context.ts',[[241,248],[776,807]],'product')]
pins=[]
for p,rs,kind in plan:
 b=(root/p).read_bytes();lines=b.decode().splitlines();assert all(1<=a<=z<=len(lines) for a,z in rs)
 pins.append({'path':p,'bytes':len(b),'lines':len(lines),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selectedLineRanges':rs,'coverage':'selected','sourceKind':kind})
(out/'supplement-before-read-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
ex=[]
for p,rs,kind in plan:
 lines=(root/p).read_text().splitlines(keepends=True);print('\nSOURCE',p)
 for a,z in rs:
  text=''.join(lines[a-1:z]);ex.append({'path':p,'range':[a,z],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i].rstrip('\n'))
(out/'supplement-excerpts.json').write_text(json.dumps(ex,ensure_ascii=False,indent=2)+'\n')

"""Read-only prior-docs/bugs value-scalar scan; no product imports/execution."""
from pathlib import Path
import json,re,hashlib
ROOT=Path(__file__).resolve().parents[3]
SNAP=Path(__file__).with_name('root-branch-scan.json')
previous=json.loads(SNAP.read_text());patterns=previous['patterns']
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};stats=dict(markdownFiles=0,jsonFiles=0,stringLeaves=0,scalarLeaves=0);errors=[];inventory=[]
def leaves(v,at='$'):
 if isinstance(v,dict):
  for k,c in v.items():yield from leaves(c,at+'.'+k)
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from leaves(c,at+'['+str(i)+']')
 else:yield at,v
for dirname in ['docs','bugs']:
 for p in sorted((ROOT/dirname).rglob('*')):
  if not p.is_file() or p.suffix not in ['.md','.json'] or 'audit-2026-10-17-round26' in p.parts:continue
  raw=p.read_bytes();inventory.append(dict(path=str(p.relative_to(ROOT)),bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
  try:
   body=raw.decode()
   if p.suffix=='.json':
    stats['jsonFiles']+=1;units=list(leaves(json.loads(body)));stats['scalarLeaves']+=len(units);stats['stringLeaves']+=sum(isinstance(v,str) for _,v in units);units=[(at,v if isinstance(v,str) else json.dumps(v)) for at,v in units]
   else:stats['markdownFiles']+=1;units=[('$',body)]
   for at,s in units:
    for key,pat in compiled.items():
     for m in pat.finditer(s):
      counts[key]+=1
      if len(hits[key])<100:hits[key].append(dict(path=str(p.relative_to(ROOT)),at=at,context=s[max(0,m.start()-180):m.end()+600]))
  except Exception as error:errors.append(dict(path=str(p.relative_to(ROOT)),error=str(error)))
assert stats==previous['stats'] and counts==previous['counts'] and not errors,(stats,counts,errors)
previous.update(inventory=inventory,inventoryAcquisition='Separate read-only metadata pass after initialscan;counts andallmatches equalfirstsnapshot. No source/test rerun.',parseErrors=errors)
SNAP.write_text(json.dumps(previous,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(stats=stats,counts=counts,inventoryFiles=len(inventory),productAttempts=0)))

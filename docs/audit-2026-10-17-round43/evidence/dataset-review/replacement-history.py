from pathlib import Path
from datetime import datetime,timezone
import json,re,hashlib
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round46-root-review');p=json.loads((D/'replacement-initial-pin.json').read_text());h=json.loads((D/'history.json').read_text());patterns={'path':re.compile(re.escape(p['path'])+'|dataset-editor\\.ts',re.I),'sha':re.compile(re.escape(p['sha256']),re.I)};counts={k:0 for k in patterns};hits={k:[] for k in patterns};rows=[]
def units(v,at='$'):
 if isinstance(v,dict):
  if v.get('path')==p['path']:rows.append(dict(historyPath=current,at=at,row=v))
  for k,x in v.items():yield from units(x,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from units(x,at+'['+str(i)+']')
 else:yield at,v if isinstance(v,str) else json.dumps(v)
for r in h['inventory']:
 q=R/r['path'];b=q.read_bytes();assert len(b)==r['bytes'] and hashlib.sha256(b).hexdigest()==r['sha256'];current=r['path'];data=[('$',b.decode())] if q.suffix=='.md' else units(json.loads(b))
 for at,s in data:
  for k,pat in patterns.items():
   for m in pat.finditer(s):
    counts[k]+=1
    if len(hits[k])<100:hits[k].append(dict(path=current,at=at,context=s[max(0,m.start()-160):m.end()+560]))
v=dict(atUTC=datetime.now(timezone.utc).isoformat(),historyFiles=len(h['inventory']),sameExact3773InventoryAllBytesVerified=True,patterns={k:v.pattern for k,v in patterns.items()},counts=counts,hits=hits,contextCapEach=100,coverageRows=rows,productRuns=0,scope='Replacement query over same whole3773 MD/JSON recursive scalar inventory including archives, not JSON keys. Before Root replacement source body display. Counts/saved contexts are not semantic exhaustion.')
(D/'replacement-history.json').write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v[k] for k in ['historyFiles','counts','hits','coverageRows']},ensure_ascii=False))

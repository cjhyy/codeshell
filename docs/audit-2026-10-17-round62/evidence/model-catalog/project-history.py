from pathlib import Path
import json,hashlib,datetime
out=Path('/tmp/codeshell-audit-round164-model-catalog')
p=Path('/tmp/codeshell-audit-round166-desktop-theme-window/history-batch.json')
b=p.read_bytes(); d=json.loads(b)
keys=['packages/core/src/model-catalog/'+n+'.ts' for n in ['resolve','gen-connections','upsert']]
proj={k:d[k] for k in ['atUTC','excludedFormalAtOrAbove','historyFiles','jsonValueScalarsVisited','capPerTarget','errors','note','productExecution']}
proj['sharedBatch']={'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
proj['queries']={k:d['queries'][k] for k in keys};proj['counts']={k:d['counts'][k] for k in keys};proj['hits']={k:d['hits'][k] for k in keys}
(out/'history-projection.json').write_text(json.dumps(proj,ensure_ascii=False,indent=2)+'\n')
for k in keys:
 print(k,'count',d['counts'][k],'saved',len(d['hits'][k]))
 print('first-hit-fields', list(d['hits'][k][0]))
 for i,h in enumerate(d['hits'][k]):
  s={kk:vv for kk,vv in h.items() if kk not in ['value','text','context','excerpt']}
  for kk in ['value','text','context','excerpt']:
   if kk in h: s[kk+'Length']=len(str(h[kk]))
  print(i,json.dumps(s,ensure_ascii=False))

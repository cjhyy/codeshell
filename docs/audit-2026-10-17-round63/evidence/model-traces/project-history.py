from pathlib import Path
import json,hashlib
out=Path('/tmp/codeshell-audit-round168-model-traces');p=Path('/tmp/codeshell-audit-round171-coverage62/history-batch.json')
b=p.read_bytes();d=json.loads(b);keys=['packages/core/src/model-traces/'+n+'.ts' for n in ['native-frames','sanitize','classification']]
proj={k:d[k] for k in ['atUTC','excludedFormalAtOrAbove','historyFiles','jsonValueScalarsVisited','capPerTarget','errors','note','productExecution']}
proj['sharedBatch']={'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()};proj['queries']={k:d['queries'][k] for k in keys};proj['counts']={k:d['counts'][k] for k in keys};proj['hits']={k:d['hits'][k] for k in keys}
(out/'history-projection.json').write_text(json.dumps(proj,ensure_ascii=False,indent=2)+'\n')
for key in keys:
 print('\nTARGET',key,'COUNT',d['counts'][key],'SAVED',len(d['hits'][key]))
 groups={}
 for h in d['hits'][key]:groups.setdefault(h['document'],[]).append(h['location'])
 for doc,locs in groups.items():print(json.dumps({'document':doc,'locations':locs},ensure_ascii=False))

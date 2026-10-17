from pathlib import Path
import json,hashlib,datetime
out=Path('/tmp/codeshell-audit-round172-server-auth');p=Path('/tmp/codeshell-audit-round175-settings-flags/history-batch.json')
b=p.read_bytes();d=json.loads(b);keys=['packages/server/src/hub/auth-http.ts','packages/server/src/hub/auth-store.ts']
proj={k:v for k,v in d.items() if k not in ['inventory','queries','counts','hits']}
proj['sharedBatch']={'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()};proj['queries']={k:d['queries'][k] for k in keys};proj['counts']={k:d['counts'][k] for k in keys};proj['hits']={k:d['hits'][k] for k in keys}
(out/'history-projection.json').write_text(json.dumps(proj,ensure_ascii=False,indent=2)+'\n')
print('BATCH',json.dumps({k:v for k,v in proj.items() if k not in ['queries','hits']},ensure_ascii=False))
for key in keys:
 print('\nTARGET',key,'TOTAL',d['counts'][key],'SAVED',len(d['hits'][key]))
 groups={}
 for h in d['hits'][key]:groups.setdefault(h['document'],[]).append(h['location'])
 for doc,locs in groups.items():
  if any(s in doc for s in ['coverage','inventory','preflight','history-batch','producer-filenames']):continue
  print(json.dumps({'document':doc,'locations':locs},ensure_ascii=False))
 print('allUniqueDocuments',len(groups),'suppressed groups are machine locator inventory/coverage/preflight only, not semantic read claims')

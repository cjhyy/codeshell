from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round168-model-traces')
paths=['docs/audit-2026-10-17-round18/evidence/presentation-source-manifest.json','docs/audit-2026-10-17-round18/presentation.md','docs/audit-2026-10-17-round44/evidence/coverage-frontier/coverage-claims.json']
pins=[]
for p in paths:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()})
(out/'history-gate-before-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
objects=[]
d=json.loads((root/paths[0]).read_text());print('R18 root noncollection fields',{k:v for k,v in d.items() if not isinstance(v,(list,dict))})
for i,r in enumerate(d['files']):
 if r.get('path')=='packages/core/src/model-traces/classification.ts':
  obj={'document':paths[0],'pointer':'/files/'+str(i),'row':r};objects.append(obj);print(json.dumps(obj,ensure_ascii=False,indent=2))
lines=(root/paths[1]).read_text().splitlines();a,z=15,min(36,len(lines));print('\nREPORT',paths[1],'range',a,z)
for i in range(a-1,z):print(str(i+1)+': '+lines[i])
(out/'history-gate-report-excerpt.json').write_text(json.dumps({'path':paths[1],'range':[a,z],'text':'\n'.join(lines[a-1:z])},ensure_ascii=False,indent=2)+'\n')
d=json.loads((root/paths[2]).read_text())
for i in [3224,3225,3226,3233,3237,3238,3239,3240]:
 r=d['claims'][i];objects.append({'document':paths[2],'pointer':'/claims/'+str(i),'row':r})
 compact={k:v for k,v in r.items() if k not in ['sourceObject','object','rawValue','value','rawObject','text']}
 print('\nDERIVED LOCATOR',i,json.dumps(compact,ensure_ascii=False))
(out/'history-gate-objects.json').write_text(json.dumps(objects,ensure_ascii=False,indent=2)+'\n')

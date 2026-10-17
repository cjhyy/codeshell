from pathlib import Path
import json,hashlib,datetime,subprocess
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
r=subprocess.run(['rg','--files','docs/audit-2026-10-17-round10','docs/audit-2026-10-17-round17'],cwd=root,capture_output=True,text=True)
(out/'canonical-filenames.stdout.txt').write_text(r.stdout);(out/'canonical-filenames.stderr.txt').write_text(r.stderr);(out/'canonical-filenames.exit.json').write_text(json.dumps({'exitCode':r.returncode})+'\n')
print('catalog metadata filenames')
for f in r.stdout.splitlines():
 if 'catalog' in f and (f.endswith('.md') or 'source-manifest' in f):print(f)
paths=['docs/audit-2026-10-17-round10/evidence/catalog-source-manifest.json','docs/audit-2026-10-17-round17/evidence/catalog-source-manifest.json']
pins=[]
for p in paths:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'prior-audit-metadata'})
(out/'canonical-initial-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
selected=[]
targets={'packages/core/src/model-catalog/'+n+'.ts' for n in ['resolve','gen-connections','upsert']}
for p in paths:
 d=json.loads((root/p).read_text());print('\nDOCUMENT',p,'keys',list(d))
 for k,v in d.items():
  if not isinstance(v,(dict,list)): print('root',k,json.dumps(v,ensure_ascii=False))
 for k in ['files','sources']:
  for i,row in enumerate(d.get(k,[])):
   if row.get('path') in targets:
    item={'document':p,'pointer':'/'+k+'/'+str(i),'row':row};selected.append(item);print(json.dumps(item,ensure_ascii=False,indent=2))
(out/'canonical-selected-objects.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2)+'\n')

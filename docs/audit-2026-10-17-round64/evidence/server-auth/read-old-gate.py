from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
plans=[('docs/review-2026-10-12/auth-round7.md',None),('docs/review-2026-10-12/file-mutex-quality-round19.md',None),('docs/review-2026-10-12/file-mutex-round19.md',[[1,35],[88,103]])]
pins=[]
for p,_ in plans:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()})
raw='docs/review-2026-10-12/validation/postdelivery-report-review/audit-a.raw.json';b=(root/raw).read_bytes();pins.append({'path':raw,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()})
(out/'old-gate-initial-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
reads=[]
for p,rs in plans:
 lines=(root/p).read_text().splitlines();rs=rs or [[1,len(lines)]];assert all(1<=a<=z<=len(lines) for a,z in rs)
 print('\nREPORT',p,'TOTAL',len(lines),'RANGES',rs)
 for a,z in rs:
  reads.append({'path':p,'range':[a,z],'text':'\n'.join(lines[a-1:z])})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i])
(out/'old-gate-report-excerpts.json').write_text(json.dumps(reads,ensure_ascii=False,indent=2)+'\n')
d=json.loads((root/raw).read_text());objects=[]
for k in ['84740d56','a66f4ef2']:
 row=d['module_inventory'][k];objects.append({'document':raw,'pointer':'/module_inventory/'+k,'row':row});print('\nORIGINAL MODULE GROUP',k,json.dumps(row,ensure_ascii=False))
(out/'old-gate-objects.json').write_text(json.dumps(objects,ensure_ascii=False,indent=2)+'\n')

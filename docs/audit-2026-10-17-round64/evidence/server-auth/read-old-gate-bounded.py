from pathlib import Path
import json
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
pins=json.loads((out/'old-gate-initial-pins.json').read_text());print('ORIGINAL PIN LINE COUNTS',[(r['path'],r.get('lines')) for r in pins])
plans=[('docs/review-2026-10-12/auth-round7.md',[[1,45],[89,102]]),('docs/review-2026-10-12/file-mutex-quality-round19.md',[[5,15],[19,23],[31,31],[53,57]])]
reads=[]
for p,rs in plans:
 lines=(root/p).read_text().splitlines();assert all(1<=a<=z<=len(lines) for a,z in rs)
 print('\nREPORT',p,'RANGES',rs)
 for a,z in rs:
  reads.append({'path':p,'range':[a,z],'text':'\n'.join(lines[a-1:z])})
  for i in range(a-1,z):print(str(i+1)+': '+lines[i])
(out/'old-gate-bounded-report-excerpts.json').write_text(json.dumps(reads,ensure_ascii=False,indent=2)+'\n')
raw='docs/review-2026-10-12/validation/postdelivery-report-review/audit-a.raw.json';d=json.loads((root/raw).read_text());objects=[]
for k in ['84740d56','a66f4ef2']:
 row=d['module_inventory'][k];objects.append({'document':raw,'pointer':'/module_inventory/'+k,'row':row});print('\nORIGINAL MODULE GROUP',k,json.dumps(row,ensure_ascii=False))
(out/'old-gate-objects.json').write_text(json.dumps(objects,ensure_ascii=False,indent=2)+'\n')

from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
paths=['docs/audit-2026-10-17-round10/catalog.md','docs/audit-2026-10-17-round10/evidence/catalog-static-read-failure.md','docs/audit-2026-10-17-round17/catalog.md','docs/audit-2026-10-17-round17/evidence/catalog-navigation-skip.md']
pins=[]
for p in paths:
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'prior-audit-report'})
(out/'prior-report-initial-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
reads=[]
for p in paths:
 lines=(root/p).read_text().splitlines();end=len(lines) if len(lines)<=90 else 60
 reads.append({'path':p,'selectedLineRanges':[[1,end]],'displayLines':end,'totalLines':len(lines)})
 print('\nDOCUMENT',p,'TOTAL',len(lines),'DISPLAY 1-'+str(end))
 for i in range(end): print(str(i+1)+': '+lines[i])
(out/'prior-report-read-ranges.json').write_text(json.dumps(reads,indent=2)+'\n')

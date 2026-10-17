"""Byte index after saving actual method stdout/stderr/exit; metadata only."""
from pathlib import Path
import hashlib, json
OUT=Path(__file__).resolve().parents[1]
rows=[]
for p in sorted(OUT.rglob('*')):
    if p.is_file() and p.name!='evidence-index.json':
        raw=p.read_bytes()
        rows.append(dict(path=str(p.relative_to(OUT)),bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
(OUT/'evidence-index.json').write_text(json.dumps(dict(files=rows,excludesSelf=True,productRuns=0),ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(indexedFiles=len(rows),productRuns=0)))

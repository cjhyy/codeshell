from pathlib import Path
import json,hashlib
D=Path(__file__).resolve().parent
p=D/'author-receipt.json'
assert not p.exists()
rows=[]
for f in sorted(D.rglob('*')):
 if f.is_file() and f!=p:
  b=f.read_bytes();rows.append(dict(path=str(f.relative_to(D)),bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
p.write_text(json.dumps(dict(files=rows,productAttempts=0,selfExcluded=True),ensure_ascii=False,indent=2)+'\n')

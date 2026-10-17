from pathlib import Path
import hashlib,json
P=Path(__file__).resolve().parent
receipt=P/'author-receipt.json'
assert not receipt.exists()
rows=[]
for p in sorted(P.rglob('*')):
 if p.is_file() and p!=receipt:
  b=p.read_bytes();rows.append(dict(path=str(p.relative_to(P)),bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
receipt.write_text(json.dumps(dict(files=rows,scope='Frozen own artifacts; self excluded; 1 product shard, no reruns'),ensure_ascii=False,indent=2)+'\n')

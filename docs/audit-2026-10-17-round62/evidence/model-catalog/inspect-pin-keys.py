from pathlib import Path
import json
p=Path('/tmp/codeshell-audit-round164-model-catalog/initial-pins.json')
d=json.loads(p.read_text())
print(json.dumps(d['files'][:2],ensure_ascii=False,indent=2))

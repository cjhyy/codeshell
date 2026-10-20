from pathlib import Path
import json,collections
out=Path('/tmp/codeshell-audit-round87-frontier-selection'); a=json.loads((out/'history-claims.json').read_text())['claims']
for c in a:
 if c['canonicalManifestNameHint']:
  print(json.dumps(c,ensure_ascii=False,separators=(',',':')))
print('SUMMARY',json.dumps(collections.Counter((c['path'],c['sameCurrentSourceSha']) for c in a if c['canonicalManifestNameHint']),default=str))

"""Historical metadata-only search, no runtime product imports."""
from pathlib import Path
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[3]
OUT=Path(__file__).with_suffix('.json')
BASE='ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f'
PATTERNS={
 'module':r'reorderBidi|hasRTLCharacters|render/bidi[.]ts|bidi-js',
 'mechanism':r'(?:RTL|Hebrew|Arabic|希伯来|阿拉伯).{0,100}(?:regex|正则|范围|转义|reorder|反转)|(?:regex|正则|双反斜杠).{0,100}(?:RTL|Hebrew|Arabic|希伯来|阿拉伯)',
 'clustering':r'(?:bidi|RTL).{0,100}(?:grapheme|cluster|styleId|hyperlink|width|mirr|括号)',
}
def leaves(v,loc='$'):
 if isinstance(v,str): yield loc,v
 elif isinstance(v,list):
  for n,x in enumerate(v): yield from leaves(x,f'{loc}[{n}]')
 elif isinstance(v,dict):
  for k,x in v.items(): yield from leaves(x,f'{loc}.{k}')
compiled={k:re.compile(v,re.I) for k,v in PATTERNS.items()}
counts={k:0 for k in PATTERNS};hits={k:[] for k in PATTERNS}
scanned={'markdownFiles':0,'jsonFiles':0,'jsonStringLeaves':0}
errors=[];inventory=[]
for directory in [ROOT/'docs',ROOT/'bugs']:
 for path in sorted(directory.rglob('*')):
  if not path.is_file() or path.suffix not in ['.md','.json'] or 'audit-2026-10-17-round16' in path.parts: continue
  raw=path.read_bytes();relative=str(path.relative_to(ROOT));inventory.append({'path':relative,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
  try:
   body=raw.decode()
   if path.suffix=='.json':
    scanned['jsonFiles']+=1;units=list(leaves(json.loads(body)));scanned['jsonStringLeaves']+=len(units)
   else: scanned['markdownFiles']+=1;units=[('$',body)]
   for location,body in units:
    for key,pattern in compiled.items():
     for match in pattern.finditer(body):
      counts[key]+=1
      if len(hits[key])<80: hits[key].append({'file':relative,'location':location,'context':body[max(0,match.start()-140):match.end()+260]})
  except Exception as error: errors.append({'file':relative,'error':str(error)})
OUT.write_text(json.dumps({'frozenBase':BASE,'scope':'All prior docs/bugs Markdown and parsed JSON string leaves including archive/_archive; current batch excluded. File inventory hashes are metadata coverage, not semantic read coverage.','patterns':PATTERNS,'scanned':scanned,'parseErrors':errors,'matchCounts':counts,'maxContextsPerPattern':80,'hits':hits,'inventory':inventory},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'scanned':scanned,'errors':errors,'matchCounts':counts,'hits':hits},ensure_ascii=False))

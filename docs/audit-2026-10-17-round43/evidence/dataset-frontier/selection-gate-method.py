import json,hashlib,re,datetime,sys
from pathlib import Path
base=Path('/tmp/codeshell-audit-round46-core-data-frontier')
h=json.loads((base/'history.json').read_text());ps=json.loads((base/sys.argv[1]).read_text())['files']
patterns={r['path']:re.compile(re.escape(r['path'])+'|'+re.escape(Path(r['path']).stem)+r'\.(?:ts|tsx)|'+re.escape(r['sha256'])) for r in ps}
hits={k:[] for k in patterns};counts={k:0 for k in patterns};objs=[];drift=[]
def hit(txt,loc,p):
 for k,pat in patterns.items():
  if pat.search(txt):
   counts[k]+=1
   if len(hits[k])<80:hits[k].append({'path':p,'location':loc,'excerpt':txt[:2000]})
def visit(v,loc,p):
 if isinstance(v,dict):
  if any(str(v.get(z,'')) in patterns for z in ['path','file','source','sourcePath']):objs.append({'path':p,'location':loc,'object':v})
  for k,x in v.items():visit(x,loc+'['+json.dumps(k)+']',p)
 elif isinstance(v,list):
  for k,x in enumerate(v):visit(x,loc+'['+str(k)+']',p)
 else:hit(str(v),loc,p)
for row in h['inventory']:
 p=row['path'];b=Path(p).read_bytes()
 if hashlib.sha256(b).hexdigest()!=row['sha256']:drift.append(p)
 if p.endswith('.json'):visit(json.loads(b),'$',p)
 else:
  for n,s in enumerate(b.decode().splitlines(),1):hit(s,str(n),p)
o={'capturedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'inventorySha':h['inventoryCanonicalSha256'],'matchCounts':counts,'contextCap':80,'hits':hits,'directSourceObjects':objs,'drift':drift}
(base/sys.argv[2]).write_text(json.dumps(o,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'counts':counts,'objects':len(objs),'drift':drift}))

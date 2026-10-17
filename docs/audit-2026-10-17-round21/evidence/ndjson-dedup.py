from pathlib import Path
import json,re,hashlib
root=Path('.')
out=root/'docs/audit-2026-10-17-round21/evidence/ndjson-dedup.json'
patterns={"exact":re.compile(r"NdjsonReader|ndjson-reader(?:\.test)?\.ts|ndjson-reader\.js",re.I),"mechanism":re.compile(r"(?:ndjson|readline).{0,90}(?:malformed|handler|schema|validation|close|abort|lifecycle|类型|解析|校验|验证|关闭|空值)",re.I)}
files=[]; stats={"markdown":0,"json":0,"stringLeaves":0,"scalarLeaves":0}; errors=[]
matches={k:[] for k in patterns}; counts={k:0 for k in patterns}; capped={k:100 for k in patterns}
def walk(v,p='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from walk(x,p+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,p+'['+str(i)+']')
 else:yield p,v
for base in ['docs','bugs']:
 for p in sorted((root/base).rglob('*')):
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round21' in p.parts:continue
  raw=p.read_bytes(); files.append({"path":str(p),"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()})
  text=raw.decode('utf-8')
  if p.suffix.lower()=='.md':stats['markdown']+=1; rows=((str(i),x) for i,x in enumerate(text.splitlines(),1))
  else:
   stats['json']+=1
   try:tree=json.loads(text)
   except Exception as e:errors.append({"path":str(p),"error":str(e)});continue
   rows=[]
   for loc,value in walk(tree):
    stats['scalarLeaves']+=1
    if isinstance(value,str):stats['stringLeaves']+=1; rows.append((loc,value))
  for loc,t in rows:
   for name,pattern in patterns.items():
    for m in pattern.finditer(t):
     counts[name]+=1
     if len(matches[name])<capped[name]:matches[name].append({"path":str(p),"location":loc,"excerpt":t[max(0,m.start()-260):min(len(t),m.end()+780)],"wholeValueCharacters":len(t)})
result={"base":"615e4e4dd3a61b1ad132ab4f3683985a0d582386","roots":["docs","bugs"],"excluded":"docs/audit-2026-10-17-round21/**","inventory":files,"totals":{"files":len(files),**stats,"parseErrors":len(errors)},"parseErrors":errors,"patterns":{k:v.pattern for k,v in patterns.items()},"matchCounts":counts,"contextCaps":capped,"matches":matches,"limitations":["Keywords are navigation, not proof of semantic exhaustion.","Inventory is read-time frozen corpus, not promised unchanged final main.","String leaves counted separately from all scalar JSON values; only string values are searched; keys are not treated as values."]}
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({"totals":result['totals'],"matchCounts":counts,"savedContexts":{k:len(v) for k,v in matches.items()}},ensure_ascii=False))

from pathlib import Path
import json,re,hashlib
root=Path('.')
out=root/'docs/audit-2026-10-17-round23/evidence/product-cwd-dedup.json'
patterns={"factory":re.compile(r"createRunManager|CreateRunManagerOptions|core/src/run/factory\.ts",re.I),"cwd_loss":re.compile(r"(?:cwd|working directory|工作目录).{0,90}(?:unused|ignored|not (?:used|passed|forwarded)|未使用|未传|忽略)|(?:unused|ignored|not (?:used|passed|forwarded)|未使用|未传|忽略).{0,90}(?:cwd|working directory|工作目录)",re.I)}
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
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round23' in p.parts:continue
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
    if isinstance(value,str):stats['stringLeaves']+=1
    rows.append((loc,value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)))
  for loc,t in rows:
   for name,pattern in patterns.items():
    for m in pattern.finditer(t):
     counts[name]+=1
     if len(matches[name])<capped[name]:matches[name].append({"path":str(p),"location":loc,"excerpt":t[max(0,m.start()-260):min(len(t),m.end()+780)],"wholeValueCharacters":len(t)})
result={"base":"c1d007ed0af1eca9b56b32fabbb0ea2401037ee1","roots":["docs","bugs"],"excluded":"docs/audit-2026-10-17-round23/**","inventory":files,"totals":{"files":len(files),**stats,"parseErrors":len(errors)},"parseErrors":errors,"patterns":{k:v.pattern for k,v in patterns.items()},"matchCounts":counts,"contextCaps":capped,"matches":matches,"limitations":["Keywords are navigation, not proof of semantic exhaustion.","Inventory is read-time frozen corpus, not promised unchanged final main.","String leaves counted separately from all scalar JSON values; all scalar JSON values are searched as text; keys are not treated as values."]}
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({"totals":result['totals'],"matchCounts":counts,"savedContexts":{k:len(v) for k,v in matches.items()}},ensure_ascii=False))

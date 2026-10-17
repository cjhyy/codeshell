from pathlib import Path
import json,re,hashlib
root=Path(".")
base="70d2e3846ea48d0d797e51dbeac7026f563c76bb"
patterns={"exact":re.compile(r"output-clean(?:\.test)?\.ts|foldProgressLines|cleanOutput|session-memory-sort|sortSessionMemoriesByRecency|sessionMessageOutcome|session-message-result|formatResetTime|formatResetText",re.I),"newlineMechanism":re.compile(r"(?:CRLF|\\r\\n|carriage.return|progress.{0,10}redraw|foldProgress|输出清理|回车).{0,140}(?:drop|empty|strip|fold|line|lose|missing|丢|空|删|清理)|(?:BashOutput|output.clean).{0,130}(?:CRLF|carriage|newline|\\r|换行|回车)",re.I)}
files=[]; stats={"markdown":0,"json":0,"stringLeaves":0,"scalarLeaves":0}; errors=[]
matches={k:[] for k in patterns};counts={k:0 for k in patterns};caps={"exact":300,"newlineMechanism":200}
def walk(v,p="$"):
 if isinstance(v,dict):
  for k,x in v.items():yield from walk(x,p+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,p+"["+str(i)+"]")
 else:yield p,v
for dirname in ["docs","bugs"]:
 for p in sorted((root/dirname).rglob("*")):
  if not p.is_file() or p.suffix.lower() not in [".md",".json"] or "audit-2026-10-17-round25" in p.parts:continue
  raw=p.read_bytes();files.append({"path":str(p),"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()})
  text=raw.decode("utf-8")
  if p.suffix.lower()==".md":
   stats["markdown"]+=1;rows=[(str(i),x) for i,x in enumerate(text.splitlines(),1)]
  else:
   stats["json"]+=1
   try:tree=json.loads(text)
   except Exception as e:errors.append({"path":str(p),"error":str(e)});continue
   rows=[]
   for loc,v in walk(tree):
    stats["scalarLeaves"]+=1
    if isinstance(v,str):stats["stringLeaves"]+=1;t=v
    else:t=json.dumps(v,ensure_ascii=False)
    rows.append((loc,t))
  for loc,t in rows:
   for name,pattern in patterns.items():
    for m in pattern.finditer(t):
     counts[name]+=1
     if len(matches[name])<caps[name]:matches[name].append({"path":str(p),"location":loc,"excerpt":t[max(0,m.start()-180):min(len(t),m.end()+600)],"wholeValueCharacters":len(t)})
result={"base":base,"roots":["docs","bugs"],"excluded":"docs/audit-2026-10-17-round25/**","inventory":files,"totals":{"files":len(files),**stats,"parseErrors":len(errors)},"parseErrors":errors,"patterns":{k:v.pattern for k,v in patterns.items()},"matchCounts":counts,"contextCaps":caps,"matches":matches,"limitations":["Keywords navigate history; they do not establish semantic exhaustion.","Inventory is frozen at read time; current batch excluded, archives included recursively.","JSON keys are not scalar values. String leaves and all scalar leaves are counted separately; every scalar is searched through its string or JSON spelling."]}
Path("/tmp/codeshell-audit-round25-pure-data-frontier/history.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"totals":result["totals"],"matchCounts":counts,"savedContexts":{k:len(v) for k,v in matches.items()}},ensure_ascii=False))

from pathlib import Path
import json,re,hashlib
root=Path(".")
base="ab258c3f534b19014b2ed85da3111649f166ab86"
patterns={"exact":re.compile(r"checkTokenBudget|createBudgetTracker|crossedReactiveThreshold|token-budget\.ts|reactive-threshold",re.I),"budgetMechanism":re.compile(r"(?:budget|预算|continuationCount|diminishing).{0,100}(?:nudge|90%|0\.9|wrap|diminish|continuation|stop|阈值|终止|计数|递减)|(?:nudge|diminish|continuationCount).{0,100}(?:budget|预算|stop|>= ?3)",re.I),"reactiveMechanism":re.compile(r"(?:reactive|反应式|streamingResponseTokens).{0,100}(?:bucket|2000|probe|threshold|compac|warning)|(?:2000|2,000).{0,100}(?:token|bucket|probe|compac)",re.I)}
files=[]; stats={"markdown":0,"json":0,"stringLeaves":0,"scalarLeaves":0}; errors=[]
matches={k:[] for k in patterns};counts={k:0 for k in patterns};caps={"exact":500,"budgetMechanism":120,"reactiveMechanism":120}
def walk(v,p="$"):
 if isinstance(v,dict):
  for k,x in v.items():yield from walk(x,p+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,p+"["+str(i)+"]")
 else:yield p,v
for dirname in ["docs","bugs"]:
 for p in sorted((root/dirname).rglob("*")):
  if not p.is_file() or p.suffix.lower() not in [".md",".json"] or "audit-2026-10-17-round22" in p.parts:continue
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
result={"base":base,"roots":["docs","bugs"],"excluded":"docs/audit-2026-10-17-round22/**","inventory":files,"totals":{"files":len(files),**stats,"parseErrors":len(errors)},"parseErrors":errors,"patterns":{k:v.pattern for k,v in patterns.items()},"matchCounts":counts,"contextCaps":caps,"matches":matches,"limitations":["Keywords navigate history; they do not establish semantic exhaustion.","Inventory is frozen at read time; current batch excluded, archives included recursively.","JSON keys are not scalar values. String leaves and all scalar leaves are counted separately; every scalar is searched through its string or JSON spelling."]}
Path("docs/audit-2026-10-17-round22/evidence/budget-dedup.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"totals":result["totals"],"matchCounts":counts,"savedContexts":{k:len(v) for k,v in matches.items()}},ensure_ascii=False))

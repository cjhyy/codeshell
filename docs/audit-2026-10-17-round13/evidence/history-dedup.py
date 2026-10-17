from pathlib import Path
import json,re
roots=[Path("docs"),Path("bugs")]
files=sorted(p for r in roots if r.exists() for p in r.rglob("*") if p.is_file() and p.suffix in (".md",".json") and "audit-2026-10-17-round13" not in p.parts)
patterns={"history":r"input-history|removeLastFromHistory|clearPendingHistoryEntries|createHistoryNavigator|getProjectHistory|_flushScheduled|_skippedTimestamps", "model-display":r"model-display|modelTags|fmtTokens", "history-semantics":r"input.{0,30}history|command.{0,30}history|history.{0,30}(?:queue|current.session|navigator|pending|priority|nextTick)|(?:输入|命令).{0,10}历史|(?:current.session|nextTick).{0,40}histor|_pendingEntries|_lastAddedEntry"}
counts={"md":0,"json":0,"json_leaves":0}; errors=[]; hits=[]
def leaves(v,ptr=""):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,ptr+"/"+str(k))
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,ptr+"/"+str(i))
 else:yield ptr,str(v)
for p in files:
 if p.suffix==".md":
  counts["md"]+=1;units=[(str(i),line) for i,line in enumerate(p.read_text().splitlines(),1)]
 else:
  counts["json"]+=1
  try:units=list(leaves(json.loads(p.read_text())));counts["json_leaves"]+=len(units)
  except Exception as e:errors.append({"path":str(p),"error":str(e)});continue
 for key,regex in patterns.items():
  selected=[{"location":loc,"text":s[:1600]} for loc,s in units if re.search(regex,s,re.I)]
  if selected:hits.append({"path":str(p),"topic":key,"matches":selected})
result={"scope":"All .md/.json recursively under docs and bugs, including archive/_archive; current round13 excluded; JSON parsed into recursive scalar leaves", "counts":counts,"files":len(files),"parse_errors":errors,"patterns":patterns,"hits":hits}
Path("docs/audit-2026-10-17-round13/evidence/history-dedup.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"counts":counts,"files":len(files),"errors":len(errors),"hit_files":len(hits)}))
for h in hits:
 if not any(k in h["path"] for k in ("evidence-index","source-manifest","source-pins","sources.json","validation.json","dedup")):
  print(h["path"],h["topic"])
  for m in h["matches"][:10]:print(m["location"],m["text"][:500])

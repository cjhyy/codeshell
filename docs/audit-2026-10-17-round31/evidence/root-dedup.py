from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell");out=Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round31/evidence")
patterns={
 "search-leaf":r"searchMatches|searchHighlight|findRowSearchMatches|scanPositions",
 "greek-case":r"(?:sigma|Σ|ς|Greek|希腊).{0,100}(?:case|search|搜索|lower|大小写)|(?:case|search|搜索|lower).{0,100}(?:sigma|Σ|ς|Greek|希腊)",
 "case-map":r"(?:search|highlight|搜索|高亮).{0,100}(?:lowercas|codeUnitToCell|İ|grapheme|大小写)|(?:lowercas|codeUnitToCell|İ).{0,100}(?:search|highlight|搜索|高亮)",
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};inventory=[];errors=[];stats=dict(markdown=0,json=0,stringLeaves=0,scalarLeaves=0,archivePaths=0)
def leaves(v,at="$"):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,at+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,at+"["+str(i)+"]")
 else:yield at,v
for dirname in ["docs","bugs"]:
 for p in sorted((root/dirname).rglob("*")):
  if not p.is_file() or p.suffix not in [".md",".json"] or "audit-2026-10-17-round31" in p.parts:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));inventory.append(dict(path=rel,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()));stats["archivePaths"]+=any(x in ["archive","_archive"] for x in p.parts)
  try:
   if p.suffix==".md":stats["markdown"]+=1;rows=[(str(i),s) for i,s in enumerate(raw.decode().splitlines(),1)]
   else:
    stats["json"]+=1;vals=list(leaves(json.loads(raw)));stats["scalarLeaves"]+=len(vals);stats["stringLeaves"]+=sum(isinstance(v,str) for _,v in vals);rows=[(at,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)) for at,v in vals]
   for at,s in rows:
    for k,pat in compiled.items():
     for m in pat.finditer(s):
      counts[k]+=1
      if len(hits[k])<100:hits[k].append(dict(path=rel,location=at,excerpt=s[max(0,m.start()-140):min(len(s),m.end()+550)]))
  except Exception as error:errors.append(dict(path=rel,error=str(error)))
r=dict(readAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),parentReportedBaseline="4dad999bd43b776995b5d212dde275dab86a1ddd",gitCommands=0,productExecution=False,roots=["docs","bugs"],excluded=["docs/audit-2026-10-17-round31/**"],totals=dict(files=len(inventory),**stats,parseErrors=len(errors)),parseErrors=errors,patterns=patterns,matchCounts=counts,contextCap=100,retainedContextCounts={k:len(v) for k,v in hits.items()},hits=hits,inventory=inventory,limits=["Formal metadata snapshot includes frozen30, excludes current31. No additional product semantic read.","Prior JSON values recursively searched; keys excluded; archive/_archive included. Keyword and capped context navigation is not semantic exhaustion.","No product import/test/function/VM/AST/eval, SDK/barrel/native/real task/network/model/HOME/auth/identity operation."])
(out/"root-dedup.json").write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(dict(totals=r["totals"],matches=counts,retained=r["retainedContextCounts"]),ensure_ascii=False))

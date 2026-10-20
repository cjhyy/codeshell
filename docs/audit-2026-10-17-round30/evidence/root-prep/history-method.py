from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell");out=Path("/tmp/codeshell-audit-round30-root-frontier")
patterns={
 "intl-format":r"utils/intl|formatResetTime|formatResetText|formatRelativeTime|formatLogMetadata|getRelativeTimeFormat|getSystemLocaleLanguage",
 "display-option":r"(?:showTime|showTimezone|numeric|style).{0,100}(?:ignored|未生效|忽略|formatReset|formatRelative)|(?:formatReset|formatRelative).{0,100}(?:short|showTime|flag|option|参数)",
 "old-failed":r"(?:earlyInput|i18n|getLanguage).{0,100}(?:fail|失败|skip|跳过)",
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
  if not p.is_file() or p.suffix not in [".md",".json"] or any(x in p.parts for x in ["audit-2026-10-17-round29", "audit-2026-10-17-round30"]):continue
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
r=dict(readAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),parentReportedBaseline="b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0",gitCommands=0,productExecution=False,roots=["docs","bugs"],excluded=["docs/audit-2026-10-17-round29/**","docs/audit-2026-10-17-round30/**"],totals=dict(files=len(inventory),**stats,parseErrors=len(errors)),parseErrors=errors,patterns=patterns,matchCounts=counts,contextCap=100,retainedContextCounts={k:len(v) for k,v in hits.items()},hits=hits,inventory=inventory,limits=["Prep metadata snapshot includes frozen Round28 and excludes mutable Round29/30. It adds no product semantic reads.","Prior JSON values recursively searched; keys excluded; archive/_archive included. Keyword and capped context navigation is not semantic exhaustion.","No product import/test/function/VM/AST/eval, SDK/barrel/native/real task/network/model/HOME/auth/identity operation."])
(out/"history.json").write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(dict(totals=r["totals"],matches=counts,retained=r["retainedContextCounts"]),ensure_ascii=False))

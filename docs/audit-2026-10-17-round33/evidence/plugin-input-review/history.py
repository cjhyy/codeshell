"""Read-only prior-docs/bugs value scalar metadata scan; no product execution."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
ROOT=Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell")
OUT=Path("/tmp/codeshell-audit-round33-plugin-input-review/history.json")
PATTERNS={"plugin-input":r"parseMarketplaceInput|deriveMarketplaceName|githubRepoToCloneUrl|plugins/installer/parseSource|parseNpmPluginSource", "github-suffix":r"(?:github|GitHub|marketplace|插件市场).{0,100}(?:trailing|slash|query|fragment|suffix|尾斜|查询串|\.git|末尾)|(?:append|拼接|追加|trimmed).{0,80}\.git", "source-normalization":r"(?:plugin|插件|marketplace).{0,100}(?:URL|url|source|输入).{0,100}(?:normaliz|规范|trailing|ref|unsafe|git)|unsafeTransport|lowerUrlScheme"}
patterns={k:re.compile(v,re.I) for k,v in PATTERNS.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};CAP=100
stats=dict(markdownFiles=0,jsonFiles=0,stringLeaves=0,scalarLeaves=0);inventory=[];errors=[]
def leaves(v,at="$"):
 if isinstance(v,dict):
  for k,c in v.items():yield from leaves(c,at+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from leaves(c,at+"["+str(i)+"]")
 else:
  stats["scalarLeaves"]+=1
  if isinstance(v,str):stats["stringLeaves"]+=1
  yield at,v if isinstance(v,str) else json.dumps(v)
for p in sorted(p for root in [ROOT/"docs",ROOT/"bugs"] for p in root.rglob("*") if p.is_file() and p.suffix.lower() in [".md",".json"] and not p.relative_to(ROOT).as_posix().startswith(("docs/audit-2026-10-17-round32/","docs/audit-2026-10-17-round33/"))):
 raw=p.read_bytes();name=p.relative_to(ROOT).as_posix();inventory.append(dict(path=name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
 try:
  if p.suffix.lower()==".md":stats["markdownFiles"]+=1;units=[("$",raw.decode())]
  else:stats["jsonFiles"]+=1;units=list(leaves(json.loads(raw)))
  for at,text in units:
   for key,pattern in patterns.items():
    for match in pattern.finditer(text):
     counts[key]+=1
     if len(hits[key])<CAP:hits[key].append(dict(path=name,at=at,context=text[max(0,match.start()-180):match.end()+650]))
 except Exception as error:errors.append(dict(path=name,error=str(error)))
dictout=dict(parentReportedContext="4be4016b8661c6a10c60f4eb0f218552b4b7c5d0",formalRound33Baseline=None,completedUtc=datetime.now(timezone.utc).isoformat(),excluded=["current Round32","future Round33"],roots=["docs","bugs"],archivesIncluded=True,inventory=inventory,stats=stats,patterns=PATTERNS,occurrenceCounts=counts,contextCapEach=CAP,hits=hits,parseErrors=errors,productAttempts=0,gitCommands=0,limitations=["JSON value scalars searched, not keys. Whole Markdown searched. Regex/bytes do not prove semantic exhaustion.","Dated independent Round33 plugin-input prep includes frozen31, excludes mutable32/future33; no formal33 baseline claimed."])
OUT.write_text(json.dumps(dictout,ensure_ascii=False,indent=2)+"\n");print(json.dumps(dict(files=len(inventory),stats=stats,occurrenceCounts=counts,savedContexts={k:len(v) for k,v in hits.items()},parseErrors=len(errors),productAttempts=0)))

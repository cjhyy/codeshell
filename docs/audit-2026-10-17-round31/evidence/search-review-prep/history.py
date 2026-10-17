"""Read-only prior-docs/bugs value scalar metadata scan; no product execution."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
ROOT=Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell")
OUT=Path("/tmp/codeshell-audit-round31-search-review/history.json")
PATTERNS={"search-helpers":r"findRowSearchMatches|searchMatches\.ts|searchHighlight\.ts|scanPositions|applySearchHighlight", "contextual-casing":r"final[_ -]?sigma|Σ|σ|ς|sigma|(?:case|大小写).{0,80}(?:fold|lower|search|搜)|(?:lowercas|toLowerCase).{0,100}(?:grapheme|cell|上下文)","search-case-contract":r"(?:TUI|search|搜索|highlight).{0,100}(?:case.insensitive|大小写|lowercas|case.fold|Unicode|unicode)"}
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
for p in sorted(p for root in [ROOT/"docs",ROOT/"bugs"] for p in root.rglob("*") if p.is_file() and p.suffix.lower() in [".md",".json"] and not p.relative_to(ROOT).as_posix().startswith(("docs/audit-2026-10-17-round30/","docs/audit-2026-10-17-round31/"))):
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
dictout=dict(parentReportedContext="19efab9225723c76af447f8b9d9f65aace3b0780",formalRound31Baseline=None,completedUtc=datetime.now(timezone.utc).isoformat(),excluded=["current Round30","future Round31"],roots=["docs","bugs"],archivesIncluded=True,inventory=inventory,stats=stats,patterns=PATTERNS,occurrenceCounts=counts,contextCapEach=CAP,hits=hits,parseErrors=errors,productAttempts=0,gitCommands=0,limitations=["JSON value scalars searched, not keys. Whole Markdown searched. Regex/bytes do not prove semantic exhaustion.","Dated independent Round31 prep history includes frozen Round29, excludes mutable current Round30 and future Round31; no formal31 baseline claimed."])
OUT.write_text(json.dumps(dictout,ensure_ascii=False,indent=2)+"\n");print(json.dumps(dict(files=len(inventory),stats=stats,occurrenceCounts=counts,savedContexts={k:len(v) for k,v in hits.items()},parseErrors=len(errors),productAttempts=0)))

"""Read-only prior-docs/bugs value scalar metadata scan; no product execution."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
ROOT=Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell")
OUT=ROOT/"docs/audit-2026-10-17-round30/evidence/data-history.json"
PATTERNS={"parse-log":r"parseGitLog|parse-log\.ts|%H\|%s\|%an\|%ci", "pipe-contract":r"(?:git|commit|提交).{0,100}(?:pipe|delimiter|分隔|竖线|\|).{0,100}(?:log|subject|author|message|日志|作者|标题)|(?:parseGitLog|parse-log).{0,100}(?:bug|缺陷|split|pipe|字段)","channel-contract":r"channelCapabilities|supportsOutgoingAttachment|isWebhookChannelAdapter|BUILTIN_CHANNEL_CAPABILITIES"}
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
for p in sorted(p for root in [ROOT/"docs",ROOT/"bugs"] for p in root.rglob("*") if p.is_file() and p.suffix.lower() in [".md",".json"] and not p.relative_to(ROOT).as_posix().startswith("docs/audit-2026-10-17-round30/")):
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
dictout=dict(formalBaselineReportedByRoot="19efab9225723c76af447f8b9d9f65aace3b0780",preservedPrepParent="b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0",completedUtc=datetime.now(timezone.utc).isoformat(),excluded=["current Round30"],roots=["docs","bugs"],archivesIncluded=True,inventory=inventory,stats=stats,patterns=PATTERNS,occurrenceCounts=counts,contextCapEach=CAP,hits=hits,parseErrors=errors,productAttempts=0,gitCommands=0,limitations=["JSON value scalars searched, not keys. Whole Markdown searched. Regex/bytes do not prove semantic exhaustion.","Formal dated Round30 history snapshot includes frozen Round29 and excludes current Round30. Separate prep history keeps its original parent/time/exclusions."])
OUT.write_text(json.dumps(dictout,ensure_ascii=False,indent=2)+"\n");print(json.dumps(dict(files=len(inventory),stats=stats,occurrenceCounts=counts,savedContexts={k:len(v) for k,v in hits.items()},parseErrors=len(errors),productAttempts=0)))

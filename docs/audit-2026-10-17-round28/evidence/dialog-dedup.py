"""Read-only history value-scalar scan; no product imports or execution."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/"docs/audit-2026-10-17-round28/evidence/dialog-dedup.json"
EXCLUDE="docs/audit-2026-10-17-round28/"
PATTERNS={
 "exact-source":r"dialogState|DialogProvider|DialogController|dialog-state",
 "dialog-contract":r"(?:dialog|modal|对话框|确认框).{0,110}(?:queue|FIFO|promise|resolv|cancel|close|unmount|排队|取消|关闭|卸载)|(?:queue|FIFO|resolv|unmount).{0,100}(?:dialog|modal|对话框)",
 "producer":r"useDialog|confirmDialog|promptDialog|showDialog|ConfirmDialogOptions|ProfileRequirements",
}
patterns={k:re.compile(v,re.I) for k,v in PATTERNS.items()};counts=dict.fromkeys(patterns,0);contexts={k:[] for k in patterns};CAP=100
inventory=[];stats=dict(markdownFiles=0,jsonFiles=0,stringLeaves=0,scalarLeaves=0);errors=[]
def values(v,at="$"):
 if isinstance(v,dict):
  for k,c in v.items():yield from values(c,at+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from values(c,at+"["+str(i)+"]")
 else:
  stats["scalarLeaves"]+=1
  if isinstance(v,str):stats["stringLeaves"]+=1
  yield at,v if isinstance(v,str) else json.dumps(v)
for p in sorted(p for root in [ROOT/"docs",ROOT/"bugs"] for p in root.rglob("*") if p.is_file() and p.suffix.lower() in [".md",".json"] and not p.relative_to(ROOT).as_posix().startswith(EXCLUDE)):
 b=p.read_bytes();name=p.relative_to(ROOT).as_posix();inventory.append(dict(path=name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
 try:
  if p.suffix.lower()==".md":stats["markdownFiles"]+=1;units=[("$",b.decode())]
  else:stats["jsonFiles"]+=1;units=list(values(json.loads(b)))
  for at,text in units:
   for key,pat in patterns.items():
    matches=list(pat.finditer(text));counts[key]+=len(matches)
    for match in matches:
     if len(contexts[key])>=CAP:break
     contexts[key].append(dict(path=name,at=at,context=text[max(0,match.start()-160):match.end()+600],unitCharacters=len(text)))
 except Exception as error:errors.append(dict(path=name,error=str(error)))
result=dict(baselineProvidedByRoot="32c633e58c20b3853f49bb0e43264b4577281eac",completedUtc=datetime.now(timezone.utc).isoformat(),roots=["docs","bugs"],excluded=EXCLUDE,archivesIncluded=True,inventory=inventory,stats=stats,parseErrors=errors,patterns=PATTERNS,occurrenceCounts=counts,contextCapEach=CAP,contexts=contexts,exactArchiveDirectoryPaths=sum(any(part in ["archive","_archive"] for part in Path(row["path"]).parts) for row in inventory),substringArchivePaths=sum("archive" in row["path"].lower() for row in inventory),productAttempts=0,gitCommands=0,limitations=["JSON scalar values searched, not dictionary keys. MD whole text searched. Regex occurrences and capped contexts are distinct.","File SHA/inventory and keyword navigation are not full semantic history reading or novelty proof.","Current28 excluded; archives retained. No product imports/tests/fixtures/VM/Git/network executed."])
OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(dict(files=len(inventory),stats=stats,occurrenceCounts=counts,savedContexts={k:len(v) for k,v in contexts.items()},parseErrors=len(errors),productAttempts=0)))

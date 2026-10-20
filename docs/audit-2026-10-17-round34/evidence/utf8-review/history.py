"""Fresh dated metadata scan for semver frontier. No product imports/execution."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,re
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round34-utf8-review/history.json')
PATTERNS={"utf8-cut":r"utf8SafeCutLength|utf8-cut\.ts|utf8-cut\.test", "stream-utf8":r"(?:background.shell|ring.?file|readOutput|BashOutput).{0,150}(?:utf.?8|multibyte|多字节|replacement|StringDecoder|surrogat|astral|字符边界|16.?KB)|(?:UTF.?8|StringDecoder|surrogat).{0,150}(?:shell|Ring|readOutput|BashOutput)", "byte-boundary":r"(?:incomplete|partial|split|chunk|chunking|boundary|截断|分块|分段|半个).{0,100}(?:UTF.?8|unicode|多字节|码点|Buffer)|(?:UTF.?8|surrogat).{0,120}(?:cursor|offset|slice|切|分页|分块|read|readOutput)"}
patterns={k:re.compile(v,re.I) for k,v in PATTERNS.items()};cap=100;counts={k:0 for k in patterns};hits={k:[] for k in patterns};stats={"markdownFiles":0,"jsonFiles":0,"stringLeaves":0,"scalarLeaves":0};inventory=[];errors=[]
started=datetime.now(timezone.utc).isoformat()
def vals(value,at='$'):
 if isinstance(value,dict):
  for key,child in value.items():yield from vals(child,at+'['+json.dumps(key,ensure_ascii=False)+']')
 elif isinstance(value,list):
  for idx,child in enumerate(value):yield from vals(child,at+'['+str(idx)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(value,str):stats['stringLeaves']+=1
  yield at,value if isinstance(value,str) else json.dumps(value)
paths=sorted(p for folder in ['docs','bugs'] for p in (ROOT/folder).rglob('*') if p.is_file() and p.suffix.lower() in ['.md','.json'] and not p.relative_to(ROOT).as_posix().startswith(('docs/audit-2026-10-17-round33/','docs/audit-2026-10-17-round34/')))
for p in paths:
 b=p.read_bytes();rel=p.relative_to(ROOT).as_posix();inventory.append({"path":rel,"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest(),"readAtUTC":datetime.now(timezone.utc).isoformat()})
 try:
  if p.suffix.lower()=='.md':stats['markdownFiles']+=1;units=[('$',b.decode())]
  else:stats['jsonFiles']+=1;units=vals(json.loads(b))
  for at,text in units:
   for key,pattern in patterns.items():
    for match in pattern.finditer(text):
     counts[key]+=1
     if len(hits[key])<cap:hits[key].append({"path":rel,"at":at,"context":text[max(0,match.start()-180):match.end()+650]})
 except Exception as error:errors.append({"path":rel,"error":str(error)})
d={"parentReportedContext":"Frozen Round32 reported by Root as short646f; full SHA not independently inspected.","formalRound34Baseline":None,"startedUTC":started,"completedUTC":datetime.now(timezone.utc).isoformat(),"roots":["docs","bugs"],"excluded":["mutable Round33","future Round34"],"archivesIncluded":True,"includesFrozenRound32":True,"freshScan":True,"reusedPriorScanResults":False,"stats":stats,"inventory":inventory,"patterns":PATTERNS,"occurrenceCounts":counts,"contextCapEach":cap,"hits":hits,"parseErrors":errors,"limits":["Fresh file bytes and recursive JSON value scalars; not keys. Whole Markdown. Keyword/capped excerpts do not establish semantic exhaustion.","Dated per-file metadata reads are not an atomic repository snapshot. End-byte checks separately record potential release-document/source drift without replacing original rows.","No semver, updater, CLI, npm, network, native, language fixture or product test executed."],"productAttempts":0,"gitCommands":0}
OUT.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({"files":len(inventory),"stats":stats,"occurrenceCounts":counts,"retainedCounts":{k:len(v) for k,v in hits.items()},"parseErrors":len(errors)}))

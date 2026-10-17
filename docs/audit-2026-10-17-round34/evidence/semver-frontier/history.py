"""Fresh dated metadata scan for semver frontier. No product imports/execution."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,re
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round34-semver-frontier/history.json')
PATTERNS={"semver-wrapper":r"utils/semver|semverGte|semverGt|semverLt|isProgressReportingAvailable|gt\(latestVersion", "version-comparison":r"(?:semver|version|版本).{0,100}(?:prerelease|pre.release|排序|compare|comparison|gte|\bgt\b|\blt\b|大小|更新)", "updater-contract":r"(?:getLatestVersion|getCurrentVersion|TERM_PROGRAM_VERSION|auto.?updat|自动更新).{0,100}(?:semver|invalid|fallback|版本|version|pre.release)|semver.{0,100}(?:throw|fallback|coerce|无效)"}
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
paths=sorted(p for folder in ['docs','bugs'] for p in (ROOT/folder).rglob('*') if p.is_file() and p.suffix.lower() in ['.md','.json'] and not p.relative_to(ROOT).as_posix().startswith(('docs/audit-2026-10-17-round32/','docs/audit-2026-10-17-round33/','docs/audit-2026-10-17-round34/')))
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
d={"parentReportedContext":"4be4016b8661c6a10c60f4eb0f218552b4b7c5d0","formalRound34Baseline":None,"startedUTC":started,"completedUTC":datetime.now(timezone.utc).isoformat(),"roots":["docs","bugs"],"excluded":["mutable Round32","mutable Round33","future Round34"],"archivesIncluded":True,"freshScan":True,"reusedPriorScanResults":False,"stats":stats,"inventory":inventory,"patterns":PATTERNS,"occurrenceCounts":counts,"contextCapEach":cap,"hits":hits,"parseErrors":errors,"limits":["Fresh file bytes and recursive JSON value scalars; not keys. Whole Markdown. Keyword/capped excerpts do not establish semantic exhaustion.","Dated per-file metadata reads are not an atomic repository snapshot. End-byte checks separately record potential release-document/source drift without replacing original rows.","No semver, updater, CLI, npm, network, native, language fixture or product test executed."],"productAttempts":0,"gitCommands":0}
OUT.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({"files":len(inventory),"stats":stats,"occurrenceCounts":counts,"retainedCounts":{k:len(v) for k,v in hits.items()},"parseErrors":len(errors)}))

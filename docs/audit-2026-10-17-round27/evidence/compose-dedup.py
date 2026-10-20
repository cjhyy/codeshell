"""Read-only docs/bugs Markdown + recursive JSON value-scalar navigation; no product execution."""
from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path(__file__).resolve().parents[3]
out=Path(__file__).with_suffix(".json")
patterns={
 "compose-leaf":r"composeFileEdits(?:\.test)?\.ts|composeFileEdits|syntheticSnippetDiff|uniqueIndex\(edit\.oldText",
 "aggregation-snapshot":r"fileChangeAggregator(?:\.test)?\.ts|aggregateFileChangeSummary|groupReviewSnapshot|reviewSnapshot\.ts",
 "outer-proof":r"outerIndex|proven adjacent|known after|uniquely encloses|surrounding text|(?:snippet|片段).{0,100}(?:different location|distinct location|位置错误|错误位置)|(?:fileChangeAggregator|composeFileEdits).{0,150}(?:unrelated|different|合并|连续)",
 "old-boundaries":r"GROUPS-R13-C[12]|GROUPS-R13-R1|DESKTOP-R12-R1|countLines\(\) counts trailing|R59.{0,50}首提交|R2-0[89]|R2-1[01]",
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};byfile={k:collections.Counter() for k in patterns}
files=[];errors=[];stats=dict(markdown=0,json=0,stringLeaves=0,scalarLeaves=0,archivePaths=0)
def leaves(v,at="$"):
 if isinstance(v,dict):
  for k,c in v.items():yield from leaves(c,at+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from leaves(c,at+"["+str(i)+"]")
 else:yield at,v
for d in ["docs","bugs"]:
 for p in sorted((root/d).rglob("*")):
  if not p.is_file() or p.suffix not in [".md",".json"] or "audit-2026-10-17-round27" in p.parts:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));files.append(dict(path=rel,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()));stats["archivePaths"]+=any(x in ["archive","_archive"] for x in p.parts)
  try:
   if p.suffix==".md":stats["markdown"]+=1;rows=[(str(i),s) for i,s in enumerate(raw.decode().splitlines(),1)]
   else:
    stats["json"]+=1;values=list(leaves(json.loads(raw)));stats["scalarLeaves"]+=len(values);stats["stringLeaves"]+=sum(isinstance(v,str) for _,v in values);rows=[(at,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)) for at,v in values]
   for at,s in rows:
    for k,pat in compiled.items():
     for m in pat.finditer(s):
      counts[k]+=1;byfile[k][rel]+=1
      if len(hits[k])<160:hits[k].append(dict(path=rel,at=at,context=s[max(0,m.start()-140):min(len(s),m.end()+550)],wholeValueCharacters=len(s)))
  except Exception as e:errors.append(dict(path=rel,error=str(e)))
prior=json.loads((Path(__file__).parent/"compose-prep/history-supplement.json").read_text());old={r["path"]:r["sha256"] for r in prior["inventory"]};new={r["path"]:r["sha256"] for r in files}
r=dict(readAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),parentReportedBaseline="9b667863e8a8eb91db7b1f99eb9876169dcf19ec",gitCommandsExecuted=0,independentGitBlobVerification=False,roots=["docs","bugs"],excluded=["docs/audit-2026-10-17-round27/**"],totals=dict(files=len(files),**stats,parseErrors=len(errors)),parseErrors=errors,patterns=patterns,matchCounts=counts,contextCap=160,retainedContextCounts={k:len(v) for k,v in hits.items()},hits=hits,matchesByFile={k:dict(v) for k,v in byfile.items()},inventory=files,driftFromCopiedSupplement=dict(addedPaths=sorted(set(new)-set(old)),missingPaths=sorted(set(old)-set(new)),changedPaths=sorted(k for k in set(new)&set(old) if new[k]!=old[k])),limits=["Archives recursively included; JSON values, never keys, searched.","Name/keyword matches navigate to records; they do not prove semantic absence or complete repository review.","This collector reads metadata text only; no product imports/tests/fixtures/functions, Git, VM/native/UI/network execution."])
out.write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({k:r[k] for k in ["totals","matchCounts","retainedContextCounts","driftFromCopiedSupplement"]},ensure_ascii=False))

"""Filesystem prior docs/bugs MD and JSON value-scalar navigation only; zero product execution."""
from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path(__file__).resolve().parents[3]
out=Path(__file__).with_suffix(".json")
patterns={
 "leaf-and-consumer":r"splitStreamingMarkdown|splitIntoChunks|StreamingMarkdownBody|StreamMarkdownChunk",
 "blank-fence-chunks":r"(?:空行|blank.line).{0,120}(?:代码块|code.block|fenc|chunk)|(?:代码块|code.block|fenc).{0,120}(?:chunk|按.{0,5}空行|split.{0,20}blank)",
 "code-chunk-bug":r"(?:splitIntoChunks|StreamMarkdownChunk|streaming.?markdown|流式.{0,5}Markdown).{0,160}(?:错|缺陷|丢|破坏|bug|incorrect|broken|内部分割)|(?:fence|代码块).{0,100}(?:内部空行|inside.{0,25}blank|分成.{0,10}(?:chunk|块)|chunk.{0,30}(?:切|分))",
 "old-parser-boundary":r"parseDocument.{0,130}(?:fail|失败|skip|跳过)|(?:fail|失败|skip|跳过).{0,130}parseDocument",
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};byfile={k:collections.Counter() for k in patterns};files=[];errors=[];stats=dict(markdown=0,json=0,stringLeaves=0,scalarLeaves=0,archivePaths=0)
def leaves(v,at="$"):
 if isinstance(v,dict):
  for k,c in v.items():yield from leaves(c,at+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from leaves(c,at+"["+str(i)+"]")
 else:yield at,v
for dirname in ["docs","bugs"]:
 for p in sorted((root/dirname).rglob("*")):
  if not p.is_file() or p.suffix not in [".md",".json"] or "audit-2026-10-17-round28" in p.parts:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));files.append(dict(path=rel,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()));stats["archivePaths"]+=any(x in ["archive","_archive"] for x in p.parts)
  try:
   if p.suffix==".md":stats["markdown"]+=1;rows=[(str(i),s) for i,s in enumerate(raw.decode().splitlines(),1)]
   else:
    stats["json"]+=1;vals=list(leaves(json.loads(raw)));stats["scalarLeaves"]+=len(vals);stats["stringLeaves"]+=sum(isinstance(v,str) for _,v in vals);rows=[(at,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)) for at,v in vals]
   for at,s in rows:
    for k,pat in compiled.items():
     for m in pat.finditer(s):
      counts[k]+=1;byfile[k][rel]+=1
      if len(hits[k])<120:hits[k].append(dict(path=rel,location=at,excerpt=s[max(0,m.start()-140):min(len(s),m.end()+650)]))
  except Exception as err:errors.append(dict(path=rel,error=str(err)))
record=dict(readAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),parentReportedBaseline="32c633e58c20b3853f49bb0e43264b4577281eac",gitCommands=0,productExecution=False,roots=["docs","bugs"],excluded=["docs/audit-2026-10-17-round28/**"],totals=dict(files=len(files),**stats,parseErrors=len(errors)),parseErrors=errors,patterns=patterns,matchCounts=counts,contextCap=120,retainedContextCounts={k:len(v) for k,v in hits.items()},matchesByFile={k:dict(v) for k,v in byfile.items()},hits=hits,inventory=files,limits=["Full prior MD and recursively nested JSON value scalars searched including exact archive/_archive path parts; keys not searched.","Keyword navigation and capped contexts do not establish semantic exhaustion or complete historical novelty.","No product import/parse/render/test/helper function, VM/eval, Git, network/native/UI/security/identity execution."])
out.write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(dict(totals=record["totals"],counts=counts,retained=record["retainedContextCounts"]),ensure_ascii=False))

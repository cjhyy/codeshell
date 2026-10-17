from pathlib import Path
import json,re
root=Path(__file__).resolve().parents[3]
batch="docs/audit-2026-10-17-round18"
patterns={
 "web_presentation":r"model-trace-presentation|modelTraceInputBoundary|presentModelTraceCallType",
 "trace_boundary":r"provider-wire|external-cli-input|logical-input",
 "trace_categories":r"ModelTraceCallType|MODEL_TRACE_CALL_TYPES|callType.{0,35}(speech|transcription|audio)",
 "old_desktop":r"modelTracePresentation|TRACE-R14|tracePresentation|duration/group/merge",
}
compiled={key:re.compile(value,re.I) for key,value in patterns.items()}
counts={key:0 for key in patterns}
contexts={key:[] for key in patterns}
files=[];errors=[];strings=0;scalars=0;md=0;js=0

def leafs(value,pointer="$ "):
 if isinstance(value,dict):
  for key,item in value.items(): yield from leafs(item,pointer+"/"+str(key))
 elif isinstance(value,list):
  for i,item in enumerate(value): yield from leafs(item,pointer+"/"+str(i))
 else: yield pointer,value

def inspect(text,path,pointer):
 for key,regex in compiled.items():
  matches=list(regex.finditer(text));counts[key]+=len(matches)
  for match in matches:
   if len(contexts[key])<16:
    contexts[key].append({"path":path,"pointer":pointer,"match":match.group(0),"context":text[max(0,match.start()-160):match.end()+220]})

for dirname in ("docs","bugs"):
 for path in sorted((root/dirname).rglob("*")):
  if not path.is_file() or path.suffix.lower() not in (".md",".json"): continue
  relative=path.relative_to(root).as_posix()
  if relative==batch or relative.startswith(batch+"/"): continue
  files.append(relative)
  try:
   text=path.read_text(encoding="utf-8")
   if path.suffix.lower()==".md":
    md+=1;inspect(text,relative,"whole markdown")
   else:
    js+=1
    for pointer,value in leafs(json.loads(text)):
     scalars+=1
     if isinstance(value,str):
      strings+=1;inspect(value,relative,pointer)
  except Exception as error: errors.append({"path":relative,"error":repr(error)})
result={"excludes":batch,"recursiveIncludesArchives":True,"markdownFiles":md,"jsonFiles":js,"totalFiles":len(files),"jsonStringLeaves":strings,"jsonScalarLeaves":scalars,"errors":errors,"patterns":patterns,"matchCounts":counts,"contextsCapPerPattern":16,"contexts":contexts,"files":files,"note":"Keyword matches and bounded contexts aid dedup; they do not prove exhaustive semantic coverage. Counts include every match, contexts are capped separately. JSON keys are not leaf values."}
(root/batch/"evidence/presentation-dedup.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({key:result[key] for key in ("totalFiles","markdownFiles","jsonFiles","jsonStringLeaves","jsonScalarLeaves","errors","matchCounts")},ensure_ascii=False))

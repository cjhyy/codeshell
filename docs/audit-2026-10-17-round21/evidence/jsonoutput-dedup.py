import hashlib,json,pathlib,re,subprocess
root=pathlib.Path.cwd();batch="docs/audit-2026-10-17-round21";base="615e4e4dd3a61b1ad132ab4f3683985a0d582386"
files=sorted(p for top in [root/"docs",root/"bugs"] if top.exists() for p in top.rglob("*") if p.is_file() and p.suffix in [".md",".json"] and batch not in p.relative_to(root).as_posix())
patterns={"renderer and output format":r"JsonRenderer|JsonlRenderer|StreamJsonRenderer|cli/output/renderer|stream-json","child and fallback aggregation":r"child.*(?:pollut|json|聚合)|子.*(?:污染|JSON)|text \|\| this.text|JSON.*(?:摘要|summary|fallback)|json.*(?:empty|空|result|completion)","wire and metadata":r"completionKind|output.*schema|NDJSON|jsonl emits|final.*meta"}
counts={k:0 for k in patterns};contexts={k:[] for k in patterns};inventory=[];errors=[];strings=0;scalars=0

def leaves(value,path='$'):
 if isinstance(value,dict):
  for k,v in value.items():yield from leaves(v,path+'.'+str(k))
 elif isinstance(value,list):
  for i,v in enumerate(value):yield from leaves(v,path+'['+str(i)+']')
 else:yield path,value
for p in files:
 b=p.read_bytes();rel=p.relative_to(root).as_posix();inventory.append({"path":rel,"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()})
 if p.suffix=='.md':rows=[('line:'+str(i),line) for i,line in enumerate(b.decode('utf8').splitlines(),1)]
 else:
  try:rows=list(leaves(json.loads(b)))
  except Exception as e:errors.append({"path":rel,"error":str(e)});continue
  strings+=sum(isinstance(v,str) for _,v in rows);scalars+=len(rows)
 for loc,value in rows:
  s=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)
  for key,pattern in patterns.items():
   if re.search(pattern,s,re.I):
    counts[key]+=1
    if len(contexts[key])<100:contexts[key].append({"path":rel,"location":loc,"text":s[:1200],"textTruncated":len(s)>1200})
result={"base":base,"excludedBatch":batch,"inventoryFiles":len(inventory),"markdownFiles":sum(p.suffix=='.md' for p in files),"jsonFiles":sum(p.suffix=='.json' for p in files),"jsonStringLeaves":strings,"jsonScalarLeaves":scalars,"jsonParseErrors":errors,"contextCapPerPattern":100,"textCapPerContext":1200,"patterns":patterns,"totalMatchingLeavesOrMarkdownLines":counts,"contexts":contexts,"inventory":inventory,"limitations":["Keyword matches are navigation evidence, not semantic exhaustion.","Inventory reflects this frozen worktree read time, not later main updates.","JSON keys are traversed as locations; counts describe recursive value leaves only."]}
(root/batch/'evidence/jsonoutput-dedup.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['contexts','inventory']},ensure_ascii=False))

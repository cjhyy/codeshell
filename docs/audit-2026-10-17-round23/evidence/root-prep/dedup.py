from pathlib import Path
import json,re,hashlib,collections,subprocess
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
patterns={
'memory-sort':re.compile(r'sortSessionMemoriesByRecency|session-memory-sort(?:\.test)?\.ts|session memor.{0,30}(?:sort|recen)',re.I),
'core-format':re.compile(r'core/src/utils/format(?:\.test)?\.ts|formatRelativeTimeAgo|formatResetTime|formatResetText|formatSecondsShort',re.I),
'json-extraction':re.compile(r'core/src/utils/json(?:\.test)?\.ts|extractJSONArray|extractJSON',re.I),
}
stats={'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};files=[];errors=[];hits={k:[] for k in patterns};counts={k:0 for k in patterns};byfile={k:collections.Counter() for k in patterns}
def leaves(x,loc='$'):
 if isinstance(x,dict):
  for k,v in x.items():yield from leaves(v,loc+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(x,list):
  for i,v in enumerate(x):yield from leaves(v,loc+'['+str(i)+']')
 else:yield loc,x
for directory in ['docs','bugs']:
 for path in sorted((root/directory).rglob('*')):
  if not path.is_file() or path.suffix.lower() not in ['.md','.json']:continue
  raw=path.read_bytes(); relative=str(path.relative_to(root));files.append({'path':relative,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
  if path.suffix.lower()=='.md':stats['markdown']+=1;rows=[(str(i),v) for i,v in enumerate(raw.decode().splitlines(),1)]
  else:
   stats['json']+=1
   try:tree=json.loads(raw)
   except Exception as e:errors.append({'path':relative,'error':str(e)});continue
   rows=[]
   for loc,value in leaves(tree):
    stats['scalarLeaves']+=1
    if isinstance(value,str):stats['stringLeaves']+=1
    rows.append((loc,value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)))
  for loc,value in rows:
   for name,p in patterns.items():
    for m in p.finditer(value):
     counts[name]+=1;byfile[name][relative]+=1
     if len(hits[name])<60:hits[name].append({'path':relative,'location':loc,'excerpt':value[max(0,m.start()-130):min(len(value),m.end()+500)],'wholeValueCharacters':len(value)})
result={'readHead':subprocess.run(['git','rev-parse','HEAD'],cwd=root,capture_output=True,text=True,check=True).stdout.strip(),'roots':['docs','bugs'],'excluded':[],'inventory':files,'totals':{'files':len(files),**stats,'parseErrors':len(errors)},'parseErrors':errors,'patterns':{k:p.pattern for k,p in patterns.items()},'matchCounts':counts,'contextCap':60,'hits':hits,'matchesByFile':{k:dict(v) for k,v in byfile.items()},'note':'Read-time history, including current round22 documents. Recursive JSON scalar values searched as text, keys excluded. Keywords and capped contexts are navigation, not semantic exhaustion.'}
Path('/tmp/codeshell-audit-round23-leaf-frontier/history.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'readHead':result['readHead'],'totals':result['totals'],'matchCounts':counts,'retained':{k:len(v) for k,v in hits.items()}},ensure_ascii=False))

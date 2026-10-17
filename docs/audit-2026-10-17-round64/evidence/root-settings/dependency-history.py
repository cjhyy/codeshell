from pathlib import Path
import hashlib,json,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round175-settings-flags')
paths=['packages/core/src/settings/manager.ts', 'packages/core/src/links/operation-hook-custody.ts']
queries={p:[p,hashlib.sha256((R/p).read_bytes()).hexdigest()] for p in paths};out={p:[] for p in paths};counts={p:0 for p in paths};files=[];errors=[];scalars=0
names=subprocess.check_output(['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.json'],cwd=R).decode().splitlines()
def walk(v,loc=''):
 global scalars
 if isinstance(v,dict):
  for k,x in v.items():yield from walk(x,loc+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,loc+'/'+str(i))
 else:
  scalars+=1
  if isinstance(v,str):yield loc,v
for name in sorted(names):
 m=re.search(r'audit-\d{4}-\d{2}-\d{2}-round(\d+)(?:/|$)',name)
 if m and int(m.group(1))>=64:continue
 p=R/name;b=p.read_bytes();files.append(dict(path=name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
 try:items=list(enumerate(b.decode().splitlines(),1)) if p.suffix=='.md' else walk(json.loads(b))
 except Exception as e:errors.append(dict(path=name,error=str(e)));continue
 for loc,s in items:
  for target,qs in queries.items():
   matched=[q for q in qs if q in s]
   if matched:
    counts[target]+=1
    if len(out[target])<100:out[target].append(dict(document=name,location=loc,matched=matched,value=s[:1800],truncatedValue=len(s)>1800))
j=dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),excludedFormalAtOrAbove=64,historyFiles=len(files),inventory=files,jsonValueScalarsVisited=scalars,queries=queries,counts=counts,hits=out,capPerTarget=100,errors=errors,note='Shared machine path/SHA navigation only, all traversed scalar values not semantically read; JSON keys excluded, archives included; exact shown values capped; source byte hashing not product semantic reading.',productExecution=0)
(D/'dependency-history.json').write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(historyFiles=len(files),counts=counts,errors=errors)))

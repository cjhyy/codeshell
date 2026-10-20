from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round103-chat-compress')
initial=json.loads((D/'selection-initial-pins.json').read_text());pats={}
for i,r in enumerate(initial['files']):
 pats[str(i)+'-path']=re.compile(re.escape(r['path'])+'|'+re.escape(Path(r['path']).name),re.I);pats[str(i)+'-sha']=re.compile(re.escape(r['sha256']),re.I)
pats['compress-contract']=re.compile(r'chat/compress|(?:compress|compact|压缩).{0,60}(?:chat|message|display|显示)|(?:chat|message|display|显示).{0,60}(?:compress|compact|压缩)',re.I)
counts={k:0 for k in pats};hits={k:[] for k in pats};inventory=[];stats=dict(markdownFiles=0,jsonFiles=0,stringLeaves=0,scalarLeaves=0);errors=[];rows=[]
def units(v,at='$'):
 if isinstance(v,dict):
  if any(v.get('path')==r['path'] for r in initial['files']):rows.append(dict(historyPath=current,at=at,row=v))
  for k,x in v.items():yield from units(x,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from units(x,at+'['+str(i)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(v,str):stats['stringLeaves']+=1
  yield at,v if isinstance(v,str) else json.dumps(v)
excluded=tuple('docs/audit-2026-10-17-round'+str(n)+'/' for n in range(52,1000))
for p in sorted(p for base in ['docs','bugs'] for p in (R/base).rglob('*') if p.is_file() and p.suffix.lower() in ['.md','.json'] and not p.relative_to(R).as_posix().startswith(excluded)):
 b=p.read_bytes();current=p.relative_to(R).as_posix();inventory.append(dict(path=current,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
 try:
  if p.suffix.lower()=='.md':stats['markdownFiles']+=1;data=[('$',b.decode())]
  else:stats['jsonFiles']+=1;data=units(json.loads(b))
  for at,s in data:
   for k,pat in pats.items():
    for m in pat.finditer(s):
     counts[k]+=1
     if len(hits[k])<60:hits[k].append(dict(path=current,at=at,context=s[max(0,m.start()-180):m.end()+500]))
 except Exception as e:errors.append(dict(path=current,error=str(e)))
v=dict(atUTC=datetime.now(timezone.utc).isoformat(),files=len(inventory),stats=stats,inventory=inventory,patterns={k:p.pattern for k,p in pats.items()},counts=counts,hits=hits,contextCapEach=60,errors=errors,excluded=list(excluded),archivesIncluded=True,productRuns=0,limitations=['All recursive JSON value scalars queried, keys excluded. Counts and retained contexts are not all semantic reading.','Source row objects collected separately to identify same-SHA coverage declarations; hash pins are not full semantic receipts.'])
(D/'history.json').write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');(D/'coverage-rows.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(files=len(inventory),stats=stats,counts=counts,rows=len(rows),errors=errors),ensure_ascii=False))

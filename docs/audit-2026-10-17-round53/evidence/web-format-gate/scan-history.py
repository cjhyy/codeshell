from pathlib import Path
import hashlib,json,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); O=Path('/tmp/codeshell-audit-round109-web-format')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def pin(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest(),lines=len(b.splitlines()))
target='packages/web/src/lib/format.ts'
pins=[pin(x) for x in ['CODESHELL.md','AGENTS.md',target]]
(O/'initial-pins.json').write_text(json.dumps(dict(createdAt=now(),parentContext='524c0827a480132119b637aa87e16f0eab9895f3',gitExecuted=False,files=pins),ensure_ascii=False,indent=2)+'\n')
paths=sorted(set(subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()))
included=[]; excluded=[]
for p in paths:
 m=re.search(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)',p)
 (excluded if m and int(m.group(1))>=53 else included).append(p)
sha=pins[-1]['sha256']; query={'exact-path':target,'sha256':sha,'basename':'src/lib/format.ts'}
hits={k:[] for k in query};rows=[]; stats=dict(md=0,json=0,jsonStringValues=0,jsonScalarValues=0,exactArchiveDirectories=0,substringArchivePaths=0); inv=[]
def pointer(s):return str(s).replace('~','~0').replace('/','~1')
def walk(v,ptr,doc):
 if isinstance(v,dict):
  direct=[(k,x) for k,x in v.items() if isinstance(x,str) and (x==target or x.endswith('/'+target))]
  if direct: rows.append(dict(document=doc,pointer=ptr,row=v))
  for k,x in v.items():walk(x,ptr+'/'+pointer(k),doc)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(x,ptr+'/'+str(i),doc)
 else:
  stats['jsonScalarValues']+=1
  if isinstance(v,str):stats['jsonStringValues']+=1
  if isinstance(v,(str,int,float,bool)) or v is None:
   s=str(v)
   for k,q in query.items():
    if q in s:hits[k].append(dict(document=doc,pointer=ptr,text=s))
for p in included:
 b=(R/p).read_bytes();inv.append(dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
 if 'archive' in Path(p).parts:stats['exactArchiveDirectories']+=1
 if 'archive' in p:stats['substringArchivePaths']+=1
 if p.endswith('.md'):
  stats['md']+=1
  for n,s in enumerate(b.decode('utf-8').splitlines(),1):
   for k,q in query.items():
    if q in s:hits[k].append(dict(document=p,line=n,text=s))
 else:
  stats['json']+=1;walk(json.loads(b), '',p)
(O/'history-inventory.json').write_text(json.dumps(dict(createdAt=now(),method='rg --files docs bugs *.md/*.json; exclude audit round>=53; Markdown lines plus recursive JSON scalar values, no object keys; source-row direct exact path extraction; inventories are byte metadata, not semantic reading',stats=stats,total=len(included),files=inv,excludedPaths=excluded),ensure_ascii=False,indent=2)+'\n')
(O/'history-gate.json').write_text(json.dumps(dict(createdAt=now(),target=target,sha256=sha,queryTotals={k:len(v) for k,v in hits.items()},capPerQuery=100,hits={k:v[:100] for k,v in hits.items()},directSourceRows=rows),ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(pins=pins,historyTotal=len(included),stats=stats,excluded=len(excluded),queryTotals={k:len(v) for k,v in hits.items()},canonicalRows=len(rows)),ensure_ascii=False))

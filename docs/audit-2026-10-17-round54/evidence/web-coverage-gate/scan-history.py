from pathlib import Path
import hashlib,json,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round115-output-coverage');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def pin(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest(),lines=len(b.splitlines()),pinnedBeforeBodyUTC=now())
target='packages/web/src/lib/outputCoverage.ts';pins=[pin(p)for p in ['CODESHELL.md','AGENTS.md',target]];save('initial-pins.json',dict(createdAt=now(),parentContext='16c1a40c7e3f0cf7701fccd723293bfb1291f105',parentContextSource='Root-provided, no Git query',files=pins))
paths=sorted(set(subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()));inc=[];exc=[]
for p in paths:
 m=re.search(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)',p);(exc if m and int(m.group(1))>=54 else inc).append(p)
queries={'exact-path':target,'sha256':pins[-1]['sha256'],'basename':'outputCoverage'};hits={k:[]for k in queries};rows=[];mdhits=[];inv=[];stats=dict(md=0,json=0,jsonStringValues=0,jsonScalarValues=0,exactArchiveDirectories=0,substringArchivePaths=0)
def bounded(s):
 return dict(text=s if len(s)<=1800 else s[:1800],originalCharacters=len(s),originalValueSha256=hashlib.sha256(s.encode()).hexdigest(),contextCapCharacters=1800)
def add(s,loc):
 for k,q in queries.items():
  if q in s:hits[k].append(dict(**loc,**bounded(s)))
def walk(v,ptr,doc):
 if isinstance(v,dict):
  if any(isinstance(x,str)and x==target for x in v.values()):rows.append(dict(document=doc,pointer=ptr,row=v))
  for k,x in v.items():walk(x,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),doc)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(x,ptr+'/'+str(i),doc)
 else:
  stats['jsonScalarValues']+=1
  if isinstance(v,str):stats['jsonStringValues']+=1
  add(str(v),dict(document=doc,pointer=ptr))
for p in inc:
 b=(R/p).read_bytes();inv.append(dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()));stats['exactArchiveDirectories']+=int('archive'in Path(p).parts);stats['substringArchivePaths']+=int('archive'in p)
 if p.endswith('.md'):
  stats['md']+=1
  for n,s in enumerate(b.decode().splitlines(),1):
   add(s,dict(document=p,line=n))
   if 'outputCoverage'in s:mdhits.append(dict(document=p,line=n,**bounded(s)))
 else:stats['json']+=1;walk(json.loads(b),'',p)
save('history-inventory.json',dict(createdAt=now(),total=len(inc),stats=stats,excludedPaths=exc,method='rg --files docs bugs MD/JSON; exclude formal audit round>=54; exact MD line and recursive JSON scalar values, no key names as text; original source objects extracted directly for canonical path/hash/range gate',files=inv))
save('history-gate.json',dict(createdAt=now(),queryTotals={k:len(v)for k,v in hits.items()},capPerQuery=100,contextCapCharacters=1800,hits={k:v[:100]for k,v in hits.items()},directSourceRows=rows,allMarkdownBasenameHits=mdhits))
print(json.dumps(dict(pins=pins,history=len(inc),stats=stats,excluded=len(exc),queryTotals={k:len(v)for k,v in hits.items()},sourceRows=len(rows),mdBasenameHits=len(mdhits)),ensure_ascii=False))
for r in rows:
 if 'source-manifest' in r['document'] and not any(x in r['document']for x in ['inventory','coverage-adapter','history']):
  row=r['row']; print(json.dumps(dict(document=r['document'],pointer=r['pointer'],fields={k:v for k,v in row.items()if k in ['path','bytes','sha256','scope','review','readScope','readRanges','inspectionScope','reviewMode','coverage','selectedLineRanges','lineCount','lines','frozenSourceSha256','currentSha256']}),ensure_ascii=False))

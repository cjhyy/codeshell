from pathlib import Path
import hashlib,json,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round115-output-coverage');p='packages/web/src/lib/uiLanguage.ts';now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat();b=(R/p).read_bytes();pin=dict(path=p,bytes=len(b),lines=len(b.splitlines()),sha256=hashlib.sha256(b).hexdigest(),pinnedBeforeBodyUTC=now());(O/'fallback-before-pin.json').write_text(json.dumps(pin,indent=2)+'\n')
queries={'exact-path':p,'sha256':pin['sha256'],'basename':'uiLanguage'};hits={k:[]for k in queries};rows=[];md=[];inv=json.loads((O/'history-inventory.json').read_text())
def bnd(s):return dict(text=s[:1800],originalCharacters=len(s),originalValueSha256=hashlib.sha256(s.encode()).hexdigest())
def add(s,loc):
 for k,q in queries.items():
  if q in s:hits[k].append(dict(**loc,**bnd(s)))
def walk(v,ptr,doc):
 if isinstance(v,dict):
  if any(isinstance(x,str)and x==p for x in v.values()):rows.append(dict(document=doc,pointer=ptr,row=v))
  for k,x in v.items():walk(x,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),doc)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(x,ptr+'/'+str(i),doc)
 else:add(str(v),dict(document=doc,pointer=ptr))
for f in inv['files']:
 raw=(R/f['path']).read_bytes();assert hashlib.sha256(raw).hexdigest()==f['sha256']
 if f['path'].endswith('.md'):
  for n,s in enumerate(raw.decode().splitlines(),1):
   add(s,dict(document=f['path'],line=n))
   if 'uiLanguage'in s:md.append(dict(document=f['path'],line=n,**bnd(s)))
 else:walk(json.loads(raw),'',f['path'])
d=dict(createdAt=now(),pin=pin,historyCohort='history-inventory.json original5311; all original bytes checked unchanged before fallback gate',capPerQuery=100,contextCapCharacters=1800,queryTotals={k:len(v)for k,v in hits.items()},hits={k:v[:100]for k,v in hits.items()},directSourceRows=rows,allMarkdownBasenameHits=md)
(O/'fallback-history-gate.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps(dict(pin=pin,queryTotals=d['queryTotals'],directRows=len(rows),mdBasenameHits=len(md)),ensure_ascii=False))
for r in rows:
 if 'source-manifest' in r['document'] and not any(x in r['document']for x in ['inventory','history','coverage-adapter']):
  row=r['row'];print(json.dumps(dict(document=r['document'],pointer=r['pointer'],fields={k:v for k,v in row.items()if k in ['path','bytes','sha256','scope','review','readScope','readRanges','inspectionScope','reviewMode','coverage','selectedLineRanges','lineCount','lines','frozenSourceSha256','currentSha256']}),ensure_ascii=False))
print('MD basename hits')
for m in md:print(json.dumps(m,ensure_ascii=False))

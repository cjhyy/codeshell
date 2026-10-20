from pathlib import Path
import hashlib,json,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round112-glob-summary-review');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
targets=['packages/tui/src/ui/components/ToolCall.tsx','packages/core/src/tool-system/builtin/glob.ts','packages/core/src/tool-system/builtin/glob.test.ts']
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def pin(p):
 b=(R/p).read_bytes();return dict(path=p,bytes=len(b),lines=len(b.splitlines()),sha256=hashlib.sha256(b).hexdigest(),pinnedBeforeBodyUTC=now())
pins=[pin(p)for p in ['CODESHELL.md','AGENTS.md']+targets];save('initial-pins.json',dict(createdAt=now(),parentContext='524c0827a480132119b637aa87e16f0eab9895f3',gitExecuted=False,files=pins))
paths=sorted(set(subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()));included=[];excluded=[]
for p in paths:
 m=re.search(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)',p);(excluded if m and int(m.group(1))>=53 else included).append(p)
queries={}
for x in pins[2:]:queries[x['path']]=x['path'];queries[x['path']+' SHA']=x['sha256']
patterns={
 'literal-empty-glob':re.compile(r'No files matched the pattern\.',re.I),
 'glob-wrong-count':re.compile(r'(?is)(?:glob|No files matched).{0,240}(?:non.empty|非空|1\s*files|1\s*个?文件|no.matches|零结果|无匹配|空结果|计数|count)|(?:non.empty|非空|1\s*files|计数|count).{0,240}(?:glob|No files matched)'),
 'glob-summary':re.compile(r'(?is)(?:glob.{0,160}(?:compactOutput|renderToolOutput|collapsed|summary|折叠|摘要))|(?:(?:compactOutput|renderToolOutput|collapsed|summary|折叠|摘要).{0,160}glob)')}
hits={k:[]for k in queries};causes={k:[]for k in patterns};rows=[];inv=[];stats=dict(md=0,json=0,jsonStringValues=0,jsonScalarValues=0,exactArchiveDirectories=0,substringArchivePaths=0)
def add(s,loc):
 for k,q in queries.items():
  if q in s:hits[k].append(dict(**loc,text=s))
 for k,pat in patterns.items():
  if pat.search(s):causes[k].append(dict(**loc,text=s))
def walk(v,ptr,doc):
 if isinstance(v,dict):
  if any(isinstance(x,str)and x in targets for x in v.values()):rows.append(dict(document=doc,pointer=ptr,row=v))
  for k,x in v.items():walk(x,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),doc)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(x,ptr+'/'+str(i),doc)
 else:
  stats['jsonScalarValues']+=1
  if isinstance(v,str):stats['jsonStringValues']+=1
  add(str(v),dict(document=doc,pointer=ptr))
for p in included:
 b=(R/p).read_bytes();inv.append(dict(path=p,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
 stats['exactArchiveDirectories']+=int('archive'in Path(p).parts);stats['substringArchivePaths']+=int('archive'in p)
 if p.endswith('.md'):
  stats['md']+=1;lines=b.decode().splitlines()
  for n,s in enumerate(lines,1):
   for k,q in queries.items():
    if q in s:hits[k].append(dict(document=p,line=n,text=s))
  start=1;block=[]
  for n,s in enumerate(lines+[''],1):
   if not s.strip():
    if block:
     text='\n'.join(block)
     for k,pat in patterns.items():
      if pat.search(text):causes[k].append(dict(document=p,lineStart=start,lineEnd=n-1,text=text))
     block=[]
    start=n+1
   else:block.append(s)
 else:stats['json']+=1;walk(json.loads(b),'',p)
save('history-inventory.json',dict(createdAt=now(),method='rg --files docs bugs MD/JSON; exclude formal audit round>=53; Markdown exact paths by line, cause by paragraph; recursive JSON scalar values not object keys; original source-row direct objects retained for canonical gate',total=len(included),stats=stats,files=inv,excludedPaths=excluded))
save('history-gate.json',dict(createdAt=now(),capPerQuery=100,queryTotals={k:len(v)for k,v in hits.items()},hits={k:v[:100]for k,v in hits.items()},causePatterns={k:v.pattern for k,v in patterns.items()},causeTotals={k:len(v)for k,v in causes.items()},causeContexts={k:v[:100]for k,v in causes.items()},directSourceRows=rows))
print(json.dumps(dict(pins=pins,total=len(included),stats=stats,queryTotals={k:len(v)for k,v in hits.items()},causeTotals={k:len(v)for k,v in causes.items()},sourceRows=len(rows),excluded=len(excluded)),ensure_ascii=False))

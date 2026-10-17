from pathlib import Path
import json,hashlib,re,subprocess,datetime,collections
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round117-host-requests')
UTC=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
TARGETS={'packages/host/src/runtime.ts': 'b785ab50fd5265ffb7f7d78c312f01b8c2ace165a5bcfdb6a25655b3e5dd3089'}
queries={}
for path,sha in TARGETS.items():
 queries['targetPath']=re.compile(re.escape(path));queries['targetSHA']=re.compile(sha);queries['targetFilename']=re.compile(r'packages/host/src/runtime\.ts|HostRuntime',re.I)
queries['oldCause']=re.compile(r'HostRuntime|runtime\.ts.{0,100}(?:dispatch|register|service|route|请求|分派)',re.I)
exclude=re.compile(r'(^|/)audit-2026-10-17-round(?:5[4-9]|[6-9][0-9]|[1-9][0-9]{2,})(/|$)')
p=subprocess.run(['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json','-g','!**/.git/**','-g','!**/node_modules/**'],cwd=ROOT,capture_output=True,text=True,check=True)
allpaths=sorted(set(p.stdout.splitlines()));paths=[p for p in allpaths if not exclude.search(p)]
counts=collections.Counter();matches=collections.Counter();contexts={k:[]for k in queries};rows=[];errors=[];sourceobjects=[]
def search(s,doc,ptr,kind):
 for k,pat in queries.items():
  for m in pat.finditer(s):
   matches[k]+=1
   if len(contexts[k])<100:contexts[k].append({'path':doc,'pointer':ptr,'kind':kind,'offset':m.start(),'context':s[max(0,m.start()-500):min(len(s),m.end()+900)],'completeScalar':len(s)<=1400})
def walk(x,doc,ptr=''):
 if isinstance(x,dict):
  counts['objects']+=1
  if any(isinstance(v,str)and(v in TARGETS or v in TARGETS.values())for v in x.values()):sourceobjects.append({'document':doc,'jsonPointer':ptr,'row':x})
  for k,v in x.items():walk(v,doc,ptr+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(x,list):
  counts['arrays']+=1
  for i,v in enumerate(x):walk(v,doc,ptr+'/'+str(i))
 else:
  counts['scalars']+=1
  if isinstance(x,str):counts['strings']+=1;search(x,doc,ptr,'json-value-scalar')
started=UTC()
for rel in paths:
 b=(ROOT/rel).read_bytes();kind='json'if rel.lower().endswith('.json')else'md';rows.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'kind':kind})
 try:
  if kind=='json':counts['json']+=1;walk(json.loads(b),rel)
  else:counts['md']+=1;text=b.decode('utf-8');search(text,rel,'','MD text')
 except Exception as e:errors.append({'path':rel,'error':repr(e)})
summary={'startedUTC':started,'finishedUTC':UTC(),'root':str(ROOT),'files':rows,'fileCount':len(rows),'excludedExactPattern':exclude.pattern,'excludedPaths':[p for p in allpaths if exclude.search(p)],'counts':dict(counts),'matches':dict(matches),'retained':{k:len(v)for k,v in contexts.items()},'capPerQuery':100,'parseErrors':errors,'archiveExactDirectoryCount':sum(any(x in ['archive','_archive']for x in Path(p).parts)for p in paths),'scope':'MD text + recursively searched JSON value scalars, keys not searched; includes frozen53, excludes numeric formal54+ including ownfuture117. Derived rows are search metadata only, never new source evidence.'}
(OUT/'fallback-history.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
(OUT/'fallback-history-contexts.json').write_text(json.dumps(contexts,ensure_ascii=False,indent=2)+'\n')
(OUT/'fallback-coverage-gate-objects.json').write_text(json.dumps({'rows':sourceobjects,'count':len(sourceobjects),'scope':'Exact path/SHA same-object metadata; not all are semantic coverage. Original canonical metadata wins over derived indexes/copies.'},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items()if k!='files'},ensure_ascii=False,indent=2))
print('DIRECT_PATH_OR_SHA_OBJECTS',len(sourceobjects))

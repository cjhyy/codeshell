from pathlib import Path
import json,hashlib,datetime,re,subprocess,collections
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); OUT=Path('/tmp/codeshell-audit-round90-param-controls')
TARGET='packages/desktop/src/renderer/settings/ParamControls.tsx'; TEST='packages/desktop/src/renderer/settings/ParamControls.test.tsx'; SHA='6076e25165aa527836ae31d99fe1c2c7250e12518d0a43dd7daf6572459c5c6c'
QUERIES={'exact-path':re.compile(re.escape(TARGET)),'basename':re.compile('ParamControls'),'current-sha':re.compile(SHA),'parameter-control-old-cause':re.compile(r'(?:参数|parameter|param control|numeric control).{0,140}(?:重置|reset|枚举|enum|numeric|number|空值|empty|default|minimum|maximum)',re.I)}
counts=collections.Counter(); totals=collections.Counter(); retained={q:[] for q in QUERIES}; cap=80; inventory=[]; sourceRows=[]; parseErrors=[]
cmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json']; r=subprocess.run(cmd,cwd=ROOT,capture_output=True)
(OUT/'history-command.json').write_text(json.dumps({'command':cmd,'exitCode':r.returncode,'stderr':r.stderr.decode()},indent=2)+'\n'); assert r.returncode==0
paths=[]; excluded=[]
for p in sorted(set(r.stdout.decode().splitlines())):
 m=re.match(r'^docs/audit-\d{4}-\d{2}-\d{2}-round(\d+)(?:/|$)',p)
 (excluded if m and int(m.group(1))>=50 else paths).append(p)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def record(s,p,ptr,kind):
 for q,rx in QUERIES.items():
  m=rx.search(s)
  if m:
   totals[q]+=1
   if len(retained[q])<cap:
    lo=max(0,m.start()-300); hi=min(len(s),m.end()+900)
    retained[q].append({'document':p,'locator':ptr,'kind':kind,'totalStringChars':len(s),'excerpt':s[lo:hi],'excerptStart':lo,'excerptEnd':hi,'excerptTruncated':lo>0 or hi<len(s)})
def sourcepath(v):
 if not isinstance(v,str): return None
 if v.startswith(str(ROOT)+'/'):v=v[len(str(ROOT))+1:]
 return v if re.fullmatch(r'(?:packages|tests|scripts|bench)/[^\n]+\.(?:ts|tsx|js|jsx|mjs|cjs)',v) else None
def walk(x,p,ptr,dh):
 if isinstance(x,dict):
  ps={sourcepath(v) for v in x.values() if sourcepath(v)}
  if ps&{TARGET,TEST}:
   hs={k:v for k,v in x.items() if isinstance(v,str) and re.fullmatch('[0-9a-fA-F]{64}',v) and any(t in k.lower() for t in ['sha','hash'])}
   meta={k:v for k,v in x.items() if any(t in k.lower() for t in ['scope','review','coverage','read','range','lines']) or k in ['note','reason','role']}
   sourceRows.append({'document':p,'documentSha256':dh,'jsonPointer':ptr,'directSourcePaths':sorted(ps),'sourceHashFields':hs,'uniqueDirectPath':len(ps)==1,'uniqueDirectHash':len(set(hs.values()))==1,'metadata':meta,'manifestFilenameHint':'manifest' in Path(p).name.lower() and not any(t in Path(p).name.lower() for t in ['history','coverage','receipt','index'])})
  for k,v in x.items():walk(v,p,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),dh)
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,p,ptr+'/'+str(i),dh)
 else:
  counts['jsonScalarValues']+=1
  if isinstance(x,str):counts['jsonStringValues']+=1; record(x,p,ptr,'json-recursive-value')
started=now()
for p in paths:
 b=(ROOT/p).read_bytes(); h=hashlib.sha256(b).hexdigest(); inventory.append({'path':p,'bytes':len(b),'sha256':h})
 if Path(p).suffix.lower()=='.md':
  counts['markdownFiles']+=1
  # Each paragraph is a query context, not a claim of full historic file reading.
  for j,part in enumerate(b.decode().split('\n\n')):record(part,p,'paragraph/'+str(j),'markdown-paragraph')
 else:
  counts['jsonFiles']+=1
  try:walk(json.loads(b),p,'',h)
  except Exception as e:parseErrors.append({'path':p,'type':type(e).__name__,'message':str(e)})
counts['files']=len(paths); counts['archiveExactDirectoryFiles']=sum('archive' in Path(p).parts for p in paths); counts['archiveSubstringFiles']=sum('archive' in p for p in paths)
(OUT/'history-initial-inventory.json').write_text(json.dumps({'capturedUTC':started,'exclusion':'audit directoryround>=50; include frozen49; all docs/bugs MD and recursive JSON scalar values includingarchive. JSON keys not searched as value text.','files':inventory},ensure_ascii=False,indent=2)+'\n')
(OUT/'history-source-rows.json').write_text(json.dumps({'rows':sourceRows,'association':'No ancestor hash association or genericcomplete alias activation. Original canonical row metadata must be read before a decision.'},ensure_ascii=False,indent=2)+'\n')
(OUT/'history-contexts.json').write_text(json.dumps({'capPerQuery':cap,'queryPatterns':{q:rx.pattern for q,rx in QUERIES.items()},'totalMatches':dict(totals),'retainedCounts':{q:len(v) for q,v in retained.items()},'actualHumanRead':'pending; machine scanned counts are not semantic reading','contexts':retained},ensure_ascii=False,indent=2)+'\n')
summary={'startedUTC':started,'finishedUTC':now(),'counts':dict(counts),'excludedAudit50PlusCount':len(excluded),'parseErrors':parseErrors,'sourceObjectRows':len(sourceRows),'manifestHintRows':sum(r['manifestFilenameHint'] for r in sourceRows),'totalMatches':dict(totals),'retainedCap':cap,'retainedCounts':{q:len(v) for q,v in retained.items()},'productExecutions':0,'GitOperations':0,'testsExecuted':0}
(OUT/'history-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n'); print(json.dumps(summary,ensure_ascii=False))

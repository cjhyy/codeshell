from pathlib import Path
import json,hashlib,datetime,re,subprocess,collections
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');OUT=Path('/tmp/codeshell-audit-round96-message-time')
TARGET='packages/desktop/src/renderer/messages/time.ts';TEST='packages/desktop/src/renderer/messages/time.test.ts';SHA='aa7268c80a57df06eed92c7b0439e5d0eefed9c7410e6df6553ab160a82a5435'
Q={'exact-path':re.compile(re.escape(TARGET)),'message-time-basename':re.compile(r'messages/time(?:\.test)?\.ts'),'current-sha':re.compile(SHA),'time-format-old-cause':re.compile(r'(?:formatDuration|formatTimestamp|formatElapsed|formatRelativeTime|relative time|时间戳|耗时).{0,180}(?:毫秒|秒|minute|hour|小时|unit|格式|negative|负数|overflow)',re.I|re.S)}
cap=100;contexts={q:[] for q in Q};totals=collections.Counter();counts=collections.Counter();rows=[];inventory=[];errors=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def hit(s,p,l,k):
 for q,rx in Q.items():
  m=rx.search(s)
  if m:
   totals[q]+=1
   if len(contexts[q])<cap:
    lo=max(0,m.start()-220);hi=min(len(s),m.end()+700);contexts[q].append({'document':p,'locator':l,'kind':k,'excerpt':s[lo:hi],'excerptStart':lo,'excerptEnd':hi,'originalChars':len(s),'excerptTruncated':lo>0 or hi<len(s)})
def sp(v):
 if not isinstance(v,str):return None
 if v.startswith(str(ROOT)+'/'):v=v[len(str(ROOT))+1:]
 return v if re.fullmatch(r'(?:packages|tests|scripts|bench)/[^\n]+\.(?:ts|tsx|js|jsx|mjs|cjs)',v) else None
def walk(x,p,l,h):
 if isinstance(x,dict):
  ps={sp(v) for v in x.values() if sp(v)}
  if ps&{TARGET,TEST}:
   hs={k:v for k,v in x.items() if isinstance(v,str) and re.fullmatch('[0-9a-fA-F]{64}',v) and any(t in k.lower() for t in ['sha','hash'])};meta={k:v for k,v in x.items() if any(t in k.lower() for t in ['scope','review','read','range','coverage','lines']) or k in ['note','reason','role']}
   rows.append({'document':p,'documentSha256':h,'jsonPointer':l,'directSourcePaths':sorted(ps),'hashFields':hs,'uniqueDirectPath':len(ps)==1,'uniqueDirectHash':len(set(hs.values()))==1,'metadata':meta,'manifestNameHint':'manifest' in Path(p).name.lower() and not any(t in Path(p).name.lower() for t in ['history','receipt','coverage','index'])})
  for k,v in x.items():walk(v,p,l+'/'+str(k).replace('~','~0').replace('/','~1'),h)
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,p,l+'/'+str(i),h)
 else:
  counts['jsonScalarValues']+=1
  if isinstance(x,str):counts['jsonStringValues']+=1;hit(x,p,l,'json-recursive-value')
cmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.MD','-g','*.json'];r=subprocess.run(cmd,cwd=ROOT,capture_output=True);(OUT/'history-command.json').write_text(json.dumps({'command':cmd,'exitCode':r.returncode,'stderr':r.stderr.decode()},indent=2)+'\n');assert r.returncode==0
paths=[];excluded=[]
for p in sorted(set(r.stdout.decode().splitlines())):
 m=re.match(r'^docs/audit-\d{4}-\d{2}-\d{2}-round(\d+)(?:/|$)',p);(excluded if m and int(m.group(1))>=51 else paths).append(p)
started=now()
for p in paths:
 b=(ROOT/p).read_bytes();h=hashlib.sha256(b).hexdigest();inventory.append({'path':p,'bytes':len(b),'sha256':h})
 if p.lower().endswith('.md'):
  counts['markdownFiles']+=1
  for i,s in enumerate(b.decode().split('\n\n')):hit(s,p,'paragraph/'+str(i),'markdown-paragraph')
 else:
  counts['jsonFiles']+=1
  try:walk(json.loads(b),p,'',h)
  except Exception as e:errors.append({'path':p,'type':type(e).__name__,'message':str(e)})
counts['files']=len(paths);counts['archiveExactDirectoryFiles']=sum('archive' in Path(p).parts for p in paths);counts['archiveSubstringFiles']=sum('archive' in p for p in paths)
(OUT/'history-initial-inventory.json').write_text(json.dumps({'capturedUTC':started,'scope':'All docs/bugs MD+recursiveJSONscalarvalues, includingarchives/frozen50, excluding audit51+. Keys not searched as value text.','files':inventory},ensure_ascii=False,indent=2)+'\n')
(OUT/'history-source-rows.json').write_text(json.dumps({'rows':rows,'hashAssociation':'Direct unique same-object sourcepath/SHA only; artifact/document hashes are not source bindings; no implicit complete alias.'},ensure_ascii=False,indent=2)+'\n')
(OUT/'history-contexts.json').write_text(json.dumps({'capPerQuery':cap,'queryPatterns':{q:rx.pattern for q,rx in Q.items()},'totalMatches':dict(totals),'retainedCounts':{q:len(v) for q,v in contexts.items()},'actualHumanRead':'pending; machine scan not semantic reading','contexts':contexts},ensure_ascii=False,indent=2)+'\n')
x={'startedUTC':started,'finishedUTC':now(),'counts':dict(counts),'excludedAudit51PlusCount':len(excluded),'parseErrors':errors,'sourceObjectRows':len(rows),'manifestHintRows':sum(x['manifestNameHint'] for x in rows),'totalMatches':dict(totals),'capPerQuery':cap,'retainedCounts':{q:len(v) for q,v in contexts.items()},'productExecutions':0,'GitOperations':0,'testExecutions':0}
(OUT/'history-summary.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n');print(json.dumps(x,ensure_ascii=False))

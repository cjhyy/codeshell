from pathlib import Path
import json,hashlib,re,datetime,subprocess
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round116-backup-format')
targets={'backup':('packages/core/src/session/output-journal-backup-format.ts','98aaf46c9aa750189927786e834e47c1e39ae6b52cb77ed185dda0ac604e876a','output-journal-backup-format'), 'fallback':('packages/core/src/session/output-storage-prototype/id-index.ts','d794b760c52318fd51cb9e3bb37b9121bea11907c9126312432756eb023f09c8','output-storage-prototype/id-index')}
base=[x for x in ['docs','bugs'] if (ROOT/x).exists()]
r=subprocess.run(['rg','--files',*base],cwd=ROOT,text=True,capture_output=True)
if r.returncode: raise RuntimeError(r.stderr)
paths=[]
for p in r.stdout.splitlines():
 if Path(p).suffix.lower() not in {'.md','.json'}: continue
 nums=[int(n) for n in re.findall(r'audit-\d{4}-\d{2}-\d{2}-round(\d+)',p)]
 if any(n>=54 for n in nums): continue
 paths.append(p)
counts={'md':0,'json':0,'strings':0,'scalars':0,'objects':0,'arrays':0,'parseErrors':0}
hits={k:{'path':0,'sha256':0,'filename':0,'oldcause':0} for k in targets};contexts={k:{a:[] for a in hits[k]} for k in targets};objects={k:[] for k in targets};inventory=[]
old=re.compile(r'backup.{0,45}(?:format|codec|entries|restore)|(?:journal|backup).{0,45}(?:serializ|parse|recover)|(?:id.index|index).{0,40}(?:duplicate|序列|备份)',re.I)
def esc(x): return str(x).replace('~','~0').replace('/','~1')
def scalar(s,p,ptr):
 for k,(path,sha,name) in targets.items():
  for label,yes in [('path',path in s),('sha256',sha in s),('filename',name in s),('oldcause',bool(old.search(s)))]:
   if not yes: continue
   hits[k][label]+=1
   if len(contexts[k][label])>=80: continue
   pos=s.find(path if label=='path' else sha if label=='sha256' else name) if label!='oldcause' else old.search(s).start()
   contexts[k][label].append({'path':p,'pointer':ptr,'scalarLength':len(s),'offset':pos,'text':s[max(0,pos-280):min(len(s),pos+650)],'bounded':True})
def walk(v,p,ptr=''):
 if isinstance(v,dict):
  counts['objects']+=1
  direct=[x for x in v.values() if isinstance(x,str)]
  for k,(path,sha,name) in targets.items():
   if any(path==x or x.endswith('/'+path) for x in direct):
    selected={a:b for a,b in v.items() if isinstance(b,(str,int,float,bool,type(None))) or a.lower() in {'ranges','selectedlineranges','lineranges','range','coverage','readscope','inspectionscope','scope','reviewmode','review','full','declaredlines','sourceranges'}}
    objects[k].append({'document':p,'pointer':ptr,'object':selected})
  for a,b in v.items(): walk(b,p,ptr+'/'+esc(a))
 elif isinstance(v,list):
  counts['arrays']+=1
  for i,b in enumerate(v):walk(b,p,ptr+'/'+str(i))
 else:
  counts['scalars']+=1
  if isinstance(v,str):counts['strings']+=1;scalar(v,p,ptr)
for p in sorted(paths):
 b=(ROOT/p).read_bytes();sha=hashlib.sha256(b).hexdigest();inventory.append({'path':p,'bytes':len(b),'sha256':sha})
 if p.lower().endswith('.md'):
  counts['md']+=1;scalar(b.decode('utf-8'),p,'')
 else:
  counts['json']+=1
  try:walk(json.loads(b),p)
  except (UnicodeDecodeError,json.JSONDecodeError) as e:counts['parseErrors']+=1;contexts.setdefault('errors',[]).append({'path':p,'error':str(e)})
meta={'snapshotAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(ROOT),'includesFormalThrough':53,'excludesFormalFrom':54,'inputPrefixes':base,'inventoryCommand':['rg','--files',*base],'inventoryExitCode':r.returncode,'counts':counts,'historyMembers':len(paths),'archiveExactMembers':sum(any(x in {'archive','_archive'} for x in Path(p).parts) for p in paths),'hits':hits,'capPerQuery':80,'machineOnlyNotSemanticRead':True,'files':inventory}
for n,obj in [('history.json',meta),('history-contexts.json',contexts),('coverage-gate-objects.json',objects)]: (OUT/n).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:meta[k] for k in meta if k!='files'},ensure_ascii=False,indent=2))
print(json.dumps({k:len(v) for k,v in objects.items()}))

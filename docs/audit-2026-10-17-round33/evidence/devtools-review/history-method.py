from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round33-devtools-review');excluded=['docs/audit-2026-10-17-round32/','docs/audit-2026-10-17-round33/']
patterns={'exact-inspector':r'browser-devtools|createBrowserInspector|createPuppeteerInspector|BrowserInspectorPage|browser_inspect','recording-cap-contract':r'recording.{0,35}(?:console|network)|max.?entries|RECORD_CAP|framenavigated|inspector\.inspect|记录.{0,15}(?:console|network)','old-failed':r'(?:browser.?inspect|browser.?devtools|inspector).{0,100}(?:fail|失败|SKIP)|(?:fail|失败|SKIP).{0,100}(?:browser.?inspect|browser.?devtools|inspector)'}
rx={k:re.compile(v,re.I) for k,v in patterns.items()};counts={k:0 for k in rx};hits={k:[] for k in rx};stats={'markdownFiles':0,'jsonFiles':0,'stringLeaves':0,'scalarLeaves':0};inventory=[];errors=[];cap=60;started=datetime.now(timezone.utc).isoformat()
def search(text,path,at):
 for k,p in rx.items():
  for m in p.finditer(text):
   counts[k]+=1
   if len(hits[k])<cap:hits[k].append({'path':path,'at':at,'context':text[max(0,m.start()-120):min(len(text),m.end()+240)]})
def walk(x,path,at='$'):
 if isinstance(x,dict):
  for k,v in x.items():walk(v,path,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,path,at+'['+str(i)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(x,str):stats['stringLeaves']+=1;search(x,path,at)
  else:search(json.dumps(x,ensure_ascii=False),path,at)
for q in sorted(q for name in ('docs','bugs') for q in (root/name).rglob('*') if q.is_file() and q.suffix.lower() in ('.md','.json') and not any(str(q.relative_to(root)).startswith(x) for x in excluded)):
 path=str(q.relative_to(root));b=q.read_bytes();inventory.append({'path':path,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 try:
  text=b.decode('utf8')
  if q.suffix.lower()=='.md':stats['markdownFiles']+=1;search(text,path,'whole Markdown')
  else:stats['jsonFiles']+=1;walk(json.loads(text),path)
 except Exception as exc:errors.append({'path':path,'error':str(exc)})
d={'startedUTC':started,'completedUTC':datetime.now(timezone.utc).isoformat(),'context':'Root reported mutableRound32 on4be; futureRound33 not bound','excluded':excluded,'archivesIncluded':True,'inventory':inventory,'stats':stats,'patterns':patterns,'occurrenceCounts':counts,'contextCapEach':cap,'hits':hits,'parseErrors':errors,'exactArchiveDirectoryFiles':sum(any(c in ('archive','_archive') for c in Path(x['path']).parts[:-1]) for x in inventory),'productAttempts':0,'gitCommands':0,'limits':'WholeMD plus recursive JSON value scalars, not keys. Metadata keyword inventory is not full semantic history review; selected contexts read separately.'}
(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'files':len(inventory),'stats':stats,'counts':counts,'saved':{k:len(v) for k,v in hits.items()},'errors':errors},ensure_ascii=False))

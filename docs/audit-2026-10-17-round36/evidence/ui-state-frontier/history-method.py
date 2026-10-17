from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round36-ui-state-frontier');excluded=['docs/audit-2026-10-17-round34/','docs/audit-2026-10-17-round35/','docs/audit-2026-10-17-round36/'];leaves={x['path']:x['sha256'] for x in json.loads((out/'initial-pins.json').read_text())['files'] if x['path'].startswith('packages/')}
patterns={'exact-leaf':r'dialogState|toastState','ordinary-ui-queue':r'(?:dialog|toast).{0,35}(?:queue|state|dismiss|close|remove|timer|duration)|(?:queue|dismiss|duration).{0,35}(?:dialog|toast)|弹窗.{0,15}(?:队列|状态)|提示.{0,10}(?:队列|关闭)','old-failed':r'(?:dialogState|toastState).{0,100}(?:fail|失败|SKIP)|(?:fail|失败|SKIP).{0,100}(?:dialogState|toastState)'}
rx={k:re.compile(v,re.I) for k,v in patterns.items()};counts={k:0 for k in rx};hits={k:[] for k in rx};stats={'markdownFiles':0,'jsonFiles':0,'stringLeaves':0,'scalarLeaves':0};inventory=[];coverage=[];errors=[];cap=60;started=datetime.now(timezone.utc).isoformat()
def search(t,p,a):
 for k,pattern in rx.items():
  for m in pattern.finditer(t):
   counts[k]+=1
   if len(hits[k])<cap:hits[k].append({'path':p,'at':a,'context':t[max(0,m.start()-140):min(len(t),m.end()+260)]})
def walk(x,p,a='$'):
 if isinstance(x,dict):
  for leaf,sha in leaves.items():
   if leaf in [v for v in x.values() if isinstance(v,str)]:
    hashes={k:v for k,v in x.items() if isinstance(v,str) and re.fullmatch(r'[0-9a-f]{64}',v)};kind=x.get('coverage',x.get('kind'));coverage.append({'metadataPath':p,'at':a,'sourcePath':leaf,'row':x,'sameCurrentShaAnyField':sha in hashes.values(),'coverageField':kind,'explicitFullOrSelected':kind in ('full','selected')})
  for k,v in x.items():walk(v,p,a+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,p,a+'['+str(i)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(x,str):stats['stringLeaves']+=1;search(x,p,a)
  else:search(json.dumps(x,ensure_ascii=False),p,a)
for q in sorted(q for name in ('docs','bugs') for q in (root/name).rglob('*') if q.is_file() and q.suffix.lower() in ('.md','.json') and not any(str(q.relative_to(root)).startswith(x) for x in excluded)):
 p=str(q.relative_to(root));b=q.read_bytes();inventory.append({'path':p,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 try:
  t=b.decode('utf8')
  if q.suffix.lower()=='.md':stats['markdownFiles']+=1;search(t,p,'whole Markdown')
  else:stats['jsonFiles']+=1;walk(json.loads(t),p)
 except Exception as exc:errors.append({'path':p,'error':str(exc)})
d={'startedUTC':started,'completedUTC':datetime.now(timezone.utc).isoformat(),'prepOnly':True,'formalBaseline':None,'parentReportedFrozenRound33':'40d79ff2190a98aa31067eb07006099c2726b21a','includesFrozen32And33':True,'excluded':excluded,'archivesIncluded':True,'inventory':inventory,'stats':stats,'patterns':patterns,'occurrenceCounts':counts,'contextCapEach':cap,'hits':hits,'coverageMetadataRows':coverage,'parseErrors':errors,'productAttempts':0,'gitCommands':0,'limits':'WholeMD plus recursive JSON value scalars,notkeys. Explicit sameSHA coverage metadata is conservative; missing rows do not prove source unread. Keywords/capped contexts do not prove semantic history exhaustion.'}
(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'files':len(inventory),'stats':stats,'counts':counts,'retained':{k:len(v) for k,v in hits.items()},'coverageRows':len(coverage),'explicitSameSha':[{k:x[k] for k in ('metadataPath','at','sourcePath','coverageField')} for x in coverage if x['sameCurrentShaAnyField'] and x['explicitFullOrSelected']],'errors':errors},ensure_ascii=False))

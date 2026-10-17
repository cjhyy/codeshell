from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round34-memoize-frontier');excluded=['docs/audit-2026-10-17-round32/','docs/audit-2026-10-17-round33/','docs/audit-2026-10-17-round34/'];leaves={x['path']:x['sha256'] for x in json.loads((out/'initial-pins.json').read_text())['files'] if x['path'].startswith('packages/')}
patterns={'exact-source':r'memoize(?:\.test)?\.ts|task-sanitizer(?:\.test)?\.ts','ordinary-cache-text':r'memoiz|sanitize.?task|task.{0,15}sanitiz|Promise.{0,25}cache|cache.{0,25}reject|sanitiz.{0,30}(?:subject|description|title)|任务.{0,15}(?:净化|清理|过滤)','old-failed':r'(?:memoiz|task-sanitizer).{0,100}(?:fail|失败|SKIP)|(?:fail|失败|SKIP).{0,100}(?:memoiz|task-sanitizer)'}
rx={k:re.compile(v,re.I) for k,v in patterns.items()};counts={k:0 for k in rx};hits={k:[] for k in rx};stats={'markdownFiles':0,'jsonFiles':0,'stringLeaves':0,'scalarLeaves':0};inventory=[];errors=[];coverage=[];cap=60;started=datetime.now(timezone.utc).isoformat()
def match(text,path,at):
 for k,p in rx.items():
  for m in p.finditer(text):
   counts[k]+=1
   if len(hits[k])<cap:hits[k].append({'path':path,'at':at,'context':text[max(0,m.start()-140):min(len(text),m.end()+260)]})
def walk(x,path,at='$'):
 if isinstance(x,dict):
  for target,sha in leaves.items():
   if target in [v for v in x.values() if isinstance(v,str)]:
    hashes={k:v for k,v in x.items() if isinstance(v,str) and re.fullmatch(r'[0-9a-f]{64}',v)};kind=x.get('coverage',x.get('kind'));coverage.append({'metadataPath':path,'at':at,'sourcePath':target,'row':x,'sameCurrentShaAnyField':sha in hashes.values(),'coverageField':kind,'explicitFullOrSelected':kind in ('full','selected')})
  for k,v in x.items():walk(v,path,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,path,at+'['+str(i)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(x,str):stats['stringLeaves']+=1;match(x,path,at)
  else:match(json.dumps(x,ensure_ascii=False),path,at)
for q in sorted(q for name in ('docs','bugs') for q in (root/name).rglob('*') if q.is_file() and q.suffix.lower() in ('.md','.json') and not any(str(q.relative_to(root)).startswith(x) for x in excluded)):
 rel=str(q.relative_to(root));b=q.read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 try:
  t=b.decode('utf8')
  if q.suffix.lower()=='.md':stats['markdownFiles']+=1;match(t,rel,'whole Markdown')
  else:stats['jsonFiles']+=1;walk(json.loads(t),rel)
 except Exception as exc:errors.append({'path':rel,'error':str(exc)})
d={'startedUTC':started,'completedUTC':datetime.now(timezone.utc).isoformat(),'prepOnly':True,'formalBaseline':None,'excluded':excluded,'archivesIncluded':True,'inventory':inventory,'stats':stats,'patterns':patterns,'occurrenceCounts':counts,'contextCapEach':cap,'hits':hits,'coverageMetadataRows':coverage,'parseErrors':errors,'productAttempts':0,'gitCommands':0,'limits':'MD wholetext andrecursive JSONvalue scalars,notkeys. Explicit full/selected matchedSHA rows are conservative metadata evidence; missing coverage is not proof nobody read source. Semantic old-report statements inspected separately.'}
(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'files':len(inventory),'stats':stats,'counts':counts,'retained':{k:len(v) for k,v in hits.items()},'coverageRows':len(coverage),'explicitSameSha':[{k:x[k] for k in ('metadataPath','at','sourcePath','coverageField')} for x in coverage if x['sameCurrentShaAnyField'] and x['explicitFullOrSelected']],'errors':errors},ensure_ascii=False))

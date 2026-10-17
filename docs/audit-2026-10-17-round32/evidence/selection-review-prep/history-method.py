from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round32-selection-review');excluded='docs/audit-2026-10-17-round32/'
patterns={'exact-selection':r'contextSelection|buildSelectableContextTurns|selectedTurnRange|selectContextRange|finalizeModelTurn','turn-range-contract':r'turn_boundary|context.{0,35}(selection|range)|complete.{0,20}user.{0,10}turn|上下文.{0,15}(选择|范围)|模型轮|完整任务','old-failed':r'(?:failed|失败|SKIP).{0,100}(?:contextSelection|forkSession|turn_boundary|context.?selection)|(?:contextSelection|forkSession|turn_boundary|context.?selection).{0,100}(?:failed|失败|SKIP)'}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()};counts={k:0 for k in patterns};hits={k:[] for k in patterns};stats={'markdownFiles':0,'jsonFiles':0,'stringLeaves':0,'scalarLeaves':0};inventory=[];errors=[];cap=60
started=datetime.now(timezone.utc).isoformat()
def match(text,path,where):
 for key,rx in compiled.items():
  for found in rx.finditer(text):
   counts[key]+=1
   if len(hits[key])<cap:hits[key].append({'path':path,'at':where,'context':text[max(0,found.start()-140):min(len(text),found.end()+220)]})
def walk(value,path,where='$'):
 if isinstance(value,dict):
  for key,item in value.items():walk(item,path,where+'['+json.dumps(key,ensure_ascii=False)+']')
 elif isinstance(value,list):
  for index,item in enumerate(value):walk(item,path,where+'['+str(index)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(value,str):stats['stringLeaves']+=1;match(value,path,where)
  else:match(json.dumps(value,ensure_ascii=False),path,where)
paths=sorted(q for name in ('docs','bugs') for q in (root/name).rglob('*') if q.is_file() and q.suffix.lower() in ('.md','.json') and not str(q.relative_to(root)).startswith(excluded))
for q in paths:
 rel=str(q.relative_to(root));b=q.read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 try:
  text=b.decode('utf-8')
  if q.suffix.lower()=='.md':stats['markdownFiles']+=1;match(text,rel,'whole Markdown')
  else:stats['jsonFiles']+=1;walk(json.loads(text),rel)
 except Exception as exc:errors.append({'path':rel,'error':str(exc)})
d={'formalBaselineProvidedByRoot':'4be4016b8661c6a10c60f4eb0f218552b4b7c5d0','peerOriginalPrepParent':'4dad999bd43b776995b5d212dde275dab86a1ddd','startedUTC':started,'completedUTC':datetime.now(timezone.utc).isoformat(),'excluded':excluded,'includesFrozenRound31':True,'archivesIncluded':True,'inventory':inventory,'stats':stats,'patterns':patterns,'occurrenceCounts':counts,'contextCapEach':cap,'hits':hits,'parseErrors':errors,'exactArchiveDirectoryFiles':sum(any(p in ('archive','_archive') for p in Path(x['path']).parts[:-1]) for x in inventory),'productAttempts':0,'gitCommands':0,'limits':'All prior MD plus recursive JSON value scalars, not keys. Metadata/regex navigation is not semantic history exhaustion. Only retained selected contexts inspected separately.'}
(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'files':len(inventory),'stats':stats,'counts':counts,'saved':{k:len(v) for k,v in hits.items()},'parseErrors':errors},ensure_ascii=False))

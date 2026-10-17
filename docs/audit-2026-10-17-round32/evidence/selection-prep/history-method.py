from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round32-selection-frontier')
patterns={'exact':r'contextSelection|buildSelectableContextTurns|groupStreamItemsIntoContextTurns|alignContextSelectionGroups|selectedTurnRange|copyContextPackageOverrides|modelSelection|persistDefaultTextModel','turn-contract':r'(?:context.selection|上下文|context.package|buildSelectableContextTurns).{0,180}(?:turn_boundary|boundary|边界|complete.turn|user.turn)|(?:turn_boundary|boundary).{0,150}(?:contextSelection|selectable|选择|context.package)','old-failed':r'(?:contextSelection|modelSelection|context.package|上下文包).{0,140}(?:fail|失败|skip|跳过)|(?:fail|失败|skip|跳过).{0,140}(?:contextSelection|modelSelection|context.package)'}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};inv=[];errors=[];stats=collections.Counter()
def leaves(v,at='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,at+'['+str(i)+']')
 else:yield at,v
for base in ['docs','bugs']:
 for p in sorted((root/base).rglob('*')):
  if not p.is_file() or p.suffix not in ['.md','.json'] or any(x in p.parts for x in ['audit-2026-10-17-round31','audit-2026-10-17-round32']):continue
  b=p.read_bytes();rel=str(p.relative_to(root));inv.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()});stats['archivePaths']+=int(any(x in ['archive','_archive'] for x in p.parts))
  try:
   if p.suffix=='.md':stats['markdown']+=1;rows=[(str(i),s) for i,s in enumerate(b.decode().splitlines(),1)]
   else:
    stats['json']+=1;vs=list(leaves(json.loads(b)));stats['scalarLeaves']+=len(vs);stats['stringLeaves']+=sum(isinstance(v,str) for _,v in vs);rows=[(at,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)) for at,v in vs]
   for at,s in rows:
    for k,regex in compiled.items():
     for m in regex.finditer(s):
      counts[k]+=1
      if len(hits[k])<100:hits[k].append({'path':rel,'location':at,'excerpt':s[max(0,m.start()-140):min(len(s),m.end()+650)]})
  except Exception as ex:errors.append({'path':rel,'error':str(ex)})
d={'readAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'parentReportedPrepContext':'4dad999bd43b776995b5d212dde275dab86a1ddd','formalBaseline':None,'roots':['docs','bugs'],'excluded':['docs/audit-2026-10-17-round31/**','docs/audit-2026-10-17-round32/**'],'totals':{'files':len(inv),**dict(stats),'parseErrors':len(errors)},'parseErrors':errors,'patterns':patterns,'matchCounts':counts,'contextCap':100,'retainedContextCounts':{k:len(v) for k,v in hits.items()},'hits':hits,'inventory':inv,'inventoryCanonicalSha256':hashlib.sha256(json.dumps(inv,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'gitCommands':0,'productExecution':False,'limits':['Recursive JSON value scalars, not keys; archive/_archive exact path parts included.','Byte hash is captured before parsing/searching each file; inventory hash does not mean full semantic reading.','Keyword/capped navigation is not historical semantic exhaustion. Current mutable31/future32 excluded; parent4dad remains prep context, not future formal baseline.']};(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'totals':d['totals'],'matches':counts,'retained':d['retainedContextCounts'],'inventorySha256':d['inventoryCanonicalSha256']},ensure_ascii=False))

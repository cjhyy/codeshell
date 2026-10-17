from pathlib import Path
import json,re,hashlib,datetime,collections
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');o=Path('/tmp/codeshell-audit-round38-mcp-patch-frontier')
patterns={'targets':r'mcpSettingsPatch|McpSection|buildMcp.*Patch|MCP.*patch','patch-contract':r'(?:mcp|MCP).{0,140}(?:patch|merge|field|保留|合并|字段)|(?:patch|merge|保留|合并|字段).{0,100}(?:mcp|MCP)','old-failed':r'(?:mcpSettingsPatch|McpSection|mcp.{0,20}patch).{0,120}(?:failed|skip|失败|跳过)'}
rs={k:re.compile(v,re.I) for k,v in patterns.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};inv=[];stats=collections.Counter();errors=[]
def leaves(v,at='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,at+'['+str(i)+']')
 else:yield at,v
for base in ['docs','bugs']:
 for p in sorted((r/base).rglob('*')):
  if not p.is_file() or p.suffix not in ['.md','.json'] or any(x in p.parts for x in ['audit-2026-10-17-round37','audit-2026-10-17-round38']):continue
  b=p.read_bytes();path=str(p.relative_to(r));inv.append({'path':path,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()});stats['archivePaths']+=int(any(x in ['archive','_archive'] for x in p.parts))
  try:
   if p.suffix=='.md':stats['markdown']+=1;rows=[(str(i),s) for i,s in enumerate(b.decode().splitlines(),1)]
   else:
    stats['json']+=1;v=list(leaves(json.loads(b)));stats['stringLeaves']+=sum(isinstance(x,str) for _,x in v);stats['scalarLeaves']+=len(v);rows=[(at,x if isinstance(x,str) else json.dumps(x,ensure_ascii=False)) for at,x in v]
   for at,s in rows:
    for k,rx in rs.items():
     for m in rx.finditer(s):
      counts[k]+=1
      if len(hits[k])<100:hits[k].append({'path':path,'location':at,'excerpt':s[max(0,m.start()-140):min(len(s),m.end()+650)]})
  except Exception as ex:errors.append({'path':path,'error':str(ex)})
h={'parentReportedPrepContext':'ee5c','formalBaseline':None,'prepOnly':True,'readAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'roots':['docs','bugs'],'excluded':['docs/audit-2026-10-17-round37/**','docs/audit-2026-10-17-round38/**'],'totals':{'files':len(inv),**dict(stats),'parseErrors':len(errors)},'parseErrors':errors,'patterns':patterns,'matchCounts':counts,'contextCap':100,'retainedContextCounts':{k:len(v) for k,v in hits.items()},'hits':hits,'inventory':inv,'inventoryCanonicalSha256':hashlib.sha256(json.dumps(inv,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'productExecution':False,'gitCommands':0,'limits':['Whole MD by lines and recursively parsed JSON value scalars, keys excluded; archive/_archive exact path parts.','Per-file bytes captured during a dated metadata pass; not a frozen global Git snapshot and no assumption that another thread cannot edit a historical document.','Keyword/capped context navigation does not prove full semantic coverage or novelty.']};(o/'history.json').write_text(json.dumps(h,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'totals':h['totals'],'counts':counts,'retained':h['retainedContextCounts'],'inventorySha256':h['inventoryCanonicalSha256']},ensure_ascii=False))

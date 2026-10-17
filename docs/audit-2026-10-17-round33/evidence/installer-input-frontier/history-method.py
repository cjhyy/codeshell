from pathlib import Path
import json,re,hashlib,datetime,collections
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');o=Path('/tmp/codeshell-audit-round33-installer-input-frontier')
patterns={'npm-selector':r'parseNpmPluginSource|resolveNpmPlugin|installPluginFromNpm|NPM_DIST_TAG|requestedSelector|selectorKind|npm plugin auto-update','npm-contract':r'(?:npm|dist.tag).{0,120}(?:exact.version|selector|immutable|auto.update|latest|Phase.A)|(?:selector|resolvedVersion).{0,100}(?:npm|source|tag|exact)','cli-await':r'(?:installPluginFromPath|plugin install).{0,150}(?:await|Promise|未等待|异步|成功日志)|(?:await|Promise|未等待).{0,150}(?:installPluginFromPath|plugin install)','old-failed':r'(?:Skill|frontmatter|installer|parseSource).{0,100}(?:failed|fail|skip|失败|跳过)'}
regexes={k:re.compile(v,re.I) for k,v in patterns.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns};inv=[];errors=[];stats=collections.Counter()
def leaves(v,at='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,at+'['+str(i)+']')
 else:yield at,v
for base in ['docs','bugs']:
 for p in sorted((r/base).rglob('*')):
  if not p.is_file() or p.suffix not in ['.md','.json'] or any(x in p.parts for x in ['audit-2026-10-17-round32','audit-2026-10-17-round33']):continue
  b=p.read_bytes();path=str(p.relative_to(r));inv.append({'path':path,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()});stats['archivePaths']+=int(any(x in ['archive','_archive'] for x in p.parts))
  try:
   if p.suffix=='.md':stats['markdown']+=1;rows=[(str(i),t) for i,t in enumerate(b.decode().splitlines(),1)]
   else:
    stats['json']+=1;vs=list(leaves(json.loads(b)));stats['scalarLeaves']+=len(vs);stats['stringLeaves']+=sum(isinstance(v,str) for _,v in vs);rows=[(at,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)) for at,v in vs]
   for at,t in rows:
    for k,regex in regexes.items():
     for m in regex.finditer(t):
      counts[k]+=1
      if len(hits[k])<100:hits[k].append({'path':path,'location':at,'excerpt':t[max(0,m.start()-140):min(len(t),m.end()+650)]})
  except Exception as ex:errors.append({'path':path,'error':str(ex)})
h={'parentReportedPrepContext':'4be4016b8661c6a10c60f4eb0f218552b4b7c5d0','prepOnly':True,'formalBaseline':None,'readAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'roots':['docs','bugs'],'excluded':['docs/audit-2026-10-17-round32/**','docs/audit-2026-10-17-round33/**'],'totals':{'files':len(inv),**dict(stats),'parseErrors':len(errors)},'parseErrors':errors,'patterns':patterns,'matchCounts':counts,'contextCap':100,'retainedContextCounts':{k:len(v) for k,v in hits.items()},'hits':hits,'inventory':inv,'inventoryCanonicalSha256':hashlib.sha256(json.dumps(inv,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'productExecution':False,'gitCommands':0,'limits':['All prior MD and recursively parsed JSON scalar values, not keys; exact archive/_archive included.','Original mutable32/future33 exclusions and parent preserved. File hashes or keyword/capped contexts are not semantic exhaustion.','No product import/test/install/check/update/network/native/Git/authority or user directory operation.']};(o/'history.json').write_text(json.dumps(h,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'totals':h['totals'],'matchCounts':counts,'retained':h['retainedContextCounts'],'inventoryCanonicalSha256':h['inventoryCanonicalSha256']},ensure_ascii=False))

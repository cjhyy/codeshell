from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, re, subprocess
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out=Path('/tmp/codeshell-audit-round43-core-data-frontier')
started=datetime.now(timezone.utc).isoformat()
allpaths=subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=repo,check=True,capture_output=True,text=True).stdout.splitlines()
excluded=re.compile(r'(^|/)audit-2026-10-17-round(?:40|41|42|43)(/|$)')
paths=sorted(p for p in allpaths if not excluded.search(p))
leafs={'translator':'packages/core/src/tool-system/builtin/agent-transcript-translator.ts','process-state':'packages/server/src/panels/process-state.ts'}
sha={x['path']:x['sha256'] for x in json.loads((out/'initial-pins.json').read_text())['files']}
queries={k:lambda s,p=p:p in s or p.rsplit('/',1)[1] in s for k,p in leafs.items()}
queries.update({k+'-current-sha':lambda s,p=p:sha[p] in s for k,p in leafs.items()})
hits={k:0 for k in queries};contexts={k:[] for k in queries}; cap=80
inventory=[];coverage=[];errors=[];strings=0;scalars=0
keys=['path','file','sourcePath','source','sha256','sha','sourceSha256','initialSemanticReadSha256','coverage','selectedLineRanges','selectedRanges','ranges','lineRanges','readLineRanges','lineCount','totalLines','semanticLines','semanticLineCount','declaredReadLineCount','readLineCount','readKind','role','kind','firstEverSemanticReadClaim']
def observe(rel,loc,v,parent=None):
 global strings,scalars
 if isinstance(v,dict):
  for k,x in v.items(): observe(rel,loc+'/'+str(k).replace('~','~0').replace('/','~1'),x,v)
 elif isinstance(v,list):
  for i,x in enumerate(v): observe(rel,loc+'/'+str(i),x,v)
 else:
  scalars+=1
  if isinstance(v,str):
   strings+=1; unit(rel,loc,v)
   if isinstance(parent,dict):
    for name,p in leafs.items():
     if v==p or v.endswith('/'+p) or v==p.rsplit('/',1)[1]:
      row={k:parent[k] for k in keys if k in parent}
      coverage.append({'candidate':name,'historyPath':rel,'pointer':loc,'row':row,'meaning':'Explicit row/value metadata only; full reading requires manual interpretation of coverage and current SHA'})
def unit(rel,loc,s):
 for name,pred in queries.items():
  if pred(s):
   hits[name]+=1
   if len(contexts[name])<cap:
    token=leafs.get(name,sha[leafs[name.removesuffix('-current-sha')]] if name.endswith('-current-sha') else '')
    i=s.find(token);i=max(0,i);a=max(0,i-350);b=min(len(s),i+750)
    contexts[name].append({'path':rel,'locator':loc,'valueChars':len(s),'offset':i,'contextStart':a,'contextEnd':b,'text':s[a:b],'wholeValueIncluded':a==0 and b==len(s)})
for rel in paths:
 p=repo/rel;b=p.read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if p.suffix=='.md': unit(rel,'markdown-text',b.decode('utf-8'))
 else:
  try: d=json.loads(b)
  except Exception as e: errors.append({'path':rel,'error':type(e).__name__+': '+str(e)});continue
  observe(rel,'',d)
result={'startedUTC':started,'finishedUTC':datetime.now(timezone.utc).isoformat(),'method':'All inventory MD text + all recursively visited JSON value scalars; keys not searched. One query hit per string value/MD document, bounded saved context. Source coverage rows selected by exact path scalar with sibling coverage/hash fields, not an unread claim.','scope':{'includeFrozenThrough':39,'excludeMutableFuture':[40,41,42,43],'roots':['docs','bugs'],'archive':'exact path components archive or _archive included'},'fileCount':len(inventory),'markdown':sum(x['path'].endswith('.md') for x in inventory),'json':sum(x['path'].endswith('.json') for x in inventory),'jsonStringLeaves':strings,'jsonScalarLeaves':scalars,'exactArchivePaths':sum(any(c in ('archive','_archive') for c in Path(x['path']).parts) for x in inventory),'parseErrors':errors,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in hits},'inventory':inventory}
(out/'history.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
(out/'history-contexts.json').write_text(json.dumps(contexts,ensure_ascii=False,indent=2)+'\n')
(out/'coverage-gate-rows.json').write_text(json.dumps({'rows':coverage,'count':len(coverage),'semanticInterpretationPending':True},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='inventory'},ensure_ascii=False));print('coverageRows',len(coverage))

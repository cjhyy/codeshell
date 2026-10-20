from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re,subprocess
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round44-data-frontier');started=datetime.now(timezone.utc).isoformat()
exclude=re.compile(r'(^|/)audit-2026-10-17-round(?:41|42|43|44)(/|$)')
paths=sorted(p for p in subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=repo,check=True,capture_output=True,text=True).stdout.splitlines() if not exclude.search(p))
initial=json.loads((out/'initial-pins.json').read_text())['files'];by={x['path']:x for x in initial}
leafs={'codex-parse':initial[0]['path'],'web-format':initial[1]['path']}
tokens={'codex-parse':[leafs['codex-parse'],'codex-parse.ts'],'web-format':[leafs['web-format'],'web/src/lib/format.ts'],'codex-parse-current-sha':[initial[0]['sha256']],'web-format-current-sha':[initial[1]['sha256']]}
hits={k:0 for k in tokens};contexts={k:[] for k in tokens};cap=80;inventory=[];coverage=[];errors=[];strings=0;scalars=0
fields=['path','file','sourcePath','source','sha256','sha','sourceSha256','initialSemanticReadSha256','coverage','selectedLineRanges','selectedRanges','ranges','lineRanges','readLineRanges','lineCount','totalLines','semanticLines','semanticLineCount','declaredReadLineCount','readLineCount','readKind','role','kind','firstEverSemanticReadClaim']
def unit(rel,loc,s):
 for name,ts in tokens.items():
  found=[s.find(t) for t in ts if t in s]
  if found:
   hits[name]+=1
   if len(contexts[name])<cap:
    i=min(found);a=max(0,i-400);b=min(len(s),i+850)
    contexts[name].append({'path':rel,'locator':loc,'valueChars':len(s),'offset':i,'contextStart':a,'contextEnd':b,'text':s[a:b],'wholeValueIncluded':a==0 and b==len(s)})
def walk(rel,loc,v,parent=None):
 global strings,scalars
 if isinstance(v,dict):
  for k,x in v.items():walk(rel,loc+'/'+str(k).replace('~','~0').replace('/','~1'),x,v)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(rel,loc+'/'+str(i),x,v)
 else:
  scalars+=1
  if isinstance(v,str):
   strings+=1;unit(rel,loc,v)
   if isinstance(parent,dict):
    for name,p in leafs.items():
     if v==p or v.endswith('/'+p) or v==p.rsplit('/',1)[1]:coverage.append({'candidate':name,'historyPath':rel,'pointer':loc,'row':{k:parent[k] for k in fields if k in parent},'meaning':'Explicit path/hash/coverage row metadata, not an unread/full semantic conclusion'})
for rel in paths:
 b=(repo/rel).read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if rel.endswith('.md'):unit(rel,'markdown-text',b.decode())
 else:
  try:walk(rel,'',json.loads(b))
  except Exception as e:errors.append({'path':rel,'error':type(e).__name__+': '+str(e)})
r={'startedUTC':started,'finishedUTC':datetime.now(timezone.utc).isoformat(),'scope':{'includeFrozenThrough':40,'excludeFutureOrTmpOnly':[41,42,43,44],'archives':'archive/_archive exact path components included'},'method':'All MD text + all recursive JSON value scalars; keys not searched; one hit per string/MD unit; literal tokens anchor first actual matching token, cap80. Coverage dictionaries only explicit metadata.','fileCount':len(inventory),'markdown':sum(x['path'].endswith('.md') for x in inventory),'json':sum(x['path'].endswith('.json') for x in inventory),'jsonStringLeaves':strings,'jsonScalarLeaves':scalars,'exactArchivePaths':sum(any(c in ('archive','_archive') for c in Path(x['path']).parts) for x in inventory),'parseErrors':errors,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in tokens},'inventory':inventory}
(out/'history.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');(out/'history-contexts.json').write_text(json.dumps(contexts,ensure_ascii=False,indent=2)+'\n');(out/'coverage-gate-rows.json').write_text(json.dumps({'rows':coverage,'count':len(coverage)},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in r.items() if k!='inventory'},ensure_ascii=False));print('coverageRows',len(coverage))

from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re,subprocess
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round52-context-review');started=datetime.now(timezone.utc).isoformat();pins=json.loads((out/'initial-pins.json').read_text())['files'];leafs={'context':pins[0]['path'],'conversation':pins[1]['path']};tokens={k:[p,p.rsplit('/',1)[1]] for k,p in leafs.items()};tokens.update({k+'-sha':[x['sha256']] for k,x in zip(leafs,pins)});cap=100
exclude=re.compile(r'(^|/)audit-2026-10-17-round(?:44|45|46|47|48|49|50|51|52)(/|$)');paths=sorted(p for p in subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=repo,capture_output=True,text=True,check=True).stdout.splitlines() if not exclude.search(p))
hits={k:0 for k in tokens};contexts={k:[] for k in tokens};coverage=[];inventory=[];errors=[];strings=0;scalars=0
fields=['path','sha256','sha','sourceSha256','frozenSha256','coverage','scope','selectedLineRanges','selectedRanges','ranges','lineRanges','readLineRanges','readRanges','readCoverage','lineCount','lines','totalLines','semanticLineCount','role','kind','coverageKind','rawCoverageLabel']
def unit(rel,loc,s):
 for name,ts in tokens.items():
  pos=[s.find(t) for t in ts if t in s]
  if pos:
   hits[name]+=1
   if len(contexts[name])<cap:
    i=min(pos);a=max(0,i-400);b=min(len(s),i+900);contexts[name].append({'path':rel,'locator':loc,'valueChars':len(s),'offset':i,'contextStart':a,'contextEnd':b,'text':s[a:b],'wholeValueIncluded':a==0 and b==len(s)})
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
     if v==p or v.endswith('/'+p):coverage.append({'candidate':name,'historyPath':rel,'pointer':loc,'row':{k:parent[k] for k in fields if k in parent}})
for rel in paths:
 b=(repo/rel).read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if rel.endswith('.md'):unit(rel,'markdown-text',b.decode())
 else:
  try:walk(rel,'',json.loads(b))
  except Exception as e:errors.append({'path':rel,'error':type(e).__name__+': '+str(e)})
h={'startedUTC':started,'finishedUTC':datetime.now(timezone.utc).isoformat(),'scope':{'includeFrozenThrough':43,'excludeMutableFuture':[44,45,46,47,48,49,50,51,52],'archives':'exact archive/_archive path components included'},'method':'All MD text + all recursively visited JSON value scalars; keys not searched; literal tokens one hit per string/MD unit; cap100; dictionaries extracted only explicit path/hash/coverage/scope/range metadata, not unread/full proof.','fileCount':len(inventory),'md':sum(x['path'].endswith('.md') for x in inventory),'json':sum(x['path'].endswith('.json') for x in inventory),'jsonStrings':strings,'jsonScalars':scalars,'exactArchivePaths':sum(any(c in ('archive','_archive') for c in Path(x['path']).parts) for x in inventory),'parseErrors':errors,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in tokens},'inventory':inventory}
(out/'history.json').write_text(json.dumps(h,ensure_ascii=False,indent=2)+'\n');(out/'history-contexts.json').write_text(json.dumps(contexts,ensure_ascii=False,indent=2)+'\n');(out/'coverage-gate-rows.json').write_text(json.dumps({'rows':coverage,'count':len(coverage),'requiresManualFullOrSelectedInterpretation':True},ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in h.items() if k!='inventory'},ensure_ascii=False));print('coverageRows',len(coverage))

from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re,subprocess
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round85-latest-scroll');start=datetime.now(timezone.utc).isoformat();pins=json.loads((out/'initial-pins.json').read_text())['files'][:1];leafs={'latest-scroll':pins[0]};tokens={k:[r['path'],r['path'].rsplit('/',1)[1]] for k,r in leafs.items()};tokens.update({k+'-sha':[r['sha256']] for k,r in leafs.items()});cap=100
paths=[]
for rel in subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=repo,capture_output=True,text=True,check=True).stdout.splitlines():
 ms=re.findall(r'(?:^|/)audit-2026-10-17-round(\d+)(?:/|$)',rel)
 if not any(int(n)>=50 for n in ms):paths.append(rel)
paths.sort();hits={k:0 for k in tokens};contexts={k:[] for k in tokens};coverage=[];inventory=[];errors=[];strings=0;scalars=0
fields=['path','sha256','sha','sourceSha256','frozenSha256','coverage','scope','review','inspectionScope','readScope','reviewScope','reviewMode','semanticRead','selectedLineRanges','selectedRanges','ranges','lineRanges','readLineRanges','readRanges','readCoverage','lineCount','lines','totalLines','semanticLineCount','role','kind','coverageKind','rawCoverageLabel']
def unit(rel,loc,s):
 for name,ts in tokens.items():
  pos=[s.find(t) for t in ts if t in s]
  if pos:
   hits[name]+=1
   if len(contexts[name])<cap:
    i=min(pos);a=max(0,i-350);z=min(len(s),i+800);contexts[name].append({'path':rel,'locator':loc,'valueChars':len(s),'contextStart':a,'contextEnd':z,'text':s[a:z],'wholeValueIncluded':a==0 and z==len(s)})
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
     if v==p['path'] or v.endswith('/'+p['path']):coverage.append({'candidate':name,'historyPath':rel,'pointer':loc,'row':{k:parent[k] for k in fields if k in parent}})
for rel in paths:
 b=(repo/rel).read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if rel.endswith('.md'):unit(rel,'markdown-text',b.decode())
 else:
  try:walk(rel,'',json.loads(b))
  except Exception as e:errors.append({'path':rel,'error':type(e).__name__+': '+str(e)})
h={'startedUTC':start,'finishedUTC':datetime.now(timezone.utc).isoformat(),'scope':{'includeFrozenThrough':49,'excludeDateRoundAtLeast':50,'archives':'All rg-visible docs/bugs MD+JSON including archive/_archive components.'},'method':'Full recursive JSON value scalar/string and MD machine inventory; keys not searched. Literal path/basename/SHA one hit per string or MD unit. cap100 saved bounded windows, not semantic exhaustion. Same-object named scope/review/inspectionScope/ranges retained for manual gate; no-row unknown.','fileCount':len(inventory),'md':sum(x['path'].endswith('.md') for x in inventory),'json':sum(x['path'].endswith('.json') for x in inventory),'jsonStrings':strings,'jsonScalars':scalars,'exactArchivePaths':sum(any(c in ('archive','_archive') for c in Path(x['path']).parts) for x in inventory),'parseErrors':errors,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in tokens},'inventory':inventory}
for fn,v in [('history.json',h),('history-contexts.json',contexts),('coverage-gate-rows.json',{'rows':coverage,'count':len(coverage),'interpretationRequired':True})]:(out/fn).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in h.items() if k!='inventory'},ensure_ascii=False));print('coverageRows',len(coverage))

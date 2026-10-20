from pathlib import Path
from datetime import datetime,timezone
import json,hashlib
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round44-data-frontier');h=json.loads((out/'history.json').read_text());pin=json.loads((out/'selected-leaf-pin.json').read_text());p=pin['path'];sha=pin['sha256'];tokens={'selected-path':[p,'agent-transcript-translator.ts'],'selected-sha':[sha]};cap=100;hits={k:0 for k in tokens};contexts={k:[] for k in tokens};rows=[];drift=[];errors=[];strings=0;scalars=0
fields=['path','sha256','sha','frozenSha256','sourceSha256','coverage','scope','selectedLineRanges','selectedRanges','ranges','lineRanges','readLineRanges','readRanges','lineCount','lines','totalLines','semanticLines','semanticLineCount','declaredReadLineCount','readCoverage','role','kind']
def unit(rel,loc,s):
 for k,ts in tokens.items():
  pos=[s.find(t) for t in ts if t in s]
  if pos:
   hits[k]+=1
   if len(contexts[k])<cap:
    i=min(pos);a=max(0,i-350);b=min(len(s),i+850);contexts[k].append({'path':rel,'locator':loc,'valueChars':len(s),'offset':i,'contextStart':a,'contextEnd':b,'text':s[a:b],'wholeValueIncluded':a==0 and b==len(s)})
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
   if isinstance(parent,dict) and (v==p or v.endswith('/'+p) or v=='agent-transcript-translator.ts'):rows.append({'historyPath':rel,'pointer':loc,'row':{k:parent[k] for k in fields if k in parent}})
for row in h['inventory']:
 b=(repo/row['path']).read_bytes();s=hashlib.sha256(b).hexdigest()
 if len(b)!=row['bytes'] or s!=row['sha256']:drift.append({'path':row['path'],'initial':row,'now':{'bytes':len(b),'sha256':s}})
 if row['path'].endswith('.md'):unit(row['path'],'markdown-text',b.decode())
 else:
  try:walk(row['path'],'',json.loads(b))
  except Exception as e:errors.append({'path':row['path'],'error':str(e)})
r={'finishedUTC':datetime.now(timezone.utc).isoformat(),'inventorySource':'history.json3696 frozen40/exclude41–44; original rows preserved','fileCount':h['fileCount'],'stringLeaves':strings,'scalarLeaves':scalars,'parseErrors':errors,'datedByteDrift':drift,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in tokens},'coverageRows':rows,'contexts':contexts,'fullCoverageInterpretation':'Pending manual reading of explicit scope/ranges+current SHA; no-row/loaded-module inventory does not mean unread or full; old failed runtime remains skipped'}
(out/'selected-history.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k not in ['coverageRows','contexts']},ensure_ascii=False));print('meaningfulCoverageRows',json.dumps([x for x in rows if x['row'].get('sha256') or x['row'].get('coverage') or x['row'].get('scope')],ensure_ascii=False))

from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round44-data-frontier');h=json.loads((out/'history.json').read_text());cap=80
queries={'translator-revoke':lambda s:('transcript-translator' in s or 'streamingassistantid' in s) and 'tombstone' in s,'background-revoke':lambda s:'tombstone' in s and any(t in s for t in ['background','sub-agent','子代理','子agent']) and any(t in s for t in ['partial','撤销','revok','残留','ghost']),'fallback-partial':lambda s:any(t in s for t in ['streaming fallback','streaming_fallback']) and any(t in s for t in ['partial','tombstone','撤销'])}
anchor=['agent-transcript-translator','streamingAssistantId','tombstone','streaming fallback','streaming_fallback']
hits={k:0 for k in queries};contexts={k:[] for k in queries};drift=[];errors=[];strings=0;scalars=0;mdunits=0

def unit(rel,loc,s):
 low=s.lower()
 for k,p in queries.items():
  if p(low):
   hits[k]+=1
   if len(contexts[k])<cap:
    pos=[low.find(t.lower()) for t in anchor if t.lower() in low];i=min(pos) if pos else 0;a=max(0,i-450);b=min(len(s),i+1100)
    contexts[k].append({'path':rel,'locator':loc,'valueChars':len(s),'offset':i,'contextStart':a,'contextEnd':b,'text':s[a:b],'wholeValueIncluded':a==0 and b==len(s)})
def walk(rel,loc,v):
 global strings,scalars
 if isinstance(v,dict):
  for k,x in v.items():walk(rel,loc+'/'+str(k).replace('~','~0').replace('/','~1'),x)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(rel,loc+'/'+str(i),x)
 else:
  scalars+=1
  if isinstance(v,str):strings+=1;unit(rel,loc,v)
for row in h['inventory']:
 b=(repo/row['path']).read_bytes();sha=hashlib.sha256(b).hexdigest()
 if len(b)!=row['bytes'] or sha!=row['sha256']:drift.append({'path':row['path'],'initial':row,'now':{'bytes':len(b),'sha256':sha}})
 if row['path'].endswith('.md'):
  text=b.decode();line=1
  for block in re.split(r'(\n\s*\n)',text):
   if block.strip():mdunits+=1;unit(row['path'],'markdown-paragraph-start-line:'+str(line),block)
   line+=block.count('\n')
 else:
  try:walk(row['path'],'',json.loads(b))
  except Exception as e:errors.append({'path':row['path'],'error':str(e)})
r={'finishedUTC':datetime.now(timezone.utc).isoformat(),'method':'Same3696 inventory, every MD paragraph + every recursive JSON string value; all scalar counts preserved; literal/AND predicates, one hit per unit, cap80. No semantic exhaustion. Keys not searched.','fileCount':h['fileCount'],'mdParagraphUnits':mdunits,'jsonStrings':strings,'jsonScalars':scalars,'parseErrors':errors,'datedByteDrift':drift,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in queries},'contexts':contexts,'readContextsNotYetClaimed':True}
(out/'cause-history.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k!='contexts'},ensure_ascii=False));print('locatorGroups',json.dumps({k:[{'index':i,'path':x['path'],'locator':x['locator'],'chars':x['valueChars']} for i,x in enumerate(v)] for k,v in contexts.items()},ensure_ascii=False))

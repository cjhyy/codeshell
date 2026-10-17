from pathlib import Path
from datetime import datetime, timezone
import json, hashlib
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out=Path('/tmp/codeshell-audit-round43-core-data-frontier')
history=json.loads((out/'history.json').read_text())
queries={'exact-names':lambda s:'ProcessReceipts' in s or 'appendProcessEvent' in s,'replay-loss':lambda s:'Tool output was lost before it could be read' in s,'replay-fields':lambda s:'process.get' in s and ('nextSequence' in s or 'truncated' in s)}
tokens={'exact-names':['ProcessReceipts','appendProcessEvent'],'replay-loss':['Tool output was lost before it could be read'],'replay-fields':['process.get','nextSequence','truncated']}
hits={k:0 for k in queries};contexts={k:[] for k in queries};cap=80;changes=[];strings=0;scalars=0;errors=[]
def unit(rel,loc,s):
 for k,pred in queries.items():
  if pred(s):
   hits[k]+=1
   if len(contexts[k])<cap:
    positions=[s.find(t) for t in tokens[k] if t in s]; i=min(positions);a=max(0,i-400);b=min(len(s),i+1000)
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
for row in history['inventory']:
 p=repo/row['path'];b=p.read_bytes();sha=hashlib.sha256(b).hexdigest()
 if len(b)!=row['bytes'] or sha!=row['sha256']:changes.append({'path':row['path'],'before':row,'now':{'bytes':len(b),'sha256':sha}})
 if p.suffix=='.md':unit(row['path'],'markdown-text',b.decode())
 else:
  try:walk(row['path'],'',json.loads(b))
  except Exception as e:errors.append({'path':row['path'],'error':str(e)})
result={'timeUTC':datetime.now(timezone.utc).isoformat(),'inventorySource':'history.json immutable3581 snapshot; no added paths silently included','originalFileCount':history['fileCount'],'sameInventoryChangedRows':changes,'parseErrors':errors,'jsonStringLeavesThisPass':strings,'jsonScalarLeavesThisPass':scalars,'method':'All same-inventory MD/recursive JSON value scalar query; simple literal/AND, keys not searched; one hit per string/MD unit, cap80. Bounded contexts are not full documents.','queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in queries},'contexts':contexts,'oldFailedRuntimeNotReopened':True}
(out/'history-focused.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='contexts'},ensure_ascii=False))
for k,rows in contexts.items():
 for i,row in enumerate(rows):print(json.dumps({'query':k,'retainedIndex':i,**row},ensure_ascii=False))

from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round47-ui-data-frontier');h=json.loads((out/'history.json').read_text());cap=100
queries={'plugin-expand':lambda s:'expandplugincommand' in s or 'expandpluginslashcommand' in s,'draft-plugin-race':lambda s:('draft' in s or '草稿' in s) and ('plugin' in s or '插件' in s) and any(t in s for t in ['stale','switch','切换','覆盖','异步','late','mountedref']),'active-ref-draft':lambda s:'activebucketref.current' in s and ('draft' in s or 'setdraft' in s)}
anchors=['expandPluginCommand','expandPluginSlashCommand','plugin','插件','activeBucketRef.current'];hits={k:0 for k in queries};contexts={k:[] for k in queries};drift=[];errors=[];strings=0;scalars=0;paragraphs=0

def unit(rel,loc,s):
 low=s.lower()
 for k,p in queries.items():
  if p(low):
   hits[k]+=1
   if len(contexts[k])<cap:
    pos=[low.find(t.lower()) for t in anchors if t.lower() in low];i=min(pos) if pos else 0;a=max(0,i-450);b=min(len(s),i+1250);contexts[k].append({'path':rel,'locator':loc,'valueChars':len(s),'offset':i,'contextStart':a,'contextEnd':b,'text':s[a:b],'wholeValueIncluded':a==0 and b==len(s)})
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
 if len(b)!=row['bytes'] or sha!=row['sha256']:drift.append({'path':row['path'],'before':row,'now':{'bytes':len(b),'sha256':sha}})
 if row['path'].endswith('.md'):
  line=1
  for block in re.split(r'(\n\s*\n)',b.decode()):
   if block.strip():paragraphs+=1;unit(row['path'],'MD-paragraph-start:'+str(line),block)
   line+=block.count('\n')
 else:
  try:walk(row['path'],'',json.loads(b))
  except Exception as e:errors.append({'path':row['path'],'error':str(e)})
r={'finishedUTC':datetime.now(timezone.utc).isoformat(),'method':'Same3773 inventory all MD paragraphs + recursive JSON value strings (scalars counted), keys not searched; one hit per unit literal/AND; cap100; bounded windows do not imply whole-value/whole-history semantic reading','fileCount':h['fileCount'],'mdParagraphs':paragraphs,'jsonStrings':strings,'jsonScalars':scalars,'parseErrors':errors,'datedByteDrift':drift,'queries':{k:{'hits':hits[k],'cap':cap,'retained':len(contexts[k])} for k in queries},'contexts':contexts,'actualReadNotYetClaimed':True};(out/'cause-history.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k!='contexts'},ensure_ascii=False));print('locators',json.dumps({k:[{'i':i,'path':x['path'],'locator':x['locator'],'chars':x['valueChars']} for i,x in enumerate(v)] for k,v in contexts.items()},ensure_ascii=False))

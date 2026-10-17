from pathlib import Path
import json,hashlib,datetime
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round64-tui-status');hist=json.loads((out/'history.json').read_text());counts={k:0 for k in ['runstart','status-elapsed','background-elapsed','cost-model']};saved={k:[] for k in counts};drift=[];cap=30

def unit(path,loc,s):
 t=s.lower(); tests={'runstart':'runstartref' in t,'status-elapsed':'statusline' in t and any(x in t for x in ['elapsed','耗时','计时']),'background-elapsed':any(x in t for x in ['background','bgagent','后台']) and any(x in t for x in ['elapsed','runstart','耗时重置','计时重置']),'cost-model':'cost-tracker' in t and 'model' in t}
 for k,hit in tests.items():
  if not hit:continue
  counts[k]+=1
  if len(saved[k])>=cap:continue
  targets={'runstart':['runstartref'],'status-elapsed':['statusline'],'background-elapsed':['elapsed','runstart','耗时重置','计时重置'],'cost-model':['cost-tracker']}[k];pos=min(t.find(x) for x in targets if x in t);a=max(0,pos-350);z=min(len(s),pos+1000);saved[k].append({'path':path,'locator':loc,'valueChars':len(s),'contextStart':a,'contextEnd':z,'text':s[a:z],'wholeValueIncluded':a==0 and z==len(s)})
def walk(path,loc,v):
 if isinstance(v,dict):
  for k,x in v.items():walk(path,loc+'/'+str(k).replace('~','~0').replace('/','~1'),x)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(path,loc+'/'+str(i),x)
 elif isinstance(v,str):unit(path,loc,v)
for row in hist['inventory']:
 b=(repo/row['path']).read_bytes(); sha=hashlib.sha256(b).hexdigest()
 if sha!=row['sha256']:drift.append({'path':row['path'],'initialSha256':row['sha256'],'nowSha256':sha})
 if row['path'].endswith('.md'):unit(row['path'],'markdown-text',b.decode())
 else:walk(row['path'],'',json.loads(b))
r={'dateUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'Same pinned history members, recursive string values and MD text; simple literal/AND, cap30; bounded saved windows only; no product source read. Full hit counts are locator counts, not semantic review.','queries':{k:{'hits':v,'cap':cap,'retained':len(saved[k])} for k,v in counts.items()},'driftDuringFocusedRead':drift,'contexts':saved};(out/'history-focused.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k!='contexts'}))
for k,rs in saved.items():
 print(k,[(i,x['path'],x['locator']) for i,x in enumerate(rs)])

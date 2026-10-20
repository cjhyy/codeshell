from pathlib import Path
import json,re,hashlib
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round135-static-files');h=json.loads((D/'history-batch.json').read_text());rx=re.compile(r'mobileAssetPath|(?:percent.{0,10}encod|URL.{0,10}decod|decodeURIComponent|解码|百分号).{0,100}(?:static|静态|mobile)|(?:static|静态|mobile).{0,100}(?:percent.{0,10}encod|URL.{0,10}decod|decodeURIComponent|解码|百分号)',re.I)
hits=[];count=0;errors=[];members=[]
def walk(v,p=''):
 if isinstance(v,dict):
  for k,x in v.items():yield from walk(x,p+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,p+'/'+str(i))
 elif isinstance(v,str):yield p,v
for row in h['inventory']:
 p=R/row['path'];b=p.read_bytes()
 try:vals=enumerate(b.decode().splitlines(),1) if p.suffix=='.md' else walk(json.loads(b))
 except Exception as e:errors.append(dict(path=row['path'],error=str(e)));continue
 matched=False
 for loc,s in vals:
  m=rx.search(s)
  if not m:continue
  count+=1;matched=True
  if len(hits)<100:hits.append(dict(document=row['path'],location=loc,context=s[max(0,m.start()-300):m.end()+700],valueTruncated=len(s)>1000))
 if matched:members.append(row)
j=dict(historyFiles=len(h['inventory']),count=count,cap=100,hits=hits,matchedFiles=members,errors=errors,scope='Specific static/mobile encoded URI old-cause machine navigation, not full semantic dedup. JSON value strings only, current57 excluded by original inventory.',productExecution=0);(D/'cause-history.json').write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n');print(json.dumps(dict(count=count,matchedFiles=len(members),errors=errors)))

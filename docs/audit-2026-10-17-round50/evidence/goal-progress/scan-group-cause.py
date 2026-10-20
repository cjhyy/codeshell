from pathlib import Path
import json,re,hashlib,datetime
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');d=Path('/tmp/codeshell-audit-round91-goal-progress');h=json.loads((d/'history.json').read_text());p=re.compile(r'再续.{0,100}(?:按钮|分组|丢失)|(?:approaching_limit|GoalProgressView).{0,120}(?:group|onExtend|process)|(?:onExtend|过程分组|工具分组|turn_process_group).{0,100}(?:GoalProgress|goal_progress|再续)',re.I);hits=[];count=0;errors=[]
def leaves(v,at='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,at+'['+str(i)+']')
 else:yield at,v if isinstance(v,str) else json.dumps(v)
for item in h['inventory']:
 b=(r/item['path']).read_bytes();assert hashlib.sha256(b).hexdigest()==item['sha256']
 try:
  data=[('$',b.decode())] if item['path'].endswith('.md') else leaves(json.loads(b))
  for at,s in data:
   for m in p.finditer(s):
    count+=1
    if len(hits)<100:hits.append({'path':item['path'],'at':at,'context':s[max(0,m.start()-180):m.end()+500]})
 except Exception as e:errors.append({'path':item['path'],'error':str(e)})
a={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'parentInventory':'history.json','filesCheckedSameBytes':len(h['inventory']),'pattern':p.pattern,'count':count,'retained':len(hits),'cap':100,'errors':errors,'hits':hits,'productRuns':0};(d/'group-cause-history.json').write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in a.items() if k!='hits'},ensure_ascii=False))

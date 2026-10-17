from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,sys
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');OUT=Path('/tmp/codeshell-audit-round160-mcp-dot-history');plan=json.loads(Path(sys.argv[1]).read_text());rows=[]
for item in plan['items']:
 name=item['path'];b=(ROOT/name).read_bytes();pin={'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'pinAt':datetime.now(timezone.utc).isoformat()}
 # Persist each pin before semantic reading; keep ordinal file distinct from output records.
 (OUT/(plan['name']+'.'+str(len(rows))+'.pin.json')).write_text(json.dumps(pin,ensure_ascii=False,indent=2)+'\n')
 row={**pin,'readAt':datetime.now(timezone.utc).isoformat()}
 if 'ranges' in item:
  ls=b.decode().splitlines();row['selectedLineRanges']=item['ranges'];row['ranges']=[{'first':a,'last':z,'text':'\n'.join(f'{i}: {ls[i-1]}' for i in range(a,z+1))} for a,z in item['ranges']]
 else:
  obj=json.loads(b);matches=[];allids=[]
  def visit(v,ptr=''):
   if isinstance(v,dict):
    ident=v.get('id');title=v.get('title')
    if isinstance(ident,str) and isinstance(title,str):
     allids.append(ident)
     if any(q in (ident+' '+title).lower() for q in item['titleTerms']):matches.append({'pointer':ptr,'id':ident,'priority':v.get('priority'),'title':title})
    for k,x in v.items():visit(x,ptr+'/'+str(k).replace('~','~0').replace('/','~1'))
   elif isinstance(v,list):
    for i,x in enumerate(v):visit(x,ptr+'/'+str(i))
  visit(obj);row['selectedTitleObjects']=matches;row['machineIdTitleRowsSeen']=len(allids);row['allRowsSemanticallyRead']=False
 rows.append(row)
(OUT/(plan['name']+'.read.json')).write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
for row in rows:
 print(row['path'])
 for r in row.get('ranges',[]):print(r['text'])
 for r in row.get('selectedTitleObjects',[]):print(json.dumps(r,ensure_ascii=False))
 if 'machineIdTitleRowsSeen' in row:print('machine id/title rows',row['machineIdTitleRowsSeen'])

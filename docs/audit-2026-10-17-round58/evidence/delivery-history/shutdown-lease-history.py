from pathlib import Path
import json,hashlib,re,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round144-delivery-history')
B=Path('/tmp/codeshell-audit-round141-pairing/history-batch.json');batch=json.loads(B.read_text());inv=batch['inventory']
q=re.compile(r'delivery[-_ ]?queue|bound-session-chat|queue\.stop',re.I)
l=re.compile(r'\blease\b|租约',re.I)
s=re.compile(r'queue\.stop|shutdown|\bstop\b|drain|in[- ]?flight|排空|停机|停止队列',re.I)
persist=re.compile(r'persist|snapshot|consumer|覆盖|快照|消费者',re.I)
errors=[];drift=[];counts={};hits=[];total=0;scalar=0;allthree=0;cap=300
# Metadata only. JSON values (never keys) recursively traversed, no source/body imports.
def leaves(x,p=''):
 if isinstance(x,dict):
  for k,v in x.items():yield from leaves(v,p+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(x,list):
  for i,v in enumerate(x):yield from leaves(v,p+'/'+str(i))
 else:yield p,x
def add(f,loc,text,kind):
 global total,allthree
 total+=1;three=bool(q.search(text) and l.search(text) and s.search(text));allthree+=three
 counts[f]=counts.get(f,0)+1
 if len(hits)<cap:hits.append({'document':f,'location':loc,'kind':kind,'context':text[:1600],'contextTruncated':len(text)>1600,'allThreeInContext':three,'persistOrConsumerInContext':bool(persist.search(text)),'notSemanticEvidence':'Machine locator; original canonical context must be read separately.'})
for old in inv:
 f=old['path'];p=R/f
 try:
  b=p.read_bytes();h=hashlib.sha256(b).hexdigest()
  if len(b)!=old['bytes'] or h!=old['sha256']:drift.append({'path':f,'originalSha256':old['sha256'],'currentSha256':h,'originalBytes':old['bytes'],'currentBytes':len(b)})
  text=b.decode()
  if p.suffix.lower()=='.json':
   vals=list(leaves(json.loads(text)));scalar+=len(vals)
   body='\n'.join(v for _,v in vals if isinstance(v,str))
   if not (q.search(body) and l.search(body) and s.search(body)):continue
   for ptr,v in vals:
    if isinstance(v,str) and (l.search(v) or re.search(r'queue\.stop',v,re.I)):
     add(f,ptr,v,'document-coarse-compound-gated-json-value')
  else:
   if not(q.search(text) and l.search(text) and s.search(text)):continue
   ls=text.splitlines();spans=[]
   for i,line in enumerate(ls):
    if l.search(line) or re.search(r'queue\.stop',line,re.I):
     a=max(0,i-5);z=min(len(ls),i+6)
     if spans and a<=spans[-1][1]:spans[-1][1]=max(spans[-1][1],z)
     else:spans.append([a,z])
   for a,z in spans:add(f,[a+1,z],'\n'.join(ls[a:z]),'document-coarse-compound-gated-md-window')
 except Exception as e:errors.append({'path':f,'type':type(e).__name__,'message':str(e)})
r={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'One permitted metadata-only compound query over exact shared5850 inventory, archives retained, formal58+ absent from original inventory; JSON recursive value scalars only; doc coarse gate queue+lease+shutdown then leaf/window locators','inventoryOriginalAtUTC':batch['atUTC'],'historyFiles':len(inv),'jsonValueScalarsVisited':scalar,'patterns':{'queue':q.pattern,'lease':l.pattern,'shutdown':s.pattern,'persist':persist.pattern},'totalMatchingContexts':total,'matchingDocuments':len(counts),'contextsAllThreeInSameWindowOrValue':allthree,'cap':cap,'retainedContexts':len(hits),'countsByDocument':counts,'hits':hits,'errors':errors,'datedByteDrift':drift,'limits':'Derived scan/claims/copies remain locators, not independent semantic evidence. Current document bytes and original dated inventory distinguished. No exhaustive old-cause absence claim.','productFiles':[],'productExecution':0,'gitOperations':0}
(O/'shutdown-lease-history.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:r[k] for k in ['historyFiles','jsonValueScalarsVisited','totalMatchingContexts','matchingDocuments','contextsAllThreeInSameWindowOrValue','cap','retainedContexts','errors','datedByteDrift']},ensure_ascii=False))

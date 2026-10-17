from pathlib import Path
import json,hashlib,datetime
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round62-chat-adapter');hist=json.loads((out/'history.json').read_text());started=datetime.datetime.now(datetime.timezone.utc).isoformat();counts={'swc-old':0,'multi-account':0,'matrix-loop':0,'slack-thread':0};hits={k:[] for k in counts};cap=30;drift=[];errors=[]
def visit(rel,loc,s):
 lower=s.lower();matched={'swc-old':any(t in lower for t in ['swc-01','swc-02']),'multi-account':('chat' in lower or 'gateway' in lower) and any(t in lower for t in ['multi-account','多账号','错投']),'matrix-loop':'matrix' in lower and any(t in lower for t in ['回环','reply loop','self-reply']),'slack-thread':'slack' in lower and any(t in lower for t in ['thread_ts','thread丢','thread lost'])}
 for key,yes in matched.items():
  if not yes:continue
  counts[key]+=1
  if len(hits[key])>=cap:continue
  needles={'swc-old':['swc-01','swc-02'],'multi-account':['multi-account','多账号','错投'],'matrix-loop':['matrix'],'slack-thread':['slack']}[key];pos=min(lower.find(t) for t in needles if t in lower);a=max(0,pos-220);z=min(len(s),pos+850);hits[key].append({'path':rel,'locator':loc,'valueChars':len(s),'contextStart':a,'contextEnd':z,'text':s[a:z],'wholeValueIncluded':a==0 and z==len(s)})
def walk(rel,loc,v):
 if isinstance(v,dict):
  for k,x in v.items():walk(rel,loc+'/'+str(k).replace('~','~0').replace('/','~1'),x)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(rel,loc+'/'+str(i),x)
 elif isinstance(v,str):visit(rel,loc,v)
for row in hist['inventory']:
 rel=row['path'];b=(repo/rel).read_bytes();sha=hashlib.sha256(b).hexdigest()
 if sha!=row['sha256']:drift.append({'path':rel,'initialSha256':row['sha256'],'querySha256':sha,'initialBytes':row['bytes'],'queryBytes':len(b)})
 if rel.endswith('.md'):visit(rel,'markdown-text',b.decode())
 else:
  try:walk(rel,'',json.loads(b))
  except Exception as e:errors.append({'path':rel,'error':type(e).__name__+': '+str(e)})
(out/'cause-history.json').write_text(json.dumps({'startedUTC':started,'finishedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'inventoryCount':hist['fileCount'],'scopeInheritedFrom':'history.json','method':'Literal ASCII query terms over lowercased MD and recursive JSON string values; keys not searched; cap30; bounded snippets not semantic exhaustiveness','queries':{k:{'hits':counts[k],'cap':cap,'retained':len(hits[k])} for k in counts},'driftFromInitial':drift,'parseErrors':errors,'hits':hits},ensure_ascii=False,indent=2)+'\n');print(json.dumps({'counts':counts,'retained':{k:len(v) for k,v in hits.items()},'drift':drift,'parseErrors':errors},ensure_ascii=False))

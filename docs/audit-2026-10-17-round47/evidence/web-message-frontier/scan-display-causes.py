from pathlib import Path
import datetime,hashlib,json
BASE=Path('/tmp/codeshell-audit-round59-web-message-content')
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
pins=json.loads((BASE/'history-initial-pins.json').read_text())['files']
terms={'display_names':['MessageCopyButton','toolDisplaySummary','subagentStatusLabel','messageFilePath'],'web_display_cause':['web message','Web Markdown','Web消息','复制代码','复制回复','MessageContent.tsx:107','message-code-block']}
terms={k:[s.casefold() for s in v] for k,v in terms.items()}
cap=100; totals={k:0 for k in terms}; hits={k:[] for k in terms}; drift=[]; strings=0; scalars=0; errors=[]
def walk(v,p=''):
 global strings,scalars
 if isinstance(v,dict):
  for k,x in v.items(): yield from walk(x,p+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(v,list):
  for i,x in enumerate(v): yield from walk(x,p+'/'+str(i))
 else:
  scalars+=1
  if isinstance(v,str): strings+=1; yield p,v
for row in pins:
 path=row['path']; blob=(ROOT/path).read_bytes(); sha=hashlib.sha256(blob).hexdigest()
 if sha!=row['sha256']: drift.append({'path':path,'initialSha256':row['sha256'],'currentSha256':sha})
 text=blob.decode()
 try: units=walk(json.loads(text)) if row['kind']=='json' else [('',text)]
 except Exception as e: errors.append({'path':path,'error':repr(e)}); continue
 for ptr,value in units:
  f=value.casefold()
  for group,needles in terms.items():
   for needle in needles:
    totals[group]+=f.count(needle); start=0
    while len(hits[group])<cap:
     at=f.find(needle,start)
     if at<0: break
     hits[group].append({'path':path,'jsonPointer':ptr if row['kind']=='json' else None,'line':value.count('\n',0,at)+1,'needle':needle,'context':value[max(0,at-220):min(len(value),at+len(needle)+550)],'sha256':sha})
     start=at+len(needle)
out={'capturedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'historyPathSet':'history-initial-pins.json, same dated 4162 included files; no excluded/future material added','literalCasefoldedTerms':terms,'capPerGroup':cap,'totals':totals,'retained':{k:len(v) for k,v in hits.items()},'jsonStringValues':strings,'jsonScalarValues':scalars,'driftSinceInitial':drift,'parseErrors':errors,'hits':hits,'notSemanticExhaustion':True,'productAttempts':0}
(BASE/'history-display-causes.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k!='hits'},ensure_ascii=False))

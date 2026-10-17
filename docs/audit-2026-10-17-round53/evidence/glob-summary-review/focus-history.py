from pathlib import Path
import hashlib,json,re,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round112-glob-summary-review');inv=json.loads((O/'history-inventory.json').read_text());cli=json.loads((O/'cli-before-pin.json').read_text())
patterns={
 'glob-status-count':re.compile(r'(?is)(?:\bGlob\b|No files matched).{0,220}(?:非空|1\s*files|2\s*files|零结果|无匹配|空结果|计数|count|header|matched|summary|摘要|compactSummary)|(?:非空|1\s*files|2\s*files|计数|count|header|compactSummary).{0,220}\bGlob\b'),
 'glob-empty-message':re.compile(r'(?i)No files matched the pattern\.'),
 'tui-cli-specific-summary':re.compile(r'(?is)(?:ToolCallResult|renderToolOutput|compactSummary).{0,180}(?:\bGlob\b|files|count|计数)|(?:\bGlob\b).{0,180}(?:ToolCallResult|renderToolOutput|compactSummary)')}
hits={k:[]for k in patterns};extra=[];rows=[]
def proc(s,loc):
 for k,p in patterns.items():
  if p.search(s):hits[k].append(dict(**loc,text=s))
 if cli['path']in s or cli['sha256']in s:extra.append(dict(**loc,text=s))
def walk(v,ptr,doc):
 if isinstance(v,dict):
  if cli['path']in v.values():rows.append(dict(document=doc,pointer=ptr,row=v))
  for k,x in v.items():walk(x,ptr+'/'+str(k).replace('~','~0').replace('/','~1'),doc)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(x,ptr+'/'+str(i),doc)
 else:proc(str(v),dict(document=doc,pointer=ptr))
for f in inv['files']:
 b=(R/f['path']).read_bytes();assert hashlib.sha256(b).hexdigest()==f['sha256']
 if f['path'].endswith('.md'):
  ls=b.decode().splitlines();block=[];start=1
  for n,s in enumerate(ls+[''],1):
   if not s.strip():
    if block:proc('\n'.join(block),dict(document=f['path'],lineStart=start,lineEnd=n-1));block=[]
    start=n+1
   else:block.append(s)
 else:walk(json.loads(b),'',f['path'])
d=dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),cohort='Original history-inventory.json; all original bytes checked before supplement',patterns={k:p.pattern for k,p in patterns.items()},causeTotals={k:len(v)for k,v in hits.items()},capPerQuery=100,contexts={k:v[:100]for k,v in hits.items()},cliPathShaTotals=len(extra),cliContexts=extra[:100],cliSourceRows=rows,cliGateTiming='CLI was additionally pinned before its selected source reading; its source-row historical lookup is this later metadata supplement, not falsely backdated as pre-body')
(O/'focused-history-gate.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(causeTotals=d['causeTotals'],cliHits=len(extra),cliRows=len(rows)),ensure_ascii=False))
for k,v in hits.items():
 print('QUERY',k)
 for i,r in enumerate(v[:100]):
  print(json.dumps(dict(index=i,document=r['document'],location=r.get('pointer',str(r.get('lineStart'))+'-'+str(r.get('lineEnd'))),characters=len(r['text']),preview=r['text'][:300]),ensure_ascii=False))
print('CLI original rows')
for r in rows:
 if 'source-manifest' in r['document'] and not any(x in r['document']for x in ['inventory','coverage','history']):print(json.dumps(r,ensure_ascii=False))

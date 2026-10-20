from pathlib import Path
import json,re,datetime,collections
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); OUT=Path('/tmp/codeshell-audit-round90-param-controls')
Q={'named-param-range':re.compile(r'(?:ParamControls|paramValues|temperature|top_p).{0,220}(?:bound|out.of.range|clamp|invalid|validat|越界|校验|超出|范围)|(?:bound|out.of.range|clamp|invalid|validat|越界|校验|超出|范围).{0,220}(?:ParamControls|paramValues|temperature|top_p)',re.I|re.S),'numeric-form-range':re.compile(r'(?:number input|numeric (?:input|field|control)|数值(?:输入|控件|参数)|数字(?:输入|控件)).{0,180}(?:保存|save|valid|bound|范围|校验|越界)',re.I|re.S)}
rows={q:[] for q in Q}
def hit(s,p,l,k):
 for q,rx in Q.items():
  m=rx.search(s)
  if m:
   lo=max(0,m.start()-160); hi=min(len(s),m.end()+700);rows[q].append({'document':p,'locator':l,'kind':k,'excerpt':s[lo:hi],'excerptStart':lo,'excerptEnd':hi,'originalChars':len(s),'excerptTruncated':lo>0 or hi<len(s)})
def walk(x,p,l):
 if isinstance(x,dict):
  for k,v in x.items():walk(v,p,l+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,p,l+'/'+str(i))
 elif isinstance(x,str):hit(x,p,l,'json-recursive-value')
for r in json.loads((OUT/'history-initial-inventory.json').read_text())['files']:
 p=r['path'];s=(ROOT/p).read_text()
 if p.lower().endswith('.md'):
  for i,v in enumerate(s.split('\n\n')):hit(v,p,'paragraph/'+str(i),'markdown-paragraph')
 else:walk(json.loads(s),p,'')
x={'capturedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'inventory':'same frozen initial4693 docs/bugs files','cap':None,'queryPatterns':{q:r.pattern for q,r in Q.items()},'totalMatches':{q:len(v) for q,v in rows.items()},'contexts':rows,'actualHumanRead':'pending; bounded excerpt actual reading tracked separately'}
(OUT/'exact-cause-history.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n');print(json.dumps(x['totalMatches']))

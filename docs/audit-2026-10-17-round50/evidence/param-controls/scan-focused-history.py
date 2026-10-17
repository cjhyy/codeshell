from pathlib import Path
import json,re,collections,datetime
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); OUT=Path('/tmp/codeshell-audit-round90-param-controls')
QUERIES={
 'parameter-bounds':re.compile(r'(?:paramValues|参数|parameter|temperature|top_p).{0,180}(?:越界|范围|边界|out.of.range|bounds|clamp|validat|NaN|非数)',re.I|re.S),
 'numeric-save':re.compile(r'(?:number input|numeric|数值|数字).{0,180}(?:保存|persist|save|限制|reject)',re.I|re.S),
 'model-selection-patch':re.compile('modelSelectionPatch'),
}
CAP=100; total=collections.Counter(); kept={k:[] for k in QUERIES}
def hit(s,p,loc,kind):
 for q,rx in QUERIES.items():
  m=rx.search(s)
  if m:
   total[q]+=1
   if len(kept[q])<CAP:
    lo=max(0,m.start()-220);hi=min(len(s),m.end()+900)
    kept[q].append({'document':p,'locator':loc,'kind':kind,'excerpt':s[lo:hi],'excerptStart':lo,'excerptEnd':hi,'originalChars':len(s),'excerptTruncated':lo>0 or hi<len(s)})
def walk(x,p,loc):
 if isinstance(x,dict):
  for k,v in x.items():walk(v,p,loc+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(x,list):
  for i,v in enumerate(x):walk(v,p,loc+'/'+str(i))
 elif isinstance(x,str):hit(x,p,loc,'json-recursive-value')
for r in json.loads((OUT/'history-initial-inventory.json').read_text())['files']:
 p=r['path'];s=(ROOT/p).read_text()
 if p.lower().endswith('.md'):
  for i,part in enumerate(s.split('\n\n')):hit(part,p,'paragraph/'+str(i),'markdown-paragraph')
 else:walk(json.loads(s),p,'')
x={'capturedUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sameDatedInventoryFiles':4693,'queryPatterns':{k:v.pattern for k,v in QUERIES.items()},'totalMatches':dict(total),'capPerQuery':CAP,'retainedCounts':{k:len(v) for k,v in kept.items()},'contexts':kept,'actualHumanRead':'pending; machine count not claimed as fullcontext reading'}
(OUT/'focused-history.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:x[k] for k in ['totalMatches','capPerQuery','retainedCounts']},ensure_ascii=False))

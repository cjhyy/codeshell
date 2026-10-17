from pathlib import Path
import hashlib,json,re

root=Path.cwd();out=root/'docs/audit-2026-10-17-round21/evidence'
patterns={
 'exact_budget':r'tool-output-budget|createToolTextReplacement|truncateToolOutput|replaceToolResultText',
 'separator_floor':r'(?:separator|分隔|join\("\\n\\n"\)|availableChars).{0,120}(?:budget|预算|limit|超|floor|0|zero)|(?:budget|预算).{0,120}(?:separator|分隔)',
 'aggregate':r'applyToolResultBudget|tool.result.{0,60}(?:aggregate|budget)|工具.{0,30}(?:总预算|聚合预算)',
 'unicode':r'(?:truncat|截断).{0,100}(?:surrogate|UTF.?16|Unicode|grapheme)|(?:surrogate|UTF.?16).{0,100}(?:truncat|截断)',
 'structured':r'CTX-R4|structured.summary|JSON.summary.repair|tool.result.{0,100}(?:image|media|multi.?part|slot)',
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
files=sorted(p for d in ['docs','bugs'] if (root/d).exists() for p in (root/d).rglob('*') if p.is_file() and p.suffix.lower() in ['.md','.json'] and 'audit-2026-10-17-round21' not in p.parts)
stats={'files':len(files),'markdown':0,'json':0,'jsonStringLeaves':0,'jsonScalarLeaves':0}
counts={k:0 for k in patterns};matches={k:[] for k in patterns};contexts={k:[] for k in patterns};inventory=[];errors=[]
def walk(v,path='$'):
 if isinstance(v,dict):
  for k,w in v.items():yield from walk(w,path+'.'+str(k))
 elif isinstance(v,list):
  for i,w in enumerate(v):yield from walk(w,path+f'[{i}]')
 else:yield path,v
for p in files:
 rel=str(p.relative_to(root));b=p.read_bytes();inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if p.suffix.lower()=='.md':
  stats['markdown']+=1;vals=[(f'line:{i}',x) for i,x in enumerate(b.decode('utf8').splitlines(),1)]
 else:
  stats['json']+=1
  try:o=json.loads(b)
  except Exception as e:errors.append({'path':rel,'error':str(e)});continue
  vals=[]
  for ptr,v in walk(o):
   stats['jsonScalarLeaves']+=1
   if isinstance(v,str):stats['jsonStringLeaves']+=1;text=v
   else:text=json.dumps(v,ensure_ascii=False)
   vals.append((ptr,text))
 for loc,t in vals:
  for k,r in compiled.items():
   ms=list(r.finditer(t))
   if not ms:continue
   counts[k]+=len(ms);matches[k].append({'path':rel,'location':loc,'occurrences':len(ms)})
   if len(contexts[k])<25:
    m=ms[0];contexts[k].append({'path':rel,'location':loc,'context':t[max(0,m.start()-160):m.end()+230]})
obj={'base':'615e4e4dd3a61b1ad132ab4f3683985a0d582386','scope':'All docs/bugs Markdown and recursive JSON scalar values, including archived directories, current round21 excluded; read-time corpus, not final-main corpus.','statistics':stats,'patterns':patterns,'matchCounts':counts,'contextsPerPatternCap':25,'contexts':contexts,'allMatchLocators':matches,'parseErrors':errors,'inventory':inventory,'limitations':'Keyword hits only locate records for semantic review; no claim of exhausted bug coverage.'}
(out/'toolbudget-dedup.json').write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'statistics':stats,'matchCounts':counts,'parseErrors':errors,'contexts':{k:v[:3] for k,v in contexts.items()}},ensure_ascii=False,indent=2))

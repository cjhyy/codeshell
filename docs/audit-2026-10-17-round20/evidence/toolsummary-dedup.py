from pathlib import Path
import hashlib,json,re
root=Path.cwd(); out=root/'docs/audit-2026-10-17-round20/evidence'; base='d40dd06987a2e0c20c377e243cf5c4e4b549c9ec'
patterns={
 'exact_summary':r'tool-summary|generateToolUseSummary|SUMMARY_SYSTEM_PROMPT',
 'summary_error':r'tool[_ -]?summary.{0,100}(?:reject|failure|catch|null|undefined)|(?:null|undefined).{0,80}(?:throw|reject|\.message)',
 'summary_format':r'(?:tool[_ -]?summary|工具摘要|工具总结).{0,120}(?:length|chars|newline|trim|single|line|长度|截断|换行)',
 'old_json_summary':r'JSON summary repair|summary repair|JSON.*summary|summary.*JSON',
 'nonerror_rejection':r'non.?Error|non.?error|非.?Error|throw null|reject\(null\)|error.{0,30}\.message',
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
files=sorted(p for d in ['docs','bugs'] if (root/d).exists() for p in (root/d).rglob('*') if p.is_file() and p.suffix.lower() in ['.md','.json'] and 'audit-2026-10-17-round20' not in p.parts)
stats={'files':len(files),'markdown':0,'json':0,'jsonStringLeaves':0,'jsonScalarLeaves':0}; counts={k:0 for k in patterns}; matches={k:[] for k in patterns}; contexts={k:[] for k in patterns}; inventory=[]; errors=[]
def walk(v,path='$'):
 if isinstance(v,dict):
  for k,w in v.items(): yield from walk(w,path+'.'+str(k))
 elif isinstance(v,list):
  for i,w in enumerate(v): yield from walk(w,path+f'[{i}]')
 else: yield path,v
for p in files:
 rel=str(p.relative_to(root)); b=p.read_bytes(); inventory.append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if p.suffix.lower()=='.md':
  stats['markdown']+=1; vals=[(f'line:{i}',x) for i,x in enumerate(b.decode('utf8').splitlines(),1)]
 else:
  stats['json']+=1
  try:o=json.loads(b)
  except Exception as e: errors.append({'path':rel,'error':str(e)});continue
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
   counts[k]+=len(ms)
   matches[k].append({'path':rel,'location':loc,'occurrences':len(ms)})
   if len(contexts[k])<30:
    m=ms[0];contexts[k].append({'path':rel,'location':loc,'context':t[max(0,m.start()-170):m.end()+230]})
obj={'base':base,'scope':'All docs/bugs Markdown and recursive JSON scalar values, including archived directories, current batch excluded; frozen/read-time inventory, not final-main corpus.','statistics':stats,'patterns':patterns,'matchCounts':counts,'contextsPerPatternCap':30,'contexts':contexts,'allMatchLocators':matches,'parseErrors':errors,'inventory':inventory,'limitations':'Keyword contexts and locators narrow manual semantic review; zero keyword hits is not proof of novel mechanism or exhausted coverage.'}
(out/'toolsummary-dedup.json').write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'statistics':stats,'matchCounts':counts,'parseErrors':errors,'boundedContexts':contexts},ensure_ascii=False,indent=2))

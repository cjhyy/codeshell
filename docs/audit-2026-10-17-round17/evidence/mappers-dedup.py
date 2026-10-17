from pathlib import Path
import subprocess,json,re,hashlib
ROOT=Path.cwd(); BATCH='docs/audit-2026-10-17-round17/'
patterns={
 'mapper_functions':r'messageMappers|ccHistoryToEvents|roomHistoryToEvents|roomMsgToEvent',
 'history_ids':r'(?:cc-hist-|HistoryMessage.{0,160}(?:tool.?id|toolId)|(?:snapshot|history|backlog).{0,100}(?:tool.{0,20}id|paired|unmatched))',
 'turn_boundaries':r'(?:ccHistory|messageMappers|历史映射|history mapping).{0,180}(?:turn_complete|completed|turn.{0,10}bound|边界)',
 'history_mixed':r'(?:HistoryMessage|ccHistoryToEvents).{0,160}(?:mixed|顺序|order|丢|loss|tools)',
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()}
files=sorted(p for p in subprocess.check_output(['rg','--files','--hidden','docs','bugs'],text=True).splitlines() if not p.startswith(BATCH) and Path(p).suffix.lower() in ('.md','.json'))
counts={'md':0,'json':0,'stringLeaves':0,'scalarLeaves':0}; errors=[]
hits={k:{'matches':0,'contexts':[]} for k in patterns}
manifest=[]
def inspect(text,loc):
 for k,rx in compiled.items():
  for m in rx.finditer(text):
   hits[k]['matches']+=1
   if len(hits[k]['contexts'])<40:
    hits[k]['contexts'].append({'location':loc,'context':text[max(0,m.start()-140):min(len(text),m.end()+220)]})
def walk(obj,loc):
 if isinstance(obj,str):
  counts['stringLeaves']+=1;counts['scalarLeaves']+=1;inspect(obj,loc)
 elif isinstance(obj,dict):
  for k,v in obj.items():walk(v,loc+'/'+str(k))
 elif isinstance(obj,list):
  for i,v in enumerate(obj):walk(v,loc+'/'+str(i))
 else:counts['scalarLeaves']+=1
for p in files:
 b=(ROOT/p).read_bytes();manifest.append({'path':p,'sha256':hashlib.sha256(b).hexdigest()})
 try:
  if p.endswith('.md'):
   counts['md']+=1
   for i,line in enumerate(b.decode().splitlines(),1):inspect(line,p+':'+str(i))
  else:counts['json']+=1;walk(json.loads(b),p+'#')
 except Exception as e:errors.append({'path':p,'error':repr(e)})
result={'baseCommit':'d86db33012dffd5d1849e76b869fa15eb260324f','scope':'All prior docs/bugs .md and recursively parsed JSON value leaves including archive/_archive; current batch excluded. Keys are not JSON string leaves. No source/semantic exhaustive claim.','files':len(files),'counts':counts,'parseErrors':errors,'patterns':patterns,'contextCapPerPattern':40,'matches':hits,'inventorySha256':hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()}
(ROOT/'docs/audit-2026-10-17-round17/evidence/mappers-dedup.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(files),'counts':counts,'errors':errors,'matchCounts':{k:v['matches'] for k,v in hits.items()}},ensure_ascii=False))

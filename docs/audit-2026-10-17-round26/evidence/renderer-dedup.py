from pathlib import Path
import hashlib,json,re,subprocess
root=Path('.')
out=root/'docs/audit-2026-10-17-round26/evidence'
base='6d61f57ade1ef1b9fdc4d33020652007d995e7a7'
patterns={
 'exact':r'useReviewPrompt|ReviewPanel(?:\.workspace)?|composerSeed|usePanelBuckets(?:\.subagent)?|reviewSnapshot',
 'review-draft':r'(?:review|审查).{0,80}(?:draft|composer|seed|selection|session|草稿|会话|选区)|(?:draft|composer|seed|草稿|选区).{0,60}(?:review|审查)',
 'draft-session':r'(?:draft|composerSeed|initialDraft|seedDraft).{0,80}(?:session|会话|selected|selection)|(?:session|会话).{0,70}(?:draft|composerSeed|草稿)'
}
compiled={k:re.compile(v,re.I) for k,v in patterns.items()};counts={k:0 for k in patterns};hits={k:[] for k in patterns};cap=220
stats={'files':0,'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};inventory=[];errors=[]
def scalars(v,p='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from scalars(x,p+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from scalars(x,p+'['+str(i)+']')
 else:yield p,v
for dirname in ['docs','bugs']:
 for p in sorted((root/dirname).rglob('*')):
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round26' in p.parts:continue
  raw=p.read_bytes();inventory.append({'path':str(p),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()});stats['files']+=1;t=raw.decode()
  if p.suffix.lower()=='.md':stats['markdown']+=1;rows=[(str(i),line) for i,line in enumerate(t.splitlines(),1)]
  else:
   stats['json']+=1
   try:v=json.loads(t)
   except Exception as e:errors.append({'path':str(p),'error':str(e)});continue
   rows=[]
   for loc,v in scalars(v):
    stats['scalarLeaves']+=1
    if isinstance(v,str):stats['stringLeaves']+=1;text=v
    else:text=json.dumps(v,ensure_ascii=False)
    rows.append((loc,text))
  for loc,text in rows:
   for group,pattern in compiled.items():
    for match in pattern.finditer(text):
     counts[group]+=1
     if len(hits[group])<cap:hits[group].append({'path':str(p),'location':loc,'excerpt':text[max(0,match.start()-180):min(len(text),match.end()+720)],'wholeValueCharacters':len(text)})
result={'base':base,'roots':['docs','bugs'],'archivesIncluded':True,'excluded':'docs/audit-2026-10-17-round26/** including copied prior-negative-prep','inventory':inventory,'totals':dict(stats,parseErrors=len(errors)),'parseErrors':errors,'patterns':patterns,'matchCounts':counts,'contextCapPerGroup':cap,'retainedContexts':{k:len(v) for k,v in hits.items()},'matches':hits,'limitations':['Keyword contexts do not prove semantic exhaustion; match counts and context caps disclosed.','JSON scalar values recursively searched, not keys.','Fresh current history snapshot; not spliced with different-time prior-negative-prep counts.'],'productAttempts':0,'testAttempts':0,'runtimeImports':0,'gitWrites':0}
(out/'renderer-dedup.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
argv=['rg','--files','packages/desktop']
p=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
paths=[s for s in p.stdout.decode().splitlines() if re.search(r'useReviewPrompt|ReviewPanel|composerSeed|usePanelBuckets|reviewSnapshot|subagent.*test',s)]
(out/'renderer-inventory.json').write_text(json.dumps({'argv':argv,'exitCode':p.returncode,'stderr':p.stderr.decode(),'paths':paths},ensure_ascii=False,indent=2)+'\n')
source_paths=[
 'packages/desktop/src/renderer/panels/useReviewPrompt.ts',
 'packages/desktop/src/renderer/panels/useReviewPrompt.test.tsx',
 'packages/desktop/src/renderer/panels/ReviewPanel.tsx',
 'packages/desktop/src/renderer/panels/ReviewPanel.workspace.test.tsx',
 'packages/desktop/src/renderer/chat/composerSeed.ts',
 'packages/desktop/src/renderer/chat/composerSeed.test.ts',
 'packages/desktop/src/renderer/app/usePanelBuckets.ts',
 'packages/desktop/src/renderer/app/usePanelBuckets.subagent.test.tsx',
 'packages/desktop/src/renderer/diff/reviewSnapshot.ts',
 'packages/desktop/src/renderer/diff/reviewSnapshot.test.ts',
 'CODESHELL.md']
first=[]
for path in source_paths:
 raw=(root/path).read_bytes();first.append({'path':path,'bytes':len(raw),'lineCount':len(raw.splitlines()),'sha256':hashlib.sha256(raw).hexdigest(),'semanticRead':'pending except previously full-read CODESHELL; this is a before-read byte pin'})
(out/'renderer-initial-source-pins.json').write_text(json.dumps({'parentReportedFreeze':base,'gitComparisonPerformed':False,'gitCommands':0,'files':first},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'totals':result['totals'],'counts':counts,'contexts':result['retainedContexts'],'inventoryPaths':len(paths),'sourcePinsBeforeRead':len(first),'sourceLines':{r['path']:r['lineCount'] for r in first}},ensure_ascii=False))

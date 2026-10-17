from pathlib import Path
import hashlib,json,re,subprocess
root=Path('.')
out=root/'docs/audit-2026-10-17-round27/evidence'
base='9b667863e8a8eb91db7b1f99eb9876169dcf19ec'
patterns={
 'exact':r'fileChangeAggregator|FilesChangedCard|composeFileEdits|usePanelBuckets',
 'grouping':r'(?:file.?change|changed.?file|文件变更).{0,90}(?:aggregat|group|tool.?call|duplicate|重复|归组|成功|失败)|(?:aggregat|tool.?call).{0,80}(?:file.?change|changed.?file|文件变更)',
 'old-cli':r'CLI-R4|CLI.R4|RENDERER-R26-01|REVIEW(?:TARGETS)?-R26|branch.{0,40}(?:substring|配置注入)'
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
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round27' in p.parts:continue
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
result={'base':base,'roots':['docs','bugs'],'archivesIncluded':True,'excluded':'docs/audit-2026-10-17-round27/**','inventory':inventory,'totals':dict(stats,parseErrors=len(errors)),'parseErrors':errors,'patterns':patterns,'matchCounts':counts,'contextCapPerGroup':cap,'retainedContexts':{k:len(v) for k,v in hits.items()},'matches':hits,'limitations':['All MD lines and recursive JSON value scalars searched; JSON keys are not values.','Total matches vs capped retained contexts are distinct. Keywords/selected historical parent inspection do not establish semantic exhaustion.'],'productAttempts':0,'testAttempts':0,'runtimeImports':0,'gitCommands':0}
(out/'aggregator-dedup.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
argv=['rg','--files','packages/desktop/src/renderer'];p=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
paths=[s for s in p.stdout.decode().splitlines() if re.search(r'fileChangeAggregator|FilesChangedCard|usePanelBuckets|/types\.ts$|composeFileEdits',s)]
(out/'aggregator-inventory.json').write_text(json.dumps({'argv':argv,'exitCode':p.returncode,'stderr':p.stderr.decode(),'paths':paths},ensure_ascii=False,indent=2)+'\n')
source_paths=['packages/desktop/src/renderer/messages/fileChangeAggregator.ts','packages/desktop/src/renderer/messages/fileChangeAggregator.test.ts','packages/desktop/src/renderer/messages/fileChangeAggregator.count.test.ts','packages/desktop/src/renderer/messages/FilesChangedCard.tsx','packages/desktop/src/renderer/messages/FilesChangedCard.test.tsx','packages/desktop/src/renderer/app/usePanelBuckets.ts','packages/desktop/src/renderer/types.ts','CODESHELL.md']
first=[]
for path in source_paths:
 raw=(root/path).read_bytes();first.append({'path':path,'bytes':len(raw),'lineCount':len(raw.splitlines()),'sha256':hashlib.sha256(raw).hexdigest(),'semanticRead':'pending except CODESHELL already read; first byte pin before assigned source reading'})
(out/'aggregator-initial-source-pins.json').write_text(json.dumps({'parentReportedFreeze':base,'gitComparisonPerformed':False,'gitCommands':0,'files':first},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'totals':result['totals'],'counts':counts,'contexts':result['retainedContexts'],'inventoryPaths':len(paths),'sources':{x['path']:x['lineCount'] for x in first}},ensure_ascii=False))

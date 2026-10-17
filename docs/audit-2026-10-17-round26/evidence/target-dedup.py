from pathlib import Path
import json,re,hashlib,collections,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
out=root/'docs/audit-2026-10-17-round26/evidence'
patterns={
 'target':re.compile(r'review-target(?:\.test)?\.ts|parseReviewArguments|collectReviewTarget|CollectedReviewTarget'),
 'prompt-prior':re.compile(r'review-prompt(?:\.test)?\.ts|parseDimensions|PERF.{0,60}alias|R19.{0,80}(?:PERF|review)|fencedEvidence',re.I),
 'ordinary-target':re.compile(r'(?:review|审查).{0,120}(?:--all|--staged|--unstaged|--base|--commit|untracked|merge.base|scope)|(?:--staged|--unstaged|--base|--commit).{0,100}(?:review|审查)',re.I),
}
files=[];stats={'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};round25={'files':0,'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};errors=[];counts={k:0 for k in patterns};hits={k:[] for k in patterns};byfile={k:collections.Counter() for k in patterns}
def walk(v,loc='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from walk(x,loc+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from walk(x,loc+f'[{i}]')
 else:yield loc,v
for d in ['docs','bugs']:
 for p in sorted((root/d).rglob('*')):
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round26' in p.parts:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));r25=rel.startswith('docs/audit-2026-10-17-round25/')
  files.append({'path':rel,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'readTimeRound25':r25})
  if r25:round25['files']+=1
  if p.suffix.lower()=='.md':
   stats['markdown']+=1
   if r25:round25['markdown']+=1
   rows=[(str(i),v) for i,v in enumerate(raw.decode().splitlines(),1)]
  else:
   stats['json']+=1
   if r25:round25['json']+=1
   try:j=json.loads(raw)
   except Exception as e:errors.append({'path':rel,'error':str(e)});continue
   rows=[]
   for loc,v in walk(j):
    stats['scalarLeaves']+=1
    if r25:round25['scalarLeaves']+=1
    if isinstance(v,str):
     stats['stringLeaves']+=1
     if r25:round25['stringLeaves']+=1
    rows.append((loc,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))
  for loc,v in rows:
   for key,pattern in patterns.items():
    for m in pattern.finditer(v):
     counts[key]+=1;byfile[key][rel]+=1
     if len(hits[key])<80:hits[key].append({'path':rel,'location':loc,'excerpt':v[max(0,m.start()-140):min(len(v),m.end()+500)],'wholeValueCharacters':len(v),'readTimeRound25':r25})
r={'readAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'parentReportedFreeze':'6d61f57ade1ef1b9fdc4d33020652007d995e7a7','gitCommandsExecuted':0,'gitBlobVerified':False,'roots':['docs','bugs'],'excluded':['docs/audit-2026-10-17-round26/**'],'round25Partition':round25,'round25Note':'Current filesystem while parent integrates round25 metadata; included and separately labelled. Does not infer commit membership or new tests.','inventory':files,'totals':{'files':len(files),**stats,'parseErrors':len(errors)},'parseErrors':errors,'patterns':{k:p.pattern for k,p in patterns.items()},'matchCounts':counts,'contextCap':80,'hits':hits,'matchesByFile':{k:dict(v) for k,v in byfile.items()},'limits':['Includes recursively nested archive/_archive. JSON scalar values searched; keys excluded.','Keywords and capped excerpts are navigation only, not semantic coverage.','No Git invocation, product import, test/fixture, VM, subprocess product execution or network.']}
(out/'target-dedup.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'totals':r['totals'],'round25Partition':round25,'matchCounts':counts,'retained':{k:len(v) for k,v in hits.items()},'gitCommandsExecuted':0},ensure_ascii=False))

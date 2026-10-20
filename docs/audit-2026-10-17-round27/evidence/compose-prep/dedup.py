from pathlib import Path
import json,re,hashlib,datetime,collections
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round27-compose-frontier')
patterns={
 'compose-leaf':re.compile(r'composeFileEdits(?:\.test)?\.ts|composeFileEdits|syntheticSnippetDiff|uniqueIndex\(edit\.oldText'),
 'aggregation-snapshot':re.compile(r'fileChangeAggregator(?:\.test)?\.ts|aggregateFileChangeSummary|groupReviewSnapshot|reviewSnapshot\.ts'),
 'replay-proof':re.compile(r'(?:snippet|片段|enclos|surrounding|replay|重放|组合|合并).{0,120}(?:unique|唯一|location|位置|ambiguous|多次|错误|false)|(?:net.diff|净变化).{0,100}(?:snippet|片段|位置|edit|编辑)',re.I),
}
files=[];stats={'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};round26={'files':0,'markdown':0,'json':0,'stringLeaves':0,'scalarLeaves':0};errors=[];counts={k:0 for k in patterns};hits={k:[] for k in patterns};byfile={k:collections.Counter() for k in patterns}
def leaves(v,loc='$'):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,loc+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,loc+f'[{i}]')
 else:yield loc,v
for d in ['docs','bugs']:
 for p in sorted((root/d).rglob('*')):
  if not p.is_file() or p.suffix.lower() not in ['.md','.json'] or 'audit-2026-10-17-round27' in p.parts:continue
  raw=p.read_bytes();rel=str(p.relative_to(root));is26=rel.startswith('docs/audit-2026-10-17-round26/');files.append({'path':rel,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'readTimeRound26':is26})
  if is26:round26['files']+=1
  if p.suffix.lower()=='.md':
   stats['markdown']+=1
   if is26:round26['markdown']+=1
   rows=[(str(i),s) for i,s in enumerate(raw.decode().splitlines(),1)]
  else:
   stats['json']+=1
   if is26:round26['json']+=1
   try:j=json.loads(raw)
   except Exception as e:errors.append({'path':rel,'error':str(e)});continue
   rows=[]
   for loc,v in leaves(j):
    stats['scalarLeaves']+=1
    if is26:round26['scalarLeaves']+=1
    if isinstance(v,str):
     stats['stringLeaves']+=1
     if is26:round26['stringLeaves']+=1
    rows.append((loc,v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)))
  for loc,s in rows:
   for k,pat in patterns.items():
    for m in pat.finditer(s):
     counts[k]+=1;byfile[k][rel]+=1
     if len(hits[k])<100:hits[k].append({'path':rel,'location':loc,'excerpt':s[max(0,m.start()-140):min(len(s),m.end()+550)],'wholeValueCharacters':len(s),'readTimeRound26':is26})
r={'readAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'parentReportedHead':'5e10a7e19734cfebd940fc11020bab3600b6e802','gitCommandsExecuted':0,'independentGitBlobVerification':False,'roots':['docs','bugs'],'excluded':['docs/audit-2026-10-17-round27/**'],'round26Partition':round26,'inventory':files,'totals':{'files':len(files),**stats,'parseErrors':len(errors)},'parseErrors':errors,'patterns':{k:v.pattern for k,v in patterns.items()},'matchCounts':counts,'contextCap':100,'hits':hits,'matchesByFile':{k:dict(v) for k,v in byfile.items()},'limits':['All recursively nested archives included; JSON scalar values searched, keys excluded.','Round26 is current read-time filesystem while parent integrates documentation; no claim of commit membership or new runtime validations.','Keywords and limited contexts are navigation, not semantic exhaustion.','Pure metadata collection; no product imports/functions/tests/fixtures/VM/native/Git/network/security/auth/HOME execution.']}
(out/'history.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'totals':r['totals'],'round26Partition':round26,'matchCounts':counts,'retained':{k:len(v) for k,v in hits.items()}},ensure_ascii=False))

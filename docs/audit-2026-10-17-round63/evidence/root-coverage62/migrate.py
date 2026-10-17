"""Root metadata-only increment for canonical formal62 semantic files."""
from pathlib import Path
from collections import Counter
import json,hashlib,datetime,copy
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');OUT=Path('/tmp/codeshell-audit-round171-coverage62')
BASE='docs/audit-2026-10-17-round62/evidence/coverage61/unified-current-index.json'
DOCS=['docs/audit-2026-10-17-round62/evidence/'+s+'/source-manifest.json' for s in ['model-catalog','source-view','root-theme-window','server-run-replay']]
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,v):(OUT/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def ints(rs):
 out=set()
 assert isinstance(rs,list)
 for pair in rs:
  assert isinstance(pair,list) and len(pair)==2 and all(type(x) is int for x in pair)
  a,z=pair;assert 1<=a<=z;out.update(range(a,z+1))
 return out
def ranges(ns):
 out=[]
 for n in sorted(ns):
  if out and out[-1][1]+1==n:out[-1][1]=n
  else:out.append([n,n])
 return out
assert not (OUT/'input-pins.json').exists()
metadata=[BASE,*DOCS,'docs/audit-2026-10-17-round62/evidence/scope-clarifications.json']
pins=[]
for p in metadata+['CODESHELL.md','AGENTS.md']:
 b=(ROOT/p).read_bytes();pins.append(dict(path=p,bytes=len(b),sha256=sha(b),beforeAdapterParse=True,timing='Before this adapter parse. Four source manifests had an earlier Root schema-only projection; this is not a claim of persistent pin before every earlier peek.'))
write('input-pins.json',dict(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),files=pins))
base=json.loads((ROOT/BASE).read_text());assert len(base['files'])==4643
old={r['path']:r for r in base['files']};assert len(old)==4643
assert Counter(r['publishableCurrentCoverage'] for r in old.values())==dict(full=360,selected=363,unknown=3920)
inventory=[]
for p,row in old.items():
 b=(ROOT/p).read_bytes();inventory.append(dict(path=p,bytes=len(b),lines=len(b.splitlines()),sha256=sha(b)))
assert all(r['bytes']==old[r['path']]['bytes'] and r['sha256']==old[r['path']]['sha256'] for r in inventory)
write('current-source-inventory.json',dict(files=inventory,sourceSemanticReads=0,scope='Raw bytes/hash/EOF only on original4643; no product interpretation.'))
accepted=[];excluded=[];deferred=[];allrows=[]
for doc in DOCS:
 j=json.loads((ROOT/doc).read_text())
 for i,r in enumerate(j['files']):
  item=dict(document=doc,pointer='/files/'+str(i),original=r);allrows.append(item)
  p=r['path'];coverage=r.get('coverage','')
  if p not in old or coverage not in ['full','selected']:
   excluded.append(dict(item,reason='outside original denominator or explicit hash/nav/nonsemantic classification'));continue
  row=old[p]
  try:
   assert r.get('sha256')==row['sha256'],'not same source SHA'
   selected=ints(r.get('selectedLineRanges',[]));alias=ints(r.get('semanticReadLineRanges',[]))
   if not selected:selected=alias
   elif alias:assert alias==selected,'conflicting explicit semantic range aliases'
   assert selected,'no explicit semantic range'
   assert max(selected)<=row['lines'],'semantic EOF overrun'
   displayed=set()
   for key in ['bodyDisplayedLineRanges','displayedLineRanges','additionalNavigationSnippetLineRanges','navigationLineRanges','navigationOnlyLineRanges']:
    ns=ints(r.get(key,[]));assert not ns or max(ns)<=row['lines'],key+' EOF overrun';displayed.update(ns)
   assert selected<=displayed,'explicit selected absent from actual display/nav union'
   for key in ['semanticLineCount','semanticLines','semanticReadLineCount']:
    if key in r:assert r[key]==len(selected),'semantic count mismatch '+key
   if coverage=='full':
    assert r.get('semanticFull',True) is not False,'explicit full veto'
    assert selected==set(range(1,row['lines']+1)),'full lacks whole EOF range'
   accepted.append(dict(item,claimId='formal62:'+doc.split('/evidence/',1)[1].split('/')[0]+':'+str(i),path=p,sha256=row['sha256'],classification=coverage,semanticLineCount=len(selected),selectedLineRanges=ranges(selected),sourceKind=r.get('sourceKind',r.get('category','product')),scope='Original purpose/overlap/limits retained verbatim in original object; no new source reading.'))
  except AssertionError as error:deferred.append(dict(item,reason=str(error)))
write('canonical-rows.json',dict(rows=allrows));write('accepted-claims.json',dict(claims=accepted));write('excluded-deferred.json',dict(excluded=excluded,deferred=deferred))
updated=copy.deepcopy(base);updated.update(atUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),status='conservative through62 same9874 source SHA metadata; no new source reading',rootReportedByteBaselineOnly='9874f8abdfce0ade5bb058d26e026b10f173a129',gitCertified=False,productSemanticReads=0,baseIndex=next(r for r in pins if r['path']==BASE))
rank={'unknown':0,'selected':1,'full':2};by={}
for claim in accepted:by.setdefault(claim['path'],[]).append(claim)
transitions=[];retained=[]
for row in updated['files']:
 before=row['publishableCurrentCoverage'];claims=by.get(row['path'],[]);after=max([before]+[r['classification'] for r in claims],key=rank.get)
 row.update(baseFormal62PublishableCoverage=before,publishableCurrentCoverage=after,formal62ClaimIds=[r['claimId'] for r in claims],formal62SelectedRangeUnion=ranges(set().union(*(ints(r['selectedLineRanges']) for r in claims))),formal62SelectedUnionNeverPromotesFull=True)
 if after!=before:transitions.append(dict(path=row['path'],fromCoverage=before,toCoverage=after,claimIds=row['formal62ClaimIds'],sha256=row['sha256']))
 elif claims:retained.append(dict(path=row['path'],coverage=before,claimIds=row['formal62ClaimIds']))
counts=Counter(r['publishableCurrentCoverage'] for r in updated['files'])
write('unified-current-index.json',updated);write('transitions.json',dict(transitions=transitions,retainedStatusProvenance=retained));write('new-full-provenance.json',dict(rows=[r for r in accepted if any(t['path']==r['path'] and t['toCoverage']=='full' for t in transitions)]))
summary=dict(counts=dict(counts),denominator=4643,notFull=4643-counts['full'],primaryRows=len(allrows),acceptedRows=len(accepted),uniqueAcceptedPaths=len(by),excludedRows=len(excluded),deferredRows=len(deferred),transitions=len(transitions),retainedStatusPaths=len(retained),productSourceSemanticReads=0,productRuns=0,gitRuns=0)
write('summary.json',summary);print(json.dumps(summary))

from pathlib import Path
import json,hashlib,re,datetime,collections
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round154-coverage-migration')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def norm(k):return re.sub(r'[^a-z0-9]','',str(k).lower())
SOURCE_HASH_KEYS={norm(x) for x in ['sha256']}
SUPPORT_READ_HASH_KEYS={norm(x) for x in ['initialSemanticReadSha256','initialSha256','firstReadSha256','firstSemanticReadSha256','currentReadSha256','dedicatedSelectedReadSha256','selectedBodyCaptureSha256','dedicatedSelectedDisplaySha256','finishSha256','endingSha256','finishFilesystemSha256','finishFilesystemSHA','firstFilesystemSHA','lastAdditionalSha256','additionalPinSha256','additionalSha256','firstEverSemanticReadSha256']}
assert norm('sha256')=='sha256' and 'sha256' in SOURCE_HASH_KEYS
assert norm('sha256')!=re.sub(r'[^a-z]','', 'sha256')
def parse_ranges(v):
 if not isinstance(v,list):return None
 out=[]
 for x in v:
  if not(isinstance(x,list) and len(x)==2 and all(type(y)is int for y in x) and 1<=x[0]<=x[1]):return None
  out.append(x)
 return out

def lines(rs):return {i for a,z in rs for i in range(a,z+1)}
def compact(s):
 r=[]
 for i in sorted(s):
  if r and i==r[-1][1]+1:r[-1][1]=i
  else:r.append([i,i])
 return r
base=json.loads((R/'docs/audit-2026-10-17-round55/evidence/coverage-current/unified-current-index.json').read_text());inv=json.loads((O/'current-source-inventory.json').read_text());current={x['path']:x for x in inv['rows']};assert len(base['files'])==len(current)==4643
before=collections.Counter(x['publishableCurrentCoverage'] for x in base['files']);assert before=={'full':304,'selected':168,'unknown':4171}
accepted=[];excluded=[];deferred=[];doclog=[];hashchecks=collections.Counter();primaryRows=0
metainv=json.loads((O/'manifest-inventory-pins.json').read_text())['metadataFiles']
for m in metainv:
 p=m['path'];b=(R/p).read_bytes();assert len(b)==m['bytes'] and h(b)==m['sha256'];d=json.loads(b)
 if not isinstance(d,dict):doclog.append({'path':p,'reason':'unsupported-root-shape'});continue
 if '/evidence/' not in p:doclog.append({'path':p,'reason':'aggregate-source-byte-bindings-without-per-row-semantic-coverage-not-new-reading'});continue
 if Path(p).name!='source-manifest.json' or '/before-concurrent-refresh/' in p:doclog.append({'path':p,'reason':'inactive-first-or-concurrent-refresh-snapshot-not-a-second-reading'});continue
 a=d.get('files')
 if not isinstance(a,list):doclog.append({'path':p,'reason':'no-standard-files-list-deferred'});continue
 if not a:doclog.append({'path':p,'reason':'empty-semantic-files-no-gate-replay-upgrade'});continue
 doclog.append({'path':p,'reason':'primary-standard-semantic-files-list-inspected','rows':len(a)})
 for i,r in enumerate(a):
  primaryRows+=1;ptr='/files/'+str(i);q={'manifest':p,'manifestSha256':m['sha256'],'pointer':ptr,'round':m['round']}
  if not isinstance(r,dict):deferred.append({**q,'reason':'row-not-object'});continue
  path=r.get('path');q['path']=path;cov=r.get('coverage');q['declaredCoverage']=cov
  if not isinstance(path,str) or path not in current:excluded.append({**q,'reason':'outside-original4643-denominator'});continue
  if not isinstance(cov,str):deferred.append({**q,'reason':'no-explicit-row-coverage'});continue
  low=cov.lower()
  if re.search(r'hash[- ]only|navigation[- ]only|body0|semantic0|instruction-read-full-reused',low):excluded.append({**q,'reason':'explicit-hash-navigation-instruction-only-not-reading'});continue
  if 'selected' in low:status='selected'
  elif low.strip().startswith('full'):status='full'
  else:deferred.append({**q,'reason':'unsupported-or-nonsemantic-coverage-label'});continue
  candidates=[(k,v) for k,v in r.items() if norm(k) in SOURCE_HASH_KEYS and isinstance(v,str) and re.fullmatch('[0-9a-fA-F]{64}',v)]
  hashchecks['rowsConsidered']+=1
  if len(candidates)!=1:deferred.append({**q,'reason':'no-unique-direct-source-sha256','candidates':candidates});hashchecks['unbound']+=1;continue
  sh=candidates[0][1].lower();q['sourceSha256']=sh;hashchecks['boundDirectSha256']+=1
  if sh!=current[path]['sha256']:excluded.append({**q,'reason':'source-version-not-current-sha256','currentSha256':current[path]['sha256']});continue
  conf=[{'field':k,'value':v} for k,v in r.items() if norm(k) in SUPPORT_READ_HASH_KEYS and isinstance(v,str) and re.fullmatch('[0-9a-fA-F]{64}',v) and v.lower()!=sh]
  if conf:deferred.append({**q,'reason':'conflicting-reading-or-ending-source-version','conflicts':conf});continue
  if type(r.get('bytes'))is int and r['bytes']!=current[path]['bytes']:deferred.append({**q,'reason':'source-byte-count-does-not-match-same-sha-metadata','declaredBytes':r['bytes'],'currentBytes':current[path]['bytes']});continue
  rs=parse_ranges(r.get('selectedLineRanges'))
  if rs is None or not rs:deferred.append({**q,'reason':'missing-empty-or-unsupported-explicit-semantic-ranges'});continue
  ss=lines(rs)
  if max(ss)>current[path]['lines']:deferred.append({**q,'reason':'semantic-range-beyond-current-eof','ranges':rs,'currentLines':current[path]['lines']});continue
  cs={k:v for k,v in r.items() if k in ['semanticLines','semanticLineCount','selectedLineCount','coveredLineCount'] and type(v)is int}
  if any(v<=0 for v in cs.values()):excluded.append({**q,'reason':'explicit-zero-or-negative-semantic-count','counts':cs});continue
  if any(v!=len(ss) for v in cs.values()):deferred.append({**q,'reason':'explicit-semantic-count-range-disagreement','counts':cs,'rangeUnionCount':len(ss),'ranges':rs});continue
  ds=set();hasdisplay=False
  for key in ['displayedLineRanges','displayedBodyLineRanges','bodyDisplayedLineRanges','displayedBodyRanges','additionalNavigationLineRanges','navigationLineRanges']:
   z=parse_ranges(r.get(key))
   if z is not None:ds|=lines(z);hasdisplay=True
  nav=r.get('additionalNavigationSnippetLines',[])
  if isinstance(nav,list):ds|={v for v in nav if type(v)is int and v>0}
  if hasdisplay and not ss<=ds:deferred.append({**q,'reason':'semantic-ranges-not-contained-in-recorded-display-plus-navigation','missing':compact(ss-ds)});continue
  fullveto=r.get('fullFileReadingClaimed')is False or r.get('semanticFull')is False or bool(re.search(r'not[- ]full|not[- ]whole|no whole[- ]file',low))
  downgraded=False
  if status=='full' and (fullveto or ss!=set(range(1,current[path]['lines']+1))):status='selected';downgraded=True
  q.update({'acceptedCoverage':status,'selectedLineRanges':compact(ss),'semanticLineCount':len(ss),'fullClaimConservativelyDowngraded':downgraded,'sourceKind':r.get('sourceKind',r.get('kind',r.get('category'))),'purpose':r.get('purpose',r.get('scope',r.get('role'))),'limits':{'fullFileReadingClaimed':r.get('fullFileReadingClaimed'),'semanticFull':r.get('semanticFull'),'displayCoverageComplete':r.get('displayCoverageComplete'),'newUniqueCoverageClaim':r.get('newUniqueCoverageClaim')},'testDeclarationOnly':bool(re.search(r'(^|/)(?:[^/]*\.)?test\.[cm]?tsx?$',path) or ('test' in str(r.get('sourceKind',r.get('kind',''))).lower() and 'infrastructure' not in str(r.get('sourceKind',r.get('kind',''))).lower())),'runtimePassClaimedByMigration':False})
  q['claimId']='claim-'+str(len(accepted)+1).zfill(4);accepted.append(q)
by=collections.defaultdict(list)
for q in accepted:by[q['path']].append(q)
rank={'unknown':0,'selected':1,'full':2};result=[];trans=[];augment=[];rebind=[]
for old in base['files']:
 path=old['path'];cur=current[path];prior=old['publishableCurrentCoverage'];carry=prior if old['sha256']==cur['sha256'] else 'unknown'
 if carry!=prior:rebind.append({'path':path,'from':prior,'to':carry,'oldSha256':old['sha256'],'currentSha256':cur['sha256']})
 qs=by.get(path,[]);status=carry
 for q in qs:
  if rank[q['acceptedCoverage']]>rank[status]:status=q['acceptedCoverage']
 union=set()
 for q in qs:union|=lines(q['selectedLineRanges'])
 row={**old,'bytes':cur['bytes'],'lines':cur['lines'],'sha256':cur['sha256'],'base55PublishableCoverage':prior,'currentExactShaCarryForward':carry,'publishableCurrentCoverage':status,'incremental46to60ClaimIds':[q['claimId'] for q in qs],'incrementalSelectedRangeUnion':compact(union),'incrementalRangeUnionDoesNotAutoPromoteFull':True}
 result.append(row)
 if status!=carry:trans.append({'path':path,'sha256':cur['sha256'],'from':carry,'to':status,'claimIds':[q['claimId'] for q in qs],'representativeClaimId':next(q['claimId'] for q in qs if q['acceptedCoverage']==status),'selectedRangeUnion':compact(union),'fullRequiresOneExplicitFullClaim':status=='full'})
 elif qs:augment.append({'path':path,'statusUnchanged':status,'claimIds':[q['claimId'] for q in qs],'rangeUnion':compact(union)})
after=collections.Counter(x['publishableCurrentCoverage'] for x in result);carrycounts=collections.Counter(x['currentExactShaCarryForward'] for x in result)
summary={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceUniverse':4643,'base55Counts':dict(before),'baseAfterCurrentHashBinding':dict(carrycounts),'after46to60ConservativeMigration':dict(after),'canonicalManifestDocumentsInventoried':len(metainv),'primaryStandardRowsConsidered':primaryRows,'acceptedSemanticRows':len(accepted),'acceptedUniqueCurrentPaths':len(by),'excludedRows':len(excluded),'deferredRows':len(deferred),'excludedReasons':dict(collections.Counter(x['reason'] for x in excluded)),'deferredReasons':dict(collections.Counter(x['reason'] for x in deferred)),'hashNormalizer':{'algorithm':'lowercase alphanumeric preserving digits','sha256NormalizesTo':norm('sha256'),'directSourceHashAllowlist':sorted(SOURCE_HASH_KEYS),'supportReadingHashAllowlist':sorted(SUPPORT_READ_HASH_KEYS),'checks':dict(hashchecks)},'currentVersionCarryForwardDowngrades':len(rebind),'statusTransitions':len(trans),'statusUnchangedWithNewProvenance':len(augment),'all3StatusesSumTo4643':sum(after.values())==4643,'limits':['Conservative metadata lower bound, not count of unread/unfinished files or remaining bugs.','No selected-range union auto-promotes to full. Repeated author/reviewer/same-read copies attach provenance and never add counts.','Purpose/platform/test-declaration and non-execution limitations retained per original object. Full means explicit full semantic text read for its stated purpose, not whole behavior/runtime certification.','Rows outside original denominator, inactive first snapshots, aggregate byte-only bindings, hash/nav/empty gate records and ambiguous range/hash/count schemas never upgrade coverage.','No product semantic source read/import/helper/test/Git/network/native execution, only source byte hashing inventory.']}
save('accepted-claims.json',{'claims':accepted,'productSemanticRead':0});save('excluded-deferred.json',{'excluded':excluded,'deferred':deferred,'documentDecisions':doclog});save('transitions.json',{'statusTransitions':trans,'currentVersionDowngrades':rebind,'rangeOrProvenanceAugmentationsWithoutStatusChange':augment});save('unified-current-index.json',{'atUTC':summary['atUTC'],'status':'conservative-explicit-same-current-SHA46to60-migration','rootReportedByteBaselineOnly':'659b6b2ce5888723a40ce046cbbf643382cb130b','gitCertified':False,'productSemanticReads':0,'sourceUniverse':4643,'old55IndexUnmodified':True,'files':result});save('migration-summary.json',summary)
print(json.dumps(summary,ensure_ascii=False))

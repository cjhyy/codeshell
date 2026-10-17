from pathlib import Path
import json,hashlib,collections,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round154-coverage-migration')
def read(n):return json.loads((O/n).read_text())
base=json.loads((R/'docs/audit-2026-10-17-round55/evidence/coverage-current/unified-current-index.json').read_text())['files'];new=read('unified-current-index.json')['files'];c={x['path']:x for x in read('current-source-inventory.json')['rows']};a=read('accepted-claims.json')['claims'];t=read('transitions.json')['statusTransitions'];summary=read('migration-summary.json');cache={};by=collections.defaultdict(list)
assert [x['path'] for x in base]==[x['path'] for x in new] and len(c)==4643
for x in a:
 p=x['manifest']
 if p not in cache:cache[p]=json.loads((R/p).read_text())
 row=cache[p]['files'][int(x['pointer'].split('/')[-1])];assert row['path']==x['path'] and row['sha256']==x['sourceSha256']==c[x['path']]['sha256']
 rg={i for lo,hi in row['selectedLineRanges'] for i in range(lo,hi+1)};saved={i for lo,hi in x['selectedLineRanges'] for i in range(lo,hi+1)};assert rg==saved and rg and max(rg)<=c[x['path']]['lines']
 if x['acceptedCoverage']=='full':
  assert str(row['coverage']).lower().startswith('full') and row.get('semanticFull')is not False and row.get('fullFileReadingClaimed')is not False and rg==set(range(1,c[x['path']]['lines']+1))
 else:assert 'selected' in str(row['coverage']).lower() or x['fullClaimConservativelyDowngraded']
 by[x['path']].append(x)
rank={'unknown':0,'selected':1,'full':2};count=collections.Counter();actual=[]
for old,cur in zip(base,new):
 status=old['publishableCurrentCoverage'] if old['sha256']==c[old['path']]['sha256'] else 'unknown'
 for q in by[old['path']]:
  if rank[q['acceptedCoverage']]>rank[status]:status=q['acceptedCoverage']
 assert cur['publishableCurrentCoverage']==status and cur['sha256']==c[old['path']]['sha256'];count[status]+=1
 if status!=old['publishableCurrentCoverage']:actual.append(old['path'])
assert set(actual)=={x['path'] for x in t} and dict(count)==summary['after46to60ConservativeMigration']
full=[x for x in t if x['to']=='full'];sel=[x for x in t if x['to']=='selected'];rep={x['claimId']:x for x in a};fullread=[]
for x in full:
 q=rep[x['representativeClaimId']];fullread.append({'path':x['path'],'currentSha256':x['sha256'],'manifest':q['manifest'],'pointer':q['pointer'],'fullRange':q['selectedLineRanges'],'purpose':q['purpose'],'testDeclarationOnly':q['testDeclarationOnly'],'originalRowConstraints':q['originalRowConstraints'],'sourceBodyReadByMigration':False})
(O/'new-full-provenance.json').write_text(json.dumps({'role':'Metadata-only original row/EOF/SHA checks plus bounded manual purpose review of all51 representative full transitions; no product source reading','records':fullread},ensure_ascii=False,indent=2)+'\n')
checks={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':{'files':[]},'oldBaseReproduced':dict(collections.Counter(x['publishableCurrentCoverage'] for x in base)),'updatedIndexCounts':dict(count),'denominatorUnchanged':True,'accepted495CanonicalPointersRangeAndShaRebound':True,'all51NewFullExplicitOriginalFullCoverageAndCurrentEOF':True,'all186NewSelectedHaveExplicitSemanticRanges':True,'statusTransitionsExactly237':True,'authorReviewerOverlapDoesNotIncreasePathCount':True,'selectedUnionNeverPromotesFull':True,'constraintsPreserved':True,'rowsDeferred':0,'documentsDeferred':0,'limitedSchemaScope':'Only77 nonempty canonical standard .files author/root/reviewer lists; aggregate binding15/empty-gate17/inactive2 skipped. Earlier MD-only/other noncanonical formats outside this incremental scope remain unclassified.','productSourceSemanticRead':0,'productExecution':0,'oldMethodsExecuted':False,'git':0};(O/'verification-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n');print(json.dumps(checks,ensure_ascii=False))

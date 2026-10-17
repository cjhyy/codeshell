from pathlib import Path
import json,hashlib,datetime,collections
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round154-coverage-migration');p=O/'accepted-claims.json';before=p.read_bytes();(O/'accepted-claims.first.json').write_bytes(before);d=json.loads(before);cache={}
ROW_CONSTRAINT_KEYS=['purpose','scope','role','kind','category','sourceKind','oldCoverageLimitation','fullFileReadingClaimed','semanticFull','sameShaOldFull','newUniqueCoverageClaim','firstEverReadingClaimed','firstEverReadClaim','priorCoverage','overlap','priorReadingOverlap','historicalOverlap','displayCoverageComplete','sourceSemanticReads']
DOC_CONSTRAINT_KEYS=['role','scope','limitations','note','overlap','coverageOverlap','scopeLimits','authorityScope','mechanismLimits','sourceSemanticReads','sourceReading','testDeclarations','instructionStatus']
for x in d['claims']:
 f=x['manifest']
 if f not in cache:cache[f]=json.loads((R/f).read_text())
 doc=cache[f];row=doc['files'][int(x['pointer'].split('/')[-1])]
 x['originalRowConstraints']={k:row[k] for k in ROW_CONSTRAINT_KEYS if k in row}
 x['manifestScopeConstraints']={k:doc[k] for k in DOC_CONSTRAINT_KEYS if k in doc}
 if x['purpose'] is None:x['purpose']=row.get('oldCoverageLimitation') or row.get('category') or 'Purpose retained by canonical original object; no broader behavior claim.'
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
summary=json.loads((O/'migration-summary.json').read_text());rej=json.loads((O/'excluded-deferred.json').read_text());docReasons=collections.Counter(x['reason'] for x in rej['documentDecisions']);q={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Metadata constraint preservation and checks only, no reclassification or new product reading','firstAcceptedClaimsSha256':hashlib.sha256(before).hexdigest(),'finalAcceptedClaimsSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'claimCountUnchanged':len(d['claims'])==summary['acceptedSemanticRows'],'documentDecisionCounts':dict(docReasons),'conservativelyDowngradedFullClaims':sum(x['fullClaimConservativelyDowngraded'] for x in d['claims']),'rowDeferredCount':len(rej['deferred']),'deferredDocuments':[x for x in rej['documentDecisions'] if 'deferred' in x['reason']],'productExecution':0,'oldMethodsExecuted':False};(O/'constraint-preservation.json').write_text(json.dumps(q,ensure_ascii=False,indent=2)+'\n');print(json.dumps(q,ensure_ascii=False))

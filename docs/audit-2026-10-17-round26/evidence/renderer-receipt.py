from pathlib import Path
import hashlib,json,re

root=Path('.')
batch=root/'docs/audit-2026-10-17-round26'
evidence=batch/'evidence'
report=batch/'review-renderer-report.md'
base='6d61f57ade1ef1b9fdc4d33020652007d995e7a7'

def sha(raw):return hashlib.sha256(raw).hexdigest()
def save(path,v):path.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')

# This is metadata checking only. It never imports product/test code, runs a
# test, invokes React/browser/native tools or executes any Git command.
manifest=json.loads((evidence/'renderer-source-manifest.json').read_text())
checks=[]
for row in manifest['files']:
 raw=(root/row['path']).read_bytes();h=sha(raw);count=len(raw.splitlines())
 assert h==row['sha256']==row['currentSha256']==row['firstCapturedSha256']
 assert count==row['lineCount']
 assert all(1<=a<=z<=count for a,z in row['selectedLineRanges'])
 assert row['frozenSha256'] is None and row['frozenGitBlob'] is None
 checks.append({'path':row['path'],'sha256':h,'matchesFirstCaptured':True,'coverage':row['coverage'],'frozenComparedByAuthor':False})
assert len(checks)==16 and manifest['productTestConsumerReadLines']==2298
assert manifest['assignedTargetReadLines']==1753 and manifest['dependencyConsumerReadLines']==545
f=json.loads((evidence/'renderer-findings.json').read_text())
assert len(f)==1 and f[0]['id']=='RENDERER-R26-01' and f[0]['priority']=='P3'
assert json.loads((evidence/'renderer-candidates.json').read_text())==[]
assert json.loads((evidence/'renderer-related.json').read_text())==[]
v=json.loads((evidence/'renderer-validation.json').read_text())
assert v['runs']==v['guardedRuns']==[] and v['raw'] is None and v['exit'] is None
assert v['existingTestSourceDeclarations']==23
for key in ['productAttempts','testAttempts','runtimeImports','fixtureCount','reactRenders','browserActions','vmAstEvaluations','nativeExperiments','networkRequests','realHomeAccess','permissionSecurityCustodyIdentityExperiments','gitCommands','gitWrites','pass','fail','expect','existingTestsExecuted','focusedTestsExecuted']:
 assert v[key]==0,key
links=[]
for link in re.findall(r'\[[^\]]+\]\(([^)]+)\)',report.read_text()):
 target,sep,tail=link.rpartition(':');line=int(tail) if sep and tail.isdigit() else None
 p=report.parent/(target if line is not None else link)
 assert p.is_file(),link
 if line is not None:assert 1<=line<=len(p.read_bytes().splitlines()),link
 links.append({'link':link,'exists':True,'line':line})

names=['renderer-dedup.py','renderer-dedup.json','renderer-inventory.json',
       'renderer-initial-source-pins.json','renderer-dedup-supplement.json',
       'renderer-source-manifest.json','renderer-findings.json',
       'renderer-candidates.json','renderer-related.json','renderer-validation.json',
       'renderer-history-decisions.json','renderer-metadata-notes.json',
       'renderer-receipt.py','renderer-metadata-check.json']
owned=[report]+[evidence/name for name in names]
for p in owned:
 assert p.is_file(),str(p)
 if p.suffix=='.json':json.loads(p.read_text())
check={'base':base,'kind':'metadata only;0product/test/import/Git',
       'sourcePinCount':16,'productTestConsumerReadLines':2298,
       'assignedTargetCount':10,'assignedTargetReadLines':1753,'additionalConsumerDependencyReadLines':545,
       'sourceChecks':checks,'frozenComparedByAuthor':False,
       'frozenComparisonNote':'Root aggregate may independently verify source against suppliedfreeze; author uses0Gitcommands and does not invent frozen blobs.',
       'formalCount':1,'candidateCount':0,'relatedCount':0,'runtimeAttempts':0,
       'existingTestSourceDeclarations':23,'existingTestsExecuted':0,
       'raw':None,'exit':None,'localLinkCount':len(links),'localLinks':links,
       'authorArtifactCountWithoutReceipt':len(owned),'metadataFailureCount':0,
       'copiedPriorNegativePrepModified':False,'productChanges':False,'gitWrites':False}
save(evidence/'renderer-metadata-check.json',check)
files=[{'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in owned]
save(evidence/'renderer-artifact-receipt.json',{'base':base,'report':str(report),
       'formalCount':1,'candidateCount':0,'relatedCount':0,
       'artifactCount':len(files),'files':files,'receiptExcludesItself':True,
       'copiedPrepExcluded':True,'foreignReviewArtifactsExcluded':True,
       'rawLogs':[],'runtimeAttempts':0,'productChanges':False,'gitWrites':False})
print(json.dumps({'sourcePins':16,'authorArtifacts':len(files),'receiptAdditional':1,
       'localLinks':len(links),'formal':1,'priority':'P3','runtimeAttempts':0,
       'reportSha256':sha(report.read_bytes()),'receiptSha256':sha((evidence/'renderer-artifact-receipt.json').read_bytes())},ensure_ascii=False))

"""Metadata-only static audit assembly. No product imports, scripts or tests."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round24'
EV=OUT/'evidence'
BASE='c9056c8047a8e75ab2469e59bf1d3fedd9ad7272'

def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(name):return json.loads((EV/name).read_text())
def save(name,value):(OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def rows(data,key):
    if isinstance(data,list):return data
    for name in [key,'related','observations']:
        if name in data:return data[name]
    raise ValueError(list(data))

prefixes=['root','windows','browser-helpers','browser-scenes']
findings,candidates,related=[],[],[]
for prefix in prefixes:
    findings+=rows(read(prefix+'-findings.json'),'findings')
    candidates+=rows(read(prefix+'-candidates.json'),'candidates')
    related+=rows(read(prefix+'-related.json'),'observations')
assert not findings and not candidates and not related
save('findings.json',dict(baseline=BASE,count=0,findings=[],note='No new established defect in bounded deep static review; not all-repository correctness.'))
save('candidates.json',dict(baseline=BASE,count=0,candidates=[]))
save('related.json',dict(baseline=BASE,count=0,observations=[],note='Known report-after-removal and prior WEB/retention boundaries discussed without new issue counts.'))
for prefix in ['windows','browser-helpers','browser-scenes']:
    data=read(prefix+'-validation.json');assert data['runs']==[]
    for key in ['productAttempts','testAttempts','pass','fail','expect','cleanRuns','failedRuns']:
        assert data['totals'][key]==0,(prefix,key)
totals=dict(firstBunShards=0,completedCleanShards=0,failedBunShards=0,productAttempts=0,testAttempts=0,runtimeImports=0,passedTests=0,expectations=0,failedTests=0,skippedOrFilteredTests=0,existingBaselineTests=0,focusedTests=0,productReruns=0,
    primaryFullStaticFiles=19,primaryFullStaticLines=7776,rootPrimaryFullStaticFiles=4,rootPrimaryFullStaticLines=1143,windowsPrimaryFullStaticFiles=5,windowsPrimaryFullStaticLines=2041,browserHelpersPrimaryFullStaticFiles=5,browserHelpersPrimaryFullStaticLines=1511,browserScenesPrimaryFullStaticFiles=5,browserScenesPrimaryFullStaticLines=3081)
save('validation.json',dict(baseline=BASE,totals=totals,runs=[],notes=[
    'All product/import/test/browser/installer/native/auth/custody/security/identity/realHOME/authority attempts0. No product raw/exit or fabricated passing test exists.',
    '19primarychangedscript/workflow targets full static7776lines;one release-history path selected. Extra full/selected dependencies stay in author manifests; fullstatic is not full contract/transitive/OS/runtime coverage.',
    'Previous64Node/31browser/83native/13UI and expected2pass6fail are historical contract/context only, never added to this batch0executions.',
    'Expectednegative exact case/status/source/HOME retention does not independently prove every failure cause; no new ordinary false-pass chain established.',
    'Generic settle cleanup delegated to caller and existing thirdtest permits attempt after primary error; no universal allassertion-retention contract inferred. Signal ledger meansrequests,notOSdelivery.',
    '135prior packageprep pins hash-only/provenance;no new package/dist/build/install/type/import/CLI failure invented or failed direction recovered.',
    'Root metadataEOF1156vsactual1155 assertion corrected with firstresponse note, not product failure/retry. Reportanchors and Gitwrite wording clarified before authorhash refresh.',
    'Concurrent main changed7commits/7paths incl2selectedfiles;frozen/source/current SHA separated. No nativefix/remoteacceptance/runtime replay or new5scripts comprehensive audit claim.',
    'No shareddependency/dist rebuild,fullsuite/build/typecheck/lint/E2E or external platform/action-version/OS behavior verification.',
]))

sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json'};checks=[]
for manifest_name in ['root-source-manifest.json','windows-source-manifest.json','browser-helpers-source-manifest.json','browser-scenes-source-manifest.json']:
    data=read(manifest_name)
    for row in data.get('files',data.get('sources',[])):
        name=row['path'];sources.add(name);frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT)
        expected=row.get('sha256',row.get('frozenSha256'));assert sha(frozen)==expected,(manifest_name,name)
        checks.append(dict(manifest=manifest_name,path=name,sha256=expected,note='Author reading-time frozen pin, not final-current equality promise'))
prep=read('root-prep-current.json')['checks']
for row in prep:
    sources.add(row['path']);assert sha(subprocess.check_output(['git','show',BASE+':'+row['path']],cwd=ROOT))==row['sha256']
main_head=subprocess.check_output(['git','rev-parse','main'],cwd=ROOT).decode().strip();manifest=[]
for name in sorted(sources):
    frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT);current=(ROOT/name).read_bytes();main=subprocess.check_output(['git','show',main_head+':'+name],cwd=ROOT)
    assert current==main,name
    manifest.append(dict(path=name,bytes=len(frozen),sha256=sha(frozen),frozenBlobVerified=True,currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=main==frozen,currentSha256=sha(current),mainSha256=sha(main),currentWorkingTreeMatchesMain=True,currentBytes=len(current),mainBytes=len(main)))
changed=[r['path'] for r in manifest if not r['mainMatchesFrozenBlob']]
expected={r['path'] for r in read('main-source-review.json')['changedSelectedSources']}
assert set(changed)==expected=={'.github/workflows/desktop-ui-acceptance.yml','docs/todo/release-real-operations-2026-10-16.md'},changed
save('source-manifest.json',dict(baseline=BASE,mainHead=main_head,files=manifest,workerSourceChecks=checks,priorPrepHashOnlyChecks=prep,changedFromFrozenPaths=changed,note='Frozenreading pins versus current/main hashes separate;2known concurrent updates.135prep checks not new fullsemantic reading.'))
save('addressed-sources.json',dict(baseline=BASE,count=0,sourceChanges=[],sourceMetadataChanges=read('main-source-review.json')['changedSelectedSources'],runtimeRetested=False,note='No addressedbug/fix claim. Concurrentworkflow9insertions/releasehistory214insertions observed in metadata;other5paths outside this frozen scope.'))
artifacts=[]
for receipt_name in ['root-artifact-receipt.json','windows-author-receipt.json','browser-helpers-author-receipt.json','browser-scenes-author-receipt.json']:
    data=read(receipt_name)
    for row in data.get('files',data.get('artifacts',[])):
        path=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path'];raw=path.read_bytes()
        assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],(receipt_name,row['path'])
        artifacts.append(dict(receipt=receipt_name,path=str(path.relative_to(ROOT)),sha256=sha(raw)))
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=artifacts,sourceCheckCount=len(checks),prepHashOnlyCheckCount=len(prep),productTestsRerun=False))
files=[]
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name!='evidence-index.json':
        raw=path.read_bytes();files.append(dict(path=str(path.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=files,note='Self excluded;0product raw logs. Metadata/scanner/proposal copies not product execution.'))
print(json.dumps(dict(findings=0,candidates=0,related=0,totals=totals,sourcePins=len(manifest),workerSourceChecks=len(checks),prepHashOnlyChecks=len(prep),workerArtifacts=len(artifacts),changedSelectedPaths=changed,indexedFiles=len(files))))

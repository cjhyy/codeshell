"""Metadata-only assembly; no product imports/tests. Run after author/reviews settle."""
from pathlib import Path
import json,hashlib,subprocess
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round25'
EV=OUT/'evidence'
BASE='8b9677c78d150abe9681a2f65ab8e55b1288be4b'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(name):return json.loads((EV/name).read_text())
def save(name,value):(OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def rows(d,*keys):
 if isinstance(d,list):return d
 for k in keys:
  if k in d:return d[k]
 raise ValueError(list(d))
findings=rows(read('output-findings.json'),'findings');candidates=rows(read('output-candidates.json'),'candidates');related=rows(read('output-related.json'),'related','observations')
assert len(findings)==1 and findings[0]['id']=='OUTPUT-R25-01' and findings[0]['priority']=='P2' and not candidates and not related
for name,data in [('findings',findings),('candidates',candidates),('related',related)]:save(name+'.json',dict(baseline=BASE,count=len(data),**{('observations' if name=='related' else name):data}))
author=read('output-validation.json');assert len(author['guardedRuns'])==1
run=author['guardedRuns'][0];assert run['exitCode']==0 and run['pass']==13 and run['expect']==23 and run['fail']==run['skipped']==run['productReruns']==0
raw=(ROOT/run['raw']).read_bytes();assert len(raw)==run['rawBytes'] and sha(raw)==run['rawSha256'];assert b'Completed Bun shard: 13 tests, 0 skipped; 0 failures.' in raw
normalized=dict(run,log=str((ROOT/run['raw']).relative_to(OUT)))
totals=dict(firstBunShards=1,completedCleanShards=1,failedBunShards=0,productAttempts=1,testAttempts=1,runtimeProductModules=1,passedTests=13,expectations=23,failedTests=0,skippedOrFilteredTests=0,existingBaselineTests=7,focusedTests=6,wrongBehaviorCharacterizations=4,focusedNormalControls=2,productReruns=0)
save('validation.json',dict(baseline=BASE,totals=totals,runs=[normalized],actualProductModules=['packages/core/src/runtime/output-clean.ts'],notes=author['limitations']+['Only actual leaf string behavior run;consumer/producer/ring/disk static. Existing7 include bounded originalANSIcontrols; focused6 onlyASCII CRLF/LF/bareCR. No newANSI/OSC/bidi/native/manager/tool experiment.','Prep/root/reviewer actions metadata/static only;guardrunner ownedHOME/JUnit writes are isolation,not a processlog diskpersistence reproduction.']))
sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json'};checks=[]
for name in ['root-source-manifest.json','output-source-manifest.json','output-static-source-manifest.json']:
 for row in rows(read(name),'files','sources'):
  path=row['path'];frozen=git('show',BASE+':'+path);assert sha(frozen)==row['sha256'],(name,path);sources.add(path);checks.append(dict(manifest=name,path=path,sha256=row['sha256'],readScope=row.get('coverage',row.get('readScope')),note='Author/reviewer declared static scopes,hash isprovenance notsemanticfullcoverage.'))
prep=read('prep-copy-receipt.json')
for row in prep['sourceChecks']:
 assert sha(git('show',BASE+':'+row['path']))==row['sha256'];sources.add(row['path'])
main_head=git('rev-parse','main').decode().strip();manifest=[]
for path in sorted(sources):
 frozen=git('show',BASE+':'+path);current=(ROOT/path).read_bytes();main=git('show',main_head+':'+path)
 assert current==main,path
 manifest.append(dict(path=path,bytes=len(frozen),sha256=sha(frozen),currentSha256=sha(current),mainSha256=sha(main),currentBytes=len(current),mainBytes=len(main),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=main==frozen,currentWorkingTreeMatchesMain=True))
changed=[r['path'] for r in manifest if not r['mainMatchesFrozenBlob']]
assert changed==[r['path'] for r in read('main-source-review.json')['changedSelectedSources']]
save('source-manifest.json',dict(baseline=BASE,mainHead=main_head,files=manifest,workerSourceChecks=checks,priorPrepHashOnlyChecks=prep['sourceChecks'],changedFromFrozenPaths=changed,note='Current==main;oneknownindexdelta fromfrozen separatelyrecorded. Root+author+staticreviewchecks separatefrom47prep hash-only checks;reviewextra sourcesnot runtime.'))
artifacts=[]
receipt=read('output-artifact-receipt.json')
for row in rows(receipt,'files','artifacts'):
 path=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path'];b=path.read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'],row['path'];artifacts.append(dict(receipt='output-artifact-receipt.json',path=str(path.relative_to(ROOT)),bytes=len(b),sha256=sha(b)))
for row in prep['files']:
 b=(OUT/row['path']).read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'],row['path'];artifacts.append(dict(receipt='prep-copy-receipt.json',path=str((OUT/row['path']).relative_to(ROOT)),bytes=len(b),sha256=sha(b)))
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=artifacts,sourceCheckCount=len(checks),prepHashOnlyCheckCount=len(prep['sourceChecks']),authorArtifactCount=len(rows(receipt,'files','artifacts')),prepCopyCount=len(prep['files']),productTestsRerun=False))
save('addressed-sources.json',dict(baseline=BASE,count=0,sourceChanges=[],sourceMetadataChanges=read('main-source-review.json')['changedSelectedSources'],runtimeRetested=False,note='New observed bug recorded,not fixed;index concurrentfeaturechange notfixverification.'))
index=[]
for p in sorted(OUT.rglob('*')):
 if p.is_file() and p.name!='evidence-index.json':
  b=p.read_bytes();index.append(dict(path=str(p.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=index,note='Self excluded;one owned raw product log retained verbatim.'))
print(json.dumps(dict(findings=1,candidates=0,related=0,tests=13,expect=23,sourcePins=len(manifest),sourceChecks=len(checks),prepHashOnlyChecks=len(prep['sourceChecks']),authorArtifacts=len(rows(receipt,'files','artifacts')),prepCopies=len(prep['files']),indexedFiles=len(index))))

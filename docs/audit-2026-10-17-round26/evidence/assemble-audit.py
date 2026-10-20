"""Aggregate static audit metadata. No product imports/tests/fixtures."""
from pathlib import Path
import json,hashlib,subprocess
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round26';EV=OUT/'evidence';BASE='6d61f57ade1ef1b9fdc4d33020652007d995e7a7'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(n):return json.loads((EV/n).read_text())
def save(n,d):(OUT/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def rows(d,*keys):
 if isinstance(d,list):return d
 for k in keys:
  if k in d:return d[k]
 raise ValueError(list(d))
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def pinsha(r):return r.get('sha256') or r.get('currentFilesystemSha256') or r.get('currentSha256') or r.get('finishFilesystemSha256') or r.get('firstCapturedSha256')
findings=[];candidates=[];related=[]
for prefix in ['root','target','renderer','service']:
 findings+=rows(read(prefix+'-findings.json'),'findings');candidates+=rows(read(prefix+'-candidates.json'),'candidates');related+=rows(read(prefix+'-related.json'),'related','observations')
assert {r['id'] for r in findings}=={'TUI-R26-01','RENDERER-R26-01'} and not candidates
assert len(related)==1 and related[0]['priorId']=='CLI-R4-01'
latest={r['id']:r for r in read('main-source-review.json')['latestFindingLocations']}
for finding in findings:finding['latestSourceMetadata']=latest[finding['id']]
save('findings.json',dict(baseline=BASE,count=2,findings=findings));save('candidates.json',dict(baseline=BASE,count=0,candidates=[]));save('related.json',dict(baseline=BASE,count=1,observations=related))
assert read('root-validation.json')['runs']==[]
assert read('renderer-validation.json')['runs']==read('renderer-validation.json')['guardedRuns']==[]
assert read('service-validation.json')['runs']==[]
assert read('target-validation.json')['productRuns']==read('target-validation.json')['testRuns']==0
totals=dict(firstBunShards=0,completedCleanShards=0,failedBunShards=0,productAttempts=0,testAttempts=0,runtimeImports=0,fixturesWritten=0,passedTests=0,expectations=0,failedTests=0,skippedOrFilteredTests=0,existingBaselineTests=0,focusedTests=0,productReruns=0)
save('validation.json',dict(baseline=BASE,totals=totals,runs=[],notes=['Bothformal findingsarestaticdirectproducer/callervalueflow;no nativebusinessGit/branchmutation orReact/UI/modelrun.','Source-derivedargv/Selectstate not actualobservedruntime. Existingtestsaredeclarations only;0executionsnot a green gate.','RootGitmetadata/workflow anddocument hashesdistinctfrombusinessproductexecution. OldCLI-R4-01 remainscandidateandfailedgroupSKIP;currentreviewconsumeronlyoldrelated,notnewformal.','Priornegativeprep12+targetprep8copies onlyprovenance/hashrechecks;notnewfullreads. FirstsemanticSHAabsentinoneprep retainedasnull,no retroactiveclaim.']))
sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json'};checks=[]
for name in ['root-source-manifest.json','target-source-manifest.json','renderer-source-manifest.json','service-source-manifest.json','review-renderer-source-manifest.json']:
 for row in rows(read(name),'files','sources'):
  path=row['path'];frozen=git('show',BASE+':'+path);expected=pinsha(row);assert sha(frozen)==expected,(name,path)
  ranges=row.get('selectedLineRanges') or [];assert all(1<=a<=b<=len(frozen.decode().splitlines()) for a,b in ranges),(name,path)
  sources.add(path);checks.append(dict(manifest=name,path=path,sha256=expected,scope=row.get('coverage',row.get('readScope')),rootIndependentlyBoundFrozenBlob=True,note='Authorreadtimeflags unchanged;Rootblobvalidation not an authordynamic orfullcoverageclaim.'))
prep_checks=read('prep-source-checks.json')['checks'][:]
for row in rows(read('target-prep/source-manifest.json'),'files','sources'):
 path=row['path'];expected=pinsha(row);assert sha(git('show',BASE+':'+path))==expected
 prep_checks.append(dict(path=path,sha256=expected,note='Originaltargetprep pin recheck only;readscope preservedinoriginalcopy;no newsemanticreading.'))
for row in prep_checks:sources.add(row['path']);assert sha(git('show',BASE+':'+row['path']))==row['sha256']
head=git('rev-parse','main').decode().strip();manifest=[]
for path in sorted(sources):
 frozen=git('show',BASE+':'+path);current=(ROOT/path).read_bytes();main=git('show',head+':'+path);assert current==main,path
 manifest.append(dict(path=path,bytes=len(frozen),sha256=sha(frozen),currentSha256=sha(current),mainSha256=sha(main),currentBytes=len(current),mainBytes=len(main),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=main==frozen,currentWorkingTreeMatchesMain=True))
changed=[r['path'] for r in manifest if not r['mainMatchesFrozenBlob']]
assert changed==[r['path'] for r in read('main-source-review.json')['changedSelectedSources']]
save('source-manifest.json',dict(baseline=BASE,mainHead=head,files=manifest,workerSourceChecks=checks,priorPrepHashOnlyChecks=prep_checks,changedFromFrozenPaths=changed,note='Frozenoldblob/rootcurrentmainseparate;9selectedconcurrentchangesrecorded.66author/reviewchecks include duplicates;15preprechecks are not newfullreading.'))
artifacts=[];author_count=0
for name in ['root-artifact-receipt.json','target-artifact-receipt.json','renderer-artifact-receipt.json','service-author-receipt.json']:
 for row in read(name)['files']:
  p=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path'];b=p.read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'],(name,row['path']);artifacts.append(dict(receipt=name,path=str(p.relative_to(ROOT)),bytes=len(b),sha256=sha(b)));author_count+=1
copy_count=0
for name in ['prep-copy-receipt.json','target-prep-copy-receipt.json']:
 for row in read(name)['files']:
  path=row.get('destination',row.get('path'));p=ROOT/path if path.startswith('docs/') else OUT/path;b=p.read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'],(name,path)
  artifacts.append(dict(receipt=name,path=str(p.relative_to(ROOT)),bytes=len(b),sha256=sha(b)));copy_count+=1
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=artifacts,sourceCheckCount=len(checks),prepHashOnlyCheckCount=len(prep_checks),authorArtifactCount=author_count,prepCopyCount=copy_count,productTestsRerun=False))
save('addressed-sources.json',dict(baseline=BASE,count=0,sourceChanges=[],sourceMetadataChanges=read('main-source-review.json')['changedSelectedSources'],runtimeRetested=False,note='No oldfixvalidated/newproductfix. BranchcodepredatesReviewfeature;newrecorddoesnotmeanintroducedbylatestcommit.'))
index=[]
for p in sorted(OUT.rglob('*')):
 if p.is_file() and p.name!='evidence-index.json':
  b=p.read_bytes();index.append(dict(path=str(p.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=index,note='Selfexcluded;0productrawlogs/0productruns. Metadatafirstresponsesnot rawtestprocesslogs.'))
print(json.dumps(dict(findings=2,candidates=0,related=1,sourcePins=len(manifest),sourceChecks=len(checks),prepHashOnlyChecks=len(prep_checks),authorArtifacts=author_count,prepCopies=copy_count,indexedFiles=len(index))))

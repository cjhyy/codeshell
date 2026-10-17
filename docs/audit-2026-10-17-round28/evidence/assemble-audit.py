"""Aggregate audit metadata; never import or execute product modules."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round28';EV=OUT/'evidence'
BASE='32c633e58c20b3853f49bb0e43264b4577281eac'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(n):return json.loads((EV/n).read_text())
def save(n,d):(OUT/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
def rows(d,*ks):
 if isinstance(d,list):return d
 for k in ks:
  if k in d:return d[k]
 raise ValueError(list(d))
findings=[];candidates=[];related=[]
for pre in ['root','lab','dialog','streaming']:
 findings+=rows(read(pre+'-findings.json'),'findings')
 candidates+=rows(read(pre+'-candidates.json'),'candidates')
 related+=rows(read(pre+'-related.json'),'observations','related')
assert {v['id'] for v in findings}=={'STREAMING-R28-01'} and not candidates and not related
for n,k,v in [('findings.json','findings',findings),('candidates.json','candidates',candidates),('related.json','observations',related)]:save(n,dict(baseline=BASE,count=len(v),**{k:v}))
for n in ['root','lab','dialog','streaming','coverage']:
 d=read(n+'-validation.json');assert d.get('runs',[])==[] and d.get('guardedRuns',[])==[]
 for k in ['productAttempts','testAttempts','runtimeImports','productReruns']:
  assert d.get(k,0)==0,(n,k)
totals=dict(firstBunShards=0,completedCleanShards=0,failedBunShards=0,productAttempts=0,testAttempts=0,runtimeImports=0,fixturesAuthored=0,passedTests=0,expectations=0,failedTests=0,productReruns=0)
save('validation.json',dict(baseline=BASE,totals=totals,runs=[],notes=['All findings and counterevidence static source contracts; zero product/React/parser/fixture/native/model runtime.','Existing test declarations were read only. No raw/exit exists to fabricate.','R27 failed compose direction and all earlier skipped groups remain un-retried.']))
manifest_names=['root-source-manifest.json','lab-source-manifest.json','dialog-source-manifest.json','streaming-source-manifest.json','review-streaming-root-source-manifest.json']
optional='review-streaming-independent-source-manifest.json'
if (EV/optional).is_file():manifest_names.append(optional)
sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json'};checks=[]
for name in manifest_names:
 for row in rows(read(name),'files','sources'):
  path=row['path'];frozen=git('show',BASE+':'+path);expected=row.get('sha256') or row.get('firstFilesystemSha256') or row.get('initialFilesystemSha256');assert expected==sha(frozen),(name,path)
  ranges=row.get('selectedLineRanges') or row.get('ranges') or [];assert all(1<=a<=z<=len(frozen.decode().splitlines()) for a,z in ranges),(name,path)
  checks.append(dict(manifest=name,path=path,sha256=expected,coverage=row.get('coverage',row.get('readScope')),rootBoundFrozenGitBlob=True,note='Original author read-time timing and no-Git flags retained. Root binding does not retroactively prove read-start SHA or whole-source semantic reading.'));sources.add(path)
prep=[]
for row in read('lab-prep/initial-pins.json')['files']:
 path=row['path'];expected=row['firstFilesystemSha256'];assert sha(git('show',BASE+':'+path))==expected,path;prep.append(dict(path=path,sha256=expected,coverage='Lab prep inventory hash-only current-baseline Git binding, not an additional semantic read'));sources.add(path)
ranking=read('coverage-prep/coverage-ranking.json')
for path in ['packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts','packages/desktop/src/renderer/ui/dialogState.ts','packages/desktop/src/renderer/sessionStatus.ts']:
 matches=[v for v in ranking['rankedCandidates'] if v['path']==path];assert len(matches)==1
 row=matches[0];assert sha(git('show',BASE+':'+path))==row['sha256'];prep.append(dict(path=path,sha256=row['sha256'],coverage='Coverage shortlist hash-only recheck; active semantic scope separately listed by assigned author'));sources.add(path)
head=git('rev-parse','main').decode().strip();manifest=[]
for path in sorted(sources):
 frozen=git('show',BASE+':'+path);current=(ROOT/path).read_bytes();main=git('show',head+':'+path);assert current==main,path
 manifest.append(dict(path=path,bytes=len(frozen),sha256=sha(frozen),currentBytes=len(current),currentSha256=sha(current),mainBytes=len(main),mainSha256=sha(main),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=main==frozen,currentWorkingTreeMatchesMain=True))
changed=[v['path'] for v in manifest if not v['mainMatchesFrozenBlob']];assert changed==read('main-source-review.json')['changedSelectedSourcePaths']
save('source-manifest.json',dict(baseline=BASE,mainHead=head,files=manifest,workerSourceChecks=checks,priorPrepHashOnlyChecks=prep,changedFromFrozenPaths=changed,packageInventoryHashOnlyRecheck='evidence/coverage-current-recheck.json',note='4087 package inventory hashes are not semantic coverage or individual Root Git binding; frozen source/current/main and semantic scopes remain separate. Erroneous first range metadata retained only as diagnostic, not active contributor.'))
receipts=['root-artifact-receipt.json','lab-artifact-receipt.json','dialog-author-receipt.json','streaming-artifact-receipt.json','coverage-artifact-receipt.json'];art=[];author_count=0
for name in receipts+['lab-prep-copy-receipt.json','coverage-prep-copy-receipt.json']:
 for row in read(name)['files']:
  path=row.get('destination',row.get('path'));q=ROOT/path if path.startswith('docs/') else OUT/path;b=q.read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'],(name,path)
  if 'source' in row:assert Path(row['source']).read_bytes()==b,row['source']
  art.append(dict(receipt=name,path=str(q.relative_to(ROOT)),bytes=len(b),sha256=sha(b)))
  if name in receipts:author_count+=1
assert len(art)-author_count==18
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=art,sourceCheckCount=len(checks),prepHashOnlyCheckCount=len(prep),authorArtifactCount=author_count,prepCopyCount=18,packageInventoryHashOnlyChecks=4087,productTestsRerun=False))
save('addressed-sources.json',dict(baseline=BASE,count=0,sourceChanges=[],sourceMetadataChanges=changed,runtimeRetested=False,note='Audit only; no product fix or runtime fix acceptance.'))
index=[]
for q in sorted(OUT.rglob('*')):
 if q.is_file() and q.name!='evidence-index.json':
  b=q.read_bytes();index.append(dict(path=str(q.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=index,note='Self excluded. No product raw log or test run. Metadata diagnostic excerpts/first mistaken range are labeled and separate.'))
print(json.dumps(dict(findings=1,candidates=0,related=0,sourcePins=len(manifest),sourceChecks=len(checks),prepHashOnlyChecks=len(prep),authorArtifacts=author_count,prepCopies=18,indexedFiles=len(index))))

"""Assemble frozen marketplace-list review, dated coverage metadata and old-ID source-stage status; no product imports/execution."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round44';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());baseline=plan['baseline'];main=plan['refreshedMain'];assert git('rev-parse','HEAD').decode().strip()==main
GROUPS=[('market-frontier','artifact-receipt.json',48,'ui-data-frontier'),('market-review','reviewer-receipt.json',48,'notification-review'),('market-aggregate','artifact-receipt.json',44,'market-aggregate-review'),('coverage-frontier','artifact-receipt.json',49,'coverage-frontier'),('coverage-status','artifact-receipt.json',51,'coverage-status'),('source-status-root','artifact-receipt.json',50,'source-disposition'),('source-status-review','reviewer-receipt.json',50,'source-review'),('source-status-aggregate','artifact-receipt.json',50,'source-aggregate-review')]
copies=[];receipts=[];pins={};active=[];hashonly=[];incidental=[];snapshots=[]
for stem,receipt,prep_round,source_stem in GROUPS:
 src=Path('/tmp/codeshell-audit-round'+str(prep_round)+'-'+source_stem);dest=EV/stem;dest.mkdir(exist_ok=True)
 if receipt=='AUTO':
  options=[n for n in ['author-receipt.json','artifact-receipt.json','reviewer-receipt.json'] if (src/n).is_file()];assert len(options)==1;receipt=options[0]
 for p in sorted(src.rglob('*')):
  if p.is_dir() or (stem=='source-status-root' and p.name=='source-diff.first.txt'):continue
  assert p.is_file() and not p.is_symlink();rel=p.relative_to(src);target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True);b=p.read_bytes()
  if target.exists():assert target.read_bytes()==b
  else:target.write_bytes(b)
  copies.append(dict(source=str(p),path=str(target.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
  lines=b.splitlines();trailing=[i for i,l in enumerate(lines,1) if l.endswith((b' ',b'\t'))]
  if trailing or b.endswith(b'\n\n'):snapshots.append(dict(path=str(target.relative_to(ROOT)),source=str(p),bytes=len(b),sha256=sha(b),trailingLineNumbers=trailing,newBlankLineAtEof=b.endswith(b'\n\n'),preservation='Frozen provenance artifact bytes; never product runtime log or product source mutation.'))
 names=[receipt]+(['history-peer/author-receipt.json'] if stem=='marketplace-local-frontier' else [])
 for name in names:
  rp=src/name;j=json.loads(rp.read_text());rr=j.get('files',j.get('artifacts',[]));assert rr
  for r in rr:
   source=Path(r['path']);relative=source.relative_to(rp.parent) if source.is_absolute() else source;assert '..' not in relative.parts;target=dest/Path(name).parent/relative;b=target.read_bytes();assert len(b)==r['bytes'] and sha(b)==r['sha256'],(stem,name,str(relative))
   receipts.append(dict(receipt=str((dest/name).relative_to(OUT)),path=str(target.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
 mp=dest/'source-manifest.json'
 if not mp.exists():continue
 j=json.loads(mp.read_text())
 for collection in ['files','historicalReportReads','instructionsCarryForward','instructionCarryForward','instructionFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','navigationOnlyFiles','instructionPins']:
  for r in j.get(collection,[]):
   path=r['path'];h=r['sha256'];current=(ROOT/path).read_bytes();version=None
   for ref in [baseline,'c2db5d9259afcc4c7264d190ab6bb673d49d5fe0','07e5791b1fc1ad1fcfd5c55c2913d8a45f1b20cb']:
    raw=git('show',ref+':'+path)
    if sha(raw)==h:
     version=ref;b=raw;break
   assert version is not None and len(b)==r['bytes'],(stem,path,h)
   for a,z in r.get('selectedLineRanges',[]):assert 1<=a<=z<=len(b.splitlines())
   pins.setdefault(path,{})[h]=dict(sha256=h,bytes=len(b),gitSourceVersion=version,currentShaMatchesRead=sha(current)==h)
   if current!=b:
    assert path=='packages/desktop/src/preload/types.d.ts' and h=='cd152ddf606dac52a88370b05808ce5c9eafe9d968b5162a5fb4211161a546ba'
    assert sha(current)=='31935ed8a627c1552a4a6867d0811c667e27bf8dfdf7240853eba8198ebde0f0'
    for a,z in [[863,883],[2068,2094]]:assert b.splitlines(keepends=True)[a-1:z]==current.splitlines(keepends=True)[a-1:z]
   coverage=r.get('coverage','instruction-carry-forward')
   row=dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,sha256=h,coverage=coverage,note='Original timing/ranges/null and same-read limitations retained; formalization adds no repeated semantic read.')
   (hashonly if 'hash' in coverage or collection in ['instructionsCarryForward','instructionCarryForward','instructionFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','instructionPins'] else incidental if 'navigation' in coverage or 'incidental' in coverage else active).append(row)
receipts.extend(dict(receipt='prep-copy-receipt.json',path=r['path'],bytes=r['bytes'],sha256=r['sha256']) for r in copies)
write(EV/'prep-copy-receipt.json',dict(copies=copies,productRuns=0));write(EV/'root-receipt-checks.json',dict(checks=receipts,productExecution=False));write(EV/'frozen-artifact-whitespace.json',dict(exactArtifacts=snapshots,productRuns=0,scope='Only frozen copied provenance. All other files must pass ordinary whitespace check; full check actual exit retained.'))
files=[]
for path,versions in sorted(pins.items()):
 frozen=git('show',baseline+':'+path);current=(ROOT/path).read_bytes();mainraw=git('show',main+':'+path);assert current==mainraw
 files.append(dict(path=path,bytes=len(frozen),sha256=sha(frozen),currentBytes=len(current),currentSha256=sha(current),mainBytes=len(mainraw),mainSha256=sha(mainraw),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=mainraw==frozen,readVersions=list(versions.values())))
write(OUT/'source-manifest.json',dict(baseline=baseline,mainHead=main,files=files,workerSourceChecks=active,hashOnlyChecks=hashonly,incidentalChecks=incidental,changedFromFrozenPaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],priorReadVersionsDifferentFromTaskBaseline=[r['path'] for r in files if any(v['sha256']!=r['sha256'] for v in r['readVersions'])],versionPolicy='Per-read SHA and original baseline retained. Old types.d.ts SHA binds to c2db; current binds to task/main. Only old selected DTO spans 863-883 and2068-2094 are byte-equal; whole file changed. New50 source read has its own newer SHA. Root binding adds no source-body read or full coverage.'))
write(OUT/'source-status-updates.json',json.loads((EV/'source-status-root/source-status-updates.json').read_text()))

write(OUT/'findings.json',dict(baseline=baseline,count=0,findings=[]));write(OUT/'candidates.json',dict(baseline=baseline,count=0,candidates=[],note='No new candidate in finite ordinary marketplace-list scope. Three source dispositions reference old IDs only; not new findings or related classifications.'));write(OUT/'related.json',dict(baseline=baseline,count=0,related=[]))
write(OUT/'validation.json',dict(baseline=baseline,runs=[],totals=dict(productAttempts=0,passedTests=0,expectations=0,productReruns=0),mode='Static ordinary marketplace-list DTO review and dated coverage metadata; source-stage follow-up of three old IDs. Worker0 Git; Root prior five-file Git diff read1 and formal binding metadata separately recorded. No product/helper/Buffer/fixture/test/React/UI/model/native/business-network execution.'))
c=json.loads((EV/'coverage-status/summary.json').read_text());summary=dict(baseline=baseline,mainHead=main,formal=0,candidates=0,related=0,oldSourceStatusUpdates=3,runtimeFixConfirmations=0,uniqueSourcePins=len(files),activeSourceChecks=len(active),incidentalSourceChecks=len(incidental),hashOnlyChecks=len(hashonly),receiptChecks=len(receipts),verbatimCopies=len(copies),frozenWhitespaceArtifacts=len(snapshots),datedConservativeCoverage=c,productRuns=0,goalStillActive=True);write(OUT/'coverage.json',summary);print(json.dumps(summary,ensure_ascii=False))

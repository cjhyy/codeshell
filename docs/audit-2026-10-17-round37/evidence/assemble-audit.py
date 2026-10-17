"""Assemble frozen static namespace audit; no product imports/execution."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round37';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());baseline=plan['baseline'];main=plan['refreshedMain'];assert git('rev-parse','HEAD').decode().strip()==main
GROUPS=[('marketplace-local-frontier','author-receipt.json'),('local-marker-review','artifact-receipt.json'),('root-frontier','author-receipt.json'),('root-review','author-receipt.json'),('aggregate-review','reviewer-receipt.json'),('history-supplement','reviewer-receipt.json')]
copies=[];receipts=[];pins={};active=[];hashonly=[];snapshots=[]
for stem,receipt in GROUPS:
 src=Path('/tmp/codeshell-audit-round37-'+stem);dest=EV/stem;dest.mkdir(exist_ok=True)
 for p in sorted(src.rglob('*')):
  if p.is_dir():continue
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
 for collection in ['files','historicalReportReads','instructionsCarryForward']:
  for r in j.get(collection,[]):
   path=r['path'];h=r['sha256'];b=(ROOT/path).read_bytes();assert len(b)==r['bytes'] and sha(b)==h
   for a,z in r.get('selectedLineRanges',[]):assert 1<=a<=z<=len(b.splitlines())
   assert path not in pins or pins[path]==h;pins[path]=h;coverage=r.get('coverage','instruction-carry-forward')
   row=dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,sha256=h,coverage=coverage,note='Original timing/ranges/null and same-read limitations retained; formalization adds no repeated semantic read.')
   (hashonly if 'hash' in coverage or collection=='instructionsCarryForward' else active).append(row)
receipts.extend(dict(receipt='prep-copy-receipt.json',path=r['path'],bytes=r['bytes'],sha256=r['sha256']) for r in copies)
write(EV/'prep-copy-receipt.json',dict(copies=copies,productRuns=0));write(EV/'root-receipt-checks.json',dict(checks=receipts,productExecution=False));write(EV/'frozen-artifact-whitespace.json',dict(exactArtifacts=snapshots,productRuns=0,scope='Only frozen copied provenance. All other files must pass ordinary whitespace check; full check actual exit retained.'))
files=[]
for path,h in sorted(pins.items()):
 frozen=git('show',baseline+':'+path);current=(ROOT/path).read_bytes();mainraw=git('show',main+':'+path);assert sha(frozen)==h and current==mainraw
 files.append(dict(path=path,bytes=len(frozen),sha256=h,currentBytes=len(current),currentSha256=sha(current),mainBytes=len(mainraw),mainSha256=sha(mainraw),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=mainraw==frozen))
write(OUT/'source-manifest.json',dict(baseline=baseline,mainHead=main,files=files,workerSourceChecks=active,hashOnlyChecks=hashonly,changedFromFrozenPaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],note='Parent/independent proposed opinions preserved. Old full/selected/hash distinctions remain; child historical selected text is not automatically another active source manifest.'))
finding=dict(id='MARKETPLACE-R37-01',severity='P3',status='confirmed-statically',title='A legal marketplace named local is routed to direct-local plugin uninstall',location=dict(path='packages/desktop/src/renderer/extensions/uninstallTarget.ts',start=29,end=34),trigger='A valid marketplace has registry name local and a plugin is successfully installed from it; the ordinary state has no direct-local directory for that plugin name.',expected='Use the marketplace uninstall route for its cached installation.',actual='The catalog suffix is local, so resolver returns kind local and the UI calls uninstallLocalPlugin. Its direct-directory guard rejects rather than uninstalling the marketplace cache entry.',cause='Allowed marketplace names and the direct-local origin marker share the same namespace and plugin@local identity, while the routing DTO/helper lacks a discriminating origin.',evidence=['evidence/marketplace-local-frontier/proposal.md','evidence/local-marker-review/report.md','evidence/root-frontier/proposal.md','evidence/aggregate-review/review.md'],counterevidence=['Actual direct-local marker behavior is intentional and must be preserved.','CSMeta/source and installPath exist, but the inspected catalog/helper routing does not use them to distinguish these origins.','Old truthy-local missing branch is the reverse-origin failure; R52 local version cache and PROFILE-R5-01 repo-key folding are separate causes.'],validation='Three attributed static source scopes plus metadata review; no product/helper/fixture/test, install/uninstall/catalog/existsSync/HTTP/native execution. No runtime observation or deletion/damage claim.',remediation='Preserve an explicit installation origin through the producer/summary/helper contract, or consistently reserve/migrate the name; do not simply remove actual local-marker support.',provenanceCandidateAlias='MARKETPLACE-LOCAL-R37-C1',classificationNote='Root promotes this same candidate to one static P3 finding after supported ordinary input/entry and deterministic branch/callee proof. Original candidate/support records are unchanged; alias is not a second item.')
write(OUT/'findings.json',dict(baseline=baseline,count=1,findings=[finding]));write(OUT/'candidates.json',dict(baseline=baseline,count=0,candidates=[],promotedAliases=[dict(fromId='MARKETPLACE-LOCAL-R37-C1',toId='MARKETPLACE-R37-01')]));write(OUT/'related.json',dict(baseline=baseline,count=0,related=[]))
write(OUT/'validation.json',dict(baseline=baseline,runs=[],totals=dict(productAttempts=0,passedTests=0,expectations=0,productReruns=0),mode='Static ordinary name/identity/UI routing contract only. Metadata source readers/scanners and byte checks are not product validation.'))
h=json.loads((EV/'root-history.json').read_text());summary=dict(baseline=baseline,mainHead=main,formal=1,candidates=0,related=0,uniqueSourcePins=len(files),activeSourceChecks=len(active),hashOnlyChecks=len(hashonly),receiptChecks=len(receipts),verbatimCopies=len(copies),frozenWhitespaceArtifacts=len(snapshots),historyFiles=h['files'],history=h['stats'],productRuns=0,goalStillActive=True);write(OUT/'coverage.json',summary);print(json.dumps(summary,ensure_ascii=False))

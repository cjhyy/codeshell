"""Assemble frozen ordinary callsite reviews, targeted elapsed verification, historical list and metadata checks; no product imports/execution."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round48';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());baseline=plan['baseline'];main=plan['refreshedMain'];assert git('rev-parse','HEAD').decode().strip()==main
GROUPS=[('cost-context-frontier','artifact-receipt.json',61,'cost-context'),('chat-adapter-frontier','reviewer-receipt.json',62,'chat-adapter'),('cost-context-review','reviewer-receipt.json',63,'cost-context-review'),('elapsed-frontier','reviewer-receipt.json',64,'tui-status'),('session-title-frontier','artifact-receipt.json',65,'session-titles'),('root-elapsed-review','reviewer-receipt.json',66,'elapsed-review'),('elapsed-review','reviewer-receipt.json',67,'elapsed-review'),('user-catalog-draft','receipt.json',68,'user-catalog'),('packet-review','reviewer-receipt.json',69,'packet-review'),('delivery-review','reviewer-receipt.json',70,'delivery-review')]
copies=[];receipts=[];pins={};active=[];hashonly=[];incidental=[];snapshots=[]
for stem,receipt,prep_round,source_stem in GROUPS:
 src=Path('/tmp/codeshell-audit-round'+str(prep_round)+'-'+source_stem);dest=EV/stem;dest.mkdir(exist_ok=True)
 if receipt=='AUTO':
  options=[n for n in ['author-receipt.json','artifact-receipt.json','reviewer-receipt.json'] if (src/n).is_file()];assert len(options)==1;receipt=options[0]
 for p in sorted(src.rglob('*')):
  if p.is_dir() or (stem=='root-mcp-frontier' and p.name=='source-excerpts.txt'):continue
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
   path=r['path'];h=r['sha256'];b=(ROOT/path).read_bytes();assert len(b)==r['bytes'] and sha(b)==h
   for a,z in r.get('selectedLineRanges',[]):assert 1<=a<=z<=len(b.splitlines())
   assert path not in pins or pins[path]==h;pins[path]=h;coverage=r.get('coverage','instruction-carry-forward')
   row=dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,sha256=h,coverage=coverage,note='Original timing/ranges/null and same-read limitations retained; formalization adds no repeated semantic read.')
   (hashonly if 'hash' in coverage or collection in ['instructionsCarryForward','instructionCarryForward','instructionFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','instructionPins'] else incidental if 'navigation' in coverage or 'incidental' in coverage else active).append(row)
receipts.extend(dict(receipt='prep-copy-receipt.json',path=r['path'],bytes=r['bytes'],sha256=r['sha256']) for r in copies)
write(EV/'prep-copy-receipt.json',dict(copies=copies,productRuns=0));write(EV/'root-receipt-checks.json',dict(checks=receipts,productExecution=False));write(EV/'frozen-artifact-whitespace.json',dict(exactArtifacts=snapshots,productRuns=0,scope='Only frozen copied provenance. All other files must pass ordinary whitespace check; full check actual exit retained.'))
files=[]
for path,h in sorted(pins.items()):
 frozen=git('show',baseline+':'+path);current=(ROOT/path).read_bytes();mainraw=git('show',main+':'+path);assert sha(frozen)==h and current==mainraw
 files.append(dict(path=path,bytes=len(frozen),sha256=h,currentBytes=len(current),currentSha256=sha(current),mainBytes=len(mainraw),mainSha256=sha(mainraw),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=mainraw==frozen))
write(OUT/'source-manifest.json',dict(baseline=baseline,mainHead=main,files=files,workerSourceChecks=active,hashOnlyChecks=hashonly,incidentalChecks=incidental,changedFromFrozenPaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],note='Original full/selected/navigation/hash distinctions and timing retained. Discovery-only hash pins do not become semantic coverage through current Git binding. No product execution or source reread added.'))
finding=json.loads((EV/'formal-finding-input.json').read_text())
write(OUT/'findings.json',dict(baseline=baseline,count=1,findings=[finding]))
write(OUT/'candidates.json',dict(baseline=baseline,count=0,candidates=[],promotedAliases=['STATUSLINE-R64-C1'],note='Original64 candidate retained verbatim in frozen packet; promoted once as TUI-R48-01, no second candidate count.'))
write(OUT/'related.json',dict(baseline=baseline,count=0,related=[]))
write(OUT/'validation.json',dict(baseline=baseline,runs=[],totals=dict(productAttempts=0,passedTests=0,expectations=0,productReruns=0),mode='Static ordinary cost/chat/session data and elapsed control-flow review, metadata-only catalog and integrity checks. No product/helper/fixture/test/React/clock/timer/model/native/business-network or authority experiment. Root Git metadata separately recorded.'))
summary=dict(baseline=baseline,mainHead=main,formal=1,candidates=0,related=0,uniqueSourcePins=len(files),activeSourceChecks=len(active),incidentalSourceChecks=len(incidental),hashOnlyChecks=len(hashonly),receiptChecks=len(receipts),verbatimCopies=len(copies),frozenWhitespaceArtifacts=len(snapshots),datedCoverageReference='Round47 inspectionScope adapter through frozen45 only:4643 TS/TSX,304full/169selected/4170unknown;46+ source reads not recomputed into it;4339 not unread/remaining bug count.',historicalFormalRecords=112,priorities=dict(P2=44,P3=68),productRuns=0,goalStillActive=True);write(OUT/'coverage.json',summary);print(json.dumps(summary,ensure_ascii=False))

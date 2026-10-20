"""Assemble frozen session/job/static-path reviews; source binding is metadata only, one separately recorded product unit shard."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round57';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());baseline=plan['baseline'];main=plan['refreshedMain'];assert git('rev-parse','HEAD').decode().strip()==main
GROUPS=[('pet-topic','AUTO',132,'topic-segment'),('tool-jobs','AUTO',133,'tool-jobs'),('session-titles','AUTO',134,'session-titles'),('root-static-files','AUTO',135,'static-files'),('pet-closure-review','AUTO',136,'pet-closure-review'),('mobile-path-review','AUTO',137,'mobile-path-review')]
copies=[];receipts=[];pins={};active=[];hashonly=[];incidental=[];snapshots=[];unbound=[];frozen_cache={};missing_declared_bytes=[];nonreading_gate_assertions=[]
def frozen(path):
 if path not in frozen_cache:frozen_cache[path]=git('show',baseline+':'+path)
 return frozen_cache[path]
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
 collections=['files','historicalReportReads','instructionsCarryForward','instructionCarryForward','instructionFiles','instructionPins','instructionReads','instructionHashOnly','instructionsHashOnly','instructionHashOnlyFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','hashOnlyProducts','navigationOnlyFiles','filenameNavigation','filenameOnlyNavigation','navigationOnlyUnreviewed','filenameOnlyUnopened','hashOnlySourceRows','metadataFiles','historicalMetadataSelected','contractMetadataFiles','historicalMarkdownSelected','canonicalMetadataDocuments','navigationOrHashOnlyFiles','instructionCarryForwardFiles','instructionHashOnlyPins']
 hash_collections={'instructionsCarryForward','instructionCarryForward','instructionFiles','instructionPins','instructionReads','instructionHashOnly','instructionsHashOnly','instructionHashOnlyFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','hashOnlyProducts','hashOnlySourceRows','instructionHashOnlyPins','instructionCarryForwardFiles'}
 for key,values in j.items():
  if key=='gateDecisions' and stem=='root-agent-registry':
   for r in values:
    assert j['files']==[] and r['disposition'].startswith('old-full-excluded-before-') and any(p['path']==r['path'] and p['sha256']==r['sha256'] for p in j['hashOnlyFiles'])
    nonreading_gate_assertions.append(dict(manifest=str(mp.relative_to(EV)),path=r['path'],sha256=r['sha256'],note='Duplicate old-full decision bound to explicit hash-only row and empty current semantic files; original qualifiers and missing newProductSemanticLines field preserved, not additional source reading.'))
  elif isinstance(values,list) and key not in collections:
   assert not any(isinstance(r,dict) and str(r.get('path','')).startswith('packages/') and 'sha256' in r for r in values),(stem,key,'Unclassified top-level current product pins require explicit adapter review')
 for collection in collections:
  for r in j.get(collection,[]):
   if isinstance(r,str) or 'sha256' not in r:
    unbound.append(dict(manifest=str(mp.relative_to(EV)),collection=collection,row=r,note='Original filename/navigation reference only; no new hash/source binding or semantic reading inferred.'));continue
   path=r['path'];h=r['sha256'];b=frozen(path);assert sha(b)==h,(stem,path)
   if 'bytes' in r:assert len(b)==r['bytes'],(stem,path)
   else:missing_declared_bytes.append(dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,reportedBytes=None,rootFrozenGitBytes=len(b),note='No author byte count invented; Root independently binds Git bytes.'))
   for a,z in r.get('selectedLineRanges',[]):assert 1<=a<=z<=len(b.splitlines()),(stem,path,a,z)
   assert path not in pins or pins[path]==h;pins[path]=h;coverage=r.get('coverage','hash-only-from-collection' if collection in hash_collections else 'navigation-only-from-collection' if collection!='files' else 'selected-original-scope-preserved')
   row=dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,sha256=h,coverage=coverage,note='Original timing/ranges/null and same-read limitations retained; formalization adds no repeated semantic read.')
   (hashonly if 'hash' in coverage or collection in hash_collections else incidental if 'navigation' in coverage or 'incidental' in coverage else active).append(row)

receipts.extend(dict(receipt='prep-copy-receipt.json',path=r['path'],bytes=r['bytes'],sha256=r['sha256']) for r in copies)
write(EV/'source-pin-adapter-notes.json',dict(missingDeclaredByteCounts=missing_declared_bytes,nonReadingGateAssertions=nonreading_gate_assertions,unboundNavigationReferences=unbound,scope='Only explicit frozen source/instruction/nav/hash pins bound; filename-only references stay unbound, missing bytes derived separately from baseline Git, never fabricated into original rows.',productRuns=0));write(EV/'prep-copy-receipt.json',dict(copies=copies,scope='Metadata copy only; product run recorded in validation.json'));write(EV/'root-receipt-checks.json',dict(checks=receipts,productExecution=False));write(EV/'frozen-artifact-whitespace.json',dict(exactArtifacts=snapshots,productRuns=0,scope='Only frozen copied provenance. All other files must pass ordinary whitespace check; full check actual exit retained.'))
files=[]
for path,h in sorted(pins.items()):
 frozen_raw=frozen(path);current=(ROOT/path).read_bytes();mainraw=git('show',main+':'+path);assert sha(frozen_raw)==h and current==mainraw
 files.append(dict(path=path,bytes=len(frozen_raw),sha256=h,currentBytes=len(current),currentSha256=sha(current),mainBytes=len(mainraw),mainSha256=sha(mainraw),currentWorkingTreeMatchesFrozenBlob=current==frozen_raw,mainMatchesFrozenBlob=mainraw==frozen_raw))
write(OUT/'source-manifest.json',dict(baseline=baseline,mainHead=main,files=files,workerSourceChecks=active,hashOnlyChecks=hashonly,incidentalChecks=incidental,changedFromFrozenPaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],note='Original full/selected/navigation/hash distinctions and timing retained. Discovery-only hash pins do not become semantic coverage through current Git binding. No product execution or source reread added.'))
decision=json.loads((EV/'root-decision.json').read_text())
assert decision['independent136SupportVerified'] is True
write(OUT/'findings.json',dict(baseline=baseline,count=len(decision['formal']),findings=decision['formal']))
write(OUT/'candidates.json',dict(baseline=baseline,count=len(decision['candidates']),candidates=decision['candidates'],note='Original132/136 candidate is promoted once to PET-R57-01 by Root; no duplicate pending entry. STATIC-R135-C1 remains unproven for actual default asset producer.'))
write(OUT/'related.json',dict(baseline=baseline,count=0,related=[]))
run=json.loads((EV/'root-static-files/static-path-first-exit.json').read_text())
assert run['exitCode']==0 and run['firstAttempt'] and run['reruns']==0
write(OUT/'validation.json',dict(baseline=baseline,runs=[dict(command=run['command'],stdout='evidence/root-static-files/static-path-first.stdout',stderr='evidence/root-static-files/static-path-first.stderr',exit='evidence/root-static-files/static-path-first-exit.json',exitCode=0,firstAttempt=True)],totals=dict(productAttempts=1,passedTests=3,expectations=8,failedTests=0,productReruns=0),mode='One guarded static-handler unit shard only, real owned temporary files and Writable response recorder; no actual server/socket/proxy/browser/model/worker/Core Engine/native/account/business-network experiments. PET finding is static only; its independent reviewers ran no product. Existing test declarations not executed.'))
summary=dict(baseline=baseline,mainHead=main,formal=len(decision['formal']),candidates=len(decision['candidates']),related=0,uniqueSourcePins=len(files),activeSourceChecks=len(active),incidentalSourceChecks=len(incidental),hashOnlyChecks=len(hashonly),unboundNavigationReferences=len(unbound),missingDeclaredByteCounts=len(missing_declared_bytes),receiptChecks=len(receipts),verbatimCopies=len(copies),frozenWhitespaceArtifacts=len(snapshots),datedCoverageReference='Original45 migrated same-SHA snapshot4643 paths:304full/168selected/4171unknown;46–53 DEFERRED_UNPARSED,54–57 not backfilled. This round adds one evidence-only TS fixture to the current filtered inventory, no new full certification.',historicalFormalRecords=117,priorities=dict(P2=44,P3=73),changedFromFrozenSourcePaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],productRuns=1,goalStillActive=True)
write(OUT/'coverage.json',summary)
print(json.dumps(summary,ensure_ascii=False))

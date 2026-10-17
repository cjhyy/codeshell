"""Assemble frozen coverage/capability/context/composition reviews; metadata binding only, zero current product executions."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round64';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());baseline=plan['baseline'];main=plan['refreshedMain'];assert git('rev-parse','HEAD').decode().strip()==main
GROUPS=[('server-auth','AUTO',172,'server-auth'),('panel-github','AUTO',173,'panel-github'),('server-attachments','AUTO',174,'server-attachments'),('root-settings','AUTO',175,'settings-flags'),('attachment-peer','AUTO',176,'attachment-peer')]
copies=[];receipts=[];pins={};active=[];hashonly=[];incidental=[];snapshots=[];unbound=[];frozen_cache={};missing_declared_bytes=[];nonreading_gate_assertions=[];external_inputs=[]
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
 if not mp.exists():mp=dest/'metadata-manifest.json'
 if not mp.exists():continue
 j=json.loads(mp.read_text())
 collections=['files','historicalReportReads','instructionsCarryForward','instructionCarryForward','instructionFiles','instructionPins','instructionReads','instructionHashOnly','instructionsHashOnly','instructionHashOnlyFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','hashOnlyProducts','navigationOnlyFiles','filenameNavigation','filenameOnlyNavigation','navigationOnlyUnreviewed','filenameOnlyUnopened','hashOnlySourceRows','metadataFiles','historicalMetadataSelected','contractMetadataFiles','historicalMarkdownSelected','canonicalMetadataDocuments','navigationOrHashOnlyFiles','navigationOnly','instructionCarryForwardFiles','instructionHashOnlyPins','historyReferences','historicalSelectedFiles','filenameOnlyReferences','instructionsCarryForwardSameSHA','hashOnly','filenameOnlySourceInputs','historicalMetadata','oldFirstFailureHashOnly','metadataDocumentSelections','directCanonicalSelections']
 hash_collections={'instructionsCarryForward','instructionCarryForward','instructionFiles','instructionPins','instructionReads','instructionHashOnly','instructionsHashOnly','instructionHashOnlyFiles','hashOnlyFiles','hashOnlyExcludedLeafFiles','hashOnlyProducts','hashOnlySourceRows','instructionHashOnlyPins','instructionCarryForwardFiles','hashOnly','oldFirstFailureHashOnly'}
 for key,values in j.items():
  if key=='validationArtifactInputs':
   for row in values:
    path=row['path'];assert path.startswith('docs/audit-2026-10-17-round64/') and row['taskOwnedEvidence'] and row['baselineGitProductFile'] is False
    raw=(ROOT/path).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
    for range_key in ['bodyDisplayLineRanges','allDisplayedLineRanges','selectedLineRanges','navigationLineRanges']:
     for a,z in row.get(range_key,[]):assert 1<=a<=z<=len(raw.splitlines())
    external_inputs.append(dict(taskOwnedEvidencePath=path,bytes=len(raw),sha256=sha(raw),scope='Uncommitted Root first-run evidence read by peer; not a baseline product/Git source pin.'))
   continue
  if key=='metadataInputs' and stem=='subagent-continuation-review':
   for r in values:
    p=Path(r['path']);rel=p.relative_to(Path('/tmp/codeshell-audit-round148-subagent-continuation'));target=EV/'root-subagent-continuation'/rel;b=target.read_bytes()
    assert b==p.read_bytes() and len(b)==r['bytes'] and sha(b)==r['sha256']
    external_inputs.append(dict(originalPath=str(p),frozenCopy=str(target.relative_to(OUT)),bytes=len(b),sha256=sha(b),scope=r.get('readScope')))
    receipts.append(dict(receipt=str(mp.relative_to(OUT)),path=str(target.relative_to(OUT)),bytes=len(b),sha256=sha(b)))
   continue
  if key=='gateDecisions' and stem=='root-agent-registry':
   for r in values:
    assert j['files']==[] and r['disposition'].startswith('old-full-excluded-before-') and any(p['path']==r['path'] and p['sha256']==r['sha256'] for p in j['hashOnlyFiles'])
    nonreading_gate_assertions.append(dict(manifest=str(mp.relative_to(EV)),path=r['path'],sha256=r['sha256'],note='Duplicate old-full decision bound to explicit hash-only row and empty current semantic files; original qualifiers and missing newProductSemanticLines field preserved, not additional source reading.'))
  elif isinstance(values,list) and key not in collections:
   assert not any(isinstance(r,dict) and str(r.get('path','')).startswith('packages/') and 'sha256' in r for r in values),(stem,key,'Unclassified top-level current product pins require explicit adapter review')
 for collection in collections:
  for r in j.get(collection,[]):
   if isinstance(r,str) or 'sha256' not in r:
    unbound.append(dict(manifest=str(mp.relative_to(EV)),collection=collection,row=r,note='Original string/navigation or noncanonical hash-key row retained verbatim; no additional Root Git-bound source pin or semantic scope inferred from this adapter omission.'));continue
   path=r['path'];h=r['sha256'];absolute=Path(path)
   if absolute.is_absolute():
    if absolute.is_relative_to(ROOT):path=str(absolute.relative_to(ROOT))
    else:
     matches=[]
     for other_stem,other_receipt,other_round,other_source_stem in GROUPS:
      other_source=Path('/tmp/codeshell-audit-round'+str(other_round)+'-'+other_source_stem)
      if absolute.is_relative_to(other_source):matches.append((other_stem,absolute.relative_to(other_source)))
     assert len(matches)==1,(stem,path,'External input needs explicit frozen-copy mapping')
     other_stem,relative=matches[0];target=EV/other_stem/relative;raw=absolute.read_bytes()
     assert target.read_bytes()==raw and sha(raw)==h and len(raw)==r['bytes']
     external_inputs.append(dict(originalPath=path,frozenCopy=str(target.relative_to(OUT)),bytes=len(raw),sha256=h,scope='Metadata external artifact only; no Git source pin or semantic coverage inferred.'))
     receipts.append(dict(receipt=str(mp.relative_to(OUT)),path=str(target.relative_to(OUT)),bytes=len(raw),sha256=h))
     continue
   b=frozen(path);assert sha(b)==h,(stem,path)
   if 'bytes' in r:assert len(b)==r['bytes'],(stem,path)
   else:missing_declared_bytes.append(dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,reportedBytes=None,rootFrozenGitBytes=len(b),note='No author byte count invented; Root independently binds Git bytes.'))
   for range_key in ['selectedLineRanges','bodyDisplayedLineRanges','displayedLineRanges','additionalNavigationSnippetLineRanges','semanticReadLineRanges','navigationLineRanges','navigationOnlyLineRanges','bodyDisplayLineRanges','allDisplayedLineRanges']:
    for a,z in r.get(range_key,[]):assert 1<=a<=z<=len(b.splitlines()),(stem,path,range_key,a,z)
   assert path not in pins or pins[path]==h;pins[path]=h;coverage=r.get('coverage','hash-only-from-collection' if collection in hash_collections else 'navigation-only-from-collection' if collection!='files' else 'selected-original-scope-preserved')
   row=dict(manifest=str(mp.relative_to(EV)),collection=collection,path=path,sha256=h,coverage=coverage,note='Original timing/ranges/null and same-read limitations retained; formalization adds no repeated semantic read.')
   (hashonly if 'hash' in coverage or collection in hash_collections else incidental if 'navigation' in coverage or 'incidental' in coverage else active).append(row)

receipts.extend(dict(receipt='prep-copy-receipt.json',path=r['path'],bytes=r['bytes'],sha256=r['sha256']) for r in copies)
write(EV/'source-pin-adapter-notes.json',dict(missingDeclaredByteCounts=missing_declared_bytes,nonReadingGateAssertions=nonreading_gate_assertions,unboundNavigationReferences=unbound,externalMetadataInputs=external_inputs,scope='Only explicit frozen source/instruction/nav/hash pins bound; filename-only references stay unbound, missing bytes derived separately from baseline Git, never fabricated into original rows. Nested historical inputs without the canonical sha256 key remain original author metadata, not additional source coverage.',productRuns=0));write(EV/'prep-copy-receipt.json',dict(copies=copies,scope='Metadata copy only; product run recorded in validation.json'));write(EV/'root-receipt-checks.json',dict(checks=receipts,productExecution=False));write(EV/'frozen-artifact-whitespace.json',dict(exactArtifacts=snapshots,productRuns=0,scope='Only frozen copied provenance. All other files must pass ordinary whitespace check; full check actual exit retained.'))
files=[]
for path,h in sorted(pins.items()):
 frozen_raw=frozen(path);current=(ROOT/path).read_bytes();mainraw=git('show',main+':'+path);assert sha(frozen_raw)==h and current==mainraw
 files.append(dict(path=path,bytes=len(frozen_raw),sha256=h,currentBytes=len(current),currentSha256=sha(current),mainBytes=len(mainraw),mainSha256=sha(mainraw),currentWorkingTreeMatchesFrozenBlob=current==frozen_raw,mainMatchesFrozenBlob=mainraw==frozen_raw))
write(OUT/'source-manifest.json',dict(baseline=baseline,mainHead=main,files=files,workerSourceChecks=active,hashOnlyChecks=hashonly,incidentalChecks=incidental,changedFromFrozenPaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],note='Original full/selected/navigation/hash distinctions and timing retained. Discovery-only hash pins do not become semantic coverage through current Git binding. No product execution or source reread added.'))
decision=json.loads((EV/'root-decision.json').read_text())
assert decision['allReadersFrozen'] is True
assert decision['rootSourceReviewComplete'] is True
assert len(decision['formal'])==1 and decision['formal'][0]['id']=='ATTACH-R64-01' and decision['candidates']==[]
write(OUT/'findings.json',dict(baseline=baseline,count=len(decision['formal']),findings=decision['formal']))
write(OUT/'candidates.json',dict(baseline=baseline,count=len(decision['candidates']),candidates=decision['candidates'],note='Current finite round only. Historical candidates indexed separately without reclassification.'))
write(OUT/'related.json',dict(baseline=baseline,count=0,related=[]))
raw=(EV/'attachment-shared-path.first.log').read_text();first=json.loads((EV/'attachment-shared-path.first-exit.json').read_text());assert first['exitCode']==0 and first['attempt']==1 and first['rerun'] is False
assert '1 pass' in raw and '0 fail' in raw and '11 expect() calls' in raw and 'Completed Bun shard: 1 tests, 0 skipped; 0 failures.' in raw
write(OUT/'validation.json',dict(baseline=baseline,runs=[dict(id='attachment-shared-path',command=first['command'],log='evidence/attachment-shared-path.first.log',exit='evidence/attachment-shared-path.first-exit.json',attempt=1,exitCode=0,passedTests=1,expectations=11,failedTests=0,skippedTests=0,guardedCompleted=True,scope='Real attachment service in owned temporary FS with public now parameter; current defect assertions plus independent-path sent control, no real UI/native/network/account.')],totals=dict(productAttempts=1,passedTests=1,expectations=11,failedTests=0,skippedTests=0,productReruns=0),mode='Source audit plus one first guarded attachment reproduction. No product fixes or broad build/test/lint certification.'))
formal=len(decision['formal'])
p2=46+sum(r['severity']=='P2' for r in decision['formal']);p3=73+sum(r['severity']=='P3' for r in decision['formal'])
summary=dict(baseline=baseline,mainHead=main,formal=formal,candidates=len(decision['candidates']),related=0,uniqueSourcePins=len(files),activeSourceChecks=len(active),incidentalSourceChecks=len(incidental),hashOnlyChecks=len(hashonly),unboundNavigationReferences=len(unbound),missingDeclaredByteCounts=len(missing_declared_bytes),receiptChecks=len(receipts),verbatimCopies=len(copies),frozenWhitespaceArtifacts=len(snapshots),datedCoverageReference='Through62 prior coverage368/377/3898; current SHA rebind downgrades one changed full source:367full/377selected/3899unknown,4276 not full.63/64 current source reviews not unioned. Additional TS paths outside original denominator separately listed; whole-repository remaining unknown.',historicalFormalRecords=119+formal,priorities=dict(P2=p2,P3=p3),changedFromFrozenSourcePaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],productRuns=1,goalStillActive=True)
write(OUT/'coverage.json',summary)
print(json.dumps(summary,ensure_ascii=False))

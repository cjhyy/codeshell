"""Owned documentation metadata assembly only. No product imports or tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round23'
EV=OUT/'evidence'
BASE='c1d007ed0af1eca9b56b32fabbb0ea2401037ee1'

def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(name):return json.loads((EV/name).read_text())
def save(name,value):(OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def rows(data,key):
    if isinstance(data,list):return data
    for name in [key,'related','observations']:
        if name in data:return data[name]
    raise ValueError(list(data))

findings,candidates,related=[],[],[]
for prefix in ['root','product','cron','room-data']:
    findings+=rows(read(prefix+'-findings.json'),'findings')
    candidates+=rows(read(prefix+'-candidates.json'),'candidates')
    related+=rows(read(prefix+'-related.json'),'observations')
assert len(findings)==1 and findings[0]['id']=='PRODUCT-R23-01' and not candidates
assert len(related)==1 and related[0]['id']=='PRODUCT-R23-R1'
save('findings.json',dict(baseline=BASE,count=1,findings=findings,note='Static public API config omission, no dynamic product construction or downstream operation claim.'))
save('candidates.json',dict(baseline=BASE,count=0,candidates=[]))
save('related.json',dict(baseline=BASE,count=1,observations=related,note='Old customPrompt/sections mechanism, no new severity or formal count.'))
save('addressed-sources.json',dict(baseline=BASE,count=0,sourceChanges=[],priorSourceStatus=[read('cron-source-status.json')],runtimeRetested=False,note='PriorTIME1 byte identity proves source unchanged only, not replay or fix validation. Selected main source status checked separately.'))

specs=[
    ('cron-first.raw.log','cron-first.exit.json',7,'Actual zero-import cron leaf,7ordinary focused short fixedUTC controls; five nextTime calls<=6candidate minutes total. No old malformed/DST/leap/long search/Scheduler/real timer.'),
    ('room-data-first.raw.log','room-data-first.exit.json',6,'Actual mobile-history leaf,4ordinary+2owned deferred/reject controls. No realreader/Room/FS/CLI/SDK; Codex parser/approval/oldR3/R84 baselines static only.'),
]
runs=[]
for log_name,exit_name,focused,scope in specs:
    raw=(EV/log_name).read_bytes();body=raw.decode();receipt=read(exit_name);command=receipt.get('command',receipt.get('argv'))
    assert command[:4]==['node','scripts/run-bun-test-shard.mjs','--timeout','30000']
    complete=re.search(r'Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.',body)
    assert complete and receipt['exitCode']==0
    def count(pattern,default=None):
        match=re.search(pattern,body,re.M);return int(match.group(1)) if match else default
    row=dict(log='evidence/'+log_name,exitFile='evidence/'+exit_name,command=command,firstRun=True,attempts=1,reruns=0,exitCode=0,completed=True,clean=True,
        passed=count(r'^\s*(\d+) pass\s*$'),failed=count(r'^\s*(\d+) fail\s*$'),errors=count(r'^\s*(\d+) error\s*$',0),expectations=count(r'^\s*(\d+) expect\(\) calls\s*$'),skipped=int(complete.group(2)),existingTests=0,focusedTests=focused,scope=scope,sha256=sha(raw))
    assert row['passed']==focused==int(complete.group(1)) and receipt['rawSha256']==row['sha256']
    assert row['failed']==row['errors']==row['skipped']==int(complete.group(3))==0
    runs.append(row)
totals=dict(firstBunShards=2,completedCleanShards=2,failedBunShards=0,passedTests=sum(r['passed'] for r in runs),expectations=sum(r['expectations'] for r in runs),failedTests=0,skippedOrFilteredTests=0,existingBaselineTests=0,focusedTests=13,directActualLeafCases=13,manuallyMirroredConsumerTests=0,productReruns=0,rootProductAttempts=0,productFactoryAttempts=0,codexParserAttempts=0)
assert (totals['passedTests'],totals['expectations'])==(13,32)
save('validation.json',dict(baseline=BASE,totals=totals,runs=runs,notes=[
    'Both first combined raw stdout/stderr and exit saved before inspection;0failed Bun shards/fixture repair/product rerun/alternative validation.',
    'PRODUCT-R23-01 rests on explicit public cwd option contract and complete static omission/default source flow, not a passing fixture. No factory/Manager/Engine constructed or actual task/tool/FS/model/permission run.',
    'Factory and defineProduct are one missing default-cwd chain, counted once. Old prompt precedence related item remains unranked, no new prompt output or model experiment.',
    'Cron7short ordinary controls completed before later root static-priority followup arrived; all subsequent work static. No new mechanism or oldTIME1 malformed/DST/leap/Scheduler replay.',
    'Mobile6cases=4ordinary+2ownedcallback boundary controls; no producerfailure/recovery/realconcurrency claim. Codex entire existing suite static only, no current CLI format proof or new shape finding.',
    'Root33selection reads and10prior prep hash revalidations are static/provenance only; oldstdinCLI failed direction excluded before0attempts, oldqueue/params/OM3/Unicode/JSON families not recovered.',
    'Metadata guessedfile/schema/range/selfreceipt ordering errors labeled separately, no product failure or retry. Hashes/search counts do not prove full semantic coverage.',
    'No real model/paid API/account/user data/business network/external message/native/PTY/auth/permission/security/custody/watchdog/identity/timer or shareddependency/dist/build/typecheck/lint/fullsuite/E2E experiment.',
]))

sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json','packages/core/src/run/index.ts'};checks=[]
for manifest_name in ['root-source-manifest.json','product-source-manifest.json','cron-source-manifest.json','room-data-source-manifest.json']:
    data=read(manifest_name)
    for row in data.get('files',data.get('sources',[])):
        name=row['path'];sources.add(name);frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT)
        expected=row.get('sha256',row.get('frozenSha256'));assert sha(frozen)==expected,(manifest_name,name)
        checks.append(dict(manifest=manifest_name,path=name,sha256=expected))
prep_checks=read('root-prep-current.json')['checks']
for row in prep_checks:
    sources.add(row['path']);assert sha(subprocess.check_output(['git','show',BASE+':'+row['path']],cwd=ROOT))==row['sha256']
manifest=[]
for name in sorted(sources):
    frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT);current=(ROOT/name).read_bytes();main=subprocess.check_output(['git','show','main:'+name],cwd=ROOT)
    manifest.append(dict(path=name,bytes=len(frozen),sha256=sha(frozen),frozenBlobVerified=True,currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=main==frozen,currentSha256=sha(current),mainSha256=sha(main)))
assert all(r['currentWorkingTreeMatchesFrozenBlob'] and r['mainMatchesFrozenBlob'] for r in manifest)
save('source-manifest.json',dict(baseline=BASE,mainHead=subprocess.check_output(['git','rev-parse','main'],cwd=ROOT).decode().strip(),files=manifest,workerSourceChecks=checks,priorPrepHashOnlyChecks=prep_checks,reviewerExtraSource=dict(path='packages/core/src/run/index.ts',coverage='Product reviewer full static1-78 re-export bridge; no runtime or change to author19pin scope'),note='Selected full/static scopes stay in author manifests;pins are not full/transitive/runtime audit.10prep checks not new full-source reading.'))
artifacts=[]
for receipt_name in ['root-artifact-receipt.json','product-author-receipt.json','cron-artifact-receipt.json','room-data-author-receipt.json']:
    data=read(receipt_name)
    for row in data.get('files',data.get('artifacts',[])):
        path=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path'];raw=path.read_bytes()
        assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],(receipt_name,row['path'])
        artifacts.append(dict(receipt=receipt_name,path=str(path.relative_to(ROOT)),sha256=sha(raw)))
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=artifacts,sourceCheckCount=len(checks),prepHashOnlyCheckCount=len(prep_checks),productTestsRerun=False))
files=[]
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name!='evidence-index.json':
        raw=path.read_bytes();files.append(dict(path=str(path.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=files,note='Self excluded;2product raw logs preserved verbatim. Prep copies and metadata transcripts not new product execution.'))
print(json.dumps(dict(findings=1,candidates=0,related=1,totals=totals,sourcePins=len(manifest),workerSourceChecks=len(checks),prepHashOnlyChecks=len(prep_checks),workerArtifacts=len(artifacts),indexedFiles=len(files))))

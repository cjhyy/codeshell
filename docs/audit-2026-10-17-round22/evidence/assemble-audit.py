"""Assemble owned audit metadata only. Never import product code or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/audit-2026-10-17-round22'
EV = OUT / 'evidence'
BASE = 'ab258c3f534b19014b2ed85da3111649f166ab86'

def sha(raw): return hashlib.sha256(raw).hexdigest()
def read(name): return json.loads((EV / name).read_text())
def save(name, value): (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
def classify(data, key):
    if isinstance(data, list): return data
    for name in [key, 'related', 'observations']:
        if name in data: return data[name]
    raise ValueError(list(data))

findings, candidates, related = [], [], []
for prefix in ['root', 'budget', 'title']:
    findings += classify(read(prefix+'-findings.json'), 'findings')
    candidates += classify(read(prefix+'-candidates.json'), 'candidates')
    related += classify(read(prefix+'-related.json'), 'observations')
terminal = read('terminal-summary.json')
assert not terminal['findings'] and not terminal['candidates'] and not terminal['related']
assert len(findings)==1 and findings[0]['id']=='ERROR-R22-01' and not candidates and not related
save('findings.json', dict(baseline=BASE, count=1, findings=findings))
save('candidates.json', dict(baseline=BASE, count=0, candidates=[]))
save('related.json', dict(baseline=BASE, count=0, observations=[], unclassifiedStaticFrontiers=terminal['unclassifiedStaticLeads'], note='One terminal banner arithmetic clue remains unclassified, outside all finding/candidate/related counts. Historical budget documentation contradiction and old diminishing concern not new issues.'))
save('addressed-sources.json', dict(baseline=BASE, count=0, sourceChanges=[], runtimeRetested=False, note='No source-fix claim; selected frozen/current/main pins checked separately.'))

specs = [
    ('root-friendly.first.raw.log','root-friendly.first.exit.json',0,12,'Actual friendly error leaf + lightweight LLMRateLimitError; owned messages. Provider/SDK/wrapper/retry/TurnLoop static only. Mixed existing custody/transcript/auth suite unexecuted.'),
    ('budget-first.raw.log','budget-first.exit.json',4,4,'Actual zero-import reactive threshold;4existing+4focused; token-budget old controls not rerun, consumer and document contradiction static only.'),
    ('title-session-leaf.raw.log','title-session-leaf.exit.json',0,12,'Actual type-only title leaf with owned callbacks/usage collectors/deferred Promises. No Engine/SDK/model/store/rename/IPC runtime; all existing mixed tests unexecuted.'),
]
runs=[]
for log_name, exit_name, existing, focused, scope in specs:
    raw=(EV/log_name).read_bytes(); body=raw.decode(); receipt=read(exit_name)
    command=receipt.get('command',receipt.get('argv'))
    assert command[:4]==['node','scripts/run-bun-test-shard.mjs','--timeout','30000']
    complete=re.search(r'Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.',body)
    assert complete and receipt['exitCode']==0
    def count(pattern,default=None):
        match=re.search(pattern,body,re.M);return int(match.group(1)) if match else default
    row=dict(log='evidence/'+log_name,exitFile='evidence/'+exit_name,command=command,firstRun=True,attempts=1,reruns=0,exitCode=0,completed=True,clean=True,
        passed=count(r'^\s*(\d+) pass\s*$'),failed=count(r'^\s*(\d+) fail\s*$'),errors=count(r'^\s*(\d+) error\s*$',0),expectations=count(r'^\s*(\d+) expect\(\) calls\s*$'),
        skipped=int(complete.group(2)),existingTests=existing,focusedTests=focused,scope=scope,sha256=sha(raw))
    assert row['passed']==existing+focused==int(complete.group(1))
    assert row['failed']==row['errors']==row['skipped']==int(complete.group(3))==0
    assert receipt['rawSha256']==row['sha256']
    runs.append(row)
totals=dict(firstBunShards=3,completedCleanShards=3,failedBunShards=0,passedTests=sum(r['passed'] for r in runs),expectations=sum(r['expectations'] for r in runs),failedTests=0,skippedOrFilteredTests=0,
    existingBaselineTests=sum(r['existingTests'] for r in runs),focusedTests=sum(r['focusedTests'] for r in runs),directActualLeafCases=32,manuallyMirroredConsumerTests=0,productReruns=0,terminalProductAttempts=0)
assert (totals['passedTests'],totals['expectations'],totals['existingBaselineTests'],totals['focusedTests'])==(32,76,4,28)
save('validation.json',dict(baseline=BASE,totals=totals,runs=runs,notes=[
    'All three first combined raw stdout/stderr and exit saved before inspection.0failed Bun shards/fixture repair/product retry/alternative validation.',
    'ERROR-R22-01 is a narrowly scoped P3 cause/hint loss: actual helper and exception control plus static unconditional429 wrapper and official external error contract; no SDK429 instance/provider/TurnLoop execution.',
    'One local Node package-export metadata resolver query failed, then SDK metadata direction skipped with0Bun/SDK runtime attempts. It does not establish missing package or Bun resolution failure. Leaf tests have no SDK dependency.',
    'Terminal collector and history scanner receipts are metadata only, not product/test attempts; two source pins hash-only and unclassified banner arithmetic not runtime coverage.',
    'Title fake callback error/deferred tests are owned boundary controls, not ordinary provider/Engine concurrency or manual rename evidence. Current titleManual/override guards static counterevidence.',
    'Reactive existing4 plus focused4 are actual leaf controls; old token-budget finite/infinite and90percent sequence not rerun, old diminishing concern/docs wording not new issues.',
    'No auth/custody/transcript special-case experiment; no real model, paid API, account, user data, business network, native/PTY, external message, security/permission/watchdog/identity or retry timer run.',
    'No shared dependency/dist rebuild, build/typecheck/lint/full-suite/E2E claim. Scope-limited progress; repository audit continues.',
]))

source_specs=['root-source-manifest.json','budget-source-manifest.json','title-source-manifest.json','terminal-sources.json']
sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json','packages/desktop/src/main/session-titles-store.ts'};worker_checks=[]
for manifest_name in source_specs:
    data=read(manifest_name)
    for row in data.get('files',data.get('sources',[])):
        name=row['path']; sources.add(name)
        frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT)
        expected=row.get('sha256',row.get('frozenSha256'))
        assert sha(frozen)==expected,(manifest_name,name)
        worker_checks.append(dict(manifest=manifest_name,path=name,sha256=expected))
manifest=[]
for name in sorted(sources):
    frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT);current=(ROOT/name).read_bytes();main=subprocess.check_output(['git','show','main:'+name],cwd=ROOT)
    manifest.append(dict(path=name,bytes=len(frozen),sha256=sha(frozen),frozenBlobVerified=True,currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=main==frozen,currentSha256=sha(current),mainSha256=sha(main)))
assert all(r['currentWorkingTreeMatchesFrozenBlob'] and r['mainMatchesFrozenBlob'] for r in manifest)
save('source-manifest.json',dict(baseline=BASE,mainHead=subprocess.check_output(['git','rev-parse','main'],cwd=ROOT).decode().strip(),files=manifest,workerSourceChecks=worker_checks,reviewerExtraSource=dict(path='packages/desktop/src/main/session-titles-store.ts',coverage='Reviewer full static1-14, SHA checked; not title author coverage or runtime'),note='Pins are selected source bytes, not whole-file/transitive/runtime coverage. terminal manifest contains2hash-only pins. Prep sources retained as provenance, not current coverage.'))
artifacts=[]
for receipt_name in ['root-artifact-receipt.json','budget-artifact-receipt.json','title-author-receipt.json','terminal-artifact-receipt.json']:
    data=read(receipt_name)
    for row in data.get('files',data.get('artifacts',[])):
        path=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path'];raw=path.read_bytes()
        assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],(receipt_name,row['path'])
        artifacts.append(dict(receipt=receipt_name,path=str(path.relative_to(ROOT)),sha256=sha(raw)))
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=artifacts,sourceCheckCount=len(worker_checks),productTestsRerun=False))
files=[]
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name!='evidence-index.json':
        raw=path.read_bytes();files.append(dict(path=str(path.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=files,note='Self excluded;3product raw logs preserved verbatim. Metadata transcripts/scanners explicitly labeled; no product reruns during assembly.'))
print(json.dumps(dict(findings=1,candidates=0,related=0,unclassifiedStaticFrontiers=1,totals=totals,sourcePins=len(manifest),workerSourceChecks=len(worker_checks),workerArtifacts=len(artifacts),indexedFiles=len(files))))

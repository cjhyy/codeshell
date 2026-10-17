"""Assemble preserved metadata only; never import product modules or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/audit-2026-10-17-round21'
EV = OUT / 'evidence'
BASE = '615e4e4dd3a61b1ad132ab4f3683985a0d582386'
PREFIXES = ['ndjson', 'jsonoutput', 'toolbudget']

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')

def rows(data, key):
    if isinstance(data, list):
        return data
    for name in [key, 'related', 'observations']:
        if name in data:
            return data[name]
    raise ValueError(('Unknown inspected classification schema', list(data)))

findings, candidates, related = [], [], []
for prefix in PREFIXES:
    findings.extend(rows(read(prefix+'-findings.json'), 'findings'))
    candidates.extend(rows(read(prefix+'-candidates.json'), 'candidates'))
    related.extend(rows(read(prefix+'-related.json'), 'observations'))
assert not findings and not candidates
assert {row['id'] for row in related} == {'BUDGET-R21-R1'}
save('findings.json', dict(baseline=BASE, count=0, findings=[], note='No new confirmed defect in this limited batch; no all-repository completion claim.'))
save('candidates.json', dict(baseline=BASE, count=0, candidates=[]))
save('related.json', dict(baseline=BASE, count=1, observations=related, note='Prior budget-floor source concern; actual helper separator floor under real positive backstop, handmade302-slot producer and aggregate gate unproved.'))
save('addressed-sources.json', dict(baseline=BASE, count=0, sourceChanges=[], runtimeRetested=False, note='No selected frozen/current/main source differences at assembly; actual main refresh and external paths recorded separately in integration plan.'))

specs = [
    ('root-prefix.first.raw.log','root-prefix.first.exit.json',0,7,'Actual normalize/list prefix functions on ordinary valid short labels; no validator attack/branch gate/ownership/real Git operations'),
    ('ndjson-first.raw.log','ndjson-first.exit.json',0,15,'Actual reader with owned streams,7start+5iterator+3lifecycle; no timers/default stdin/schema/approval/auth/real CLI, no ordinary production consumer found'),
    ('jsonoutput-first.raw.log','jsonoutput-first.exit.json',0,16,'Actual JSON renderer classes/factory and chalk; unused Coreinternal/truncate stubs, child process stdout spy; no Text/CLI/old A12/runtime consumer'),
    ('toolbudget-first.raw.log','toolbudget-first.exit.json',8,10,'Actual budget leaf+token heuristic;8existing+8ordinaryfocused+301slot handmade control+302slot related characterisation; no Manager/compaction gate/storage/tool/model'),
]

runs=[]
for log_name, exit_name, existing, focused, scope in specs:
    raw=(EV/log_name).read_bytes()
    body=raw.decode()
    receipt=read(exit_name)
    command=receipt.get('command',receipt.get('argv'))
    assert command[:4] == ['node', 'scripts/run-bun-test-shard.mjs', '--timeout', '30000']
    complete=re.search(r'Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.', body)
    assert complete and receipt['exitCode']==0
    def count(pattern, default=None):
        match=re.search(pattern, body, re.M)
        return int(match.group(1)) if match else default
    row=dict(log='evidence/'+log_name, exitFile='evidence/'+exit_name, command=command, firstRun=True, attempts=1, reruns=0,
        exitCode=0, completed=True, clean=True, passed=count(r'^\s*(\d+) pass\s*$'), failed=count(r'^\s*(\d+) fail\s*$'),
        errors=count(r'^\s*(\d+) error\s*$',0), expectations=count(r'^\s*(\d+) expect\(\) calls\s*$'), skipped=int(complete.group(2)),
        existingTests=existing, focusedTests=focused, scope=scope, sha256=sha(raw))
    assert row['passed']==existing+focused==int(complete.group(1))
    assert row['failed']==row['errors']==row['skipped']==int(complete.group(3))==0
    runs.append(row)
totals=dict(firstBunShards=4,completedCleanShards=4,failedBunShards=0,passedTests=sum(row['passed'] for row in runs),
    expectations=sum(row['expectations'] for row in runs),failedTests=0,skippedOrFilteredTests=0,
    existingBaselineTests=sum(row['existingTests'] for row in runs),focusedTests=sum(row['focusedTests'] for row in runs),
    directDataAndRendererTestCases=56,manuallyMirroredCompositionTests=0,unusedTextDependencyStubCases=16,ownedStreamReaderCases=15,handCraftedSeparatorFloorTests=2,productReruns=0)
assert (totals['passedTests'],totals['expectations'],totals['existingBaselineTests'],totals['focusedTests'])==(56,193,8,48)
save('validation.json',dict(baseline=BASE,totals=totals,runs=runs,notes=[
    'Every first combined raw stdout/stderr and exit saved before inspection;0failed Bun shards/fixture repairs/product retries/alternative validation.',
    'No new formal/candidate; budget related observation is a handmade302slot result under real600chars/200heuristic tokens,301slot boundary control. Ordinary302slot producer and actual aggregate gate unproved; old record is source concern with no finding ID.',
    'Budget and token heuristic are real pure modules; only estimateStringTokens called in dependency. Existing Unicode/default30k samples maintained controls, not new recovery/stress/provider-token contract.',
    'NDJSON owned streams only,15focused; existing2timer tests source-only. No actual stdin/CLI/schema/approval/auth/timer; ordinary production consumer literal search finds only leaf/tests, and old dead-reader leak known.',
    'JSON classes/factory and chalk actual; exact Coreinternal/truncate throw-if-called stubs remain unused. Child process stdout spy restored; no Text/internal-barrel/old sliceAnsi/i18n/A12child fallback/mixedsuite/CLI revalidation.',
    'Root prefix actualnormalize/list only,7focused valid-label controls; old5existing tests known from rounds8/13 and not rerun, no invalid validator/gate/ownership/native Git operation.',
    'CompletionKind metadata source difference lacks finalJSON contract and ordinary headless trigger; source observation only, no bug/candidate count.',
    'Metadata guesses/output truncation/source range/symbol anchors are recorded and do not trigger product retry; historical string/scalar counts and caps are separately stated.',
    'No real models/paid APIs/accounts/user files/external messages/product network/native/Git/PTY/auth/permission/security/custody/watchdog experiment; no shared deps/dist rebuild/full build/typecheck/lint/suite/E2E.',
]))

sources={'CODESHELL.md','AGENTS.md','package.json','bun.lock','tsconfig.json'}
for path in OUT.glob('*.md'):
    sources.update(re.findall(r'\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b',path.read_text()))
worker_checks=[]
for path in sorted(EV.glob('*source-manifest.json')):
    data=json.loads(path.read_text())
    for row in data.get('files',data.get('sources',[])):
        name=row['path'];sources.add(name)
        frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT)
        expected=row.get('sha256',row.get('frozenSha256'))
        assert expected==sha(frozen),(path.name,name)
        worker_checks.append(dict(manifest=path.name,path=name,sha256=expected))
manifest=[]
for name in sorted(sources):
    frozen=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT)
    current=(ROOT/name).read_bytes()
    main=subprocess.check_output(['git','show','main:'+name],cwd=ROOT)
    manifest.append(dict(path=name,bytes=len(frozen),sha256=sha(frozen),frozenBlobVerified=True,currentWorkingTreeMatchesFrozenBlob=current==frozen,
        mainMatchesFrozenBlob=main==frozen,currentSha256=sha(current),mainSha256=sha(main)))
differences=[row['path'] for row in manifest if not row['currentWorkingTreeMatchesFrozenBlob'] or not row['mainMatchesFrozenBlob']]
assert not differences, differences
save('source-manifest.json',dict(baseline=BASE,assemblyWorkingTreeHead=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip(),
    mainHead=subprocess.check_output(['git','rev-parse','main'],cwd=ROOT).decode().strip(),files=manifest,workerSourceChecks=worker_checks,
    note='Frozen/current/main selected source pins only; not full-file/transitive/all-repository coverage. Historical inventory is a read-time snapshot.'))

artifact_checks=[]
for prefix in PREFIXES:
    name=prefix+'-artifact-receipt.json'
    data=read(name)
    for row in data.get('files',data.get('artifacts',[])):
        path=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path']
        raw=path.read_bytes()
        assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],(name,row['path'])
        artifact_checks.append(dict(receipt=name,path=str(path.relative_to(ROOT)),sha256=sha(raw)))
save('worker-integrity.json',dict(baseline=BASE,artifactChecks=artifact_checks,sourceCheckCount=len(worker_checks),productTestsRerun=False))
files=[]
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name!='evidence-index.json':
        raw=path.read_bytes();files.append(dict(path=str(path.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
save('evidence-index.json',dict(baseline=BASE,algorithm='sha256',files=files,note='Self excluded; four raw logs verbatim; metadata tool-response transcriptions labeled. No product/test execution in assembly.'))
print(json.dumps(dict(findings=len(findings),candidates=len(candidates),related=len(related),totals=totals,sources=len(manifest),workerSourceChecks=len(worker_checks),workerArtifacts=len(artifact_checks),indexedFiles=len(files))))

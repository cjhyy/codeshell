"""Assemble preserved metadata only; never import product modules or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/audit-2026-10-17-round20'
EV = OUT / 'evidence'
BASE = 'd40dd06987a2e0c20c377e243cf5c4e4b549c9ec'
PREFIXES = ['positiveint', 'toolsummary', 'streamattempt']

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
assert {row['id'] for row in related} == {'TOOLSUMMARY-R20-R1'}
save('findings.json', dict(baseline=BASE, count=0, findings=[], note='No new confirmed defect in this limited batch; no all-repository completion claim.'))
save('candidates.json', dict(baseline=BASE, count=0, candidates=[]))
save('related.json', dict(baseline=BASE, count=1, observations=related, note='Old non-Error catch mechanism in tool summary; hand-crafted callback rejection, no ordinary provider producer established.'))
save('addressed-sources.json', dict(baseline=BASE, count=0, sourceChanges=[], runtimeRetested=False, note='No selected frozen/current/main source differences at assembly; actual main refresh and external paths recorded separately in integration plan.'))

specs = [
    ('root-mediakind.first.raw.log', 'root-mediakind.first.exit.json', 0, 7, 'Actual mediaKind only; mixed module imported behind deny-fetch; no network/bytes/adapter/other exports; raw expect count adopted without hook inference'),
    ('positiveint-first.raw.log', 'positiveint-first.exit.json', 5, 8, 'Actual parsePositiveInt/positiveIntOption and real Commander dependency; CLI/timers/allocations/precision speculative contracts excluded'),
    ('toolsummary-first.raw.log', 'toolsummary-first.exit.json', 0, 14, 'Actual summary leaf; exact preimport logger warn spy and owned fake async callback; 11 ordinary+3 handmade non-Error rejection observations; no real logger/provider/Engine/TurnLoop'),
    ('streamattempt-first.raw.log', 'streamattempt-first.exit.json', 2, 10, 'Actual StreamAttempt only; ordinary owned metadata and IDs, type-only store; no App mirror/React/provider/replay/accounting'),
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
totals=dict(firstBunShards=4, completedCleanShards=4, failedBunShards=0, passedTests=sum(row['passed'] for row in runs),
    expectations=sum(row['expectations'] for row in runs), failedTests=0, skippedOrFilteredTests=0,
    existingBaselineTests=sum(row['existingTests'] for row in runs), focusedTests=sum(row['focusedTests'] for row in runs),
    directLeafTestCases=46, manuallyMirroredCompositionTests=0, loggerStubbedLeafTestCases=14, handCraftedNonErrorRejectionTests=3, productReruns=0)
assert (totals['passedTests'],totals['expectations'],totals['existingBaselineTests'],totals['focusedTests'])==(46,127,7,39)
save('validation.json',dict(baseline=BASE,totals=totals,runs=runs,notes=[
    'Every first combined raw stdout/stderr and exit saved before inspection; no failed Bun shard/fixture repair/product retry/alternative validation.',
    'No new formal/candidate. Tool-summary related mechanism uses three handmade non-Error callback rejections; null/undefined TypeError is not proof an ordinary provider causes it, and downstream catch is static.',
    'Actual tool summary source retains all logic except exact preimport logger warn spy; only fake async callback, no actual client/model/log filesystem/Engine/TurnLoop or old JSON repair direction.',
    'Positive integer controls use real leaf and Commander. Round15 baseline/precision/old NaN mechanism acknowledged; no actual CLI, huge-limit allocation, timer overflow or invented safe-integer contract tested.',
    'StreamAttempt type-only store import; actual leaf arrays/IDs only, no App mirror or provider/replay/renderer/accounting. Round7 controls and old Desktop F-01 excluded from new counts.',
    'MediaKind only called behind preimport deny-fetch; mixed module other functions/URL/private-IP/bytes/loader/safe name/tracker not called. Root expect21 is raw, not hook-count inference.',
    'MIME/filename conflict, old filename Unicode/alias limit, Mattermost Markdown and all old failed dynamic/authority directions stay excluded.',
    'Guessed locators/partial display truncation/read-range/schema metadata are disclosed separately; no product rerun follows metadata correction.',
    'No real models/paid APIs/accounts/user files/external messages/product network/native/Git/PTY/auth/permission/security/custody/watchdog experiment; no shared deps/dist/full build/typecheck/lint/suite/E2E.',
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

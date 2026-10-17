"""Assemble preserved metadata only; never import product modules or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/audit-2026-10-17-round19'
EV = OUT / 'evidence'
BASE = '5f5cf69df8526470700712a4dc2d5ae6bd2da132'
PREFIXES = ['reviewprompt', 'timing', 'simplediff']

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')

def rows(data, key):
    return data if isinstance(data, list) else data[key]

findings, candidates, related = [], [], []
for prefix in PREFIXES:
    findings.extend(rows(read(prefix+'-findings.json'), 'findings'))
    candidates.extend(rows(read(prefix+'-candidates.json'), 'candidates'))
    related.extend(rows(read(prefix+'-related.json'), 'observations'))
assert {row['id'] for row in findings} == {'REVIEWPROMPT-R19-01'}
assert not candidates and len(related) == 2
save('findings.json', dict(baseline=BASE, count=1, findings=findings, note='One help/parser contract defect; actual leaf characterization plus static ordinary consumer, not CLI/model execution.'))
save('candidates.json', dict(baseline=BASE, count=0, candidates=[]))
save('related.json', dict(baseline=BASE, count=2, observations=related, note='Old fixed-fence and UTF-16 mechanisms in new static contexts; no new runtime/repeated finding count.'))
save('addressed-sources.json', dict(baseline=BASE, count=0, sourceChanges=[], runtimeRetested=False, note='External main advance in release documentation only at final assembly; no selected product source or prior bug repair revalidation.'))

specs = [
    ('root-undo.first.raw.log', 'root-undo.first.exit.json', 25, 4, 'Actual pure selectors on owned metadata; no FileHistory/fs/current plan/command/renderer'),
    ('reviewprompt-first.raw.log', 'reviewprompt-first.exit.json', 9, 6, 'Actual parser/builder on owned strings; two wrong-current-behavior characterizations, four controls; CLI/UI/Git/client/model static or excluded'),
    ('timing-normal.first.raw.log', 'timing-normal.first.exit.json', 2, 8, 'Actual timing leaf and caller-owned numeric clocks; engine/publisher/run-stream static; no actual clock/timer/replay/recorder'),
    ('simplediff-normal.first.raw.log', 'simplediff-normal.first.exit.json', 7, 10, 'Actual zero-import diff leaves on small strings; twelve pairs in one projection case; undo/renderer/static consumer only'),
]
runs=[]
for log_name, exit_name, existing, focused, scope in specs:
    raw=(EV/log_name).read_bytes()
    body=raw.decode()
    receipt=read(exit_name)
    command=receipt['command']
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
    directLeafTestCases=71, manuallyMirroredCompositionTests=0, focusedWrongBehaviorCharacterizationTests=2, productReruns=0)
assert (totals['passedTests'],totals['expectations'],totals['existingBaselineTests'],totals['focusedTests'])==(71,187,43,28)
save('validation.json',dict(baseline=BASE,totals=totals,runs=runs,notes=[
    'First combined raw stdout/stderr and exit saved before inspection for every shard; no failed Bun/test repair/retry/alternative validation.',
    'Passing characterization of perf omission demonstrates wrong current behavior, not a fix. Ordinary CLI/UI source chain is static; actual /review/client/model not run.',
    'Related fixed fences and UTF-16 truncation are static old mechanisms only; no Unicode/Markdown/model/security revalidation.',
    'Root selector supplement does not exercise current FileHistory plan, actual undo/redo or filesystem; no present TUI producer is claimed for legacy latestUndoTarget.',
    'Timing caller-owned clocks do not change system clocks or prove default Date.now/performance.now/engine/journal/replay/recorder behavior; old recorder failure stays skipped.',
    'Simple diff is a human preview, not a patch generator; CRLF normalization/empty split tokens are disclosed, known O(n*m) direction wholly excluded.',
    'Metadata-only guessed document/glob/source-range/limited-output corrections are separately preserved; no product rerun follows them.',
    'No real models/paid APIs/accounts/user artifacts/external messages/product network/native/Git/PTY/auth/permission/security/custody/watchdog experiment; no shared deps/dist rebuild/full suite/build/typecheck/lint/E2E.',
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

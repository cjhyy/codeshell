"""Read-only final metadata verification; never imports product code/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round55'

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((OUT/name).read_text())

index=read('evidence-index.json')
expected={row['path'] for row in index['files']}
actual={str(path.relative_to(OUT)) for path in OUT.rglob('*') if path.is_file() and path.name!='evidence-index.json'}
assert expected==actual,dict(missing=sorted(actual-expected),extra=sorted(expected-actual))
for row in index['files']:
    raw=(OUT/row['path']).read_bytes()
    assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],row['path']
sources=read('source-manifest.json')
assert subprocess.check_output(['git','rev-parse','main'],cwd=ROOT).decode().strip()==sources['mainHead']
for row in sources['files']:
    frozen=subprocess.check_output(['git','show',sources['baseline']+':'+row['path']],cwd=ROOT)
    current=(ROOT/row['path']).read_bytes()
    main=subprocess.check_output(['git','show',sources['mainHead']+':'+row['path']],cwd=ROOT)
    assert sha(frozen)==row['sha256'],row['path']
    assert sha(current)==row['currentSha256'] and len(current)==row['currentBytes'],row['path']
    assert sha(main)==row['mainSha256'] and current==main,row['path']

freeze=read('evidence/freeze-checks.json')
assert len(freeze['checks'])==freeze['expectedCount']==21
for row in freeze['checks']:
    raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
coverage=read('coverage.json')
assert coverage['historicalFormalRecords']==116 and coverage['priorities']==dict(P2=44,P3=72)
assert coverage['formal']==0 and coverage['candidates']==coverage['related']==0
assert coverage['changedFromFrozenSourcePaths']==sources['changedFromFrozenPaths']==[] and len(sources['files'])==coverage['uniqueSourcePins']
assert read('evidence/assemble-final-exit.json')['exitCode']==0
assert read('evidence/incoming-history-drift.json')['missing']==[]
assert [r['path'] for r in read('evidence/incoming-history-drift.json')['changed']]==['docs/todo/release-real-operations-2026-10-16.md']
assert read('evidence/incoming-main-paths.json')['paths']==['.github/workflows/desktop-ui-acceptance.yml', 'docs/todo/release-real-operations-2026-10-16.md', 'packages/desktop/scripts/e2e-ui-packaged.mjs', 'packages/desktop/scripts/packaged-pet-fixture.mjs', 'packages/desktop/scripts/windows-packaged-main-crash-evidence.mjs', 'packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs', 'scripts/bun-test-completion.mjs']
assert read('evidence/root-whitespace-review.json')['exactTrailingWhitespaceLines']=={}

checks=0
for row in read('evidence/root-receipt-checks.json')['checks']:
    target=row['path'];path=ROOT/target if target.startswith('docs/') else OUT/target
    raw=path.read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'];checks+=1
links=[]
for path in sorted(OUT.rglob('*.md')):
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',path.read_text()):
        target=target.strip('<>')
        if re.match(r'^(?:https?:|app:|codex:|mailto:|#)',target):continue
        raw_target=target
        line=None
        if '#L' in target:
            target,fragment=target.split('#L',1);line=int(re.match(r'\d+',fragment).group())
        elif '#' in target:
            target=target.split('#',1)[0]
        colon=re.search(r':(\d+)$',target)
        if colon:line=int(colon.group(1));target=target[:colon.start()]
        destination=Path(target) if target.startswith('/') else path.parent/target
        destination=destination.resolve()
        assert destination.is_file(),(str(path.relative_to(OUT)),raw_target)
        if line is not None:assert 1<=line<=len(destination.read_text().splitlines()),(str(path.relative_to(OUT)),raw_target)
        links.append(dict(fromFile=str(path.relative_to(OUT)),target=raw_target))
validation=read('validation.json')
assert validation['totals']['passedTests']==0 and validation['totals']['expectations']==0
assert read('findings.json')['count']==read('candidates.json')['count']==read('related.json')['count']==0
assert validation['totals']['productAttempts']==0
assert not (OUT/'recorded-findings-catalog.json').exists()
assert len(json.loads((ROOT/'docs/audit-2026-10-17-round53/recorded-findings-catalog.json').read_text())['findings'])==116
assert read('evidence/coverage-snapshot-current-binding.json')['sourcePaths']==4643 and read('evidence/coverage-snapshot-current-binding.json')['changedPaths']==[]
print(json.dumps(dict(files=len(actual)+1,indexedFiles=len(actual),sourcePins=len(sources['files']),workerSourceChecks=len(sources['workerSourceChecks']),
    workerArtifacts=checks,localMarkdownLinks=len(links),rawLogs=len(validation['runs']),productReruns=0,allChecksPassed=True)))

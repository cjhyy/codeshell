"""Read-only final metadata verification; never imports product code/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round44'

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
assert len(freeze['checks'])==freeze['expectedCount']==30
for row in freeze['checks']:
    raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
assert sources['priorReadVersionsDifferentFromTaskBaseline']==['packages/desktop/src/preload/types.d.ts']
for row in sources['files']:
    for version in row['readVersions']:
        old=subprocess.check_output(['git','show',version['gitSourceVersion']+':'+row['path']],cwd=ROOT)
        assert sha(old)==version['sha256'] and len(old)==version['bytes']
        if sha(old)!=row['sha256']:
            assert row['path']=='packages/desktop/src/preload/types.d.ts'
            new=(ROOT/row['path']).read_bytes()
            for a,z in [[863,883],[2068,2094]]:assert old.splitlines(keepends=True)[a-1:z]==new.splitlines(keepends=True)[a-1:z]
updates=read('source-status-updates.json')['updates']
assert [r['id'] for r in updates]==['MARKETPLACE-R37-01','MCP-R38-01','MCP-R39-01']
assert all(r['runtimeRetested'] is False and r['sourceDisposition']=='source-addressed' and r['newFinding'] is False and r['originalClassificationUnchanged'] for r in updates)
rawdiff=read('evidence/source-status-root/source-diff-preserved.json');raw=rawdiff['text'].encode()
assert len(raw)==rawdiff['bytes'] and sha(raw)==rawdiff['sha256']
assert raw==Path('/tmp/codeshell-audit-round50-source-disposition/source-diff.first.txt').read_bytes()
assert not (OUT/'evidence/source-status-root/source-diff.first.txt').exists()
coverage=read('evidence/coverage-status/summary.json')
assert coverage['explicitFull']==288 and coverage['explicitSelectedNoFull']==150 and coverage['semanticCoverageNotConfirmed']==4205 and coverage['total']==4643
assert sum(coverage[k] for k in ['explicitFull','explicitSelectedNoFull','semanticCoverageNotConfirmed'])==coverage['total']

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
assert read('findings.json')['count']==0 and read('candidates.json')['count']==0 and read('related.json')['count']==0
print(json.dumps(dict(files=len(actual)+1,indexedFiles=len(actual),sourcePins=len(sources['files']),workerSourceChecks=len(sources['workerSourceChecks']),
    workerArtifacts=checks,localMarkdownLinks=len(links),rawLogs=len(validation['runs']),productReruns=0,allChecksPassed=True)))

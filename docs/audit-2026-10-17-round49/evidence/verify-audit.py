"""Read-only final metadata verification; never imports product code/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round49'

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
assert len(freeze['checks'])==freeze['expectedCount']==39
for row in freeze['checks']:
    raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
coverage=read('coverage.json')
assert coverage['historicalFormalRecords']==112 and coverage['priorities']==dict(P2=44,P3=68)
assert coverage['formal']==coverage['candidates']==coverage['related']==0
assert coverage['changedFromFrozenSourcePaths']==[] and len(sources['files'])==44
adapter=read('evidence/source-pin-adapter-notes.json')
assert len(adapter['missingDeclaredByteCounts'])==1 and adapter['missingDeclaredByteCounts'][0]['path']=='CODESHELL.md' and adapter['missingDeclaredByteCounts'][0]['reportedBytes'] is None
assert len(adapter['nonReadingGateAssertions'])==2 and len(adapter['unboundNavigationReferences'])==16
assert read('evidence/assemble-first-exit.json')['exitCode']==1 and read('evidence/assemble-final-exit.json')['exitCode']==0
assert 'gateDecisions' in (OUT/'evidence/assemble-first.txt').read_text()
branch=read('evidence/branch-begin-output-clarification.json')
assert branch['actualOwnedHead']==branch['planBaseline']==sources['baseline']=='dc2b3d4c7b3650e36f27deda6f20c87712a8e684'
assert branch['originalPrintedSummary']['baseline']!=branch['planBaseline'] and branch['productBytesSwitched'] is False
incoming=read('evidence/incoming-main-paths.json')
assert len(incoming['paths'])==7 and not (set(incoming['paths']) & {r['path'] for r in sources['files']})
drift=read('evidence/incoming-history-drift.json')
assert drift['frozenHistoryFiles']==4492 and len(drift['changed'])==1 and drift['missing']==[]
for row in drift['changed']:
    assert row['path']=='docs/todo/release-real-operations-2026-10-16.md'
    frozen=subprocess.check_output(['git','show',sources['baseline']+':'+row['path']],cwd=ROOT)
    current=(ROOT/row['path']).read_bytes()
    assert sha(frozen)==row['frozenSha256'] and len(frozen)==row['frozenBytes']
    assert sha(current)==row['currentSha256'] and len(current)==row['currentBytes']
assert read('evidence/root-cost-review/assessment.json')['hypothesisDisposition'].startswith('Remote TUI /cost local-empty singleton hypothesis withdrawn')
assert read('evidence/root-summary-review/source-manifest.json')['counts']['semanticProductLines']==263
assert read('evidence/latest-message-frontier/source-manifest.json')['counts']['productSemanticLines']==335

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

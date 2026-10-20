"""Read-only final metadata verification; never imports product code/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round47'

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
assert len(freeze['checks'])==freeze['expectedCount']==15
for row in freeze['checks']:
    raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
adapter=read('evidence/coverage-adapter/summary.json')
assert adapter['sourceFiles']==4643 and adapter['historyFiles']==4162
assert adapter['original49Reproduction']['full']==292 and adapter['original49Reproduction']['selectedNoFull']==154
assert adapter['original49Reproduction']['fullSetDifference']==adapter['original49Reproduction']['selectedSetDifference']==[]
assert adapter['status51Comparison']['fullSetDifference']==adapter['status51Comparison']['selectedSetDifference']==[]
assert adapter['currentStages']['plusFrozen45']==dict(full=304,selected=169,unknown=4170)
assert sum(adapter['currentStages']['plusFrozen45'].values())==4643
peer=read('evidence/coverage-review/checks.json')
assert peer['files']==[] and peer['integrityAllPass'] and peer['all10RawCanonicalObjectsChecked'] and peer['all20InspectionObjectIdentitiesIndependentlyLocated']
assert peer['transitionRepresentatives']==35 and peer['canonicalSourceManifestRepresentatives']==34 and peer['canonicalDisplayClarifications']==1 and peer['allOriginalRangeSupportValid']
assert peer['stageCounts']['plus-frozen45']==dict(full=304,selected=169,unknown=4170)
assert peer['stageChanges']==[10,14,11] and peer['reviewerFalseSHARequirementRetracted'] and peer['datedCountsAllMatch']
clarify=read('evidence/provenance-clarification.json');doc=ROOT/clarify['canonicalDocument'];raw=doc.read_bytes()
assert sha(raw)==clarify['canonicalDocumentSha256']
assert raw==subprocess.check_output(['git','show',sources['baseline']+':'+clarify['canonicalDocument']],cwd=ROOT)
canonical=json.loads(raw)['files'][3];assert canonical==clarify['canonicalRow']
assert canonical['coverage']=='selected' and canonical['selectedLineRanges']==[[1,181]] and canonical['lines']==345
assert canonical['scope'].endswith('remaining filesystem/store body not read')
assert sha((ROOT/canonical['path']).read_bytes())==canonical['sha256']
assert clarify['notNewSemanticRead'] and clarify['notFullFile'] and clarify['countsChanged'] is False

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

"""Read-only final metadata verification; never imports product code/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round24'

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

checks=0
for manifest in [OUT/'evidence'/name for name in ['root-artifact-receipt.json','windows-author-receipt.json','browser-helpers-author-receipt.json','browser-scenes-author-receipt.json']]:
    data=json.loads(manifest.read_text())
    for row in data.get('files',data.get('artifacts',[])):
        path=ROOT/row['path'] if row['path'].startswith('docs/') else OUT/row['path']
        raw=path.read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],row['path'];checks+=1
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

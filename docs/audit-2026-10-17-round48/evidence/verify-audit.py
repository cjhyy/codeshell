"""Read-only final metadata verification; never imports product code/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round48'

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
assert len(freeze['checks'])==freeze['expectedCount'] and freeze['expectedCount']>=27
for row in freeze['checks']:
    raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
cat=read('recorded-findings-catalog.json');old=json.loads((ROOT/'docs/audit-2026-10-17-round43/recorded-findings-catalog.json').read_text())
assert cat['findings'][:-1]==old['findings'] and len(cat['findings'])==112
assert len({r['id'] for r in cat['findings']})==112
assert cat['counts']==dict(formalRecordRows=112,uniqueIds=112,byPriority=dict(P2=44,P3=68),rounds=48)
assert sum(r['priority']=='P2' for r in cat['findings'])==44 and sum(r['priority']=='P3' for r in cat['findings'])==68
assert len(cat['sourceDocuments'])==48
for row in cat['sourceDocuments']:
    raw=(ROOT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
finding=read('findings.json')['findings'][0]
assert finding['id']=='TUI-R48-01' and finding['severity']=='P3' and finding['proposalAlias']=='STATUSLINE-R64-C1' and finding['runtimeValidated'] is False
assert cat['findings'][-1]['id']==finding['id']
rows=[]
for line in (OUT/'ALL-ISSUES.md').read_text().splitlines():
    m=re.match(r'^\| \[([^\]]+)\]\(([^)]+)\) \| (P[0-3]) \|',line)
    if m:rows.append((m.group(1),m.group(3)))
assert rows==[(r['id'],r['priority']) for r in cat['findings']]
assert read('evidence/catalog-checks.json')['markdownTableIssueRows']==112
root=read('evidence/root-elapsed-review/source-manifest.json')
assert len(root['files'])==10 and root['counts']['semanticProductLines']==353 and root['counts']['productRuns']==0
assert read('evidence/elapsed-review/source-manifest.json')['semanticProductLines']==291

checks=0
for row in read('evidence/root-receipt-checks.json')['checks']:
    target=row['path'];path=ROOT/target if target.startswith('docs/') else OUT/target
    raw=path.read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'];checks+=1
links=[]
pending_primary=[]
primary=Path("/Users/admin/Documents/个人学习/代码学习/codeshell")
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
        if not destination.is_file() and destination.is_relative_to(primary/'docs/audit-2026-10-17-round48'):
            mapped=ROOT/destination.relative_to(primary)
            assert mapped.is_file(),(str(path.relative_to(OUT)),raw_target)
            pending_primary.append(dict(target=str(destination),mappedOwned=str(mapped),bytes=mapped.stat().st_size,sha256=sha(mapped.read_bytes())))
            destination=mapped
        assert destination.is_file(),(str(path.relative_to(OUT)),raw_target)
        if line is not None:assert 1<=line<=len(destination.read_text().splitlines()),(str(path.relative_to(OUT)),raw_target)
        links.append(dict(fromFile=str(path.relative_to(OUT)),target=raw_target))
validation=read('validation.json')
assert validation['totals']['passedTests']==0 and validation['totals']['expectations']==0
assert read('findings.json')['count']==1 and read('candidates.json')['count']==0 and read('related.json')['count']==0
print(json.dumps(dict(files=len(actual)+1,indexedFiles=len(actual),sourcePins=len(sources['files']),workerSourceChecks=len(sources['workerSourceChecks']),
    workerArtifacts=checks,localMarkdownLinks=len(links),pendingPrimaryIntegrationLinks=pending_primary,rawLogs=len(validation['runs']),productReruns=0,allChecksPassed=True)))

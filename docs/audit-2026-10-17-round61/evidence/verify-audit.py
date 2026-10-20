"""Read-only audit metadata checks; does not import or run any product code."""
from pathlib import Path
from collections import Counter
import hashlib, json, re, subprocess

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round61'
PRIMARY=Path('/Users/admin/Documents/个人学习/代码学习/codeshell')
def sha(b): return hashlib.sha256(b).hexdigest()
def read(name): return json.loads((OUT/name).read_text())
def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT)

index=read('evidence-index.json')
actual={str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file() and p.name!='evidence-index.json'}
assert actual=={r['path'] for r in index['files']}
for row in index['files']:
    raw=(OUT/row['path']).read_bytes(); assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],row['path']
source=read('source-manifest.json')
assert git('rev-parse','main').decode().strip()==source['mainHead']
for row in source['files']:
    frozen=git('show',source['baseline']+':'+row['path']); current=(ROOT/row['path']).read_bytes(); main=git('show',source['mainHead']+':'+row['path'])
    assert sha(frozen)==row['sha256'] and sha(current)==row['currentSha256'] and len(current)==row['currentBytes']
    assert sha(main)==row['mainSha256'] and current==main==frozen,row['path']
assert source['changedFromFrozenPaths']==[]
freeze=read('evidence/freeze-checks.json'); assert len(freeze['checks'])==freeze['expectedCount']==27
for row in freeze['checks']+read('evidence/root-receipt-checks.json')['checks']:
    raw=(OUT/row['path']).read_bytes(); assert len(raw)==row['bytes'] and sha(raw)==row['sha256']

coverage=read('coverage.json')
assert coverage['formal']==1 and coverage['candidates']==coverage['related']==0
assert coverage['historicalFormalRecords']==119 and coverage['priorities']==dict(P2=46,P3=73)
assert coverage['uniqueSourcePins']==len(source['files']) and coverage['changedFromFrozenSourcePaths']==[] and coverage['goalStillActive']
findings=read('findings.json'); assert findings['count']==len(findings['findings'])==1
assert findings['findings'][0]['id']=='MCP-R61-01' and findings['findings'][0]['severity']=='P2'
for name in ['candidates.json','related.json']: assert read(name)['count']==0
validation=read('validation.json'); assert validation['runs']==[] and all(v==0 for v in validation['totals'].values())
decision=read('evidence/root-decision.json'); assert decision['allReadersFrozen'] and decision['rootSourceReviewComplete']
assert decision['formal']==findings['findings'] and decision['candidates']==[]
assert read('evidence/assemble-first-exit.json')['exitCode']==0

catalog=read('recorded-findings-catalog.json'); old=json.loads((ROOT/'docs/audit-2026-10-17-round58/recorded-findings-catalog.json').read_text())
assert catalog['findings'][:118]==old['findings'] and len(catalog['findings'])==119
assert len({r['id'] for r in catalog['findings']})==119 and Counter(r['priority'] for r in catalog['findings'])==dict(P2=46,P3=73)
assert re.findall(r'^\| \[([^\]]+)\]\(', (OUT/'ALL-ISSUES.md').read_text(),re.M)==[r['id'] for r in catalog['findings']]
candidates=read('historical-candidates.json'); assert candidates['count']==42 and candidates['currentUnresolvedCountCertified'] is False
assert len({r['id'] for r in candidates['candidates']})==42
for row in candidates['candidates']:
    original=json.loads((ROOT/row['source']).read_text()); i=int(row['pointer'].rsplit('/',1)[1])
    assert original['candidates'][i]==row['original']
for row in candidates['sourceDocuments']:
    raw=(ROOT/row['path']).read_bytes(); assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
assert len(re.findall(r'^\| \[([^\]]+)\]\(', (OUT/'HISTORICAL-CANDIDATES.md').read_text(),re.M))==42

binding=read('evidence/coverage-snapshot-current-binding.json'); ledger=read('evidence/coverage-migration/unified-current-index.json')
assert binding['sourcePaths']==len(ledger['files'])==4643 and binding['currentFilteredPaths']==4644
assert binding['notFull']==4288 and binding['changedPaths']==binding['removedPaths']==[]
assert Counter(r['publishableCurrentCoverage'] for r in ledger['files'])==binding['states']==dict(full=355,selected=354,unknown=3934)
for row in ledger['files']:
    raw=(ROOT/row['path']).read_bytes(); assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
blobs=read('evidence/coverage-source-git-bindings.json')
assert [r['path'] for r in blobs['baselineFiles']]==[r['path'] for r in ledger['files']]
assert [r['sha256'] for r in blobs['baselineFiles']]==[r['sha256'] for r in ledger['files']]
assert [r['sha256'] for r in blobs['mainFiles']]==[r['sha256'] for r in ledger['files']]
batch=read('evidence/root-composition-lifetime/history-batch.json'); drift=read('evidence/incoming-history-drift.json')
assert batch['historyFiles']==6244 and drift['changed']==drift['missing']==[]
for row in batch['inventory']: assert sha((ROOT/row['path']).read_bytes())==row['sha256'],row['path']
plan=read('evidence/integration-plan.json')
incoming=[x.decode() for x in git('diff','--name-only','-z',plan['baseline'],plan['refreshedMain']).split(b'\0') if x]
assert incoming==read('evidence/incoming-main-paths.json')['paths']

links=[]; pending=[]
for path in sorted(OUT.rglob('*.md')):
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',path.read_text()):
        target=target.strip('<>')
        if re.match(r'^(?:https?:|app:|codex:|mailto:|#)',target): continue
        raw_target=target; line=None
        if '#L' in target:
            target,fragment=target.split('#L',1); line=int(re.match(r'\d+',fragment).group())
        elif '#' in target: target=target.split('#',1)[0]
        colon=re.search(r':(\d+)$',target)
        if colon: line=int(colon.group(1)); target=target[:colon.start()]
        dest=(Path(target) if target.startswith('/') else path.parent/target).resolve()
        if not dest.is_file() and dest.is_relative_to(PRIMARY):
            mapped=ROOT/dest.relative_to(PRIMARY)
            assert mapped.is_file() and mapped.is_relative_to(OUT),(str(path),raw_target)
            raw=mapped.read_bytes(); pending.append(dict(target=str(dest),mappedOwned=str(mapped),bytes=len(raw),sha256=sha(raw))); dest=mapped
        assert dest.is_file(),(str(path.relative_to(OUT)),raw_target)
        if line is not None: assert 1<=line<=len(dest.read_text().splitlines())
        links.append(dict(fromFile=str(path.relative_to(OUT)),target=raw_target))
print(json.dumps(dict(files=len(actual)+1,indexedFiles=len(actual),sourcePins=len(source['files']),workerArtifacts=len(read('evidence/root-receipt-checks.json')['checks']),localMarkdownLinks=len(links),frozenAnchors=27,formalRecords=119,historicalCandidates=42,notFull=4288,pendingPrimaryIntegrationLinks=pending,productRuns=0,allChecksPassed=True)))

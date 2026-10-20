"""Read-only finite artifact/source metadata checks; product code never imported."""
from pathlib import Path
from collections import Counter
import hashlib,json,re,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round63'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(n):return json.loads((OUT/n).read_text())
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
index=read('evidence-index.json');actual={str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file() and p.name!='evidence-index.json'}
assert actual=={r['path'] for r in index['files']}
for row in index['files']:
 raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],row['path']
source=read('source-manifest.json');assert git('rev-parse','main').decode().strip()==source['mainHead']
for row in source['files']:
 frozen=git('show',source['baseline']+':'+row['path']);current=(ROOT/row['path']).read_bytes();main=git('show',source['mainHead']+':'+row['path'])
 assert sha(frozen)==row['sha256'] and sha(current)==row['currentSha256'] and len(current)==row['currentBytes']
 assert sha(main)==row['mainSha256'] and current==main==frozen,row['path']
assert source['changedFromFrozenPaths']==[]
freeze=read('evidence/freeze-checks.json');assert len(freeze['checks'])==freeze['expectedCount']==12
for row in freeze['checks']+read('evidence/root-receipt-checks.json')['checks']:
 raw=(OUT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
coverage=read('coverage.json');assert coverage['formal']==coverage['candidates']==coverage['related']==0
assert coverage['historicalFormalRecords']==119 and coverage['priorities']==dict(P2=46,P3=73)
assert coverage['uniqueSourcePins']==len(source['files']) and coverage['changedFromFrozenSourcePaths']==[] and coverage['goalStillActive']
for n in ['findings.json','candidates.json','related.json']:assert read(n)['count']==0
validation=read('validation.json');assert validation['runs']==[] and all(v==0 for v in validation['totals'].values())
decision=read('evidence/root-decision.json');assert decision['allReadersFrozen'] and decision['rootSourceReviewComplete'] and decision['formal']==decision['candidates']==[]
assert read('evidence/assemble-first-exit.json')['exitCode']==0
historical=read('historical-records-reference.json');assert historical['formalRecords']==119 and historical['historicalCandidates']==42 and historical['currentOpenCountCertified'] is False
catalog=json.loads((ROOT/historical['path']).read_text());assert len(catalog['findings'])==len({r['id'] for r in catalog['findings']})==119
assert Counter(r['priority'] for r in catalog['findings'])==dict(P2=46,P3=73)
binding=read('evidence/coverage-snapshot-current-binding.json');ledger=read('evidence/root-coverage62/unified-current-index.json')
assert binding['sourcePaths']==len(ledger['files'])==4643 and binding['currentFilteredPaths']==4644 and binding['notFull']==4275
assert binding['changedPaths']==binding['removedPaths']==[] and Counter(r['publishableCurrentCoverage'] for r in ledger['files'])==binding['states']==dict(full=368,selected=377,unknown=3898)
for row in ledger['files']:
 raw=(ROOT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
blobs=read('evidence/coverage-source-git-bindings.json');assert [r['path'] for r in blobs['baselineFiles']]==[r['path'] for r in ledger['files']]
assert [r['sha256'] for r in blobs['baselineFiles']]==[r['sha256'] for r in blobs['mainFiles']]==[r['sha256'] for r in ledger['files']]
batch=read('evidence/root-coverage62/history-batch.json');drift=read('evidence/incoming-history-drift.json');assert batch['historyFiles']==6669
changed=[];missing=[]
for row in batch['inventory']:
 p=ROOT/row['path']
 if not p.is_file():missing.append(row['path'])
 elif sha(p.read_bytes())!=row['sha256']:changed.append(row['path'])
assert drift['changed']==changed and drift['missing']==missing
plan=read('evidence/integration-plan.json');incoming=[x.decode() for x in git('diff','--name-only','-z',plan['baseline'],plan['refreshedMain']).split(b'\0') if x]
assert incoming==read('evidence/incoming-main-paths.json')['paths']
links=[]
for p in sorted(OUT.rglob('*.md')):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',p.read_text()):
  target=target.strip('<>')
  if re.match(r'^(?:https?:|app:|codex:|mailto:|#)',target):continue
  raw_target=target;line=None
  if '#L' in target:target,fragment=target.split('#L',1);line=int(re.match(r'\d+',fragment).group())
  elif '#' in target:target=target.split('#',1)[0]
  colon=re.search(r':(\d+)$',target)
  if colon:line=int(colon.group(1));target=target[:colon.start()]
  dest=(Path(target) if target.startswith('/') else p.parent/target).resolve();assert dest.is_file(),(str(p.relative_to(OUT)),raw_target)
  if line is not None:assert 1<=line<=len(dest.read_text().splitlines())
  links.append(dict(fromFile=str(p.relative_to(OUT)),target=raw_target))
print(json.dumps(dict(files=len(actual)+1,indexedFiles=len(actual),sourcePins=len(source['files']),workerArtifacts=len(read('evidence/root-receipt-checks.json')['checks']),localMarkdownLinks=len(links),frozenAnchors=12,formalRecords=119,historicalCandidates=42,notFull=4275,productRuns=0,allChecksPassed=True)))

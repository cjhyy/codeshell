"""Read-only artifact, source, scope, catalog and first-run evidence verification."""
from pathlib import Path
from collections import Counter
import json,hashlib,re,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round64'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads((OUT/p).read_text())
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
index=read('evidence-index.json');actual={str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file() and p.name!='evidence-index.json'}
assert actual=={r['path'] for r in index['files']}
for r in index['files']:
 b=(OUT/r['path']).read_bytes();assert len(b)==r['bytes'] and sha(b)==r['sha256'],r['path']
source=read('source-manifest.json');assert git('rev-parse','main').decode().strip()==source['mainHead']
for row in source['files']:
 before=git('show',source['baseline']+':'+row['path']);now=(ROOT/row['path']).read_bytes();main=git('show',source['mainHead']+':'+row['path']);assert before==now==main and sha(now)==row['sha256']==row['currentSha256']==row['mainSha256'];assert len(now)==row['bytes']==row['currentBytes']
assert source['changedFromFrozenPaths']==[]
freeze=read('evidence/freeze-checks.json');assert len(freeze['checks'])==freeze['expectedCount']==15
for row in freeze['checks']+read('evidence/root-receipt-checks.json')['checks']:
 b=(OUT/row['path']).read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256']
for row in read('evidence/source-pin-adapter-notes.json')['externalMetadataInputs']:
 if 'taskOwnedEvidencePath' in row:
  b=(ROOT/row['taskOwnedEvidencePath']).read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256']
cov=read('coverage.json');assert cov['formal']==1 and cov['candidates']==cov['related']==0 and cov['historicalFormalRecords']==120 and cov['priorities']==dict(P2=47,P3=73) and cov['goalStillActive'];assert cov['uniqueSourcePins']==len(source['files'])
assert read('findings.json')['count']==1 and read('findings.json')['findings'][0]['id']=='ATTACH-R64-01'
assert read('candidates.json')['count']==read('related.json')['count']==0
v=read('validation.json');assert len(v['runs'])==1 and v['totals']==dict(productAttempts=1,passedTests=1,expectations=11,failedTests=0,skippedTests=0,productReruns=0)
first=read(v['runs'][0]['exit']);assert first['exitCode']==0 and first['attempt']==1 and first['rerun'] is False
raw=(OUT/v['runs'][0]['log']).read_text();assert '1 pass' in raw and '0 fail' in raw and '11 expect() calls' in raw and 'Completed Bun shard: 1 tests, 0 skipped; 0 failures.' in raw
assert read('evidence/assemble-first-exit.json')['exitCode']==read('evidence/document-first-exit.json')['exitCode']==0
catalog=read('recorded-findings-catalog.json');oldPath='docs/audit-2026-10-17-round61/recorded-findings-catalog.json';old=json.loads((ROOT/oldPath).read_text())
assert catalog['findings'][:119]==old['findings'] and len(catalog['findings'])==len({x['id'] for x in catalog['findings']})==120 and Counter(x['priority'] for x in catalog['findings'])==dict(P2=47,P3=73)
assert len(json.loads((ROOT/'docs/audit-2026-10-17-round61/historical-candidates.json').read_text())['candidates'])==42
binding=read('evidence/coverage-current-index.json');priorRaw=(ROOT/binding['priorIndex']['path']).read_bytes();assert sha(priorRaw)==binding['priorIndex']['sha256'];prior=json.loads(priorRaw)['files'];rows=binding['files']
assert len(rows)==len(prior)==4643 and Counter(x['publishableCurrentCoverage'] for x in rows)==dict(full=367,selected=377,unknown=3899)==binding['states'] and binding['notFull']==4276
blobs=read('evidence/coverage-source-git-bindings.json');assert len(blobs['baselineFiles'])==len(blobs['currentFiles'])==4643
for i,(row,oldRow,before,now) in enumerate(zip(rows,prior,blobs['baselineFiles'],blobs['currentFiles'])):
 assert row['priorIndexRow']==i and row['path']==oldRow['path']==before['path']==now['path'];assert before['sha256']==oldRow['sha256'] and row['sha256']==now['sha256'];b=(ROOT/row['path']).read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'];assert row['publishableCurrentCoverage']==(oldRow['publishableCurrentCoverage'] if row['sameSourceAsPrior'] else 'unknown')
 assert row['sameSourceAsPrior']==(before['sha256']==now['sha256'])
assert len(binding['changed'])==4 and sum(x['priorCoverage']=='full' for x in binding['changed'])==1
extra=read('evidence/current-ts-inventory-delta.json');assert extra['originalPaths']==4643 and extra['currentFilteredPaths']==4646 and len(extra['addedPaths'])==3 and extra['removedPaths']==[]
names=subprocess.check_output(['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**'],cwd=ROOT).decode().splitlines();assert sorted(set(names)-{x['path'] for x in rows})==extra['addedPaths']
batch=read('evidence/root-settings/history-batch.json');assert batch['historyFiles']==6801 and batch['jsonValueScalarsVisited']==5060759 and batch['errors']==[]
changed=[];missing=[]
for row in batch['inventory']:
 p=ROOT/row['path']
 if not p.is_file():missing.append(row['path'])
 elif sha(p.read_bytes())!=row['sha256']:changed.append(row['path'])
drift=read('evidence/incoming-history-drift.json');assert drift['changed']==changed and drift['missing']==missing
plan=read('evidence/integration-plan.json');assert [x.decode() for x in git('diff','--name-only','-z',plan['baseline'],plan['refreshedMain']).split(b'\0') if x]==read('evidence/incoming-main-paths.json')['paths']
links=[]
for p in sorted(OUT.rglob('*.md')):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',p.read_text()):
  target=target.strip('<>')
  if re.match(r'^(?:https?:|app:|codex:|mailto:|#)',target):continue
  original=target;line=None
  if '#L' in target:target,fragment=target.split('#L',1);line=int(re.match(r'\d+',fragment).group())
  elif '#' in target:target=target.split('#',1)[0]
  match=re.search(r':(\d+)$',target)
  if match:line=int(match.group(1));target=target[:match.start()]
  dest=(Path(target) if target.startswith('/') else p.parent/target).resolve();assert dest.is_file(),(str(p.relative_to(OUT)),original)
  if line is not None:assert 1<=line<=len(dest.read_text().splitlines())
  links.append(dict(fromFile=str(p.relative_to(OUT)),target=original))
print(json.dumps(dict(files=len(actual)+1,indexedFiles=len(actual),sourcePins=len(source['files']),workerArtifacts=len(read('evidence/root-receipt-checks.json')['checks']),localMarkdownLinks=len(links),frozenAnchors=15,formalRecords=120,historicalCandidates=42,notFull=4276,productAttempts=1,allChecksPassed=True)))

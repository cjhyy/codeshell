"""Separately reconstruct states directly from original metadata, no adapter import."""
from pathlib import Path
from collections import Counter
import hashlib,json
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');D=Path('/tmp/codeshell-audit-round171-coverage62')
def read(p):return json.loads(p.read_text())
base=read(R/'docs/audit-2026-10-17-round62/evidence/coverage61/unified-current-index.json')
actual=read(D/'unified-current-index.json');summary=read(D/'summary.json')
expected={r['path']:r['publishableCurrentCoverage'] for r in base['files']};old={r['path']:r for r in base['files']};rank={'unknown':0,'selected':1,'full':2};count=0;skipped=0
for stem in ['model-catalog','source-view','root-theme-window','server-run-replay']:
 p=R/'docs/audit-2026-10-17-round62/evidence'/stem/'source-manifest.json';j=read(p)
 for row in j['files']:
  if row['path'] not in expected or row.get('coverage') not in rank or row['coverage']=='unknown':skipped+=1;continue
  oldrow=old[row['path']];assert row['sha256']==oldrow['sha256']
  sem=row.get('selectedLineRanges') or row.get('semanticReadLineRanges');assert sem
  lines=[]
  for a,z in sem:assert 1<=a<=z<=oldrow['lines'];lines.extend(range(a,z+1))
  selected=set(lines);display=set()
  for key in ['bodyDisplayedLineRanges','displayedLineRanges','additionalNavigationSnippetLineRanges','navigationLineRanges','navigationOnlyLineRanges']:
   for a,z in row.get(key,[]):assert 1<=a<=z<=oldrow['lines'];display.update(range(a,z+1))
  assert selected<=display
  if row['coverage']=='full':assert selected==set(range(1,oldrow['lines']+1)) and row.get('semanticFull',True)
  for key in ['semanticLineCount','semanticLines','semanticReadLineCount']:
   if key in row:assert row[key]==len(selected)
  if rank[row['coverage']]>rank[expected[row['path']]]:expected[row['path']]=row['coverage']
  count+=1
assert {r['path']:r['publishableCurrentCoverage'] for r in actual['files']}==expected
assert Counter(expected.values())==summary['counts']==dict(full=368,selected=377,unknown=3898)
assert count==summary['acceptedRows']==26 and skipped==summary['excludedRows']==10 and summary['deferredRows']==0
transitions=read(D/'transitions.json')['transitions'];assert len(transitions)==22
assert {r['path'] for r in transitions}=={p for p,state in expected.items() if state!=old[p]['publishableCurrentCoverage']}
pins=read(D/'input-pins.json')['files']
for row in pins:
 raw=(R/row['path']).read_bytes();assert len(raw)==row['bytes'] and hashlib.sha256(raw).hexdigest()==row['sha256']
result=dict(allChecksPassed=True,counts=dict(Counter(expected.values())),acceptedRows=count,excludedRows=skipped,transitions=22,fullUpgrades=8,selectedUpgrades=14,sourceSemanticReads=0,productRuns=0,checkerIsSecondRootImplementationNotExternalPeer=True)
(D/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result))

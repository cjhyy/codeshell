"""Frozen static prep assembly only; never imports product code."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round34';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,d):p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());baseline=plan['baseline'];main=plan['refreshedMain']
assert git('rev-parse','HEAD').decode().strip()==main
sources=[('memoize-frontier','reviewer-receipt.json'),('semver-frontier','author-receipt.json'),('renderer-status-frontier','artifact-receipt.json'),('utf8-review','author-receipt.json'),('utf8-frontier','author-receipt.json'),('aggregate-review','author-receipt.json')]
copychecks=[];receiptchecks=[];pins={};active=[];hashonly=[];metadataonly=[]
for stem,receipt in sources:
 src=Path('/tmp/codeshell-audit-round34-'+stem);dest=EV/stem;dest.mkdir(exist_ok=True)
 for p in sorted(src.iterdir()):
  assert p.is_file() and not p.is_symlink(),str(p)
  raw=p.read_bytes();target=dest/p.name
  if target.exists():assert target.read_bytes()==raw
  else:target.write_bytes(raw)
  copychecks.append(dict(source=str(p),path=str(target.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
 data=json.loads((dest/receipt).read_text());rows=data.get('files',data.get('artifacts',[]));assert rows
 for r in rows:
  name=Path(r['path']).name;target=dest/name;raw=target.read_bytes();assert len(raw)==r['bytes'] and sha(raw)==r['sha256']
  receiptchecks.append(dict(receipt=str((dest/receipt).relative_to(OUT)),path=str(target.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
 if not (dest/'source-manifest.json').exists():continue
 m=json.loads((dest/'source-manifest.json').read_text())
 for key,kind in [('files','semantic'),('hashOnlyFiles','hash'),('metadataOnlyFiles','metadata')]:
  for r in m.get(key,[]):
   path=r['path'];expected=r['sha256'];raw=(ROOT/path).read_bytes();assert len(raw)==r['bytes'] and sha(raw)==expected
   for start,end in r.get('selectedLineRanges',[]):assert 1<=start<=end<=len(raw.splitlines())
   assert path not in pins or pins[path]==expected;pins[path]=expected
   row=dict(manifest=str((dest/'source-manifest.json').relative_to(EV)),path=path,sha256=expected,coverage=r['coverage'],rootBoundFrozenGitBlob=True,note='Same prep semantic read reused once; timing/null and selected ranges stay in copied source record.')
   (active if kind=='semantic' else metadataonly if kind=='metadata' else hashonly).append(row)
write(EV/'prep-copy-receipt.json',dict(copies=copychecks,sourceRootExactDirsOnly=True,productRuns=0))
receiptchecks.extend(dict(receipt='prep-copy-receipt.json',path=r['path'],bytes=r['bytes'],sha256=r['sha256']) for r in copychecks)
write(EV/'root-receipt-checks.json',dict(checks=receiptchecks,productExecution=False))
files=[]
for path,h in sorted(pins.items()):
 frozen=git('show',baseline+':'+path);current=(ROOT/path).read_bytes();mainraw=git('show',main+':'+path);assert sha(frozen)==h and current==mainraw
 files.append(dict(path=path,bytes=len(frozen),sha256=h,currentBytes=len(current),currentSha256=sha(current),mainBytes=len(mainraw),mainSha256=sha(mainraw),currentWorkingTreeMatchesFrozenBlob=current==frozen,mainMatchesFrozenBlob=mainraw==frozen))
write(OUT/'source-manifest.json',dict(baseline=baseline,mainHead=main,files=files,workerSourceChecks=active,hashOnlyChecks=hashonly,metadataOnlyChecks=metadataonly,changedFromFrozenPaths=[r['path'] for r in files if not r['currentWorkingTreeMatchesFrozenBlob']],note='Original prep parent4be/646f remains; formal baseline40d binds same source bytes. Same-version review does not establish historical novelty or complete packages.'))
rootdecision=json.loads((EV/'utf8-frontier/decisions.json').read_text())
assert rootdecision['findings']==rootdecision['related']==[] and len(rootdecision['candidates'])==1
for kind in ['findings','candidates','related']:
 rows=[dict(r,evidence=['evidence/utf8-frontier/'+x for x in r['evidence']]) for r in rootdecision[kind]] if kind=='candidates' else rootdecision[kind]
 write(OUT/(kind+'.json'),dict(baseline=baseline,count=len(rows),**{kind:rows},sourceDecision='evidence/utf8-frontier/decisions.json',note='Root UTF8-R34-C1 is a static candidate, not runtime-confirmed. Independent same adjacent lead remains unclassified. D03 prior general encoding family is a separate JSON-lines decoder; no exact background cursor tail old cause established.'))
write(OUT/'validation.json',dict(baseline=baseline,runs=[],totals=dict(productAttempts=0,passedTests=0,expectations=0,productReruns=0),mode='Static ordinary input/DTO/caller text only; no shell, decoder/Buffer, browser, CLI, helper/language fixture or test execution; official web document reading only.'))
h=json.loads((EV/'root-history.json').read_text());summary=dict(baseline=baseline,mainHead=main,formal=0,candidates=1,related=0,uniqueSourcePins=len(files),activeSourceChecks=len(active),hashOnlyChecks=len(hashonly),metadataOnlyChecks=len(metadataonly),receiptChecks=len(receiptchecks),verbatimCopies=len(copychecks),historyFiles=h['files'],history=h['stats'],productRuns=0,goalStillActive=True)
write(OUT/'coverage.json',summary);print(json.dumps(summary,ensure_ascii=False))

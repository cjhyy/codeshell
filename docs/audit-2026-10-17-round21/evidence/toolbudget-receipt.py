from pathlib import Path
import ast,hashlib,json,re

root=Path.cwd();batch=root/'docs/audit-2026-10-17-round21';out=batch/'evidence';report=batch/'tool-budget.md';receipt=out/'toolbudget-artifact-receipt.json'
source=json.loads((out/'toolbudget-source-manifest.json').read_text());preflight=json.loads((out/'toolbudget-preflight.json').read_text());exitinfo=json.loads((out/'toolbudget-first.exit.json').read_text());validation=json.loads((out/'toolbudget-validation.json').read_text())
raw=(out/'toolbudget-first.raw.log').read_bytes();rawtext=raw.decode('utf8')
assert hashlib.sha256(raw).hexdigest()==exitinfo['rawSha256'] and len(raw)==exitinfo['rawBytes']
assert exitinfo['exitCode']==0 and exitinfo['savedBeforeInspection']
assert re.search(r'\b18 pass\b',rawtext) and re.search(r'\b94 expect\(\) calls\b',rawtext) and 'Completed Bun shard: 18 tests, 0 skipped; 0 failures.' in rawtext
assert hashlib.sha256((root/preflight['fixture']).read_bytes()).hexdigest()==preflight['fixtureSha256']
for f in source['files']:
 assert hashlib.sha256((root/f['path']).read_bytes()).hexdigest()==f['currentSha256']==f['frozenSha256']
 assert len((root/f['path']).read_bytes().splitlines())==f['lineCount']
links=[]
for target in re.findall(r'\]\(([^)]+)\)',report.read_text()):
 if target.startswith(('https://','http://')):continue
 path,_,fragment=target.partition('#');resolved=(report.parent/path).resolve()
 assert resolved.exists() or resolved==receipt
 if fragment.startswith('L'):
  assert 1<=int(fragment[1:])<=len(resolved.read_bytes().splitlines())
 links.append({'target':target,'path':str(resolved.relative_to(root)),'lineInBounds':True if fragment.startswith('L') else None})
files=sorted([report]+[p for p in out.glob('toolbudget-*') if p.is_file() and p!=receipt])
for p in files:
 if p.suffix=='.py':ast.parse(p.read_text())
 if p.suffix=='.json':json.loads(p.read_text())
 if p.suffix!='.log':assert not any(line.rstrip()!=line for line in p.read_text().splitlines()), str(p)
records=[{'path':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':len(p.read_bytes())} for p in files]
obj={'base':'615e4e4dd3a61b1ad132ab4f3683985a0d582386','report':str(report.relative_to(root)),'formalCount':0,'candidateCount':0,'relatedCount':1,'files':records,'selfExcluded':True,'rawLogsPreservedVerbatim':True,'rawAndExitSavedBeforeInspection':True,'metadataOnlyReview':{'reportLinksChecked':len(links),'allTargetsExist':True,'referencedLinesInBounds':True,'sourceCurrentHashesChecked':len(source['files']),'fixtureUnchangedSincePreflight':True,'rawMatchesExitReceipt':True,'artifactHashesChecked':len(records)},'limitations':'Receipt self excluded. Leaf and selected static coverage only; no product rerun.'}
receipt.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
assert all((root/f['path']).exists() for f in records)
print(json.dumps({'receipt':'saved','artifacts':len(records),'sourcePins':len(source['files']),'reportLinks':len(links),'pass':validation['cleanTotals']['pass'],'expect':validation['cleanTotals']['expect']}))

from pathlib import Path
import hashlib,json,re
root=Path.cwd();base='d40dd06987a2e0c20c377e243cf5c4e4b549c9ec';batch=root/'docs/audit-2026-10-17-round20';out=batch/'evidence';report=batch/'toolsummary.md';receipt=out/'toolsummary-artifact-receipt.json'
if not receipt.exists():receipt.write_text('{}\n')
links=[]
for target in re.findall(r'\]\(([^)]+)\)',report.read_text()):
 if re.match(r'^[a-z]+://',target):continue
 path,_,anchor=target.partition('#');p=(report.parent/path).resolve();assert p.is_file(),(target,'missing')
 if anchor.startswith('L'):
  lineno=int(anchor[1:]);assert 1<=lineno<=len(p.read_bytes().splitlines()),(target,'line out of bounds')
 links.append({'target':target,'path':str(p.relative_to(root))})
source=json.loads((out/'toolsummary-source-manifest.json').read_text());assert all(hashlib.sha256((root/f['path']).read_bytes()).hexdigest()==f['currentSha256'] for f in source['files'])
exitobj=json.loads((out/'toolsummary-first.exit.json').read_text());assert hashlib.sha256((root/exitobj['raw']).read_bytes()).hexdigest()==exitobj['rawSha256'];assert exitobj['exitCode']==0
pre=json.loads((out/'toolsummary-preflight.json').read_text());assert hashlib.sha256((root/pre['fixture']).read_bytes()).hexdigest()==pre['fixtureSha256']
owned=sorted([report]+[p for p in out.glob('toolsummary-*') if p.is_file() and p!=receipt]);files=[]
for p in owned:
 b=p.read_bytes();files.append({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
o={'base':base,'report':str(report.relative_to(root)),'formalCount':0,'candidateCount':0,'relatedCount':1,'files':files,'selfExcluded':True,'rawLogsPreservedVerbatim':True,'rawAndExitSavedBeforeInspection':True,'metadataOnlyReview':{'reportLinksChecked':len(links),'allTargetsExist':True,'referencedLinesInBounds':True,'sourceCurrentHashesChecked':len(source['files']),'fixtureUnchangedSincePreflight':True,'rawMatchesExitReceipt':True,'artifactHashesChecked':len(files)},'limitations':'Artifact receipt self excluded; scoped static and helper coverage only; no product reruns.'}
receipt.write_text(json.dumps(o,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(files),'reportLinks':len(links),'sourceChecks':len(source['files']),'formal':0,'candidate':0,'related':1,'noProductRerun':True}))

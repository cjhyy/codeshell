from pathlib import Path
import json,hashlib,datetime,re
p=Path('/tmp/codeshell-audit-round176-attachment-peer');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat();sha=lambda b:hashlib.sha256(b).hexdigest()
first=[]
for n in ['source-manifest.json','ending-checks.json','report.md','metadata-checks.json','diagnostics.json','reviewer-receipt.json','finalize-metadata.py']:
 dest=p/(Path(n).stem+'.first'+Path(n).suffix);b=(p/n).read_bytes();assert not dest.exists();dest.write_bytes(b);first.append({'path':dest.name,'bytes':len(b),'sha256':sha(b)})
f=p/'source-manifest.json';d=json.loads(f.read_text());ev=[x for x in d['files'] if x['path'].startswith('docs/')];d['files']=[x for x in d['files'] if not x['path'].startswith('docs/')]
for x in ev:x['taskOwnedEvidence']=True;x['baselineGitProductFile']=False;x['binding']='Root-created uncommitted formal64 first-run evidence; current bytes pinned, not certified at source baseline'
d['validationArtifactInputs']=ev;d['summary']['sourceAndInstructionPins']=len(d['files']);d['summary']['validationArtifactInputs']=len(ev);d['summary']['sourceInstructionAndEvidencePins']=len(d['files'])+len(ev);d['baselineBoundary']='Root reported5fa context applies to product source only; no Git validation performed. Task-owned fixture/raw/exit tracked separately and are not baseline Git product pins.';f.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
f=p/'ending-checks.json';d=json.loads(f.read_text());d['validationArtifactInputs']=[x for x in d['files'] if x['path'].startswith('docs/')];d['sharedMetadataInputs']=[x for x in d['files'] if x['path'].startswith('/tmp/')];d['files']=[x for x in d['files'] if x['path'].startswith('packages/') or x['path'] in ['CODESHELL.md','AGENTS.md']];f.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
f=p/'report.md';text=f.read_text().replace('All pinned inputs remain byte-identical.','All pinned inputs remain byte-identical. Root\'s new64 fixture/raw/exit are separate `validationArtifactInputs`, not source-baseline Git product files.');f.write_text(text)
f=p/'diagnostics.json';d=json.loads(f.read_text());d['metadataNormalization']={'atUTC':now(),'trigger':'Root requested task-created uncommitted64 validation evidence separated from ordinary source files','firstArtifactsPreserved':first,'scope':'No product/candidate/source range or observed runtime change; own first metadata used explicit evidence-inspection rows but mixed files list, now validationArtifactInputs separate','productRereadOrRerun':0};f.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
f=p/'metadata-checks.json';d=json.loads(f.read_text());d['taskOwnedValidationArtifactsSeparatedFromBaselineSourceFiles']=True;d['metadataNormalizationOnly']=True;d['reportLinks']=re.findall(r'\]\(([^)]+)\)',text);f.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
files=[]
for f in sorted(p.iterdir()):
 if f.is_file() and f.name!='reviewer-receipt.json':
  b=f.read_bytes();files.append({'path':f.name,'bytes':len(b),'sha256':sha(b)})
(p/'reviewer-receipt.json').write_text(json.dumps({'atUTC':now(),'role':'independent targeted source counter-review of Root attachment lead; Root validation artifacts separately pinned; no own runtime','selfExcluded':True,'frozen':True,'files':files,'listedFiles':len(files),'totalFilesIncludingReceipt':len(files)+1,'ownProductExecution':0,'ownGit':0,'metadataNormalizationOnly':True},indent=2,ensure_ascii=False)+'\n')
print('total',len(files)+1,'receiptListed',len(files),'sourceInstructionPins',9,'validationArtifacts',3)
for n in ['report.md','source-manifest.json','reviewer-receipt.json']:
 b=(p/n).read_bytes();print(n,len(b),sha(b))

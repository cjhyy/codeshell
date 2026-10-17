from pathlib import Path
from urllib.parse import unquote
import json,hashlib,re,datetime
P=Path('/tmp/codeshell-audit-round170-panel-resource-clone')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def ref(n):
 b=(P/n).read_bytes();return {'path':n,'bytes':len(b),'sha256':h(b)}
assert not (P/'artifact-receipt.json').exists()
m=json.loads((P/'source-manifest.json').read_text());e=json.loads((P/'ending.json').read_text())
assert len(m['files'])==9 and m['totals']['fullProductFiles']==4
assert m['totals']['productSemanticLines']==1155 and m['totals']['testDeclarationLines']==50
for row in m['files']:
 for a,b in row['selectedLineRanges']+row['displayedLineRanges']:assert 1<=a<=b<=row['lines']
 if row['coverage']=='full':assert row['selectedLineRanges']==[[1,row['lines']]]
assert len(e['files'])==15 and all(r['unchanged'] for r in e['files']) and e['sharedHistory']['unchanged']
assert json.loads((P/'classification.json').read_text())['counts']=={'formal':0,'candidate':0,'related':0}
links=[]
for f in sorted(P.glob('*.md')):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',f.read_text()):
  if '://' in target or target.startswith('#'):continue
  path=(f.parent/unquote(target.split('#')[0])).resolve();assert path.is_relative_to(P.resolve())
  assert path.exists() or path==(P/'artifact-receipt.json').resolve(),str(path)
  links.append({'document':f.name,'target':target,'existsInsideExactDirectoryAfterReceiptCreation':True})
save('freeze-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'metadataChecksOnly':True,'sourceRangesWithinEOF':True,'explicitFullRowsCoverEOF':4,'unchangedSourceInstructionCanonicalPins':15,'sharedHistoryUnchanged':True,'linkCount':len(links),'links':links,'productExecution':0,'Git':0,'notPromotedBoundaryHasNoIDOrCandidateCount':True})
rows=[ref(f.name) for f in sorted(P.iterdir()) if f.is_file() and f.name!='artifact-receipt.json']
save('artifact-receipt.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'scope':'Exact prep170 frozen artifacts','count':len(rows),'files':rows})
for row in rows:assert ref(row['path'])==row
for link in links:assert (P/unquote(link['target'].split('#')[0])).resolve().exists()
print(json.dumps({'frozen':True,'files':len(rows)+1,'receiptRows':len(rows),'reportLinks':len(links),'anchors':[ref(n) for n in ['report.md','source-manifest.json','artifact-receipt.json']]},ensure_ascii=False,indent=2))

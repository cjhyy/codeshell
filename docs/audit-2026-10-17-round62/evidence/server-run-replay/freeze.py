from pathlib import Path
import json,re,hashlib,datetime
from urllib.parse import unquote
P=Path('/tmp/codeshell-audit-round167-server-run-replay')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def ref(n):
 b=(P/n).read_bytes();return {'path':n,'bytes':len(b),'sha256':h(b)}
assert not (P/'artifact-receipt.json').exists()
m=json.loads((P/'source-manifest.json').read_text());e=json.loads((P/'ending.json').read_text())
assert len(m['files'])==3
assert m['totals']['productSemanticLines']==308 and m['totals']['testDeclarationLines']==109
assert m['totals']['bodyDisplayedLines']==733 and m['totals']['bodyPlusAdditionalNavigationDisplayedLines']==738
assert len(e['sourceInstructionCanonicalPins'])==10 and all(r['unchanged'] for r in e['sourceInstructionCanonicalPins'])
assert not e['historyDrift']
for row in m['files']:
 for a,b in row['selectedLineRanges']+row['displayedLineRanges']:assert 1<=a<=b<=row['lines']
 assert row['coverage']=='selected' or (row['category']=='test-declaration' and row['selectedLineRanges']==[[1,row['lines']]])
links=[]
for f in sorted(P.glob('*.md')):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',f.read_text()):
  if '://' in target or target.startswith('#'):continue
  path=(f.parent/unquote(target.split('#')[0])).resolve()
  assert path.is_relative_to(P.resolve())
  assert path.exists() or path==(P/'artifact-receipt.json').resolve(),str(path)
  links.append({'document':f.name,'target':target,'verifiedWithinExactDirectoryAfterReceiptCreation':True})
save('freeze-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'metadataChecksOnly':True,'sourceRangesValid':True,'sourceInstructionCanonicalEndingPins':10,'allUnchanged':True,'historyEndingDocuments':6484,'historyDrift':0,'productTestsRun':0,'Git':0,'links':links,'linkCount':len(links),'counts':{'newFormal':0,'newCandidate':0,'newRelated':0},'noFirstSourceOrUniqueCoverageClaim':True})
rows=[ref(f.name) for f in sorted(P.iterdir()) if f.is_file() and f.name!='artifact-receipt.json']
save('artifact-receipt.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'scope':'Exact prep167 directory frozen artifacts','count':len(rows),'files':rows})
for row in rows:assert ref(row['path'])==row
for link in links:assert (P/unquote(link['target'].split('#')[0])).resolve().exists()
print(json.dumps({'frozen':True,'files':len(rows)+1,'receiptRows':len(rows),'reportLinks':len(links),'anchors':[ref(n) for n in ['report.md','source-manifest.json','artifact-receipt.json']]},ensure_ascii=False,indent=2))

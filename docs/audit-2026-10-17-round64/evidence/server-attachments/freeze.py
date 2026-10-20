from pathlib import Path
from urllib.parse import unquote
import json,re,hashlib,datetime
P=Path('/tmp/codeshell-audit-round174-server-attachments')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def ref(n):
 b=(P/n).read_bytes();return {'path':n,'bytes':len(b),'sha256':h(b)}
assert not (P/'artifact-receipt.json').exists()
m=json.loads((P/'source-manifest.json').read_text());e=json.loads((P/'ending.json').read_text())
assert len(m['files'])==7 and m['totals']['fullProductFiles']==1
assert m['totals']['productSemanticLines']==1228 and m['totals']['testDeclarationLines']==146
assert len(e['files'])==21 and all(x['unchanged'] for x in e['files']) and e['sharedHistoryUnchanged']
for row in m['files']:
 for a,b in row['selectedLineRanges']+row['displayedLineRanges']:assert 1<=a<=b<=row['lines']
 if row['coverage']=='full':assert row['selectedLineRanges']==[[1,row['lines']]]
f=json.loads((P/'findings.json').read_text());assert f['count']==1 and f['findings'][0]['id']=='ATTACH-R64-01'
assert json.loads((P/'validation.json').read_text())['authorTestsExecuted']==0
links=[]
for md in sorted(P.glob('*.md')):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',md.read_text()):
  if '://' in target or target.startswith('#'):continue
  path=(md.parent/unquote(target.split('#')[0])).resolve();assert path.is_relative_to(P.resolve())
  assert path.exists() or path==(P/'artifact-receipt.json').resolve(),str(path)
  links.append({'document':md.name,'target':target,'existsInsideExactDirectoryAfterReceiptCreation':True})
save('freeze-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Own metadata freeze only, not product test','sourceRangeRows':7,'sourceRangesWithinEOF':True,'endingPins21Same':True,'sharedHistorySame':True,'authorProductExecution':0,'authorGit':0,'separateRootRunReportedNotAuthorRun':True,'singleRootProposalID':'ATTACH-R64-01','linkCount':len(links),'links':links})
rows=[ref(p.name) for p in sorted(P.iterdir()) if p.is_file() and p.name!='artifact-receipt.json']
save('artifact-receipt.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'scope':'Exact prep174 frozen artifacts','count':len(rows),'files':rows})
for row in rows:assert ref(row['path'])==row
for link in links:assert (P/unquote(link['target'].split('#')[0])).resolve().exists()
print(json.dumps({'frozen':True,'files':len(rows)+1,'receiptRows':len(rows),'reportLinks':len(links),'anchors':[ref(n) for n in ['report.md','source-manifest.json','artifact-receipt.json']]},ensure_ascii=False,indent=2))

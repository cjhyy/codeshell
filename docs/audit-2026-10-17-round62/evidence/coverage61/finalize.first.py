from pathlib import Path
import json,hashlib,re,datetime
from urllib.parse import unquote
P=Path('/tmp/codeshell-audit-round163-coverage61')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def ref(n):
 b=(P/n).read_bytes();return {'path':n,'bytes':len(b),'sha256':h(b)}
assert not (P/'artifact-receipt.json').exists(),'Never rewrite a frozen receipt'
summary=json.loads((P/'summary.json').read_text())
assert summary['counts']=={'unknown':3920,'full':360,'selected':363}
assert summary['transitionCount']==14 and summary['notFull']==4283
assert json.loads((P/'source-manifest.json').read_text())['files']==[]
assert json.loads((P/'independent-checks.json').read_text())['passed']
assert h((P/'migrate.first.py').read_bytes())==json.loads((P/'migration-first.exit.json').read_text())['methodSHA256']
assert h((P/'migrate.py').read_bytes())==json.loads((P/'migration-second.exit.json').read_text())['methodSHA256']
end=json.loads((P/'ending-checks.json').read_text())
assert end['sourceHashRows']==end['sourceUnchanged']==4643
assert end['metadataAndInstructionRows']==end['metadataAndInstructionUnchanged']==10
links=[]
for f in sorted(P.glob('*.md')):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',f.read_text()):
  if '://' in target or target.startswith('#'):continue
  path=(f.parent/unquote(target.split('#')[0])).resolve()
  assert path.is_relative_to(P.resolve()) and path.exists(),str(path)
  links.append({'document':f.name,'target':target,'existsInsideExactDirectory':True})
save('freeze-checks.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Own metadata freeze checks, not product verification','files':[],'links':links,'linkCount':len(links),'firstMethodSHAMatchesOriginalExit':True,'activeMethodSHAMatchesSecondExit':True,'countsMatchIndependentMethod':True,'sourceEndHashRows4643Same':True,'metadataEndPins10Same':True,'productSemanticReads':0,'Git':0,'noExternalPeerClaim':True})
rows=[ref(f.name) for f in sorted(P.iterdir()) if f.is_file() and f.name!='artifact-receipt.json']
save('artifact-receipt.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'prep163 exact directory; frozen metadata artifacts only','selfExcluded':True,'count':len(rows),'files':rows})
for row in rows:assert ref(row['path'])==row
print(json.dumps({'frozen':True,'files':len(rows)+1,'receiptRows':len(rows),'reportLinks':len(links),'anchors':[ref(n) for n in ['report.md','source-manifest.json','artifact-receipt.json']],'index':ref('unified-current-index.json')},ensure_ascii=False,indent=2))

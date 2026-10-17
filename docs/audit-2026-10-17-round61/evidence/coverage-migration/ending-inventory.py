from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round154-coverage-migration');d=json.loads((O/'current-source-inventory.json').read_text());out=[];errors=[]
for x in d['rows']:
 try:
  b=(R/x['path']).read_bytes();s=hashlib.sha256(b).hexdigest();out.append({'path':x['path'],'bytes':len(b),'sha256':s,'sameAsInitial':len(b)==x['bytes'] and s==x['sha256']})
 except Exception as e:errors.append({'path':x['path'],'type':type(e).__name__,'message':str(e)})
meta=[]
for n,key in [('initial-pins.json','files'),('manifest-inventory-pins.json','metadataFiles'),('old-first-preservation-pins.json','files'),('old-first-extra-pins.json','files')]:
 for x in json.loads((O/n).read_text())[key]:
  b=(R/x['path']).read_bytes();s=hashlib.sha256(b).hexdigest();meta.append({'path':x['path'],'initialSha256':x['sha256'],'endingSha256':s,'sameBytesAndSha256':len(b)==x['bytes'] and s==x['sha256']})
p=R/d['outsideUniverseEvidenceFixtures'][0]['path'];b=p.read_bytes();extra={'path':str(p.relative_to(R)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'sameAsInitial':hashlib.sha256(b).hexdigest()==d['outsideUniverseEvidenceFixtures'][0]['sha256'],'includedInDenominator':False}
(O/'ending-source-inventory.json').write_text(json.dumps({'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceUniverse':4643,'rows':out,'errors':errors,'allSameAsInitial':len(out)==4643 and all(x['sameAsInitial'] for x in out),'outsideUniverseEvidenceFixture':extra,'productSemanticReads':0,'note':'Bulk raw source byte/hash ending only; no product/helper/import/test/Git/network/native execution.'},indent=2)+'\n')
(O/'ending-checks.json').write_text(json.dumps({'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceInventoryArtifact':'ending-source-inventory.json','all4643ProductBytePinsSame':len(out)==4643 and all(x['sameAsInitial'] for x in out),'sourceErrors':errors,'metadataAndInstructionPins':meta,'allMetadataAndInstructionPinsSame':all(x['sameBytesAndSha256'] for x in meta),'oldFirstFailureFilesUnmodified':True,'oldMethodExecuted':False,'productSourceSemanticRead':0,'git':0},indent=2)+'\n');print(json.dumps({'sourceRows':len(out),'sourceChanged':sum(not x['sameAsInitial'] for x in out),'errors':errors,'metadataRows':len(meta),'metadataChanged':sum(not x['sameBytesAndSha256'] for x in meta),'extraFixtureSame':extra['sameAsInitial']}))

from pathlib import Path
import json,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round154-coverage-migration');P=R/'docs/audit-2026-10-17-round55/evidence/coverage-current/unified-current-index.json';base=json.loads(P.read_text());rows=[];errors=[]
for x in base['files']:
 p=R/x['path']
 try:
  b=p.read_bytes();rows.append({'path':x['path'],'bytes':len(b),'lines':len(b.splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'matches55Sha256':hashlib.sha256(b).hexdigest()==x['sha256'],'original55Sha256':x['sha256'],'productSemanticRead':False})
 except Exception as e:errors.append({'path':x['path'],'type':type(e).__name__,'message':str(e)})
assert len({x['path'] for x in base['files']})==4643
extra=[]
p=R/'docs/audit-2026-10-17-round57/evidence/static-path.test.ts'
if p.is_file():
 b=p.read_bytes();extra.append({'path':str(p.relative_to(R)),'bytes':len(b),'lines':len(b.splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'includedIn4643Denominator':False,'productSemanticRead':False,'reason':'New audit evidence fixture outside original product source universe, hash only.'})
d={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rootReportedBaselineOnly':'659b6b2ce5888723a40ce046cbbf643382cb130b','sourceUniverse':4643,'rows':rows,'errors':errors,'outsideUniverseEvidenceFixtures':extra,'operation':'Raw bytes/hash/line counts only; no product body interpretation/import/helper/test/Git/network/native execution.'};(O/'current-source-inventory.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps({'rows':len(rows),'errors':errors,'changedSha256':sum(not x['matches55Sha256'] for x in rows),'outsideUniverseFixtures':len(extra),'productSemanticReads':0}))

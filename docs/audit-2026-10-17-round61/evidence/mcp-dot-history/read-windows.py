from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,sys
OUT=Path('/tmp/codeshell-audit-round160-mcp-dot-history');ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');data=json.loads((OUT/'focused-history.json').read_text());plan=json.loads(Path(sys.argv[1]).read_text());rows=[]
for q,i in plan['selections']:
 h=data['hits'][q][i];b=(ROOT/h['document']).read_bytes();pin={'path':h['document'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'pinAt':datetime.now(timezone.utc).isoformat()}
 expected=next(p for p in json.loads((OUT/'history-inventory.json').read_text()) if p['path']==h['document']);assert pin['sha256']==expected['sha256']
 rows.append({'query':q,'savedIndex':i,'documentPin':pin,'hit':h,'readAt':datetime.now(timezone.utc).isoformat(),'scope':'Only this saved bounded window read; not whole giant JSON scalar or document.'})
(OUT/(plan['name']+'.read.json')).write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
for r in rows:
 h=r['hit'];print(r['query'],r['savedIndex'],h['document'],str(h['location']),'line',h.get('matchStartLine'));print(h['window'])

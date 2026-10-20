from pathlib import Path
import json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
raw='docs/review-2026-10-12/validation/postdelivery-report-review/audit-a.raw.json';d=json.loads((root/raw).read_text());compact=[]
for k in ['84740d56','a66f4ef2']:
 r=d['module_inventory'][k];x={'document':raw,'pointer':'/module_inventory/'+k,'keys':list(r),'production_source_files':r.get('production_source_files'),'selectedPathPointers':{'/paths/8':r['paths'][8],'/paths/9':r['paths'][9]},'hasPerFileShaOrReadScope':False};compact.append(x);print('ORIGINAL COMPACT',json.dumps(x,ensure_ascii=False))
(out/'old-gate-compact-objects.json').write_text(json.dumps(compact,ensure_ascii=False,indent=2)+'\n')
p='docs/review-2026-10-12/file-mutex-quality-round19.md';lines=(root/p).read_text().splitlines();rs=[[19,23],[31,31],[53,57]];supp=[]
print('\nOLD QUALITY MISSING INTENDED WINDOWS')
for a,z in rs:
 supp.append({'path':p,'range':[a,z],'text':'\n'.join(lines[a-1:z])})
 for i in range(a-1,z):print(str(i+1)+': '+lines[i])
(out/'old-gate-supplement-excerpts.json').write_text(json.dumps(supp,ensure_ascii=False,indent=2)+'\n')
p='packages/server/src/hub/auth-http.ts';b=(root/p).read_bytes();pin={'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'range':[1,145]}
(out/'http-before-read-pin.json').write_text(json.dumps(pin,indent=2)+'\n');lines=b.decode().splitlines(keepends=True);text=''.join(lines[:145]);(out/'http-part1-excerpt.json').write_text(json.dumps({'path':p,'range':[1,145],'text':text,'bytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()},ensure_ascii=False,indent=2)+'\n')
print('\nSOURCE',p,'RANGE1-145')
for i in range(145):print(str(i+1)+': '+lines[i].rstrip('\n'))

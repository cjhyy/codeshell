from pathlib import Path
import json,hashlib,datetime,subprocess
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round172-server-auth')
r=subprocess.run(['rg','--files','packages/web/app','packages/server/src/serve'],cwd=root,capture_output=True,text=True)
(out/'caller-filenames.first.stdout.txt').write_text(r.stdout);(out/'caller-filenames.first.stderr.txt').write_text(r.stderr);(out/'caller-filenames.first.exit.json').write_text(json.dumps({'exitCode':r.returncode})+'\n');assert r.returncode==0
available=set(r.stdout.splitlines());paths=['packages/web/app/auth.ts','packages/web/app/AuthGate.tsx','packages/server/src/serve/headless-server.ts'];known=set((out/'filenames.first.stdout.txt').read_text().splitlines());tests=[p for p in sorted(known) if '.test.' in p and 'auth' in Path(p).name];print('ACTUAL AUTH TEST FILENAMES',tests)
paths += tests
pins=[]
for p in paths:
 assert p in available or p in known
 b=(root/p).read_bytes();pins.append({'path':p,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':hashlib.sha256(b).hexdigest(),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceKind':'test-declaration' if '.test.' in p else 'product','coverage':'hash-only before navigation'})
(out/'caller-before-navigation-pins.json').write_text(json.dumps(pins,indent=2)+'\n')
plans=[(['rg','-n','createHubAuth|hubAuth\.|onRevoke|revokeSession|auth\.authenticate|auth\.handle|sessionSweep|sweep'],[paths[2]]),(['rg','-n','login|logout|setup|status|fetch|refresh|submit|deviceName|password|revision'],paths[:2])]
if tests:plans.append((['rg','-n',r'(^|\s)(test|it|describe)\('],tests))
allnav=[]
for i,(cmd,ps) in enumerate(plans):
 rr=subprocess.run(cmd+ps,cwd=root,capture_output=True,text=True);allnav.append({'command':cmd+ps,'exitCode':rr.returncode,'stdout':rr.stdout,'stderr':rr.stderr});print('\nNAV',i);print(rr.stdout)
(out/'caller-navigation.json').write_text(json.dumps(allnav,ensure_ascii=False,indent=2)+'\n')

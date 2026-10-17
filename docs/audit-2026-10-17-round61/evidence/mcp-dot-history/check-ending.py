from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re,subprocess
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');OUT=Path('/tmp/codeshell-audit-round160-mcp-dot-history');inventory=json.loads((OUT/'history-inventory.json').read_text());initial={r['path']:r for r in inventory}
cmd=['rg','--files','--hidden','--no-ignore','docs','bugs','-g','*.md','-g','*.json'];r=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True)
(OUT/'ending-inventory.first.stdout.txt').write_text(r.stdout);(OUT/'ending-inventory.first.stderr.txt').write_text(r.stderr);(OUT/'ending-inventory.first.exit.json').write_text(json.dumps({'command':cmd,'exitCode':r.returncode})+'\n')
ending=set();excluded=[]
for p in r.stdout.splitlines():
 m=re.search(r'audit-2026-10-17-round(\d+)',p)
 if m and int(m[1])>=61:excluded.append(p)
 else:ending.add(p)
checks=[];changed=[];removed=[]
for name,p in initial.items():
 try:
  b=(ROOT/name).read_bytes();s=hashlib.sha256(b).hexdigest();same=s==p['sha256'];checks.append({'path':name,'initialSha256':p['sha256'],'endingSha256':s,'unchanged':same})
  if not same:changed.append({'path':name,'initialSha256':p['sha256'],'endingSha256':s,'initialBytes':p['bytes'],'endingBytes':len(b)})
 except FileNotFoundError:removed.append(name)
x={'checkedAt':datetime.now(timezone.utc).isoformat(),'initialCount':len(initial),'endingCount':len(ending),'addedPaths':sorted(ending-set(initial)),'removedPaths':sorted(set(removed)|(set(initial)-ending)),'changed':changed,'excludedFormalAtOrAbove':61,'excludedEndingPaths':excluded,'checks':checks,'GitVerified':False,'productExecution':0,'note':'Ending hashes are metadata integrity, not renewed semantic reading. Original scan counts/first bytes remain unchanged if dated drift exists.'}
(OUT/'ending-checks.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in x.items() if k not in ['checks','excludedEndingPaths']},ensure_ascii=False))

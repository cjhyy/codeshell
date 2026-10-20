from pathlib import Path
import sys,json,hashlib,datetime,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round176-attachment-peer')
rel,pattern=sys.argv[1:]; b=(root/rel).read_bytes();at=datetime.datetime.now(datetime.timezone.utc).isoformat();pin={'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'lines':len(b.splitlines()),'pinnedAtUTC':at,'timing':'before own navigation snippets'}
f=out/'additional-pins.json';pins=json.loads(f.read_text()) if f.exists() else {'files':[]}; initial=json.loads((out/'initial-pins.json').read_text()).get('files',[])
if isinstance(initial,dict): initial=list(initial.values())
if not any(x.get('path')==rel for x in initial+pins['files']): pins['files'].append(pin);f.write_text(json.dumps(pins,indent=2)+'\n')
lines=b.decode().splitlines(); nums=[i for i,l in enumerate(lines,1) if re.search(pattern,l)];rowsf=out/'source-reads.json';rows=json.loads(rowsf.read_text()) if rowsf.exists() else [];rows.append({'path':rel,'atUTC':at,'mode':'navigation-only','ranges':[[i,i] for i in nums],'totalLines':len(lines),'sha256':pin['sha256'],'pattern':pattern});rowsf.write_text(json.dumps(rows,indent=2)+'\n');txt='\n'.join(f'{i}: {lines[i-1]}' for i in nums)+'\n'; name=f'source-display-{len(rows):02d}.txt';(out/name).write_text(txt);print(rel,name);print(txt)

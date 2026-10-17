from pathlib import Path
import sys,json,hashlib,datetime
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'); out=Path('/tmp/codeshell-audit-round176-attachment-peer')
mode,rel,*spans=sys.argv[1:]; p=root/rel; b=p.read_bytes(); at=datetime.datetime.now(datetime.timezone.utc).isoformat(); pin={'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'lines':len(b.splitlines()),'pinnedAtUTC':at}
pinsf=out/'additional-pins.json'; pins=json.loads(pinsf.read_text()) if pinsf.exists() else {'files':[]}
known=json.loads((out/'initial-pins.json').read_text()); knownrows=known.get('files',[])
if isinstance(knownrows,dict): knownrows=list(knownrows.values())
if not any(x.get('path')==rel for x in knownrows+pins['files']):
 pin['timing']='before own body/navigation'; pins['files'].append(pin); pinsf.write_text(json.dumps(pins,indent=2)+'\n')
lines=b.decode().splitlines(); ranges=[]; chunks=[]
for span in spans:
 a,z=map(int,span.split(':')); z=min(z,len(lines)); ranges.append([a,z]); chunks.extend(f'{i}: {lines[i-1]}' for i in range(a,z+1))
rec={'path':rel,'atUTC':at,'mode':mode,'ranges':ranges,'totalLines':len(lines),'sha256':pin['sha256']}; log=out/'source-reads.json'; rows=json.loads(log.read_text()) if log.exists() else []; rows.append(rec);log.write_text(json.dumps(rows,indent=2)+'\n')
text='\n'.join(chunks)+'\n'; name=f'source-display-{len(rows):02d}.txt';(out/name).write_text(text); print(rel,name); print(text)

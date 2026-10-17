"""Dated history metadata only; no product imports or execution."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round33'
EXCLUDED=('docs/audit-2026-10-17-round33/','docs/audit-2026-10-17-round34/')
PATTERNS={'local-await':r'installPluginFromPath|Inconsistent await handling|CLI.{0,80}(?:await|Promise)|runGuarded', 'plugin-input':r'parseMarketplaceInput|deriveMarketplaceName|githubRepoToCloneUrl|plugins/installer/parseSource|parseNpmPluginSource|MIG-R15-C1', 'devtools':r'browser-devtools|DIAG-R10-01|CDP-R3-03|createBrowserDevtoolsInspector'}
CAP=80;patterns={k:re.compile(v,re.I) for k,v in PATTERNS.items()};counts=dict.fromkeys(patterns,0);hits={k:[] for k in patterns}
stats=dict(markdownFiles=0,jsonFiles=0,stringLeaves=0,scalarLeaves=0);inventory=[];errors=[]
def leaves(v,at='$'):
 if isinstance(v,dict):
  for k,c in v.items():yield from leaves(c,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from leaves(c,at+'['+str(i)+']')
 else:
  stats['scalarLeaves']+=1
  if isinstance(v,str):stats['stringLeaves']+=1
  yield at,v if isinstance(v,str) else json.dumps(v)
for p in sorted(p for d in ['docs','bugs'] for p in (ROOT/d).rglob('*') if p.is_file() and p.suffix.lower() in ['.md','.json'] and not p.relative_to(ROOT).as_posix().startswith(EXCLUDED)):
 raw=p.read_bytes();name=p.relative_to(ROOT).as_posix();inventory.append(dict(path=name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
 try:
  if p.suffix.lower()=='.md':stats['markdownFiles']+=1;units=[('$',raw.decode())]
  else:stats['jsonFiles']+=1;units=leaves(json.loads(raw))
  for at,txt in units:
   for k,pat in patterns.items():
    for m in pat.finditer(txt):
     counts[k]+=1
     if len(hits[k])<CAP:hits[k].append(dict(path=name,at=at,context=txt[max(0,m.start()-160):m.end()+560]))
 except Exception as e:errors.append(dict(path=name,error=str(e)))
prior=json.loads(Path('/tmp/codeshell-audit-round33-plugin-input-review/history.json').read_text());old={r['path']:r for r in prior['inventory']};new={r['path']:r for r in inventory}
delta=dict(added=[r for n,r in new.items() if n not in old],removed=[r for n,r in old.items() if n not in new],changed=[dict(before=old[n],after=r) for n,r in new.items() if n in old and r!=old[n]])
value=dict(baseline='646f9243e03b50c49878f966f18ae98b08919177',atUTC=datetime.now(timezone.utc).isoformat(),inventory=inventory,files=len(inventory),stats=stats,patterns=PATTERNS,occurrenceCounts=counts,hits=hits,contextCapEach=CAP,parseErrors=errors,archivesIncluded=True,excluded=list(EXCLUDED),priorInventorySha256=hashlib.sha256(Path('/tmp/codeshell-audit-round33-plugin-input-review/history.json').read_bytes()).hexdigest(),delta=delta,productRuns=0,limitations=['Value scalars only, not JSON keys. Regex counts and saved contexts are not all semantically inspected.','Fresh dated full scan includes frozen32. Independent prep2988 excludes32 and remains unchanged.','Changed release document is separately dated; no claim entire prior inventory remained byte-stable.'])
(OUT/'evidence/root-history.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(files=len(inventory),stats=stats,occurrenceCounts=counts,parseErrors=len(errors),added=len(delta['added']),changed=len(delta['changed']),removed=len(delta['removed']),productRuns=0)))

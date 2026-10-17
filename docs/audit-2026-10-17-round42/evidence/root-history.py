"""Dated history metadata only; no product imports or execution."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round42'
EXCLUDED=tuple('docs/audit-2026-10-17-round'+str(n)+'/' for n in [42,43,44,45,46])
PATTERNS={'translator':r'agent-transcript-translator|createTranscriptTranslator', 'tombstone-transcript':r'(?:tombstone|撤销).{0,160}(?:transcript|转录|子代理|sub.?agent)|(?:transcript|转录|子代理|sub.?agent).{0,160}(?:tombstone|撤销)', 'fallback-placeholder':r'(?:fallback|回退|降级).{0,180}(?:placeholder|占位|部分文本|partial text)|(?:placeholder|占位|部分文本|partial text).{0,180}(?:fallback|回退|降级)'}
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
prior=json.loads((ROOT/'docs/audit-2026-10-17-round41/evidence/root-history.json').read_text());old={r['path']:r for r in prior['inventory']};new={r['path']:r for r in inventory}
delta=dict(added=[r for n,r in new.items() if n not in old],removed=[r for n,r in old.items() if n not in new],changed=[dict(before=old[n],after=r) for n,r in new.items() if n in old and r!=old[n]])
value=dict(baseline='5dcd3ee21756eab037f82193fb80b801fb24112e',atUTC=datetime.now(timezone.utc).isoformat(),inventory=inventory,files=len(inventory),stats=stats,patterns=PATTERNS,occurrenceCounts=counts,hits=hits,contextCapEach=CAP,parseErrors=errors,archivesIncluded=True,excluded=list(EXCLUDED),priorInventorySha256=hashlib.sha256((ROOT/'docs/audit-2026-10-17-round41/evidence/root-history.json').read_bytes()).hexdigest(),delta=delta,productRuns=0,limitations=['Value scalars only, not JSON keys. Regex counts and saved contexts are not all semantically inspected.','Fresh dated scan includes frozen41. Prep44 author/reviewer and Root44/45 histories3696 retain original timing and exclusions.','All history read dates are non-atomic snapshots. Deltas compare exact Root41 prior3696 inventory; no guarantee of future stability.'])
(OUT/'evidence/root-history.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(dict(files=len(inventory),stats=stats,occurrenceCounts=counts,parseErrors=len(errors),added=len(delta['added']),changed=len(delta['changed']),removed=len(delta['removed']),productRuns=0)))

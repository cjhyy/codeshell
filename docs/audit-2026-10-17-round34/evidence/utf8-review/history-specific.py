"""Targeted metadata supplement over the fresh history inventory; no product execution."""
from pathlib import Path
from datetime import datetime,timezone
import json,re,hashlib
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round34-utf8-review/history-specific.json')
BASE=Path('/tmp/codeshell-audit-round34-utf8-review/history.json')
patterns={"exact-helper-sha":r"0ca2da6f3f1a7e1f97e910478d3851846dfa3877fa6ddcc15be05058c341ba10", "cursor-utf8":r"(?:agentReadOffset|consumedBytes|rawBuf|stdoutDec|stderrDec).{0,300}?(?:UTF.?8|split|partial|incomplete|StringDecoder|chunk|replacement)|(?:UTF.?8|StringDecoder|surrogat).{0,300}?(?:agentReadOffset|consumedBytes|rawBuf|stdoutDec|stderrDec)", "background-partial":r"(?:background[- ]shell|BashOutput|readOutput|ring[- ]?file|后台输出).{0,300}?(?:chunk|分块|partial|incomplete|分片).{0,160}?(?:utf.?8|多字节|StringDecoder)|(?:chunk|分块|partial|incomplete|分片).{0,160}?(?:utf.?8|多字节|StringDecoder).{0,300}?(?:background[- ]shell|BashOutput|readOutput|ring[- ]?file|后台输出)"}
compiled={k:re.compile(v,re.I|re.S) for k,v in patterns.items()};counts={k:0 for k in patterns};hits={k:[] for k in patterns};drift=[];errors=[];CAP=100
base=json.loads(BASE.read_text())
def vals(v,at='$'):
 if isinstance(v,dict):
  for k,c in v.items():yield from vals(c,at+'['+json.dumps(k,ensure_ascii=False)+']')
 elif isinstance(v,list):
  for i,c in enumerate(v):yield from vals(c,at+'['+str(i)+']')
 else:yield at,v if isinstance(v,str) else json.dumps(v)
for row in base['inventory']:
 p=ROOT/row['path'];b=p.read_bytes();sha=hashlib.sha256(b).hexdigest()
 if sha!=row['sha256'] or len(b)!=row['bytes']:drift.append({"path":row['path'],"baseSha256":row['sha256'],"currentSha256":sha})
 try:
  units=[('$',b.decode())] if p.suffix.lower()=='.md' else vals(json.loads(b))
  for at,text in units:
   for key,pattern in compiled.items():
    for m in pattern.finditer(text):
     counts[key]+=1
     if len(hits[key])<CAP:hits[key].append({"path":row['path'],"at":at,"context":text[max(0,m.start()-150):m.end()+550]})
 except Exception as e:errors.append({"path":row['path'],"error":str(e)})
d={"completedUTC":datetime.now(timezone.utc).isoformat(),"sourceInventory":"history.json","sourceInventoryRows":len(base['inventory']),"excluded":base['excluded'],"patterns":patterns,"occurrenceCounts":counts,"contextCapEach":CAP,"hits":hits,"driftSinceFreshInventory":drift,"parseErrors":errors,"limits":["Targeted supplement verifies/reuses only fresh inventory paths, not old semantic results. Full per-file initial SHA/times stay in history.json.","Dotall bounded metadata patterns have unrelated prose hits; match/cap counts are not semantic completeness.","A matching SHA or loaded module record is a pin/import fact, not proof of prior full semantic reading."],"productAttempts":0,"gitCommands":0}
OUT.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({"sourceFiles":len(base['inventory']),"occurrenceCounts":counts,"retained":{k:len(v) for k,v in hits.items()},"drift":len(drift),"parseErrors":len(errors)}))

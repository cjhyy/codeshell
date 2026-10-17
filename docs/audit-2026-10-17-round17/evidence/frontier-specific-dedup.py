from pathlib import Path
import json,re,hashlib
r=Path.cwd();b=r/"docs/audit-2026-10-17-round17";e=b/"evidence"
patterns={"ingress-port":r"(?:ingress|webhook.{0,40}upstream|validateUpstream|renderWebhookIngress)","url-default-port":r"(?:default.?port|默认端口|localhost:80(?:[^0-9]|$)|127\.0\.0\.1:80(?:[^0-9]|$)|\[::1\]:80(?:[^0-9]|$)|url\.port)","bound-known":r"bound.session|routeBoundSessionMessage|Work Session.*(?:媒体|附件)|媒体直达"}
regs={k:re.compile(v,re.I) for k,v in patterns.items()};hits={k:[] for k in regs};counts={k:0 for k in regs};stats={"mdFiles":0,"jsonFiles":0,"jsonStringLeaves":0,"jsonScalarLeaves":0,"errors":[]};inventory=[]
def leaves(v,loc="$ "):
 if isinstance(v,dict):
  for k,x in v.items():yield from leaves(x,loc+"."+str(k))
 elif isinstance(v,list):
  for i,x in enumerate(v):yield from leaves(x,loc+"["+str(i)+"]")
 else:yield loc,v
for folder in ("docs","bugs"):
 root=r/folder
 if not root.exists():continue
 for p in sorted(root.rglob("*")):
  if not p.is_file() or p.suffix.lower() not in (".md",".json") or b in p.parents:continue
  try:
   raw=p.read_bytes();txt=raw.decode();rel=str(p.relative_to(r));inventory.append({"path":rel,"sha256":hashlib.sha256(raw).hexdigest()})
   if p.suffix.lower()==".md":stats["mdFiles"]+=1;chunks=[(str(i),s) for i,s in enumerate(txt.splitlines(),1)]
   else:
    stats["jsonFiles"]+=1;chunks=[]
    for loc,v in leaves(json.loads(txt)):
     stats["jsonScalarLeaves"]+=1
     if isinstance(v,str):stats["jsonStringLeaves"]+=1;chunks.append((loc,v))
   for loc,s in chunks:
    for key,rx in regs.items():
     for m in rx.finditer(s):
      counts[key]+=1
      if len(hits[key])<60:hits[key].append({"path":rel,"location":loc,"context":s[max(0,m.start()-180):m.end()+260]})
  except Exception as ex:stats["errors"].append({"path":str(p),"error":str(ex)})
result={"scope":"All recursive prior docs/bugs MD and parsed JSON string leaves, archived directories included, current round excluded","statistics":stats,"patterns":patterns,"patternMatches":counts,"retainedContextCapPerPattern":60,"matches":hits,"inventory":inventory,"limitations":"Keyword matches are aid, not exhaustive semantic proof; scalar and string leaves differ; retained cap does not cap counted matches."}
(e/"frontier-specific-dedup.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"statistics":stats,"patternMatches":counts},ensure_ascii=False))

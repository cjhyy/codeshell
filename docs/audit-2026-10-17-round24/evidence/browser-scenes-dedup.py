from pathlib import Path
import subprocess,hashlib,json,re
BASE=Path(__file__).resolve().parents[3];OUT=Path(__file__).resolve().parent;BATCH=OUT.parent.relative_to(BASE).as_posix();FROZEN="c9056c8047a8e75ab2469e59bf1d3fedd9ad7272"
argv=["rg","--files","--hidden","--no-ignore","docs","bugs","--glob","*.md","--glob","*.json"];p=subprocess.run(argv,cwd=BASE,capture_output=True,text=True)
(OUT/"browser-scenes-dedup-navigation.json").write_text(json.dumps({"argv":argv,"exitCode":p.returncode,"stdout":p.stdout,"stderr":p.stderr},ensure_ascii=False,indent=2)+"\n")
if p.returncode!=0:raise SystemExit("Inventory direction skipped after failure; no retry")
files=sorted(x for x in p.stdout.splitlines() if not x.startswith(BATCH+"/"));patterns={"scene_sources":r"test-auth-boundary-browser|test-service-worker-browser|test-subagent-state-browser","receipts_and_cleanup":r"authOperationsPassed|serviceWorkerOperationsPassed|cleanupPrivateHome|privateHomeRemoved|recordingFailed|retainedHome","case_contracts":r"login-survives-real-tab|old-device-401|explicit-logout-clears|current-login-401|ordered-orphan-results|child-error-keeps|completed-parent-child-details","prior_browser_boundaries":r"(?:ServiceWorker|CacheStorage|browser|浏览器).{0,100}(?:custody|HOME|retention|保留|incognito|blank.owner|旧.reducer|headless|可见|失败)"};rx={k:re.compile(v,re.I) for k,v in patterns.items()};hits={k:[] for k in patterns};counts={k:0 for k in patterns};totals={"files":len(files),"markdown":0,"json":0,"stringLeaves":0,"scalarLeaves":0};inventory=[];errors=[]
def check(path,loc,v):
 s=v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)
 for k,r in rx.items():
  for m in r.finditer(s):
   counts[k]+=1
   if len(hits[k])<150:hits[k].append({"path":path,"location":loc,"context":s[max(0,m.start()-140):min(len(s),m.end()+260)]})
def walk(path,v,loc="$" ):
 if isinstance(v,dict):
  for k,x in v.items():walk(path,x,loc+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for n,x in enumerate(v):walk(path,x,loc+f"[{n}]")
 else:
  totals["scalarLeaves"]+=1
  if isinstance(v,str):totals["stringLeaves"]+=1
  check(path,loc,v)
for rel in files:
 try:
  raw=(BASE/rel).read_bytes();inventory.append({"path":rel,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()});s=raw.decode()
  if rel.endswith(".json"):totals["json"]+=1;walk(rel,json.loads(s))
  else:
   totals["markdown"]+=1
   for n,line in enumerate(s.splitlines(),1):check(rel,f"line:{n}",line)
 except Exception as e:errors.append({"path":rel,"error":str(e)})
r={"baseline":FROZEN,"scope":"All working prior docs/bugs MD and recursively parsed JSON scalar values, archive/_archive included; current round24 excluded. Read-time inventory, not semantic exhaustion.","totals":totals,"parseErrors":errors,"patterns":patterns,"matchCounts":counts,"savedContextCounts":{k:len(v) for k,v in hits.items()},"maxContextsPerPattern":150,"inventory":inventory,"hits":hits,"limitations":["Counts are occurrences and include copied receipts/plans, not independent issues or claims of complete context review.","All scalar values searched; keys excluded; strings and all scalar leaf counts distinct.","Current source assertions and prior successful acceptance reports are not current execution evidence."]}
(OUT/"browser-scenes-dedup.json").write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n");print(json.dumps({k:v for k,v in r.items() if k not in ["inventory","hits"]},ensure_ascii=False))

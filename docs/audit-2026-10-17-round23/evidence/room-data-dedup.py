from pathlib import Path
import json,re,hashlib,subprocess
BASE=Path(__file__).resolve().parents[3];OUT=Path(__file__).resolve().parent;BATCH=OUT.parent.relative_to(BASE).as_posix();FROZEN="c1d007ed0af1eca9b56b32fabbb0ea2401037ee1"
argv=["rg","--files","--hidden","--no-ignore","docs","bugs","--glob","*.md","--glob","*.json"];p=subprocess.run(argv,cwd=BASE,capture_output=True,text=True)
(OUT/"room-data-dedup-navigation.json").write_text(json.dumps({"argv":argv,"exitCode":p.returncode,"stdout":p.stdout,"stderr":p.stderr},ensure_ascii=False,indent=2)+"\n")
if p.returncode!=0:raise SystemExit("History inventory failed; direction skipped without retry")
files=sorted(x for x in p.stdout.splitlines() if not x.startswith(BATCH+"/"));patterns={"exact":r"parseCodexJsonLine|extractThreadId|buildSessionHistory|codex-parse|mobile-history","codex_shapes":r"(?:file_change|mcp_tool_call|agent_message).{0,100}(?:summary|changes|\[object Object\]|completed|path|result)|(?:Codex|codex).{0,80}(?:null|projection|投影|摘要)","history_projection":r"(?:history|历史|FoldItem|transcript).{0,100}(?:injected|clientMessageId|timestamp|attachment|buildSessionHistory|user_message)|R84","old_families":r"\bR3-0[123]\b|MAPPERS-R17-C1|DESKTOP-R12-01|UTF.?16.{0,50}(?:slice|截断)"};rx={k:re.compile(v,re.I) for k,v in patterns.items()};hits={k:[] for k in patterns};counts={k:0 for k in patterns};totals={"files":len(files),"markdown":0,"json":0,"stringLeaves":0,"scalarLeaves":0};inventory=[];errors=[]
def scan(path,loc,v):
 s=v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)
 for k,r in rx.items():
  for m in r.finditer(s):
   counts[k]+=1
   if len(hits[k])<150:hits[k].append({"path":path,"location":loc,"context":s[max(0,m.start()-140):min(len(s),m.end()+240)]})
def walk(path,v,loc="$" ):
 if isinstance(v,dict):
  for k,x in v.items():walk(path,x,loc+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(path,x,loc+f"[{i}]")
 else:
  totals["scalarLeaves"]+=1
  if isinstance(v,str):totals["stringLeaves"]+=1
  scan(path,loc,v)
for rel in files:
 try:
  raw=(BASE/rel).read_bytes();inventory.append({"path":rel,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()});text=raw.decode()
  if rel.endswith(".json"):totals["json"]+=1;walk(rel,json.loads(text))
  else:
   totals["markdown"]+=1
   for n,line in enumerate(text.splitlines(),1):scan(rel,f"line:{n}",line)
 except Exception as e:errors.append({"path":rel,"error":str(e)})
r={"frozenHead":FROZEN,"scope":"Working corpus docs/bugs recursively including archive/_archive, excluding current round23. All parsed JSON scalar values, keys excluded; read-time inventory, not all historical semantic coverage.","totals":totals,"parseErrors":errors,"patterns":patterns,"matchCounts":counts,"savedContextCounts":{k:len(v) for k,v in hits.items()},"maxContextsPerPattern":150,"inventory":inventory,"hits":hits,"limits":["Match counts are occurrences, not issues; keyword navigation does not prove semantic exhaustion.","Codex wire format comments or old SDK evidence are not current producer validation."]}
(OUT/"room-data-dedup.json").write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n");print(json.dumps({k:v for k,v in r.items() if k not in ["inventory","hits"]},ensure_ascii=False))

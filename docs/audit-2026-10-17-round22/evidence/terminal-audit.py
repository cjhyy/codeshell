import hashlib,json,pathlib,re,subprocess,datetime
BASE=pathlib.Path(__file__).resolve().parents[3]
OUT=pathlib.Path(__file__).resolve().parent
BATCH=OUT.parent.relative_to(BASE).as_posix()
FROZEN="ab258c3f534b19014b2ed85da3111649f166ab86"
def run(argv):
 p=subprocess.run(argv,cwd=BASE,capture_output=True,text=True)
 return {"argv":argv,"cwd":str(BASE),"exitCode":p.returncode,"stdout":p.stdout,"stderr":p.stderr}
commands=[]
head=run(["git","rev-parse","HEAD"]);commands.append(head)
roots=[x for x in ["docs","bugs"] if (BASE/x).is_dir()]
inv=run(["rg","--files","--hidden","--no-ignore",*roots,"--glob","*.md","--glob","*.json"]);commands.append(inv)
if inv["exitCode"]!=0:
 (OUT/"terminal-commands.json").write_text(json.dumps({"commands":commands,"skip":"history inventory nonzero; not retried"},ensure_ascii=False,indent=2)+"\n")
 raise SystemExit(0)
files=sorted(p for p in inv["stdout"].splitlines() if not p.startswith(BATCH+"/"))
patterns={"terminal_target":r"terminal-ui|formatToolStart|formatToolResult|renderTaskList|printBanner","banner_padding":r"banner.{0,80}(?:pad|width|align)|(?:pad|width|align).{0,80}banner","known_overlap":r"A12|DESKTOP-R12-01|DESKTOP-R12-C1|UTIL-R14-R1|TUI-C2|Duplicate formatToolArgs"}
regexes={k:re.compile(v,re.I) for k,v in patterns.items()}
counts={k:0 for k in patterns};hits={k:[] for k in patterns};totals={"files":len(files),"markdown":0,"json":0,"stringLeaves":0,"scalarLeaves":0};errors=[]
def check(path,location,value):
 s=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)
 for k,rx in regexes.items():
  ms=list(rx.finditer(s));counts[k]+=len(ms)
  if len(hits[k])<80:
   for m in ms:
    if len(hits[k])>=80: break
    hits[k].append({"path":path,"location":location,"match":m.group(0),"context":s[max(0,m.start()-160):min(len(s),m.end()+240)]})
def walk(path,value,loc="$" ):
 if isinstance(value,dict):
  for k,v in value.items():walk(path,v,loc+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(value,list):
  for i,v in enumerate(value):walk(path,v,loc+f"[{i}]")
 else:
  totals["scalarLeaves"]+=1
  if isinstance(value,str):totals["stringLeaves"]+=1
  check(path,loc,value)
for rel in files:
 p=BASE/rel
 try:
  text=p.read_text()
  if p.suffix==".json":
   totals["json"]+=1;walk(rel,json.loads(text))
  else:
   totals["markdown"]+=1
   for n,line in enumerate(text.splitlines(),1):check(rel,f"line:{n}",line)
 except Exception as e:errors.append({"path":rel,"error":type(e).__name__+": "+str(e)})
history={"frozenHead":FROZEN,"actualHead":head["stdout"].strip(),"scope":"All working corpus docs/bugs Markdown and recursively parsed JSON scalar values, including archive/_archive, excluding current round22 batch. Read-time inventory; not commit-only corpus. Keys are not scalar values.","inventory":files,"totals":totals,"parseErrors":errors,"patterns":patterns,"matchCounts":counts,"savedContextCounts":{k:len(v) for k,v in hits.items()},"maxContextsPerPattern":80,"hits":hits,"limitations":["Regex hit counts are occurrences, not semantic issue counts; keywords do not establish semantic exhaustion.","Current working corpus can include unrelated in-progress evidence."]}
(OUT/"terminal-history.json").write_text(json.dumps(history,ensure_ascii=False,indent=2)+"\n")
old=json.loads(pathlib.Path("/tmp/codeshell-audit-round22-terminal-ui-frontier/sources.json").read_text())
sources=[]
readranges={"packages/tui/src/cli/output/terminal-ui.ts":[[1,235]],"packages/tui/src/cli/output/renderer.ts":[[1,163]],"packages/tui/src/cli/commands/run.ts":[[1,27],[225,280]]}
for source in old["sources"]:
 rel=source["path"];current=(BASE/rel).read_bytes();blob=subprocess.run(["git","show",FROZEN+":"+rel],cwd=BASE,capture_output=True)
 commands.append({"argv":["git","show",FROZEN+":"+rel],"cwd":str(BASE),"exitCode":blob.returncode,"stdoutBytes":len(blob.stdout),"stdoutSha256":hashlib.sha256(blob.stdout).hexdigest(),"stderr":blob.stderr.decode()})
 if blob.returncode!=0:
  sources.append({"path":rel,"skipped":"metadata source missing; not retried"});continue
 frozen=hashlib.sha256(blob.stdout).hexdigest();currenthash=hashlib.sha256(current).hexdigest()
 sources.append({"path":rel,"lineCount":len(current.decode().splitlines()),"bytes":len(current),"frozenSha256":frozen,"currentSha256":currenthash,"matchesFrozen":frozen==currenthash,"matchesPrep":frozen==source["frozenSha256"],"readScope":("full static source" if rel in readranges and readranges[rel]==[[1,len(current.decode().splitlines())]] else "selected static source" if rel in readranges else "hash-only prep revalidation; not read as coverage"),"selectedRanges":readranges.get(rel,[])})
(OUT/"terminal-sources.json").write_text(json.dumps({"frozenHead":FROZEN,"sources":sources,"runtimeAttempts":0},ensure_ascii=False,indent=2)+"\n")
(OUT/"terminal-commands.json").write_text(json.dumps({"commands":commands,"execution":"Python standard library metadata collector; no product imports, constructors, stdio capture or tests.","collectorEntrypoint":"python3 docs/audit-2026-10-17-round22/evidence/terminal-audit.py"},ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"totals":totals,"parseErrors":errors,"matchCounts":counts,"savedContextCounts":{k:len(v) for k,v in hits.items()},"sources":sources},ensure_ascii=False))

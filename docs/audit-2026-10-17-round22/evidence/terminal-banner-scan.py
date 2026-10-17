import json,pathlib,re
BASE=pathlib.Path(__file__).resolve().parents[3];OUT=pathlib.Path(__file__).resolve().parent
h=json.loads((OUT/"terminal-history.json").read_text());pattern=r"(?:banner|边框|边界|横框|padding|pad =).{0,100}(?:56|60|\+ ?4|错位|对齐|width|align)|(?:56|60).{0,40}(?:banner|padding)";rx=re.compile(pattern,re.I);hits=[];total=0;errors=[]
def scan(path,loc,value):
 global total
 s=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)
 for m in rx.finditer(s):
  total+=1
  if len(hits)<100:hits.append({"path":path,"location":loc,"context":s[max(0,m.start()-160):min(len(s),m.end()+240)]})
def walk(path,v,loc="$" ):
 if isinstance(v,dict):
  for k,x in v.items():walk(path,x,loc+"["+json.dumps(k,ensure_ascii=False)+"]")
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(path,x,loc+f"[{i}]")
 else:scan(path,loc,v)
for rel in h["inventory"]:
 try:
  p=BASE/rel;text=p.read_text()
  if p.suffix==".json":walk(rel,json.loads(text))
  else:
   for n,line in enumerate(text.splitlines(),1):scan(rel,f"line:{n}",line)
 except Exception as e:errors.append({"path":rel,"error":str(e)})
r={"basisInventory":"evidence/terminal-history.json","sameInventoryFiles":len(h["inventory"]),"pattern":pattern,"totalOccurrences":total,"savedContexts":len(hits),"maxSavedContexts":100,"parseErrors":errors,"hits":hits,"limits":"Broad supplemental banner wording; includes unrelated boundary and padding mentions. Not semantic issue or novelty proof."}
(OUT/"terminal-banner-history.json").write_text(json.dumps(r,ensure_ascii=False,indent=2)+"\n");print(json.dumps({k:v for k,v in r.items() if k!="hits"},ensure_ascii=False))

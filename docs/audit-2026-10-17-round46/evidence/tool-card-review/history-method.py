from pathlib import Path
import json,hashlib,datetime,re,subprocess
out=Path('/tmp/codeshell-audit-round54-tool-card-review');pin=json.loads((out/'initial-pins.json').read_text())['files'][0]
patterns={'path':re.compile(re.escape(pin['path']),re.I),'filename':re.compile('ToolCardShell\\.tsx',re.I),'sha':re.compile(pin['sha256'],re.I),'ordinary-contract':re.compile(r'ToolCardShell|StatusDot|(?:tool.?card|工具卡).{0,80}(?:summary|status|collapse|expand|摘要|状态|展开|折叠)|(?:summary|status|collapse|expand|摘要|状态|展开|折叠).{0,80}(?:tool.?card|工具卡)',re.I),'old-failed':re.compile(r'(?:ToolCardShell|tool.?card).{0,100}(?:failed|failure|skip|失败|跳过)',re.I)}
exclude={f'audit-2026-10-17-round{i}' for i in range(45,56)}
paths=sorted(p for p in subprocess.run(['rg','--files','docs','bugs'],capture_output=True,text=True,check=True).stdout.splitlines() if Path(p).suffix.lower() in ['.md','.json'] and not any(part in exclude for part in Path(p).parts))
counts={k:0 for k in patterns};hits={k:[] for k in patterns};caps={k:(160 if k in ['path','filename','sha'] else 100) for k in patterns};objects=[];inventory=[];errors=[];totals={'files':len(paths),'md':0,'json':0,'strings':0,'scalars':0,'exactArchivePaths':0}
def hit(s,p,loc):
 for k,rx in patterns.items():
  if rx.search(s):
   counts[k]+=1
   if len(hits[k])<caps[k]:hits[k].append({'path':p,'location':loc,'excerpt':s[:3000]})
def visit(v,p,loc):
 if isinstance(v,dict):
  if any(isinstance(v.get(k),str) and (v[k]==pin['path'] or v[k].endswith('/'+pin['path'])) for k in ['path','file','source','sourcePath']):objects.append({'path':p,'location':loc,'object':v})
  for k,x in v.items():visit(x,p,loc+'['+json.dumps(k)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):visit(x,p,loc+'['+str(i)+']')
 else:
  totals['scalars']+=1
  if isinstance(v,str):totals['strings']+=1
  hit(v if isinstance(v,str) else json.dumps(v,ensure_ascii=False),p,loc)
for p in paths:
 b=Path(p).read_bytes();inventory.append({'path':p,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if any(z.casefold() in ['archive','_archive'] for z in Path(p).parts):totals['exactArchivePaths']+=1
 if Path(p).suffix.lower()=='.md':
  totals['md']+=1
  for n,s in enumerate(b.decode().splitlines(),1):hit(s,p,str(n))
 else:
  totals['json']+=1
  try:visit(json.loads(b),p,'$')
  except Exception as e:errors.append({'path':p,'error':type(e).__name__,'message':str(e)})
d={'capturedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':{'roots':['docs','bugs'],'includeFrozenThrough':44,'excludedExactRounds':list(range(45,56)),'requestedExclusions':[45,52,53,54,55],'method':'MD lines and recursive JSON value scalars including archives; keys excluded. Original full/scope/review fields kept.'},'rootReportedBaseline':'0b17496707e0f4d679a86a9d8b4c22477093e8a6','gitVerified':False,'totals':totals,'parseErrors':errors,'patterns':{k:v.pattern for k,v in patterns.items()},'counts':counts,'caps':caps,'retained':{k:len(v) for k,v in hits.items()},'hits':hits,'directSourceObjects':objects,'inventory':inventory,'inventoryCanonicalSha256':hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'limits':['Counts and capped retained contexts are not semantic exhaustion or proof of unreadness.','No author54 report/manifest/excerpts read; only repository canonical history gate.'],'productExecution':0,'gitCommands':0}
(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'totals':totals,'counts':counts,'retained':d['retained'],'objects':len(objects),'parseErrors':errors},ensure_ascii=False))

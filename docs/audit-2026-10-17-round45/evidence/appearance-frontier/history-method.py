from pathlib import Path
import json,hashlib,datetime,re,subprocess
out=Path('/tmp/codeshell-audit-round53-appearance-settings')
first=json.loads((out/'initial-pins.json').read_text());fallback=json.loads((out/'fallback-pin.json').read_text());targets=[first['files'][0],fallback['files'][0]]
patterns={}
for index,row in enumerate(targets):
 tag='appearance' if index==0 else 'logs'
 patterns[tag+'-path']=re.compile(re.escape(row['path']),re.I)
 patterns[tag+'-filename']=re.compile(re.escape(Path(row['path']).name),re.I)
 patterns[tag+'-sha']=re.compile(re.escape(row['sha256']),re.I)
patterns['ordinary-appearance']=re.compile(r'(?:theme|主题|appearance|外观|font.?size|字号|line.?height|行高|zoom|缩放).{0,80}(?:save|保存|persist|持久|settings|设置|select|选择)|(?:save|保存|persist|持久|settings|设置|select|选择).{0,80}(?:theme|主题|appearance|外观|font.?size|字号|line.?height|行高|zoom|缩放)',re.I)
patterns['old-failed']=re.compile(r'(?:AppearanceSection|LogsView).{0,100}(?:fail|skip|失败|跳过)',re.I)
exclude={f'audit-2026-10-17-round{i}' for i in range(44,54)}
paths=sorted(p for p in subprocess.run(['rg','--files','docs','bugs'],capture_output=True,text=True,check=True).stdout.splitlines() if Path(p).suffix.lower() in ['.md','.json'] and not any(part in exclude for part in Path(p).parts))
counts={k:0 for k in patterns};hits={k:[] for k in patterns};cap={k:(80 if k in ['ordinary-appearance','old-failed'] else 160) for k in patterns};inventory=[];objects=[];errors=[];totals={'files':len(paths),'markdown':0,'json':0,'jsonStrings':0,'jsonScalars':0,'exactArchivePaths':0}
def scalar(v,p,loc):
 text=v if isinstance(v,str) else json.dumps(v,ensure_ascii=False)
 for k,r in patterns.items():
  if r.search(text):
   counts[k]+=1
   if len(hits[k])<cap[k]:hits[k].append({'path':p,'location':loc,'excerpt':text[:2600]})
def visit(v,p,loc):
 if isinstance(v,dict):
  if any(isinstance(v.get(key),str) and any(v[key]==t['path'] or v[key].endswith('/'+t['path']) for t in targets) for key in ['path','file','source','sourcePath']):objects.append({'path':p,'location':loc,'object':v})
  for k,x in v.items():visit(x,p,loc+'['+json.dumps(k)+']')
 elif isinstance(v,list):
  for i,x in enumerate(v):visit(x,p,loc+'['+str(i)+']')
 else:
  totals['jsonScalars']+=1
  if isinstance(v,str):totals['jsonStrings']+=1
  scalar(v,p,loc)
for p in paths:
 b=Path(p).read_bytes();inventory.append({'path':p,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
 if any(part.casefold() in ['archive','_archive'] for part in Path(p).parts):totals['exactArchivePaths']+=1
 if Path(p).suffix.lower()=='.md':
  totals['markdown']+=1
  for n,s in enumerate(b.decode().splitlines(),1):scalar(s,p,str(n))
 else:
  totals['json']+=1
  try:visit(json.loads(b),p,'$')
  except Exception as e:errors.append({'path':p,'error':type(e).__name__,'message':str(e)})
inventorySha=hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest()
d={'capturedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rootReportedBaseline':first['rootReportedBaseline'],'gitBindingVerified':False,'scope':{'roots':['docs','bugs'],'includeFrozenThrough':43,'excludedExactRoundDirectories':list(range(44,54)),'requestedMutableFutureExclusions':[44,52,53],'archivesIncluded':True,'method':'MD text lines and recursively visited JSON scalar values; keys not searched; original full/scope/review objects preserved. No product evaluation.'},'totals':totals,'parseErrors':errors,'patterns':{k:r.pattern for k,r in patterns.items()},'counts':counts,'cap':cap,'retained':{k:len(v) for k,v in hits.items()},'hits':hits,'directSourceObjects':objects,'inventory':inventory,'inventoryCanonicalSha256':inventorySha,'limits':['Caps/retained are navigation, not semantic exhaustion; no full/never-read inference from missing rows or hash binding.','Dated file-by-file inventory, not an independently Git-frozen snapshot.'],'productExecution':0,'gitCommands':0}
(out/'history.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'totals':totals,'counts':counts,'retained':d['retained'],'objects':len(objects),'parseErrors':errors},ensure_ascii=False))

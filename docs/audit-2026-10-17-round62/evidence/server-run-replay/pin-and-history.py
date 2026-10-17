from pathlib import Path
import hashlib,json,datetime,re,io,contextlib,traceback,subprocess
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
P=Path('/tmp/codeshell-audit-round167-server-run-replay')
TARGETS=['packages/server/src/hub/run-replay.ts','packages/server/src/session-http-responses.ts']
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def scalars(value,pointer=''):
 if isinstance(value,dict):
  for k,v in value.items():yield from scalars(v,pointer+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(value,list):
  for i,v in enumerate(value):yield from scalars(v,pointer+'/'+str(i))
 else:yield pointer,value
def main():
 pins=[]
 for rel in TARGETS+['CODESHELL.md','AGENTS.md']:
  b=(R/rel).read_bytes()
  pins.append({'path':rel,'bytes':len(b),'sha256':h(b),'lines':b.count(b'\n')+int(bool(b) and not b.endswith(b'\n')),'pinAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'beforeBodyAndLineNavigation':True,'role':'target-before-body' if rel in TARGETS else 'instruction-hash-reuse'})
 save('initial-pins.json',{'files':pins})
 patterns=TARGETS+[r['sha256'] for r in pins if r['path'] in TARGETS]
 inventory=subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,text=True,capture_output=True)
 save('history-inventory-tool.json',{'args':['rg','--files','docs','bugs','-g','*.md','-g','*.json'],'exitCode':inventory.returncode,'stderr':inventory.stderr})
 assert inventory.returncode==0
 paths=sorted(set(inventory.stdout.splitlines()))
 paths=[x for x in paths if not any(int(m)>=62 for m in re.findall(r'audit-[^/]*?-round(\d+)',x))]
 hits=[]; metadata=[]; errors=[]; counts={target:0 for target in TARGETS}; cap=80; retained={target:[] for target in TARGETS}; scalar_count=0
 for rel in paths:
  b=(R/rel).read_bytes();metadata.append({'path':rel,'bytes':len(b),'sha256':h(b)})
  text=b.decode('utf-8')
  if rel.endswith('.json'):
   try:
    values=list(scalars(json.loads(text)))
   except Exception as exc:errors.append({'path':rel,'error':repr(exc)});continue
  else:values=[('/line/'+str(i),s) for i,s in enumerate(text.splitlines(),1)]
  for pointer,value in values:
   scalar_count+=1
   if not isinstance(value,str):continue
   for target in TARGETS:
    digest=next(r['sha256'] for r in pins if r['path']==target)
    if target in value or digest in value or Path(target).name in value:
     counts[target]+=1
     record={'path':rel,'pointer':pointer,'value':value,'matchedCurrentSHA':digest in value}
     if len(retained[target])<cap:retained[target].append(record)
 save('history-inventory.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'docs/bugs MD and recursive JSON values, archives included, formal62+ excluded; machine navigation only','files':metadata})
 save('history-navigation.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'counts':counts,'capPerTarget':cap,'retainedCounts':{k:len(v) for k,v in retained.items()},'hits':retained,'errors':errors,'inventoryDocuments':len(metadata),'scalarValuesVisited':scalar_count,'MDLineAndJSONValueNavigationOnly':True,'sourceSemanticsRead':0})
 print(json.dumps({'pins':pins,'historyDocuments':len(metadata),'valuesVisited':scalar_count,'counts':counts,'cap':cap,'errors':errors},ensure_ascii=False,indent=2))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'pin-history-first.stdout').write_text(out.getvalue());(P/'pin-history-first.stderr').write_text(err.getvalue())
save('pin-history-first.exit.json',{'exitCode':code,'method':'pin-and-history.py','sha256':h(Path(__file__).read_bytes()),'scope':'Own metadata navigation only; no product import/evaluation'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

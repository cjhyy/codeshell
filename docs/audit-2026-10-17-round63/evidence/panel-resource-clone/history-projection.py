from pathlib import Path
import json,hashlib,io,contextlib,traceback,datetime
P=Path('/tmp/codeshell-audit-round170-panel-resource-clone');S=Path('/tmp/codeshell-audit-round171-coverage62/history-batch.json')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def main():
 b=S.read_bytes();save('shared-history-pin.json',{'path':str(S),'bytes':len(b),'sha256':h(b),'beforeParse':True,'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 j=json.loads(b)
 print('TOPKEYS',list(j))
 for key,value in j.items():
  if isinstance(value,dict): print('DICT',key,'KEYS',list(value)[:25])
  elif isinstance(value,list): print('LIST',key,'LEN',len(value))
  else: print('SCALAR',key,str(value)[:200])
 selected={}
 for key,value in j.items():
  if isinstance(value,dict):
   for k,v in value.items():
    if any(term in k.lower() for term in ['clone','resource-storage','resource-director','resourcestorage','resourcedirector']):selected[k]=v
 save('shared-target-projection.initial.json',{'scope':'Machine navigation only, actual canonical reads recorded later','selected':selected})
 print('PROJECTED',list(selected))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'history-first.stdout').write_text(out.getvalue());(P/'history-first.stderr').write_text(err.getvalue())
save('history-first.exit.json',{'exitCode':code,'method':'history-projection.py','sha256':h(Path(__file__).read_bytes()),'scope':'Shared metadata projection only'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

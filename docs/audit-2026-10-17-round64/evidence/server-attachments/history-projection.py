from pathlib import Path
import json,hashlib,datetime,contextlib,io,traceback
P=Path('/tmp/codeshell-audit-round174-server-attachments');S=Path('/tmp/codeshell-audit-round175-settings-flags/history-batch.json')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def main():
 b=S.read_bytes();save('shared-history-pin.json',{'path':str(S),'bytes':len(b),'sha256':h(b),'beforeParse':True,'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 j=json.loads(b);targets=[r['path'] for r in json.loads((P/'initial-pins.json').read_text())['files'] if r['path'].endswith('.ts')]
 out={'sharedPath':str(S),'sharedSHA256':h(b),'historyFiles':j['historyFiles'],'excludedFormalAtOrAbove':j['excludedFormalAtOrAbove'],'capPerTarget':j['capPerTarget'],'counts':{t:j['counts'][t] for t in targets},'hits':{t:j['hits'][t] for t in targets},'errors':j['errors'],'scope':'Target path/SHA machine navigation only; not historical semantic reading'}
 save('shared-target-projection.json',out)
 for target in targets:
  print('TARGET',target,'COUNT',j['counts'][target],'RETAINED',len(j['hits'][target]))
  grouped={}
  for hit in j['hits'][target]:grouped.setdefault(hit['document'],[]).append(hit['location'])
  for path,locators in grouped.items():
   if any(s in path for s in ['coverage','inventory','source-git-bindings','evidence-index','copy-receipt']):continue
   print(path,locators)
 print('ERRORS',j['errors'])
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'history-first.stdout').write_text(out.getvalue());(P/'history-first.stderr').write_text(err.getvalue())
save('history-first.exit.json',{'exitCode':code,'method':'history-projection.py','sha256':h(Path(__file__).read_bytes()),'scope':'Shared metadata projection only'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

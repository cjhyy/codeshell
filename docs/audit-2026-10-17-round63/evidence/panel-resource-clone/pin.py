from pathlib import Path
import json,hashlib,datetime,contextlib,io,traceback
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/tmp/codeshell-audit-round170-panel-resource-clone')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def main():
 files=[]
 for path in ['packages/server/src/panels/resources/clone.ts','packages/server/src/panels/resources/storage.ts','packages/server/src/panels/resources/directories.ts','CODESHELL.md','AGENTS.md']:
  b=(R/path).read_bytes();files.append({'path':path,'bytes':len(b),'sha256':h(b),'lines':b.count(b'\n')+int(bool(b) and not b.endswith(b'\n')),'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'beforeBodyAndLineNavigation':True,'role':'instruction hash reuse' if path in ['CODESHELL.md','AGENTS.md'] else 'target source before body'})
 save('initial-pins.json',{'files':files,'sourceSemanticsRead':0,'rootReportedBaselineOnly':'9874f8abdfce0ade5bb058d26e026b10f173a129','GitVerified':False})
 print(json.dumps(files,ensure_ascii=False,indent=2))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'pin-first.stdout').write_text(out.getvalue());(P/'pin-first.stderr').write_text(err.getvalue())
save('pin-first.exit.json',{'exitCode':code,'method':'pin.py','sha256':h(Path(__file__).read_bytes()),'scope':'Raw source byte/EOF/hash pins only'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

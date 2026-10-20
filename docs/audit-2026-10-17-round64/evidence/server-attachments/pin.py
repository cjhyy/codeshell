from pathlib import Path
import json,hashlib,datetime,io,contextlib,traceback
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/tmp/codeshell-audit-round174-server-attachments')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def main():
 rows=[]
 for path in ['packages/server/src/image-byte-probe.ts','packages/server/src/attachment-service.ts','packages/server/src/client-message-id.ts','CODESHELL.md','AGENTS.md']:
  b=(R/path).read_bytes();rows.append({'path':path,'bytes':len(b),'sha256':h(b),'lines':b.count(b'\n')+int(bool(b) and not b.endswith(b'\n')),'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'beforeBodyAndLineNavigation':True,'role':'instruction hash reuse' if path in ['CODESHELL.md','AGENTS.md'] else 'target source before body'})
 save('initial-pins.json',{'files':rows,'sourceSemanticsRead':0,'rootReportedBaselineOnly':'5fa6a076db90682733c33fd46e1f473f9214d196','GitVerified':False})
 print(json.dumps(rows,ensure_ascii=False,indent=2))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'pin-first.stdout').write_text(out.getvalue());(P/'pin-first.stderr').write_text(err.getvalue())
save('pin-first.exit.json',{'exitCode':code,'method':'pin.py','sha256':h(Path(__file__).read_bytes()),'scope':'Raw source byte/EOF/hash pins only'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

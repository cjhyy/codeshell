from pathlib import Path
import hashlib,json,datetime,io,contextlib,traceback
P=Path('/tmp/codeshell-audit-round163-coverage61')
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def main():
 first=json.loads((P/'current-source-inventory.json').read_text())['files']
 ending=[]
 for old in first:
  b=(R/old['path']).read_bytes()
  ending.append({'path':old['path'],'bytes':len(b),'sha256':h(b),'lines':b.count(b'\n')+int(bool(b) and not b.endswith(b'\n')),'unchanged':len(b)==old['bytes'] and h(b)==old['sha256']})
 metadata=[]
 for file in ['initial-metadata-pins.json','instruction-hash-pins.json']:
  for old in json.loads((P/file).read_text())['files']:
   b=(R/old['path']).read_bytes()
   metadata.append({'path':old['path'],'bytes':len(b),'sha256':h(b),'unchanged':len(b)==old['bytes'] and h(b)==old['sha256']})
 save('ending-source-inventory.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'role':'Raw bytes/EOF/hash only; no product source semantic reading','files':ending})
 save('ending-metadata-pins.json',{'files':metadata})
 result={'sourceHashRows':len(ending),'sourceUnchanged':sum(x['unchanged'] for x in ending),'metadataAndInstructionRows':len(metadata),'metadataAndInstructionUnchanged':sum(x['unchanged'] for x in metadata),'sourceSemanticReads':0,'Git':0,'productExecutions':0}
 save('ending-checks.json',result)
 assert all(x['unchanged'] for x in ending+metadata)
 print(json.dumps(result))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'ending-first.stdout').write_text(out.getvalue());(P/'ending-first.stderr').write_text(err.getvalue())
save('ending-first.exit.json',{'exitCode':code,'method':'ending.py','methodSHA256':h(Path(__file__).read_bytes()),'kind':'Metadata and raw byte ending check only'})
print(json.dumps({'exitCode':code,'stdout':out.getvalue(),'stderrBytes':len(err.getvalue())}))

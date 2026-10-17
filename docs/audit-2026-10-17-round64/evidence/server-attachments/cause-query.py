from pathlib import Path
import json,hashlib,re,datetime,contextlib,io,traceback
P=Path('/tmp/codeshell-audit-round174-server-attachments');R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def scalars(j,p=''):
 if isinstance(j,dict):
  for k,v in j.items():yield from scalars(v,p+'/'+str(k).replace('~','~0').replace('/','~1'))
 elif isinstance(j,list):
  for i,v in enumerate(j):yield from scalars(v,p+'/'+str(i))
 else:yield p,j
def main():
 pin=json.loads((P/'shared-history-pin.json').read_text());b=Path(pin['path']).read_bytes();assert h(b)==pin['sha256'];batch=json.loads(b)
 pattern=re.compile(r'cleanupAttachments|latestAttachmentState|DRAFT_ATTACHMENT_TTL_MS|SENT_ATTACHMENT_TTL_MS|(?:same|shared|dedup).{0,100}(?:file|path|attachment).{0,100}(?:TTL|expir|clean)|(?:共享|同.{0,10}(?:哈希|hash)).{0,100}(?:附件|文件).{0,100}(?:清理|过期|TTL)',re.I)
 hits=[];errors=[];drift=[];matched=0;cap=180;counts={}
 for old in batch['inventory']:
  rel=old['path'];data=(R/rel).read_bytes()
  if h(data)!=old['sha256']:drift.append({'path':rel,'before':old['sha256'],'current':h(data)})
  text=data.decode('utf-8')
  if rel.endswith('.json'):
   try:values=scalars(json.loads(text))
   except Exception as exc:errors.append({'path':rel,'error':repr(exc)});continue
  else:values=((i,s) for i,s in enumerate(text.splitlines(),1))
  for pointer,value in values:
   if not isinstance(value,str):continue
   m=pattern.search(value)
   if not m:continue
   matched+=1;counts[rel]=counts.get(rel,0)+1
   if len(hits)<cap:
    lo=max(0,m.start()-180);hi=min(len(value),m.end()+400)
    hits.append({'path':rel,'pointer':pointer,'value':value[lo:hi],'valueWindowStart':lo,'fullValueLength':len(value),'windowTruncated':lo>0 or hi<len(value)})
 save('cause-history.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'One finite shared-inventory query: MD lines and recursive JSON values, archive-inclusive, formal64+ absent; no source/fixture execution','pattern':pattern.pattern,'inventoryDocuments':len(batch['inventory']),'totalMatches':matched,'cap':cap,'retained':len(hits),'matchedDocumentCounts':counts,'hits':hits,'errors':errors,'metadataDrift':drift,'machineNavigationOnly':True})
 print(json.dumps({'documents':len(batch['inventory']),'totalMatches':matched,'retained':len(hits),'cap':cap,'errors':errors,'drift':drift,'matchedDocuments':list(counts)},ensure_ascii=False,indent=2))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'cause-first.stdout').write_text(out.getvalue());(P/'cause-first.stderr').write_text(err.getvalue())
save('cause-first.exit.json',{'exitCode':code,'method':'cause-query.py','sha256':h(Path(__file__).read_bytes()),'scope':'Own one targeted historical metadata query, not source/fixture/product runtime'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

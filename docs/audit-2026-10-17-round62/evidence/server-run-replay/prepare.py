from pathlib import Path
import json,hashlib,datetime,io,contextlib,traceback
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
P=Path('/tmp/codeshell-audit-round167-server-run-replay')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def merge(rs):
 out=[]
 for lo,hi in sorted(rs):
  if out and lo<=out[-1][1]+1:out[-1][1]=max(out[-1][1],hi)
  else:out.append([lo,hi])
 return out
def total(rs):return sum(b-a+1 for a,b in merge(rs))
def main():
 start=json.loads((P/'initial-pins.json').read_text())['files']
 dependent=json.loads((P/'dependent-source-pins.json').read_text())['files']
 pins={r['path']:r for r in start+dependent}
 replay='packages/server/src/hub/run-replay.ts';host='packages/server/src/serve/headless-server.ts';tests='packages/server/src/hub/run-replay.test.ts';http='packages/server/src/session-http-responses.ts'
 scopes={
 replay:{'coverage':'selected','selectedLineRanges':[[5,22],[24,27],[40,69],[108,146],[178,184],[188,206]],'bodyDisplayedLineRanges':[[1,206]],'additionalNavigationSnippetLineRanges':[],'scope':'Ordinary baseline/request set, event serialization and byte/event/global budget, cloned overlay/snapshot, sequence cursor and in-memory finish/forget/clear state only. OutputCoverage and persistence/proof/identity calls in displayed adjacent code are navigation boundaries, not full mechanism certification. OldR21 zero-baseline journal-anchor clipping remains excluded; no new unique/first coverage claim.','category':'product-selected'},
 host:{'coverage':'selected','selectedLineRanges':[[220,228],[239,240],[257,274],[382,415],[493,499],[975,985],[1166,1173],[1220,1229],[1235,1246],[1256,1263],[1473,1485],[1506,1517],[1559,1605]],'bodyDisplayedLineRanges':merge([[218,276],[480,507],[1202,1255],[1520,1616],[1466,1525],[378,421],[1158,1185],[1253,1277],[965,996]]),'additionalNavigationSnippetLineRanges':[[40,40],[317,317],[699,699],[1330,1330],[1346,1346]],'scope':'Actual ordinary worker-stream event projection -> publish/append -> outgoing cursor, accepted run baseline/begin/running fields, worker result/finish, agent/query local snapshot JSON. Authority/lease/enforcement, native bridge execution, output journal/store/file mechanics and cloud or account behavior shown adjacent are not certified. Prior R21 response-window overlap retained; source reading is not claimed unique.','category':'product-selected'},
 tests:{'coverage':'full','selectedLineRanges':[[1,109]],'bodyDisplayedLineRanges':[[1,109]],'additionalNavigationSnippetLineRanges':[],'scope':'Full existing7 unit-test declarations for normal prefix/overlay/cursor, overlapping request lifetime, missing session, bounds, clear, total budget and ownership. Source text only, never imported or executed; declared asserts are not observed results.','category':'test-declaration'}
 }
 semantic=[];capture=[]
 for path,scope in scopes.items():
  row=dict(pins[path]);row.update(scope)
  row['semanticFull']=row['coverage']=='full'
  row['newUniqueCoverageClaim']=False
  row['semanticLineCount']=total(row['selectedLineRanges'])
  row['bodyDisplayedLineCount']=total(row['bodyDisplayedLineRanges'])
  row['displayedLineRanges']=merge(row['bodyDisplayedLineRanges']+row['additionalNavigationSnippetLineRanges'])
  row['displayedLineCount']=total(row['displayedLineRanges'])
  assert total(row['displayedLineRanges']+row['selectedLineRanges'])==row['displayedLineCount']
  assert all(1<=a<=b<=row['lines'] for a,b in row['displayedLineRanges']+row['selectedLineRanges'])
  semantic.append(row)
  text=(R/path).read_text().splitlines()
  assert len(text)==row['lines']
  for a,b in row['selectedLineRanges']:capture.append({'path':path,'range':[a,b],'text':'\n'.join(text[a-1:b]),'captureTiming':'After actual displayed semantic range read; no new coverage'})
 save('source-excerpts.json',{'scope':'Only already-displayed explicitly semantic ranges','files':capture})
 canon=json.loads((P/'canonical-metadata-pins.json').read_text())['files']
 ending=[]
 for old in start+dependent+canon:
  b=(R/old['path']).read_bytes();ending.append({'path':old['path'],'bytes':len(b),'sha256':h(b),'unchanged':len(b)==old['bytes'] and h(b)==old['sha256']})
 assert all(r['unchanged'] for r in ending)
 history=json.loads((P/'history-inventory.json').read_text())['files']
 drift=[]
 for old in history:
  b=(R/old['path']).read_bytes()
  if len(b)!=old['bytes'] or h(b)!=old['sha256']:drift.append({'path':old['path'],'beforeBytes':old['bytes'],'beforeSHA256':old['sha256'],'endingBytes':len(b),'endingSHA256':h(b)})
 save('ending.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceInstructionCanonicalPins':ending,'sourcePinsCount':len(start+dependent),'canonicalMetadataPinsCount':len(canon),'historyInventoryCount':len(history),'historyDrift':drift,'noGitOrProductExecution':True})
 old=json.loads((R/'docs/audit-2026-10-17-round23/evidence/root-source-manifest.json').read_text())['files'][0]
 save('old-coverage-gate.json',{'http':{'target':http,'currentSHA256':pins[http]['sha256'],'canonicalPath':'docs/audit-2026-10-17-round23/evidence/root-source-manifest.json','jsonPointer':'/files/0','originalObject':old,'disposition':'Same-SHA explicit full ordinary exploratory static reading; exclude target before body. No response cancellation/revocation/authority runtime certification.'},'runReplay':{'navigationOnlyStatus':'Mostly inventories and derived unknown classifications; neither unknown nor lack of full row establishes never-read.','sourceReadingDisposition':'Bounded selected ordinary data review, not first/full/new-unique certification.','oldCauseExcluded':'R21 native Hub new-session zero baseline slicing complete journal legacy base anchor; original quality-audit28-42 and README132-143 read. Old native/model/SSE tests not rerun.'}})
 product=sum(r['semanticLineCount'] for r in semantic if r['category']=='product-selected');test=sum(r['semanticLineCount'] for r in semantic if r['category']=='test-declaration')
 manifest={'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'role':'New bounded source review; prep163 metadata work supplies no source-review proof','rootReportedBaselineOnly':'d195788bc2c18cd85c81aea4a431ab29074df5cf','GitVerified':False,'files':semantic,'hashOnlyFiles':[dict(pins[http],scope='Old same-SHA full gate; no product body read this task')],'instructionHashOnly':[r for r in start if r['path'] in ['CODESHELL.md','AGENTS.md']],'metadataFiles':canon,'history':{'path':'history-navigation.json','scope':'Target path/currentSHA/filename only; recursive JSON values, MD lines, archives included, formal62+ excluded','documents':len(history),'machineNavigationNotSemanticHistoryRead':True,'actualWindows':'actual-history-windows.json'},'totals':{'semanticFiles':len(semantic),'fullProductFiles':0,'selectedProductFiles':2,'fullTestDeclarationFiles':1,'productSemanticLines':product,'testDeclarationLines':test,'semanticLines':product+test,'bodyDisplayedLines':sum(r['bodyDisplayedLineCount'] for r in semantic),'bodyPlusAdditionalNavigationDisplayedLines':sum(r['displayedLineCount'] for r in semantic),'hashOnlyProductFiles':1,'hashOnlyInstructions':2,'declaredExistingTests':7,'testsExecuted':0,'newUniqueCoverageClaim':False},'ending':'ending.json','sourceReadBoundary':'No authority, real native worker/file/journal/store/permission enforcement certification; imports/helper/functions/fixtures/tests/browser/network/Git never executed.'}
 save('source-manifest.json',manifest)
 save('classification.json',{'newFormal':[],'newCandidates':[],'newRelated':[],'counts':{'formal':0,'candidate':0,'related':0},'oldCauseExclusions':[{'id':'R21','cause':'New Hub session baseline0 clips a later durable journal legacy anchor during active run','disposition':'Known cause, no new ID or current runtime revalidation'}],'oldFullTargetExclusions':[http],'conclusion':'No additional ordinary mismatch established in selected range. Not a whole-module, HTTP system, authority or all-history no-bug assertion.'})
 save('validation.json',{'productImports':0,'productHelpers':0,'fixtures':0,'testsExecuted':0,'declaredTestsRead':7,'UI':0,'timerOrClockExperiments':0,'native':0,'models':0,'network':0,'Git':0,'sourceRepairs':0,'oldDynamicFailureDirections':'SKIP; no NDJSON/timer, SSE/UTF8, native/model reattempt','metadataMethodsOnly':['pin-and-history.py','prepare.py'],'scope':'Static text and metadata processing; source assertions are not test passes'})
 print(json.dumps({'totals':manifest['totals'],'sourceEndingPins':len(ending),'sourceInstructionCanonicalUnchanged':True,'historyInventory':len(history),'historyDrift':drift},ensure_ascii=False,indent=2))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'prepare-first.stdout').write_text(out.getvalue());(P/'prepare-first.stderr').write_text(err.getvalue())
save('prepare-first.exit.json',{'exitCode':code,'method':'prepare.py','sha256':h(Path(__file__).read_bytes()),'kind':'Own metadata/capture/ending method, no product execution'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

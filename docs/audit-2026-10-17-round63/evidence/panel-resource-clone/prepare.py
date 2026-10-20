from pathlib import Path
import json,hashlib,datetime,contextlib,io,traceback
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');P=Path('/tmp/codeshell-audit-round170-panel-resource-clone')
def h(b):return hashlib.sha256(b).hexdigest()
def save(n,j):(P/n).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def merge(rs):
 out=[]
 for a,b in sorted(rs):
  if out and a<=out[-1][1]+1:out[-1][1]=max(out[-1][1],b)
  else:out.append([a,b])
 return out
def count(rs):return sum(b-a+1 for a,b in merge(rs))
def main():
 pins=[]
 for n in ['initial-pins.json','dependency-pins.json','consumer-pins.json']:pins+=json.loads((P/n).read_text())['files']
 by={r['path']:r for r in pins};pre='packages/server/src/panels/resources/'
 scopes={
 pre+'clone.ts':('full',[[1,114]],[[1,114]],[], 'Static entire stageResourceClone algorithm: normal eligibility/undefined fallback, staged content path, field identity comparisons, native/copy call arguments and callbacks, post-copy checks, return handle/path/verify/close and cleanup/error ordering. No execution or certification of real cp/reflink, filesystem replacement or permission enforcement.'),
 pre+'storage.ts':('full',[[1,112]],[[1,112]],[], 'Static entire scope-key/path mapping and JSON serialization/read/write budget/temporary-publication/cleanup algorithms. Includes the unpromoted exact-budget-plus-LF boundary. No real storage, crash atomicity, lock or permission guarantee validated.'),
 pre+'directories.ts':('full',[[1,119]],[[1,119]],[], 'Static entire relative-path validation, path components, held-directory loop, dev/ino comparisons, verification/close callbacks and returned name/path/location fields. Does not certify actual grant authority, OS file-descriptor or symlink enforcement.'),
 pre+'types.ts':('full',[[1,29]],[[1,29]],[], 'Full static ResourceAsset/stable ID and ExternalResourceReference compatibility field contracts; trusted Host comment is not enforcement proof.'),
 pre+'service.ts':('selected',[[17,380],[421,478]],[[1,380],[395,497]],[[6,6]], 'Normal configured service, shape and directory routing, managed/external get dispatch, actual materialize/capture algorithms and public dispatch/error mapping. Native/authority/provider callee guarantees, external-reference implementation, upload implementation and unread read-chunk method are not certified.'),
 pre+'library.ts':('selected',[[84,140],[165,390],[411,423]],[[84,140],[165,426]],[[9,9],[57,57],[64,64],[71,71],[142,142],[451,451],[453,453],[500,502]], 'Actual identity field and ID=digest record validation, ordinary constructor/scoped storage path, import byte/hash/record and commit control flow, get and managed content resolve mapping. No real file import or whole library/openRead/range/authority certification.'),
 'packages/server/src/panels/tool-executor.ts':('selected',[[106,128],[229,254],[269,282]],[[106,138],[229,255],[263,285]],[[8,8],[32,32],[67,67],[259,259],[262,262],[493,493],[536,536],[605,605],[622,622]], 'Actual admitted ordinary resource assetId/path/access mapping and prepareInput copy -> awaited resources.materialize call with directory handle. Release callback routing read; no actual tool, authority, account, network or native execution.'),
 pre+'clone.test.ts':('selected',[[27,31]],[[1,84]],[], 'One ordinary cross-device undefined-fallback test declaration only. Other four platform/native/revocation/cancellation/symlink tests were displayed but not used as mechanism verification. No fixture/test imported or run.'),
 pre+'resources.test.ts':('selected',[[158,202]],[[158,202]],[[62,62],[94,94],[120,120],[127,128],[216,216],[225,225],[244,244],[259,259],[272,272],[275,275],[282,282],[289,289],[298,298],[302,302],[310,310],[335,335],[344,344],[350,350],[374,374],[414,414],[445,445],[488,488],[554,554],[559,559],[569,569],[579,579],[624,624],[637,637],[650,650],[654,654]], 'Selected normal materialize/capture record-return test fragment and its explicit expected assetId/path/bytes/digest fields. Remaining test title/call navigation is not semantic coverage or observed results; test and fixture execution0.')
 }
 files=[];excerpts=[]
 for path,(coverage,semantic,body,nav,purpose) in scopes.items():
  row=dict(by[path]);row.update({'coverage':coverage,'selectedLineRanges':merge(semantic),'bodyDisplayedLineRanges':merge(body),'additionalNavigationSnippetLineRanges':merge(nav),'scope':purpose,'semanticFull':coverage=='full','newUniqueCoverageClaim':False,'category':'test-declaration' if path.endswith('.test.ts') else 'product'})
  row['semanticLineCount']=count(semantic);row['bodyDisplayedLineCount']=count(body);row['displayedLineRanges']=merge(body+nav);row['displayedLineCount']=count(body+nav)
  assert count(body+nav+semantic)==row['displayedLineCount']
  assert all(1<=a<=b<=row['lines'] for a,b in row['displayedLineRanges']+row['selectedLineRanges'])
  if coverage=='full':assert row['selectedLineRanges']==[[1,row['lines']]]
  text=(R/path).read_text().splitlines();assert len(text)==row['lines']
  for a,b in row['selectedLineRanges']:excerpts.append({'path':path,'range':[a,b],'text':'\n'.join(text[a-1:b]),'capture':'After actual static range display/review; not new reading'})
  files.append(row)
 save('source-excerpts.json',{'files':excerpts})
 metadata=json.loads((P/'canonical-history-pins.json').read_text())['files']
 ending=[]
 for old in pins+metadata:
  b=(R/old['path']).read_bytes();ending.append({'path':old['path'],'bytes':len(b),'sha256':h(b),'unchanged':len(b)==old['bytes'] and h(b)==old['sha256']})
 assert all(r['unchanged'] for r in ending)
 shared=json.loads((P/'shared-history-pin.json').read_text());b=Path(shared['path']).read_bytes();shared_end={'path':shared['path'],'bytes':len(b),'sha256':h(b),'unchanged':len(b)==shared['bytes'] and h(b)==shared['sha256']};assert shared_end['unchanged']
 save('ending.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':ending,'sharedHistory':shared_end,'sourceInstructionPins':len(pins),'canonicalMetadataPins':len(metadata),'noWholeHistoryEndingClaim':True})
 originals=[]
 j=json.loads((R/metadata[1]['path']).read_text())
 for i,row in enumerate(j['files']):
  if row.get('path') in [pre+'clone.ts',pre+'storage.ts',pre+'directories.ts']:originals.append({'path':metadata[1]['path'],'pointer':'/files/'+str(i),'originalObject':row,'disposition':'Path/bytes/lines/SHA inventory only, no full/selected review scope'})
 a=json.loads((R/metadata[2]['path']).read_text())
 for key in ['84740d56','a66f4ef2']:
  originals.append({'path':metadata[2]['path'],'pointer':'/module_inventory/'+key,'originalObject':a['module_inventory'][key],'disposition':'Original module inventory has paths/counts only, no explicit SHA-linked semantic full object'})
 save('canonical-old-gate.json',{'objects':originals,'scope':'No full prior record established in actually inspected target-specific canonical objects; not a proof of never-read status or all-cause novelty. Derived unknown/claims and inventory are not reused as source semantic proof.','actualMDMatchesInTargetNavigation':0})
 boundary={'id':None,'path':pre+'storage.ts','lines':[[66,76],[79,85],[91,92]],'observation':'cloneMediaJson accepts serialized JSON at MAX_MEDIA_JSON_BYTES, writeMediaJson appends LF, while readMediaJson bounds whole file bytes by that same MAX. At exact serialized4MiB, the hypothetical written file would be one byte over read bound.','notEstablishedCondition':'No normal producer in this reviewed capture/import/materialize closure was shown able to produce an exact-boundary4MiB metadata record. ResourceAsset is constructed from fixed ID/digest/byte/time fields and bounded ordinary name/MIME metadata. Other unreviewed callers are not declared globally unreachable.','disposition':'Not promoted; no bug ID, no candidate count, no hand-crafted DTO/fixture or function execution.'}
 save('classification.json',{'counts':{'formal':0,'candidate':0,'related':0},'findings':[],'candidates':[],'related':[],'notPromotedBoundary':[boundary],'rejectedPremise':'The private clone helper is not a public new-resource-ID operation. Existing assetId is intentionally returned after materialization.','limitedConclusion':'No new ordinary resource ID/path/directory/reference mismatch established in the reviewed producer-clone-consumer closure; not entire native/authority/OS correctness certification.'})
 product=[r for r in files if r['category']=='product'];tests=[r for r in files if r['category']=='test-declaration']
 totals={'semanticFiles':len(files),'fullProductFiles':sum(r['coverage']=='full' for r in product),'selectedProductFiles':sum(r['coverage']=='selected' for r in product),'selectedTestFiles':len(tests),'productSemanticLines':sum(r['semanticLineCount'] for r in product),'testDeclarationLines':sum(r['semanticLineCount'] for r in tests),'bodyDisplayedLines':sum(r['bodyDisplayedLineCount'] for r in files),'bodyPlusNavigationDisplayedLines':sum(r['displayedLineCount'] for r in files),'navigationOnlySourceFiles':1,'instructionHashOnly':2,'testsExecuted':0,'newUniqueCoverageClaim':False}
 nav=dict(by[pre+'http.ts']);nav.update({'coverage':'navigation-only','selectedLineRanges':[],'semanticLineCount':0,'displayedLineRanges':[[8,8]],'displayedLineCount':1,'scope':'Export-name search only; no HTTP serving body or behavior reviewed'})
 save('source-manifest.json',{'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'role':'New bounded source review, not proof supplied by prior metadata role','rootReportedBaselineOnly':'9874f8abdfce0ade5bb058d26e026b10f173a129','GitVerified':False,'files':files,'navigationOnlyFiles':[nav],'instructionHashOnly':[r for r in pins if r['path'] in ['CODESHELL.md','AGENTS.md']],'metadataFiles':metadata,'sharedHistoryPin':shared,'historyScope':'171 shared6669 MD/JSON archive-inclusive excluded63+, target51 each cap100 all retained; navigation is not full historical semantic reading','actualOldScopeGate':'canonical-old-gate.json','totals':totals,'fullMeaning':'Entire text statically reviewed for specified materialize/storage algorithms. Full does not imply observed FS/native/platform/authority success or security certification.','scopeEvolution':'Initial source inspection prioritized ordinary return fields. After explicit parent clarification, all345 target lines were deliberately reviewed for condition, identity comparison, copy, verify/close and cleanup control flow; no dynamic execution.','ending':'ending.json'})
 save('validation.json',{'productImports':0,'productHelpers':0,'fixtures':0,'testsExecuted':0,'native':0,'Host':0,'realResourceOrUserData':0,'model':0,'network':0,'Git':0,'sourceRepairs':0,'platformGuaranteesValidated':False,'testDeclarationsUsed':2,'testDeclarationBoundary':'Two selected ordinary test fragments, other native/security/platform/cancellation declarations are not pass results','permanentFailureDirections':'SKIP; no old dynamic retry','metadataFirstLogs':['pin-first.*','history-first.*','prepare-first.*']})
 print(json.dumps({'totals':totals,'endingSourceInstructionCanonicalPins':len(ending),'allUnchanged':True,'sharedHistorySame':True,'classification':'0/0/0'},ensure_ascii=False,indent=2))
out,err=io.StringIO(),io.StringIO();code=0
try:
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):main()
except BaseException:
 code=1;traceback.print_exc(file=err)
(P/'prepare-first.stdout').write_text(out.getvalue());(P/'prepare-first.stderr').write_text(err.getvalue())
save('prepare-first.exit.json',{'exitCode':code,'method':'prepare.py','sha256':h(Path(__file__).read_bytes()),'scope':'Metadata/excerpt capture/ending only, no product execution'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))

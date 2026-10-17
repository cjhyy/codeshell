from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round140-web-storage')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(x):return hashlib.sha256(x).hexdigest()
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def ns(rr):return {n for a,b in rr for n in range(a,b+1)}
def rr(n):
 z=[]
 for x in sorted(set(n)):
  if z and z[-1][1]+1==x:z[-1][1]=x
  else:z.append([x,x])
 return z
pins={}
for n in ['initial-pins.json','consumer-before-pins.json','hook-wrapper-before-pins.json']:
 for row in json.loads((O/n).read_text())['files']:pins[row['path']]=row
for n in ['name-producer-before-pin.json','mobile-consumer-before-pin.json']:
 row=json.loads((O/n).read_text());pins[row['path']]=row
P='packages/web/'
spec=[
 (P+'src/lib/storage.ts','product',[[9,13],[23,55]],[[1,57]],[],'Targeted ordinary persisted cs.* key/value flow and optional mint/name calls. Same-SHA old R5whole-file overlap, not first/new full. Browser storage/i18n/credential custody not executed or certified.'),
 (P+'src/lib/deviceCredential.ts','product',[[14,22]],[[1,22]],[],'32-octet input→lowercase hex formatting and actual caller only. Comment about server secretHash is not independently certified server auth. No entropy/native security conclusion. Prior hits are inventory metadata, not proof unread.'),
 (P+'src/lib/environment.ts','product',[[2,14],[16,32],[34,43]],[[1,43]],[],'Descriptor ordinary fields and tuple text encoding, with old R5/R18full overlap. No environment identity/auth mechanism certification. projectReferenceKey only tests/export found in this bounded scope; no user bug from arbitrary reference.'),
 (P+'src/hooks/useRemoteSocket.ts','product',[[3,6],[43,56],[76,84],[139,143],[153,185],[213,239]],[[1,90],[137,185],[199,239]],[],'Actual store get/set/clear and mint order, origin/ws target, pair/auth result ordinary branches. OldW10 two-read quota cause excluded; not full reconnect/liveness/auth/cleanup validation.'),
 (P+'app/environments.ts','product',[[3,11],[14,29],[31,67],[69,110]],[[1,110]],[],'Ordinary address normalization, bookmark key/limits/read/save/remove/descriptor comparison. Different key from deviceStore; comparison is client data logic, not identity enforcement.'),
 (P+'app/api-context.ts','product',[[17,39],[42,74]],[[1,74]],[],'Local scope setters/getters and ordinary API URL projection/control-plane path selection. Does not certify auth, project custody or server enforcement.'),
 (P+'app/EnvironmentMenu.tsx','product',[[14,35],[38,69],[79,92],[131,173]],[[1,101],[124,179]],[],'Actual load/edit/save-current/manual-submit/remove/go call order. Descriptor guard and errors only; no React/DOM/network/storage execution. go invokes supplied navigate or location.assign; only actual default Desktop instance selected, not every website adapter.'),
 (P+'app/WebsiteShell.tsx','navigation-only',[],[],[[5,5],[113,113],[129,129],[136,136]],'Navigation snippets only; no body or route/lifecycle semantics claimed.'),
 (P+'app/DesktopApp.tsx','product',[[24,32],[66,73]],[[24,44],[65,76]],[[1,1],[4,4],[7,7]],'Actual useRemoteApp call and EnvironmentMenu discover=false instance without navigate. Auth effect displayed boundary only.'),
 (P+'src/hooks/useRemoteApp.ts','product',[[1371,1377]],[[1365,1397]],[[30,30],[231,231]],'Actual hook composition only; surrounding resync/approval cleanup shown but not reviewed for correctness.'),
 (P+'src/index.ts','product',[[12,27]],[[10,29]],[],'Public exports connect mobile adapter import to wrapper/socket. No other exports activated.'),
 ('packages/desktop/src/mobile/App.tsx','product',[[6,6],[19,21]],[[1,23]],[[138,138],[208,208],[275,275]],'Actual Mobile App useRemoteApp caller; imports and type references only. No renderer/native/permission/UI evaluation.'),
 ('packages/server/src/environment-identity.ts','product',[[58,69]],[[57,69]],[[5,5]],'Only actual describeEnvironment ordinary name/entry fields: fixed short names. Rest of identity persistence/FS source not read. Does not prove all external hosts use this producer.'),
 (P+'src/lib/deviceCredential.test.ts','test-declaration',[[4,20]],[[1,20]],[],'Existing deterministic byte→hex and default crypto declarations; execution0, no native entropy observation.'),
 (P+'app/environments.test.ts','test-declaration',[[11,90]],[[1,90]],[],'Existing bookmark roundtrip/address/ref/invalid-storage declarations only; fixed IDs are test DTOs, not actual identity validation evidence.'),
]
rows=[];ex=[]
for path,kind,selected,body,nav,scope in spec:
 p=pins[path];b=(R/path).read_bytes();ls=b.decode().splitlines();shown=ns(body)|ns(nav);sem=ns(selected)
 assert sha(b)==p['sha256'];assert sem<=shown;assert min(shown)>=1 and max(shown)<=len(ls)
 rows.append({'path':path,'bytes':len(b),'sha256':sha(b),'lineCount':len(ls),'kind':kind,'coverage':'selected-static-purpose; not-full semantic review' if kind=='product' else 'selected-existing-test-declarations; execution0' if kind=='test-declaration' else 'navigation-only; semantic0','selectedLineRanges':selected,'selectedLineCount':len(sem),'bodyDisplayedLineRanges':body,'bodyDisplayedLineCount':len(ns(body)),'additionalNavigationSnippetLines':sorted(ns(nav)-ns(body)),'displayedLineRanges':rr(shown),'displayedLineCount':len(shown),'initialSha256':p['sha256'],'initialPinUTC':p['pinnedAtUTC'],'initialPinTiming':p['timing'],'originalPinRow':p,'scope':scope})
 ex.append(path+'\n'+'\n'.join(f'{n}: {ls[n-1]}' for n in sorted(shown)))
for path in ['CODESHELL.md','AGENTS.md']:
 p=pins[path];rows.append({'path':path,'bytes':p['bytes'],'sha256':p['sha256'],'lineCount':p['lineCount'],'kind':'instruction-reuse','coverage':'hash-only-this-packet; same-SHA prior instruction read reused','selectedLineRanges':[],'selectedLineCount':0,'bodyDisplayedLineRanges':[],'bodyDisplayedLineCount':0,'additionalNavigationSnippetLines':[],'displayedLineRanges':[],'displayedLineCount':0,'initialPinUTC':p['pinnedAtUTC'],'originalPinRow':p})
counts={'productSelectedRows':sum(x['kind']=='product' for x in rows),'productSelectedLines':sum(x['selectedLineCount'] for x in rows if x['kind']=='product'),'testDeclarationSelectedLines':sum(x['selectedLineCount'] for x in rows if x['kind']=='test-declaration'),'displayedSourceLines':sum(x['displayedLineCount'] for x in rows),'navigationOnlyRows':1,'instructionHashOnlyRows':2,'semanticFullRows':0,'sourceInstructionPins':len(pins),'runtimeAttempts':0};counts['selectedTotalLines']=counts['productSelectedLines']+counts['testDeclarationSelectedLines']
save('source-manifest.json',{'schema':'ordinary-value-static-selected/v1','createdAtUTC':now(),'rootReportedBaseline':'f31a847f45e4805bce34aeb9e6db7efb503cfcb0','gitCertified':False,'files':rows,'counts':counts,'rangeConvention':'One-based inclusive, body+navigation canonical union. Selected subset may include directly reviewed navigation. Repeated display once per file. Whole physical display does not promote semantic full/current auth review.','historyGateTiming':'Before product bodies, shared target navigation and exact R5/R18 canonical objects+bounded old MD were read. Selected current consumer rereads preserve old overlap, no no-row/unread claim or global count update.'})
(O/'source-excerpts.txt').write_text('\n\n'.join(ex)+'\n')
# Save exact canonical objects already personally read; only4 bounded original inputs.
old=json.loads((O/'prior-canonical-inputs.json').read_text());out=[]
for f in old['files']:
 if not f['path'].endswith('.json'):continue
 x=json.loads((R/f['path']).read_bytes())
 for pointer in f['selected']:
  z=x
  for part in pointer.strip('/').split('/'):z=z[int(part)] if isinstance(z,list) else z[part]
  out.append({'document':f['path'],'pointer':pointer,'row':z})
save('prior-canonical-decisions.json',{'objects':out,'decisions':{'storage':'R5 /sources9 sameSHA review whole-file, preserved old full overlap; targeted get/set/hook review rather than first coverage.','environment':'R5 /sources8 whole-file plusR18 /files2 full source read sameSHA; previous actual helper tests not rerun or borrowed as pass.','deviceCredential':'All28 target hits retained; printed provenance limited180characters per row. Navigated hits were inventory/coverage/raw filenames, not an original explicit semantic full object. This is not proof never read.','W10':'Original web-round3.md15–20 exact quota safeSet failure + pair-time secretA and pair.ok-time secretB. Current selected getter order samecause, excluded without new related item or dynamic retry.'},'historyLimits':'5850 dated MD/JSON, frozen57 included58+ excluded, recursiveJSONvalues inclarchive, keys excluded. Shared4251467 scalar visits are Root machine navigation not new reviewer semantic lines or per-reader summed runs.3targets39/28/87 allretained under cap100. First provenance preview limited1100characters per hit and later device180; exact original4bounded inputs are semantic prior reads, not all hits.'})
save('classification.json',{'formalFindings':[],'candidates':[],'relatedFindings':[],'counts':{'formal':0,'candidate':0,'newRelated':0},'existingCauseExclusions':[{'id':'W10','document':'docs/review-2026-10-12/web-round3.md','lines':[[15,20]],'cause':'safeSet failure leaves no cached secret; normal pair then auth reread may mint different secrets.','status':'Old cause only; no fix or actual browser observation in140.'}],'notPromoted':[{'lead':'bookmark name cap80 vs descriptor cap128','evidence':'isEnvironmentDescriptor accepts up to128; saveEnvironment validates<=80. Actual selected server describeEnvironment58–69 uses short fixed names.','decision':'No ordinary long-name producer or current required failing consumer established in finite scope. Not promoted, not a proof every external descriptor producer is short or every save correct. No arbitrary injected DTO or language/browser fixture used.'}],'limits':'Finite ordinary get/set/encoding/address/list/navigation-source review, not complete auth/credential security, storage failure recovery, all connection lifecycle or external environment contract verification.'})
save('diagnostics.json',{'metadataFailures':[],'productFailures':[],'runtimeAttempts':0,'testsExecuted':0,'gitCalls':0,'networkCalls':0,'firstInventoryRaw':'inventory.first.stdout/stderr/exit.json contain actual first filename command bytes, exit0.','normalNavigationNoMatch':[{'chunkId':'4b7563','combinedExit':1,'command':'rg -l useRemoteSocket packages/desktop/src packages/web/app -g*.tsx -g*.ts','meaning':'No direct socket caller in these two trees; no failed product run. Then filename inventory across packages found useRemoteApp wrapper. The preceding source excerpt command shared shell; its separate exit was not captured.','rawBytesArchived':False,'limitation':'Tool transcript remains original record; this description is not a synthetic raw stdout archive.'}],'presentationToolTruncations':[],'intentionalMetadataPreviewCaps':{'firstHistoryProvenanceCharactersPerHit':1100,'laterDeviceProvenanceCharactersPerHit':180,'fullTargetHitsSaved':'history-projection.json','meaning':'Preview caps not semantic reading of all retained values; canonical actual originals selected separately.'},'executionPolicy':'All Python is own stdlib filename/hash/range/JSON metadata. No old author method, product/helper/test module, crypto/Intl/URL/React/browser/localStorage/network operation executed. Failed historical mobile/i18n directions not retried.'})
ending=[]
for path,p in pins.items():
 b=(R/path).read_bytes();ending.append({'path':path,'bytes':len(b),'sha256':sha(b),'initialSha256':p['sha256'],'sameSha256':sha(b)==p['sha256']})
md=[]
for f in old['files']:
 b=(R/f['path']).read_bytes();md.append({'path':f['path'],'bytes':len(b),'sha256':sha(b),'initialSha256':f['sha256'],'sameSha256':sha(b)==f['sha256']})
f=json.loads((O/'shared-history-reference.json').read_text());b=Path(f['path']).read_bytes();md.append({'path':f['path'],'bytes':len(b),'sha256':sha(b),'initialSha256':f['sha256'],'sameSha256':sha(b)==f['sha256']})
assert all(x['sameSha256'] for x in ending+md)
save('ending.json',{'atUTC':now(),'sourceInstructionChecks':ending,'all17SourceInstructionPinsSameSHA':len(ending)==17,'boundedMetadataChecks':md,'all5BoundedMetadataInputsSameSHA':len(md)==5,'allComparedSameSHA':True,'scope':'Not Git certification or independent rehash/review of all5850 history files.4 exact originals+shared frozen JSON only.'})
report=f'''# Web storage 与环境书签：有限静态审查

**0 正式 / 0 候选 / 0 新关联**；旧W10精确因果排除1项，不重复登记。产品/helper/测试/React/浏览器/真实localStorage/crypto/网络/native及Git执行均0，未改产品。

[范围清单](source-manifest.json)与[摘录](source-excerpts.txt)保留普通生产链：mobile App与Web DesktopApp实际调用useRemoteApp，后者接useRemoteSocket；hook按当前origin建立/ws，读取deviceStore固定cs.*键，并调用32字节→小写hex的generateSecret。pair.ok写新deviceId后再次读取secret再发auth。这仍符合旧 [W10 原因](prior-canonical-decisions.json)：setItem配额失败没有内存缓存时两次mint可能不同；本次不重新复现、不发布新问题，也不把best-effort注释当恢复正确性证明。server secretHash比较这里只读注释，不冒充认证机制复核。

环境书签使用独立codeshell.environments.v1键，地址规范到origin+入口路径；save按规范地址替换、保留已保存environmentId且最多32条，remove使用同一地址转换。真实Menu捕获读写异常、接保存当前/手动表单/删除，go交给navigate或location.assign；所读Desktop实例不传navigate。API scope URL投影只做客户端字符串分支核对，不由它认证跨环境权限、cookie/credential隔离、Host identity或迁移正在运行的job。projectReferenceKey不以任意合法形状的无真实生产者输入凑新缺陷。

一个长度差异仅作未晋升线索：descriptor上限128，书签名称上限80；所读server describeEnvironment58–69生产固定短名，尚未建立普通长名称的实际生产者/应成功保存的错误consumer，故不列候选。这不等于所有外部descriptor都短或整个表单正确。

门槛在正文前完成：R5原/sources8、9同SHA whole-file分别覆盖environment/storage；R18原/files2与MD限定再次确认environment full source read。此次定向旧重叠不称首次/新唯一全文；deviceCredential的28命中是库存类线索，没有据此认定未读。 [原输入](prior-canonical-inputs.json)与[共享导航投影](history-projection.json)记录5850 MD/JSON（含冻57排58+）、recursiveJSON values与archives、4251467机器标量访问，三目标39/28/87命中全部保存；机器访问不作本review语义阅读数或重复加总。实际只亲读4份原canonical/MD的限定窗口。

当前12产品selected **{counts['productSelectedLines']}**行、2既有测试声明selected **{counts['testDeclarationSelectedLines']}**行（执行0），合计{counts['selectedTotalLines']}，display union **{counts['displayedSourceLines']}**；WebsiteShell仅导航，指令同SHA沿用。物理全显示与外部机制边界不升级semantic full或全局覆盖。 [diagnostics](diagnostics.json)保留首次实际库存raw exit0及一次正常空匹配exit1，未重开历史mobile/i18n失败方向；[ending](ending.json)17源码/指令pin与5限定元数据输入SHA均同，不冒称重核全5850库存。见 [自排除收据](artifact-receipt.json)。
'''
(O/'report.md').write_text(report)
links=re.findall(r'\[[^\]]*\]\(([^)]+)\)',report);assert all((O/x).exists() or x=='artifact-receipt.json' for x in links)
save('metadata-checks.json',{'kind':'Own stdlib metadata consistency only; not product/tests validation','atUTC':now(),'sourceRows':len(rows),'sourceInstructionPins':len(pins),'canonicalDisplayUnion':True,'selectedSubsetOfDisplayedAndWithinEOF':True,'endingAllComparedSameSHA':True,'reportLinks':links,'reportLinkCount':len(links),'receiptSelfLinkWillExist':True})
print(json.dumps({'counts':counts,'links':len(links),'sourcePins':len(pins),'boundedMetadataInputs':len(md)},ensure_ascii=False))

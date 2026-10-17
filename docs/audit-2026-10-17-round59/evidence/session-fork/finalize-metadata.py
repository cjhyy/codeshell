from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round146-session-fork')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def ns(rr):return {n for a,b in rr for n in range(a,b+1)}
def spans(xs):
 out=[]
 for n in sorted(set(xs)):
  if out and out[-1][1]+1==n:out[-1][1]=n
  else:out.append([n,n])
 return out
pins={}
for n in ['initial-pins.json','caller-test-before-pins.json']:
 for x in json.loads((O/n).read_text())['files']:pins[x['path']]=x
x=json.loads((O/'serializer-before-pin.json').read_text());pins[x['path']]=x
C='packages/core/src/'
spec=[
 (C+'session/session-manager.ts','product',[[302,325],[341,366],[2137,2233],[2235,2333],[2335,2351],[2477,2544],[2546,2566]],[[302,366],[2110,2405],[2477,2576]],[],'Concrete full/summary/completed-side source window, lineage/state/transcript data and copy policy. clone/remap/freeze/publication ordering reviewed; FS/native staging/locks/custody and complete tool validator not certified. Native publish body and list/state unrelated blocks are displayed boundaries only.'),
 (C+'session/transcript.ts','product',[[368,401],[883,891],[1154,1182]],[[368,406],[875,901],[1154,1237]],[[3,3],[234,234],[251,251],[582,582],[653,653],[695,695],[1122,1122],[1135,1135]],'Inclusive range clone and pair-validation call, context_transfer background projection, copied-prefix note/checkpoint reference remap. Loader/repair/native fallback source only displayed boundary, no whole transcript correctness claim.'),
 (C+'engine/engine.ts','product',[[1281,1308],[1319,1324],[1325,1339],[1341,1346],[1383,1409],[1417,1424]],[[1274,1442]],[],'Actual SessionManager delegations; selected normal textual package/portable serializer, aux request with signal and nonempty return before publication. Large-fragment token fitting, model/cost/config restore details displayed but not globally validated; no provider/model execution.'),
 (C+'protocol/server.ts','product',[[1396,1417],[1418,1497],[1512,1557],[1559,1649]],[[1390,1650]],[],'Actual fork RPC branch full/summary/side data inputs and response; summary selection before call before publication, busy check and exclusive call visible. Not certification of runExclusive implementation, protocol authorization, locks or session custody.'),
 (C+'context/compaction.ts','product',[[891,944],[946,968]],[[885,968]],[[998,998]],'Only actual portable context-package recursive serializer retaining nested text/results, explicit image metadata; differs from old ordinary compaction CTX2. No reread of old snip/ordinary compaction mechanism or global context full claim.'),
 (C+'session/session-manager.context-transfer.test.ts','test-declaration',[[15,54]],[[1,55]],[],'Existing summary-only target/background declarations. No test or FS fixture executed or historical pass borrowed.'),
 (C+'session/session-manager.side-fork.test.ts','test-declaration',[[19,79],[194,213]],[[19,80],[194,214]],[[81,81],[111,111],[126,126],[144,144],[179,179]],'Existing ordinary completed snapshot/clone independence/reset goal declarations. Source fixture writes and cleanup not executed. Other test titles navigation only.'),
 (C+'protocol/server.fork.test.ts','navigation-only',[],[],[[95,95],[146,146],[184,184],[245,245],[275,275],[303,303],[330,330],[400,400],[427,427]],'Test title inventory only;0body/0semantic, not claimed as tests read or run.'),
 (C+'engine/engine.session-fork-history.test.ts','navigation-only',[],[],[[38,38],[107,107],[162,162],[205,205]],'Test title inventory only;0body/0semantic. No fixture import, no Engine run.'),
]
rows=[];ex=[]
for path,kind,sel,body,nav,scope in spec:
 p=pins[path];b=(R/path).read_bytes();ls=b.decode().splitlines();sem=ns(sel);shown=ns(body)|ns(nav)
 assert sha(b)==p['sha256'];assert sem<=shown;assert min(shown)>=1 and max(shown)<=len(ls)
 rows.append({'path':path,'bytes':len(b),'sha256':sha(b),'lineCount':len(ls),'kind':kind,'coverage':'targeted-static-selected; not-new-full' if kind=='product' else 'selected-existing-test-declarations; execution0' if kind=='test-declaration' else 'navigation-only;semantic0;body0','selectedLineRanges':sel,'selectedLineCount':len(sem),'bodyDisplayedLineRanges':body,'bodyDisplayedLineCount':len(ns(body)),'additionalNavigationSnippetLines':sorted(ns(nav)-ns(body)),'displayedLineRanges':spans(shown),'displayedLineCount':len(shown),'initialSha256':p['sha256'],'initialPinUTC':p['pinnedAtUTC'],'initialPinTiming':p['timing'],'originalPinRow':p,'scope':scope})
 ex.append(path+'\n'+'\n'.join(f'{n}: {ls[n-1]}' for n in sorted(shown)))
for path in ['CODESHELL.md','AGENTS.md']:
 p=pins[path];rows.append({'path':path,'bytes':p['bytes'],'sha256':p['sha256'],'lineCount':p['lineCount'],'kind':'instruction-reuse','coverage':'hash-only-this-packet; sameSHA prior full instructions reused','selectedLineRanges':[],'selectedLineCount':0,'bodyDisplayedLineRanges':[],'bodyDisplayedLineCount':0,'additionalNavigationSnippetLines':[],'displayedLineRanges':[],'displayedLineCount':0,'initialPinUTC':p['pinnedAtUTC'],'originalPinRow':p})
counts={'productSelectedRows':5,'productSelectedLines':sum(x['selectedLineCount'] for x in rows if x['kind']=='product'),'testDeclarationSelectedLines':sum(x['selectedLineCount'] for x in rows if x['kind']=='test-declaration'),'displayedSourceLines':sum(x['displayedLineCount'] for x in rows),'testTitleNavigationOnlyRows':2,'instructionHashOnlyRows':2,'sourceInstructionPins':len(pins),'semanticFullRows':0,'testsExecuted':0,'runtimeAttempts':0};counts['selectedTotalLines']=counts['productSelectedLines']+counts['testDeclarationSelectedLines']
save('source-manifest.json',{'schema':'fork-data-targeted-static-review/v1','atUTC':now(),'rootReportedBaseline':'c39eb6f987b7bd5d740fee6d8ab5b46718f9c9af','gitCertified':False,'files':rows,'counts':counts,'rangeConvention':'One-based inclusive; display canonical union body+navigation. Selected subset, repeated displays once. No whole-file/new unique semantic coverage or native/custody correctness certification from a hash or complete display.','historyGate':'ExactR9/R32 original source objects and oldR9/CTX MD examined before product bodies. Older manager SHA935b differs current3a0; transcript sameSHA pin alone not explicit full. Shared609/548 matches capped100 each means not exhaustive canonical/full inventory.'})
(O/'source-excerpts.txt').write_text('\n\n'.join(ex)+'\n')
# Earlier old-MD keyword navigation had no before-read hash: keep late/null, not an invented initial pin.
nav={
'docs/review-2026-10-12/session-operations-round17.md':[],
'docs/review-2026-10-12/session-actions-round13.md':[],
'docs/review-2026-10-12/context-recovery-round17.md':[7,11,15,17,20],
'docs/review-2026-10-12/session-continuation-round26.md':[9,11,13,18,25,27],
}
a=[]
for path,lines in nav.items():
 b=(R/path).read_bytes();a.append({'path':path,'bytes':len(b),'sha256':sha(b),'lineCount':len(b.splitlines()),'initialSha256':None,'hashTiming':'Late after earlier metadata keyword navigation; not backfilled before-read pin','navigationDisplayedLines':lines,'wholeFileSemanticRead':False})
save('prior-navigation-late.json',{'files':a,'purpose':'Original bounded fork/alignment/cancellation-design context only, no old runtime pass borrowed. Empty displayed line list means keyword search produced no visible match, not semantic whole read.','atUTC':now()})
save('classification.json',{'formalFindings':[],'candidates':[],'relatedFindings':[],'counts':{'formal':0,'candidate':0,'newRelated':0},'decision':'Finite negative for normal full/summary/completed-side data chain. No new ordinary producer→consumer counterexample established; not whole-session correctness.','knownCauseExclusions':[{'id':'SESSION-R9-01','directOriginal':'docs/audit-2026-10-17-round9/session.md5–17','cause':'Provider tool batch above live cap leaves persisted unmatched tool_use and rejects full fork; not re-reported/tested.'},{'id':'CTX-1','directOriginal':'docs/audit-2026-10-17-round4/context.md7–17','cause':'Ordinary fallback snip prefix splits successful tool round; not re-reported or retested.'},{'id':'CTX-2','directOriginal':'docs/audit-2026-10-17-round4/context.md19–29','cause':'Normal compaction/archival summary drops structured result text. This fork path uses distinct portable serializer which recursively keeps it; no new CTX2 clone.'}],'otherOldReferencesOnly':'R9 explicitly points old M1 is_error replay and July synthetic-duplicate fork issue. Those exact original July records were not reread here or revalidated; no new issue based on arbitrary unmatched tools/changed IDs or any old failed dynamic route.','normalScope':['Full fork has inclusive frozen cursor and explicit event policy, new event IDs, copied-prefix context reference remap.','Side protocol selects completed snapshot and ephemeral state; current active tail intentionally excluded.','Summary protocol freezes validated closed range before aux call; returns nonempty summary before publish, target holds session_meta/context_transfer rather than raw selected prose.','State copies cwd, cloned workspace, model/provider; counters/invokedSkills/parent reset, current parent goal/control not copied. No claim all profiles/project authority are cloned or certified.'],'limits':['No real sessions/FS/model/provider/RPC/UI/helper/test/native/network/Git execution.','No global full/custody/locking/runExclusive/atomic-publication correctness claim.','Large aux-fragment/token-fit/model-trace semantics displayed but outside finite normal package opinion.','Unknown/no explicit current full in retainedcap is not evidence unread; no global coverage update.']})
save('diagnostics.json',{'metadataFailures':[],'productFailures':[],'toolOutputTruncations':[],'normalNoMatchResults':[],'firstInventoryRaw':'inventory.first.stdout/stderr/exit.json actual bytes retained, exit0.','productExecutionAttempts':0,'testsExecuted':0,'gitCalls':0,'networkCalls':0,'nativeCalls':0,'realSessionOrFSOperations':0,'historyLimits':'6010 dated MD/JSON frozen58 included59+ excluded;4291442 recursive value scalars+archives are Root machine visits not personal semantic reads or added runtime. manager609/transcript548 each only first100 retainedcap100. Provenance preview220characters per visible hit; selected exactR9/R32objects and boundedMD read separately.','metadataTiming':'Old-session-R9, R9canonical, CTX4 and R32canonical byte hashes recorded before bounded outputs and before product bodies. Earlier4old MD keyword searches had no initial hashes; late metadata explicitlyinitial=null. No source pin backfilled.','oldEvidencePolicy':'Old report commands/pass counts are historical prose only. Permanent failed model/native/CLI/mobile/context routes not executed or recovered. No old author script run.','sourceReadingEnded':'After final actual summary-return source read5e6b35; finalizer only captures already-displayed ranges/byte hashes and writes metadata.'})
checks=[]
for path,p in pins.items():
 b=(R/path).read_bytes();checks.append({'path':path,'bytes':len(b),'sha256':sha(b),'initialSha256':p['sha256'],'sameSha256':sha(b)==p['sha256']})
meta=[json.loads((O/'old-session-r9-input.json').read_text()),json.loads((O/'old-ctx-input.json').read_text()),json.loads((O/'r32-canonical-input.json').read_text())]+json.loads((O/'r9-canonical-inputs.json').read_text())['files'];ref=json.loads((O/'shared-history-reference.json').read_text());meta.append(ref)
mc=[]
for p in meta:
 path=Path(p['path']);path=path if path.is_absolute() else R/path;b=path.read_bytes();mc.append({'path':p['path'],'bytes':len(b),'sha256':sha(b),'initialSha256':p['sha256'],'sameSha256':sha(b)==p['sha256']})
assert all(x['sameSha256'] for x in checks+mc)
save('ending.json',{'atUTC':now(),'sourceInstructionChecks':checks,'all11SourceInstructionPinsSameSHA':len(checks)==11,'boundedMetadataChecks':mc,'all6ComparableMetadataInputsSameSHA':len(mc)==6,'lateOnlyMetadata':a,'allComparedSameSHA':True,'historyInventoryIndependentlyRehashed':False,'scope':'Only5old originals+shared JSON comparable hashes, not all6010 original entries or Git state. Four extra MD navigation hashes are late-only.'})
report=f'''# Session fork / context transfer：有限静态审查

**0 正式 / 0 候选 / 0 新关联**。只核正常full、summary、completed-side的数据路径；产品/helper/import/test、真实会话/FS、模型/网络/native及Git执行均0，没有改产品或旧包。

真实协议分支→Engine→SessionManager已选读。Full按冻结事件数组的inclusive cursor截取、显式copy/skip策略验证后，目标深拷贝事件并重分配ID，context note/checkpoint和turn_diff引用在复制前缀内重映射。Side用已完成游标而非进行中的tail，并选择ephemeral；没有把任意工具不配对/伪造event ID当正常反例。目标复制cwd、克隆workspace、model/provider，重置usage/turn计数、invokedSkills与parent；当前parent goal/control不会由buildForkState带入。这里只描述具体字段，不认证整个profile/project授权或跨进程存储机制。

Summary先clone/验证inclusive选区，实际portable serializer递归保留structured tool-result文本、reasoning和参数，图片使用明确metadata占位；正常非空摘要完成后才调用createSummaryFork。目标只有meta+context_transfer、重放为background是该入口合同，不能把“不复制原正文”当丢失。协议使用busy/exclusive调用并在成功后发布，但本包不由调用形状认证互斥/锁。大窗口分片与底层模型/token估计仅显示到边界，不宣称全分支正确。 [精确范围](source-manifest.json)、[已显示摘录](source-excerpts.txt)、[分类/边界](classification.json)保存有限证据。

旧因已亲核并排除：SESSION-R9-01为超工具批次的持久配对阻fork；CTX-1为普通snip前缀配对、CTX-2为普通压缩/归档丢nested文本，后者与此portable serializer不同。 [R9原文](old-session-r9-input.json)、[CTX原文](old-ctx-input.json)及[R9canonical](r9-canonical-inputs.json)/[R32对象](r32-canonical-input.json)保留版本：旧manager935b…/109011B不同当前3a0…/109429B；transcript同SHA的pin也不单独证明全文。旧重叠不叫首次。July is_error/synthetic duplicate仅保留R9引用，不伪称亲读原件；没有重开其失败/多进程方向。另[旧fork/alignment导航](prior-navigation-late.json)只有实际显示行，hash晚于导航且initial=null，不倒填。

[共享batch投影](history-projection.json)记录6010 MD/JSON、纳冻58排59+、4291442 JSON value scalar机器访问（含archive），manager609/transcript548命中各cap100；原hits不穷尽，不能据无条目认unread或新颖性，也不把机器访问加到个人语义/运行数。

范围：5产品selected **{counts['productSelectedLines']}**行，2个测试细节声明selected **{counts['testDeclarationSelectedLines']}**行（不执行），另2测试仅title导航；合计{counts['selectedTotalLines']}，display union **{counts['displayedSourceLines']}**，semantic full0。 [diagnostics](diagnostics.json)保存首次库存原raw exit0、0metadata失败/截断；[ending](ending.json)11源/指令pin、6可比限定metadata输入SHA均同，4份旧MD导航仅late hash，不冒称重核全历史或全Session无bug。见 [自排除收据](artifact-receipt.json)。
'''
(O/'report.md').write_text(report)
links=re.findall(r'\[[^\]]*\]\(([^)]+)\)',report);assert all((O/x).exists() or x=='artifact-receipt.json' for x in links)
save('metadata-checks.json',{'atUTC':now(),'kind':'Own stdlib metadata/range checks only; not product validation','sourceRows':len(rows),'sourceInstructionPins':len(pins),'selectedSubsetAndEOF':True,'canonicalDisplayUnion':True,'allComparedEndingSameSHA':True,'reportLinks':links,'reportLinkCount':len(links),'receiptSelfLinkWillExist':True})
print(json.dumps({'counts':counts,'links':len(links),'sourcePins':len(pins),'boundedComparableMetadata':len(mc)},ensure_ascii=False))

from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round136-pet-closure-review')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def nums(rr):return {n for a,b in rr for n in range(a,b+1)}
def spans(ns):
 out=[]
 for n in sorted(set(ns)):
  if out and out[-1][1]+1==n:out[-1][1]=n
  else:out.append([n,n])
 return out
# Retain original mutable metadata wording, then correct two descriptions to actual read scope/timing.
for name in ['prior-metadata-inputs.json','author-freeze-inputs.json']:
 (O/(name.replace('.json','.first.json'))).write_bytes((O/name).read_bytes())
x=json.loads((O/'prior-metadata-inputs.json').read_text())
for row in x['files']:
 row['metadataRecordSavedAtUTC']=row.pop('firstInputReadAtUTC')
 row['timing']='Exact UTC of first metadata byte read not separately recorded. Hash was calculated before bounded output in b8616b; record saved later in same invocation. No product source pin is backfilled.'
save('prior-metadata-inputs.json',x)
x=json.loads((O/'author-freeze-inputs.json').read_text());x['readScope']['classification.json']='hash-only this invocation; JSON contents not independently read'
save('author-freeze-inputs.json',x)
pins={}
for n in ['initial-pins.json','chain-before-pins.json','admission-test-before-pins.json','assistant-writer-before-pins.json']:
 for row in json.loads((O/n).read_text())['files']:pins[row['path']]=row
row=json.loads((O/'facade-wiring-before-pin.json').read_text());pins[row['path']]=row
D='packages/desktop/src/main/pet/';C='packages/core/src/engine/'
# path, kind, semantic selected, body display, extra navigation ranges, scope
spec=[
 ('packages/pet/src/topic-segment.ts','product',[[26,50],[75,75]],[[1,75]],[],'Targeted threshold/boundary DTO reread of known same-SHA old full. Prompt/other helpers physically displayed, no first/new full claim.'),
 ('packages/pet/src/segment-closure.ts','product',[[13,32],[37,37],[53,83]],[[1,154]],[],'Targeted exact-boundary lookup/null semantics, overlapping old full. Prompt/parser body display is not added semantic coverage.'),
 (D+'pet-segment-controller.ts','product',[[120,131],[151,165],[168,189],[191,252]],[[1,275]],[],'Serial beginTurn, first/idle/manual branches, persisted boundary and close callback. Other delegation/archive code displayed boundary only.'),
 (D+'pet-segment-closure-service.ts','product',[[60,94],[171,202],[204,246],[249,283]],[[1,109],[171,302]],[],'Default reader filter and IDs, close null before extraction, journal/memory call order, identical backfill anchors. No model/IO/redaction/security behavior certified.'),
 (D+'pet-dispatch-service.ts','product',[[1051,1075],[1078,1103],[1178,1204],[2139,2147],[2188,2223],[2343,2349],[2368,2398]],[[1045,1103],[1173,1204],[2127,2155],[2188,2228],[2332,2400]],[[183,183],[357,357],[362,362],[364,364],[1998,1998],[2069,2070],[2233,2233],[2260,2260],[2284,2284],[2292,2292],[2294,2297],[2469,2469],[2473,2473],[2506,2506],[2510,2510],[2520,2520]],'Ordinary host wake guard/manager serialization, H, beginTurn, unchanged worker params, settle-finally closure. Selector/authority/later host action internals not exhaustively reviewed.'),
 (D+'pet-follow-up-wake-coordinator.ts','product',[[109,130],[145,180]],[[100,180]],[],'Future once scheduling, claim/expiry and resume selection. No scheduler/claim/notification runtime efficacy claim.'),
 (D+'pet-follow-up-runtime.ts','product',[[32,46],[67,102]],[[1,105]],[],'Actual composition and guards; no-taskId ordinary idle source reaches dispatch. Publish/notify bodies shown only.'),
 (D+'pet-follow-up-host.ts','product',[[24,80]],[[1,110]],[],'Real register host path validates resume/source, optionally derives task, forwards future definition. Context/authentication and registry persistence only static call boundaries.'),
 (D+'pet-work-memory-store.ts','product',[[39,43],[67,87],[93,113],[143,153],[179,188]],[[1,113],[143,153],[179,188]],[],'Load retains segment object/ID, append+snapshot retain it, allSegments feeds backfill. Native FS persistence not executed or certified.'),
 (D+'pet-registered-follow-up-store.ts','product',[[272,305]],[[272,305]],[],'Actual registration admission rejects nonfuture time but has no below-12h cap. Other registry/mutation/identity mechanisms not reviewed.'),
 ('packages/pet/src/registered-follow-ups.ts','product',[[100,102],[129,168]],[[94,168]],[[3,3],[23,23],[31,31],[49,49],[54,54],[70,70],[75,75],[82,82],[177,177],[183,183]],'Ordinary finite timestamp and valid resume payload contract. Timezone Intl expression only read, never executed.'),
 ('packages/desktop/src/main/index.ts','product',[[2163,2181],[2211,2231],[2597,2608],[2615,2638]],[[2160,2184],[2207,2234],[2594,2645]],[],'Production Runtime/controller/default-reader wiring and startup backfill. No replacement readMessages supplied. Later independent context migration only displayed boundary, not claimed broken.'),
 ('packages/core/src/protocol/server.ts','product',[[1809,1824],[1987,2002]],[[1803,1827],[1977,2005]],[],'Two selected run branches preserve injected/clientMessageId. No complete authorization/protocol validation claim.'),
 ('packages/core/src/protocol/chat-session.ts','product',[[515,528]],[[506,539]],[],'Queued run forwards explicit opts to Engine; stream envelope correlation is distinct from persisted transcript data.'),
 (C+'run-session-open.ts','product',[[176,181],[211,218]],[[168,184],[208,223]],[],'Existing/fresh ordinary user append carries ID/injected. No session/account/permission mechanism assessment.'),
 ('packages/core/src/session/transcript.ts','product',[[407,418],[527,571]],[[407,440],[526,571]],[[109,109],[157,157],[296,296],[466,466],[586,586],[606,606],[616,616],[629,629],[634,634],[647,647],[653,653],[655,655],[684,684],[688,688],[794,794],[837,837],[850,851]],'append stores explicit data without adding run ID; appendMessage only writes ID from opts. Sync/native machinery shown but not evaluated.'),
 (C+'engine.ts','product',[[2790,2794],[3402,3413],[4343,4345]],[[2784,2805],[3398,3413]],[[106,106],[949,949],[1014,1014],[1023,1023],[1053,1053],[1440,1440],[1675,1675],[2041,2041],[2158,2158],[2450,2450],[2707,2707],[2742,2742],[2936,2936],[3334,3334],[3358,3358],[3363,3363],[3455,3455],[3660,3660],[4341,4349],[4352,4352]],'Actual same transcript→wireRunModelFacade and same facade→TurnLoop. injectContext writer navigation carries no ID. Other grep fields are navigation only, not mechanism proof.'),
 (C+'turn-loop.ts','product',[[2148,2156],[2204,2211]],[[2143,2162],[2200,2213]],[[2248,2256],[2293,2301],[2336,2344],[950,950],[1261,1261],[1405,1405],[1425,1425],[1431,1431],[1512,1512],[1530,1530],[1598,1598],[1661,1661],[1905,1905],[1907,1907],[2089,2089],[2091,2091],[39,39],[204,204],[551,551],[558,558],[568,568],[1659,1659],[1684,1684],[1810,1810],[828,828],[1322,1322],[1699,1699],[1708,1708],[1890,1890],[2045,2045]],'Only facade call/callWithoutStreaming connection semantic. Other assistant/append grep contexts navigation, no broad fallback/tool audit.'),
 (C+'model-facade.ts','product',[[174,183],[258,265],[273,305]],[[174,184],[258,305]],[[299,307],[115,115],[222,222]],'Both normal call variants recordResponse; assistant append supplies no opts/clientMessageId. No actual model call.'),
 (C+'run-finalize.ts','product',[[224,224]],[],[[128,136],[220,228]],'Selected navigation writer for system verification assistant has authority only, not H. Other goal injection context incidental; no finalize lifecycle review.'),
 (C+'run-accounting.ts','product',[[91,105]],[[91,108]],[[27,27]],'Factory creates actual ModelFacade on supplied transcript; accounting/budget mechanisms out of scope.'),
 ('packages/pet/src/topic-segment.test.ts','test-declaration',[[6,14]],[[1,23]],[],'Threshold declarations only; unrelated carryover declaration partially displayed.'),
 ('packages/pet/src/segment-closure.test.ts','test-declaration',[[9,46]],[[1,46]],[],'Existing exact ID/missing/empty-window declarations only; no execution.'),
 (D+'pet-segment-closure-service.test.ts','test-declaration',[[80,107],[212,247]],[[80,107],[212,249]],[[54,54],[120,120],[149,149],[173,173],[199,199]],'Existing fake-reader short-window and backfill declarations. They inject readMessages and do not prove default parser/injected integration.'),
]
rows=[];ex=[]
for path,kind,selected,body,nav,scope in spec:
 pin=pins[path];b=(R/path).read_bytes();ls=b.decode().splitlines();shown=nums(body)|nums(nav);sem=nums(selected)
 assert sha(b)==pin['sha256'];assert sem<=shown;assert min(shown)>=1 and max(shown)<=len(ls)
 rows.append({'path':path,'bytes':len(b),'sha256':sha(b),'lineCount':len(ls),'kind':kind,'coverage':'targeted-static-selected; not-new-full' if kind=='product' else 'selected-existing-test-declarations; execution0','selectedLineRanges':selected,'selectedLineCount':len(sem),'bodyDisplayedLineRanges':body,'bodyDisplayedLineCount':len(nums(body)),'additionalNavigationSnippetLines':sorted(nums(nav)-nums(body)),'displayedLineRanges':spans(shown),'displayedLineCount':len(shown),'initialPinUTC':pin['pinnedAtUTC'],'initialSha256':pin['sha256'],'initialPinTiming':pin['timing'],'scope':scope,'originalPinRow':pin})
 ex.append(path+'\n'+'\n'.join(f'{n}: {ls[n-1]}' for n in sorted(shown)))
for path in [D+'pet-follow-up-service.ts','CODESHELL.md','AGENTS.md']:
 pin=pins[path];body=[[1,217]] if path=='CODESHELL.md' else []
 rows.append({'path':path,'bytes':pin['bytes'],'sha256':pin['sha256'],'lineCount':pin['lineCount'],'kind':'instruction' if not path.startswith('packages/') else 'product-hash-only','coverage':'instruction-read-full-this-packet' if body else 'hash-only-this-packet','selectedLineRanges':[],'selectedLineCount':0,'bodyDisplayedLineRanges':body,'bodyDisplayedLineCount':len(nums(body)),'additionalNavigationSnippetLines':[],'displayedLineRanges':body,'displayedLineCount':len(nums(body)),'initialPinUTC':pin['pinnedAtUTC'],'originalPinRow':pin,'scope':'Current instruction read before evidence edits.' if body else 'No body read in this packet; AGENTS previously read instructions reused, unused follow-up service pin not promoted.'})
counts={'productSelectedRows':sum(r['kind']=='product' for r in rows),'productSelectedLines':sum(r['selectedLineCount'] for r in rows if r['kind']=='product'),'testDeclarationSelectedLines':sum(r['selectedLineCount'] for r in rows if r['kind']=='test-declaration'),'displayedProductAndTestLines':sum(r['displayedLineCount'] for r in rows if r['kind'] in ['product','test-declaration']),'displayedInstructionLines':217,'productSemanticFullRows':0,'sourceInstructionPins':len(pins),'productExecutionAttempts':0}
counts['semanticProductAndTestSelectedLines']=counts['productSelectedLines']+counts['testDeclarationSelectedLines']
save('source-manifest.json',{'schema':'targeted-static-review-ranges/v1','createdAt':now(),'rootReportedBaseline':'1ba606416f4fc94c081159bb3fd10e58cd8d87f0','gitCertified':False,'files':rows,'counts':counts,'rangeConvention':'One-based inclusive; canonical display = body union navigation; selected may be from bounded navigation, is subset of display. Repeats counted once per file. Display/full file bytes do not imply semantic full. Old pure-function full overlap not new coverage.','priorOverlap':'docs/audit-2026-10-17/pet-data.md21–24 / R10pet26–28 with R10files0/1 sameSHA explicitly establish old pure-function full; own canonical check occurred after concrete-candidate leaf read, not a prebody first-coverage gate.'})
(O/'source-excerpts.txt').write_text('\n\n'.join(ex)+'\n')
cls={'formalFindings':[],'candidates':[{'id':'PET-R132-C1','priority':'P3','reviewDisposition':'supports static causal chain for single author candidate; no separate ID/count','rootPlannedFormalAlias':'PET-R57-01, Root decision after this review; not counted twice','conditions':['Existing active S0 not already journaled, at least3 meaningful ordinary messages, autoExtractEnabled true.','Legitimate future resume with valid idle nonexternal source, no pending decision, no paused/interrupted task direct-resume branch; Mimi last interaction at least12h ago.','Successful manager wake H run persists injected user with H; normal assistant writer does not copy H to message.data.'],'timeline':['T1: beginTurn(H) closesS0(nextH), opensS1(startH); H is injected. Immediately after run settles, filtered reader lacksH; S0 end lookup fails, close returnsnull before extraction.','T2<12h ordinary user does not open a new segment, so S1 boundary remainsH.','T2>=12h ordinary U opensS2, closesS1(startH,endU); filtered reader lacksH, start lookup fails. Later S2 has ordinary U anchor and can recover normally.'],'impact':'Those closed segments skip journal/auto-memory extraction. This is not a guarantee that a successful model would always yield memories, not actual observed data loss, and not a claim that all future segments fail.','notClaimed':['No runtime/model/UI observation.','No independent span/context archival failure, original message deletion, permission bypass, shutdown closure, or correctness of FS/locks/authority.','No exhaustive full-history novelty claim.']}],'relatedFindings':[],'counts':{'formal':0,'candidates':1,'newRelated':0},'oldEvidence':{'path':'docs/superpowers/plans/2026-08-07-persist-mimi-archive-boundary.md','readLineRanges':[[846,876]],'keyLine':866,'decision':'Explicit old injected/closure skip discussion. It describes independent client-ID span context archive not affected by closure index policy; it is not proof that journal closure can locate a filtered wake boundary, nor a claim history never mentioned injected.'}}
save('classification.json',cls)
save('diagnostics.json',{'productExecutionAttempts':0,'testsExecuted':0,'gitCalls':0,'networkCalls':0,'firstNavigationDiagnostic':'first-navigation-diagnostic.json; exit2 wrong docs/plans inventory, partial filenames; transcript diagnostic only, no fabricated raw bytes','normalNavigationNoMatch':{'chunkId':'1e5c18','combinedExit':1,'lastPattern':'this.deps.llm.','cause':'TurnLoop dependency is model, not llm; previous two commands in same shell printed matches, their individual exit codes not captured','resolution':'44e9c6 filename/bounded navigation found deps.model; no product run/retry'},'presentationTruncations':[],'metadataFieldClarifications':{'prior-metadata-inputs.first.json':'Preserves first wording; exact first byte-read UTC was not separately recorded; renamed timestamp to save time.','author-freeze-inputs.first.json':'Preserves first readScope wording. Actual classification/source/receipt read was hash-only, only peer report text was read.'},'scopeTiming':'Initial source opinions and assistant-ID concern predate peer final report. After preliminary source-ended message, one necessary narrow assistant-ID counterevidence chain was read with new before pins; ended again after a31285. No later source semantic expansion during final metadata.','historyLimits':'Only four exact old canonical/MD inputs in this reviewer packet. Author132/Root shared history work is separate, not silently counted as independent all-history review. Root explicitly requested no full-history expansion.','authorPacketRead':'After confirmed freeze only; report full text compared, other3 anchors hashes only. Candidate timeline agrees;132 did not review assistant writer chain, this additional independent evidence is counted only136.'})
checks=[]
for path,p in pins.items():
 b=(R/path).read_bytes();checks.append({'path':path,'bytes':len(b),'sha256':sha(b),'initialSha256':p['sha256'],'sameSha256':sha(b)==p['sha256']})
mc=[]
for row in json.loads((O/'prior-metadata-inputs.json').read_text())['files']+json.loads((O/'author-freeze-inputs.json').read_text())['files']:
 p=Path(row['path']);p=p if p.is_absolute() else R/p;b=p.read_bytes();mc.append({'path':row['path'],'bytes':len(b),'sha256':sha(b),'initialSha256':row['sha256'],'sameSha256':sha(b)==row['sha256']})
assert all(x['sameSha256'] for x in checks+mc)
save('ending.json',{'atUTC':now(),'sourceInstructionChecks':checks,'all27SourceInstructionPinsSameSHA':len(checks)==27,'metadataChecks':mc,'all8BoundedInputsSameSHA':len(mc)==8,'allComparedSameSHA':True,'scope':'No current Git certification, no complete original history inventory rehash. Metadata means bounded4 old inputs+4 peer frozen anchors, not re-review of all old source.'})
report=f'''# Pet followup 与话题关闭：独立静态反证复核

支持作者单一 **PET-R132-C1 / P3 静态候选**，本包 **0 formal / 1 同项 candidate / 0 new related**。Root拟归为PET-R57-01时仍只计一项；本包不预先倒写正式结论。产品、helper、测试、模型、真实会话/文件、网络、Git执行均0。

正常事件线为已有活跃S0（至少3条有意义普通对话、尚未journal、自动提取开启），合法future resume到期，Mimi本身idle≥12h，来源会话idle且无pending/task直接resume拦截。真实host register允许该时间；wake生成稳定H，把它交给beginTurn，关闭S0(endH)并保存S1(startH)。同run经实际worker/protocol/Engine把H与injected:true写入transcript.data；settle后马上closeS0。默认reader过滤H，exact ID查不到end，close在提取前return null。T2不足idle不会换掉H；T2再跨idle的真实U开S2时，S1的startH仍找不到。S2以后可恢复，不能说整个journal永久失效。 [精确链/条件](classification.json)、[源码范围](source-manifest.json)、[已显示摘录](source-excerpts.txt)保留具体行。

关键反证已核：first interaction/未过idle不新开；不存在/external/pending/running来源和paused-task直接resume不走本触发；正常load/persist保留边界ID，backfill复用同reader/边界，无重定位fallback。Main真实接线没有替代readMessages。reader也会接收assistant行ID，因此另独立核普通assistant写入：Engine→wireRunModelFacade→同transcript的ModelFacade→TurnLoop实际call/callWithoutStreaming→recordResponse→appendMessage不传clientMessageId；通用append也仅存入传入data、不补run ID。流事件envelope关联ID与这里的持久data字段不能混用。该必要补读晚于一次初步source-ended通报，before pins与时序如实保存；此后不再扩源。

影响限上述关闭段未进入journal/auto-memory提取；不保证原本一定产生某条memory，不推原始消息丢失、独立span/context归档失败、权限或shutdown关闭行为。所有native/FS/scheduler/model机制仅静态边界，未实际验证。

旧canonical [输入](prior-metadata-inputs.json)亲读docs/audit-2026-10-17/pet-data.md21–24、R10pet26–28及files0/1同SHA，证明纯函数曾全文审过，本次是具体新问题定向重叠，不称首次/新full；原对象是在叶子正文后核，不倒填门槛。旧计划866明确提过injected/closure skip，但指独立span archive不受影响，不能当journal定位补救，也不能说全史没提。此包不重扫全史，Root/132的历史工作不冒充独立复核。 [作者冻结输入](author-freeze-inputs.json)仅在132终态后读取报告作差异核对，额外assistant证据只计136。

范围为{counts['productSelectedRows']}产品selected {counts['productSelectedLines']}行，3个既有测试声明selected {counts['testDeclarationSelectedLines']}行（执行0），合计{counts['semanticProductAndTestSelectedLines']}；产品/测试display union {counts['displayedProductAndTestLines']}，另CODESHELL指令217行。未读follow-up-service仅hash。范围/导航/旧重叠不升级全局覆盖。 [diagnostics](diagnostics.json)保存首次库存exit2和一次正常空匹配exit1，不假造原raw；[ending](ending.json)27源/指令pin与8个限定元数据输入SHA均同。见 [自排除收据](artifact-receipt.json)。
'''
(O/'report.md').write_text(report)
links=re.findall(r'\[[^\]]*\]\(([^)]+)\)',report);assert all((O/x).exists() or x=='artifact-receipt.json' for x in links)
save('metadata-checks.json',{'atUTC':now(),'kind':'Own stdlib metadata checks only, not product validation','sourceRows':len(rows),'sourcePins':len(pins),'rangeSubsetAndEOFChecks':True,'canonicalDisplayUnionChecks':True,'sourceAndBoundedMetadataChecksAllSame':True,'reportLinks':links,'reportLinkCount':len(links),'receiptSelfLinkWillExist':True,'allClassificationCountsReferToOneExistingCandidate':True})
print(json.dumps({'counts':counts,'links':len(links),'sourcePins':len(pins),'metadataInputs':len(mc)},ensure_ascii=False))

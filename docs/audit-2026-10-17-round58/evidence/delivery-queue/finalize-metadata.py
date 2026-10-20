from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, re
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round138-delivery-queue')
def now(): return datetime.now(timezone.utc).isoformat()
def digest(b): return hashlib.sha256(b).hexdigest()
def write(n,x): (OUT/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def load(n): return json.loads((OUT/n).read_text())
def union(rs):
 ans=[]
 for a,z in sorted(rs):
  if ans and a<=ans[-1][1]+1:ans[-1][1]=max(z,ans[-1][1])
  else:ans.append([a,z])
 return ans
def count(rs):return sum(z-a+1 for a,z in union(rs))
base=load('initial-pins.json'); pins={}
for n,rows in [('initial-pins.json',base['files']),('adjacent-initial-pins.json',load('adjacent-initial-pins.json')),('inflight-lifecycle-pins-navigation.json',load('inflight-lifecycle-pins-navigation.json')['pins']),('entry-lifecycle-navigation.json',load('entry-lifecycle-navigation.json')['pins'])]:
 for row in rows:
  if row['path'] not in pins:pins[row['path']]={**row,'initialPinArtifact':n}
display={}; display_refs={}
for p in sorted(OUT.glob('*display*.json')):
 v=json.loads(p.read_text()); rows=v if isinstance(v,list) else [v]
 for row in rows:
  path=row.get('path'); ranges=row.get('displayedLineRanges',[])
  if path in pins and ranges:
   display.setdefault(path,[]).extend(ranges);display_refs.setdefault(path,[]).append(p.name)
for path in display:display[path]=union(display[path])
plan=[
 ('packages/chat/src/delivery-queue.ts','product',[[7,57],[91,315],[318,338],[482,603],[605,620],[700,721]],'Lifecycle, durable acceptance, instance mutation and complete-state persistence. Spool/security helper display is excluded; directory helpers read only to identify absence of queue writer coordination in this call path.'),
 ('packages/chat/src/bound-session-chat.ts','product',[[1,99]],'Ordinary accepted/not-bound routing and reply disposition; no actual host/session operation or enforcement certification.'),
 ('packages/chat/src/chat-gateway.ts','product',[[54,61],[79,95],[102,186],[199,231]],'Actual queue creation, middleware dispatch, adapter-handler acceptance, runner shutdown and queue.stop consumer.'),
 ('packages/chat/src/cli.ts','product',[[1,1],[66,145],[317,320]],'Actual Node entry, same-config lock/inbox wiring, shutdown signal, watcher/gateway finalization and exitCode-only error handler. WeChat login/service/canary adjacent display excluded.'),
 ('packages/chat/src/telegram.ts','product',[[91,133],[150,174],[184,200],[212,222],[267,280]],'Normal text producer and ACK/offset order, abortable inbound polling, reply send local timeout and ordinary Error propagation. No platform connection or account behavior tested.'),
 ('packages/chat/src/channel.ts','product',[[109,119],[144,164]],'Inbound message fields and sender/adapter signatures. Capability matrix display not claimed as new full semantic review.'),
 ('packages/chat/src/gateway.ts','product',[[129,148],[198,204],[224,244]],'Real Mimi middleware await/reply and petChat input forwarding only; cached reply/sendTask internals incidentally displayed but not reviewed as a new cache finding.'),
 ('packages/chat/src/desktop-control-client.ts','product',[[101,131],[139,148],[151,190],[208,218],[258,263],[275,291],[316,321]],'petChat pending polling lacks caller abort; watcher does forward its signal; request local timeout cleanup. Descriptor/credential/startup mechanism display excluded and not certified.'),
 ('packages/chat/src/instance-lock.ts','product',[[27,30],[47,50],[52,90],[95,101],[156,159]],'Static single-owner lease comment, normal marker creation/close/release and token-checked removal only; no OS/process/custody enforcement experiment.'),
 ('packages/chat/src/delivery-queue.test.ts','test-declaration',[[34,104]],'Existing persistence/retry/dedupe/recovery/backpressure declarations only; no tests run and no shutdown race execution.'),
 ('packages/chat/src/bound-session-chat.test.ts','test-declaration',[[68,94]],'Existing route-error retry and accepted-immediate-reply declarations only; no tests run.'),
]
rows=[]
for path,kind,ranges,scope in plan:
 pin=pins[path]; b=(ROOT/path).read_bytes();sha=digest(b)
 assert sha==pin['sha256'],path
 assert all(any(da<=a and z<=dz for da,dz in display[path]) for a,z in ranges),(path,ranges,display[path])
 rows.append({**pin,'sourceKind':kind,'coverage':'full' if ranges==[[1,pin['lines']]] else 'selected','selectedLineRanges':ranges,'semanticLineCount':count(ranges),'displayedLineRanges':display[path],'displayedLineCount':count(display[path]),'displayArtifacts':display_refs[path],'scope':scope,'endingSha256':sha,'endingUnchanged':True,'newUniqueCoverageClaim':False})
meta_path='packages/chat/package.json';pin=pins[meta_path]
metadata=[{**pin,'sourceKind':'package-entry-metadata','coverage':'selected','selectedLineRanges':[[1,4],[70,72]],'semanticLineCount':7,'displayedLineRanges':display[meta_path],'displayedLineCount':count(display[meta_path]),'scope':'Package identifies Node/Bun standalone gateway and bin maps code-shell-chat to dist/cli.js. This is metadata, not product runtime.'}]
assert digest((ROOT/meta_path).read_bytes())==pin['sha256']
hashonly=[{**pins[p],'coverage':'hash-only','selectedLineRanges':[],'semanticLineCount':0,'scope':'Instructions read previously; same SHA reused, no new full instruction read.'} for p in ['CODESHELL.md','AGENTS.md']]
source_checks=[]
for pin in pins.values():
 b=(ROOT/pin['path']).read_bytes();source_checks.append({'path':pin['path'],'initialSha256':pin['sha256'],'endingSha256':digest(b),'bytes':len(b),'unchanged':digest(b)==pin['sha256']})
assert all(x['unchanged'] for x in source_checks)
history=[]
for n in ['prior-canonical-read.json','entry-and-old-r11-display.json']:
 for row in load(n):
  if row['path'].startswith('docs/') and not any(h['path']==row['path'] for h in history):history.append({'path':row['path'],'sha256':row['sha256'],'bytes':row['bytes'],'selectionArtifact':n,'scope':'Only explicitly saved selected old lines/objects were read; no whole-history semantic exhaustion.'})
old=load('prior-shutdown-bounded.json');history.append({'path':old['path'],'sha256':old['sha256'],'bytes':old['bytes'],'selectionArtifact':'prior-shutdown-bounded.json','scope':'Two derived bounded contexts read in full at later metadata check; not the entire 548101-byte old scanner output or original source report.'})
shared=load('shared-history-projection.json')
shared_input=shared['input']
# Shared batch is a single immutable metadata input; this does not re-walk its 5850 source paths.
shared_path=Path(shared_input['path']); sb=shared_path.read_bytes()
shared_expected=shared_input.get('sha256')
assert digest(sb)==shared_expected
hchecks=[]
for h in history:
 b=(ROOT/h['path']).read_bytes();hchecks.append({'path':h['path'],'initialSha256':h['sha256'],'endingSha256':digest(b),'unchanged':digest(b)==h['sha256']})
assert all(h['unchanged'] for h in hchecks)
totals={'productFiles':sum(r['sourceKind']=='product' for r in rows),'productSemanticLines':sum(r['semanticLineCount'] for r in rows if r['sourceKind']=='product'),'testDeclarationFiles':sum(r['sourceKind']=='test-declaration' for r in rows),'testDeclarationLines':sum(r['semanticLineCount'] for r in rows if r['sourceKind']=='test-declaration'),'fullFiles':sum(r['coverage']=='full' for r in rows),'selectedFiles':sum(r['coverage']=='selected' for r in rows),'semanticFilesDisplayedLines':sum(r['displayedLineCount'] for r in rows),'packageMetadataLines':7,'packageMetadataDisplayedLines':metadata[0]['displayedLineCount'],'hashOnlyFiles':len(hashonly),'navigationOnlyFiles':0}
manifest={'root':str(ROOT),'context':{'rootReportedHead':base['rootReportedHead'],'branchReported':base['branchReported'],'GitVerified':False,'sourceReadType':'static-only','productRuntimeExecutions':0,'GitCalls':0},'files':rows,'metadataFiles':metadata,'hashOnlyFiles':hashonly,'historyReferences':history,'sharedHistory':{'input':shared_input,'snapshotAt':shared['snapshotAt'],'sharedHistoryFiles':shared['sharedHistoryFiles'],'machineValueScalarVisits':shared['machineValueScalarVisits'],'excludedFormalAtOrAbove':58,'targetHitCounts':{'delivery-queue':79,'bound-session-chat':68},'cap':100,'targetHitsAllSaved':True,'allSavedHitsSemanticallyRead':False,'note':'Shared recursive JSON value/MD machine navigation only. Root owns full inventory binding. This author only read the identified canonical lines/objects and two derived windows.'},'totals':totals,'limitations':['Range sums are declared static reading, include known prior overlap and are not global unique new coverage.','Full bound-session-chat read does not certify host/session authority or actual routing execution.','Displayed but excluded adjacent code is not semantic review. Test declarations are not test results.'],'endingAt':now()}
write('source-manifest.json',manifest)
write('ending-checks.json',{'checkedAt':now(),'sourceChecks':source_checks,'historyChecks':hchecks,'sharedBatchCheck':{'path':str(shared_path),'initialSha256':shared_expected,'endingSha256':digest(sb),'unchanged':True},'allSourceAndSelectedHistoryUnchanged':True,'fullSharedInventoryRecheckedByThisAuthor':False,'GitCalls':0})
classification={'formalFindings':[],'candidates':[{'id':'CHAT-R138-C1','proposedPriority':'P2','status':'static-candidate-pending-independent-review-and-root-decision','title':'CLI释放网关lease后旧投递仍写整份队列快照，可撤销新实例已ACK消息的持久记录','source':'packages/chat/src/delivery-queue.ts','line':131,'lines':[131,137],'companionSourceRanges':{'packages/chat/src/delivery-queue.ts':[[241,315],[537,592]],'packages/chat/src/chat-gateway.ts':[[144,186]],'packages/chat/src/cli.ts':[[66,96],[115,144],[317,320]],'packages/chat/src/gateway.ts':[[224,244]],'packages/chat/src/desktop-control-client.ts':[[101,118],[258,291],[316,321]],'packages/chat/src/instance-lock.ts':[[76,90],[156,159]]},'normalTimeline':['Old CLI with the same normal config durably accepts text A. Its Mimi petChat request remains pending; inbound adapter and idle notification watcher are otherwise healthy.','SIGINT/SIGTERM aborts inbound polling/watch. ChatGateway waits adapter runners then invokes non-awaitable queue.stop; CLI finally releases the file lease. The entry has no process.exit, and the active petChat request does not receive that shutdown signal.','A new CLI starts with the same config/inbox, obtains the released lease, reloads pending A, then durably enqueues and ACKs distinct normal text B. A/B may be long-running; no fabricated invalid DTO or rejection is required.','Old A resolves while the old request/timer is still live. Its process completion removes A and persists the old instance pending/completed arrays, which do not contain B; the atomic rename can replace the new durable snapshot without B.','B can remain in new-instance memory and a later new-instance persist may restore it. If that instance exits abnormally before a restoring write, the next load cannot recover B from the overwritten inbox.'],'expected':'Accepted durable inbox entries remain recoverable across process restart; releasing single-writer ownership must not permit a prior owner to rewrite stale durable state.','impactLimit':'Source-level durable-state overwrite, not observed platform delivery or guaranteed permanent loss. Duplicate A alone is permitted at-least-once behavior and is not this candidate. No runtime/process/network/timer/FS fixture was executed.','rootPromotionNotWrittenIntoAuthorCounts':True}],'relatedFindings':[],'counts':{'formal':0,'candidate':1,'newRelated':0},'oldCauseExclusions':[{'id':'SWC-01','cause':'adapter account ordinal routing after reordering; not stale writer ownership'},{'id':'SWC-02','cause':'dedupe key omits account; distinct B does not rely on collision'},{'id':'SWC-03','cause':'attachment spool error memory fallback; candidate uses ordinary durable text without spool failure'},{'id':'C8','cause':'earlier retry overtaken by later message within an active queue; no owner handoff/snapshot replacement'},{'id':'CHAT-R11-01','cause':'notification-progress first rejected loadTask remains cached; independent old formal, not this queue ownership race'}],'validation':{'productCalls':0,'imports':0,'tests':0,'fixtures':0,'realProcessesOrAccounts':0,'network':0,'Git':0,'peer143FinalReportUsed':False,'peer144FinalReportUsed':False},'scopeCaution':'Exact same-cause absence is bounded to actual old canonical reads; shared path/SHA hits are not exhaustive cause review. Root has separate independent source and historical reviewers.'}
write('classification.json',classification)
write('diagnostics.json',{'firstToolFailures':[],'knownMetadataErrors':[],'toolOutputTruncationObserved':False,'legitimateNavigationNoMatch':[{'artifact':'consumer-test-navigation.json','note':'deliverBoundSessionChat query did not match; actual middleware is createBoundSessionChat. Raw command statuses retained.'}],'incidentalDisplayExcluded':['cli.ts250–306 includes WeChat login/service option code, not semantically reviewed or executed; adjacent cli146–213 is also excluded.','delivery-queue.ts353–480 attachment spool/security helpers displayed; old issues not reopened.','gateway.ts149–197 and205–218 cached-reply/sendTask details displayed but excluded from new semantic cache review.','desktop-control-client descriptor/credential startup lines adjacent to request were displayed but excluded; no actual descriptor or credentials read.','channel capability table1–105 displayed but not treated as whole-file semantic review.'],'wordingCorrections':[{'first':'Earlier message informally called petChat chat.','correct':'Actual gateway.ts231 invokes options.desktop.petChat; desktop-control-client.ts101 defines petChat.'},{'first':'Earlier navigation discussion confused Root mention of CHAT-R11 first Promise-cache failure with a failed validation and tentatively associated it with Mimi cache code.','correct':'Canonical round11/chat.md1–17 and both findings/0 objects show confirmed CHAT-R11-01 in notification-progress.ensureLoaded. Its old validation is not a failed fixture. This author did not execute or rerun any old or new fixture.'}],'permanentSkip':'Discord import failure and other previously failed dynamic directions were not reopened. Old formal notification-progress cause is excluded without changing its status.','rawOutputCaution':'Early display JSONs record exact SHA/ranges/time, not verbatim stdout; actual tool outputs remain in conversation. Later candidate excerpt materialization is labeled as archival and is not substituted for first output.'})
# Freeze already-read decisive text as a recoverable excerpt; no additional source semantics are counted.
excerpts=[]
for path,ranges in {'packages/chat/src/delivery-queue.ts':[[91,94],[121,137],[183,238],[241,315],[537,571],[580,592]],'packages/chat/src/chat-gateway.ts':[[144,186]],'packages/chat/src/cli.ts':[[66,96],[115,144],[317,320]],'packages/chat/src/gateway.ts':[[224,244]],'packages/chat/src/desktop-control-client.ts':[[101,118],[275,291],[316,321]],'packages/chat/src/instance-lock.ts':[[76,90],[156,159]],'packages/chat/package.json':[[70,72]]}.items():
 b=(ROOT/path).read_bytes();ls=b.decode().splitlines()
 excerpts.append({'path':path,'sha256':digest(b),'ranges':[{'first':a,'last':z,'text':'\n'.join(ls[a-1:z])+'\n'} for a,z in ranges]})
write('candidate-excerpts.json',{'materializedAt':now(),'purpose':'Archival copy of already-read same-SHA ranges; not a new semantic read, original first display outputs are not replaced.','files':excerpts})
report=f'''# Chat 投递停止与持久队列交接：有限静态候选

作者分类 **0 正式 / 1 候选 / 0 新 related**：`CHAT-R138-C1`，建议 P2，等待独立反证与 Root 决定。固定产品上下文由 Root 提供为 `f31a847f45e4805bce34aeb9e6db7efb503cfcb0`、branch58；本作者没有调用 Git。只写本 tmp，0 产品导入/函数/fixture/测试/进程/账户/网络/native 执行。

**候选原因。** `packages/chat/src/delivery-queue.ts:131–137` 的 `stop()` 只停标志和定时器，`241–315` 已启动的投递仍可完成并在308写盘。`537–571` 持久化整个实例的 `pending/completed`，`580–592` 只串行化同一实例。真实调用 `chat-gateway.ts:144–186` 创建队列并仅等待 adapter runners；finally 不等待投递便 `queue.stop()`。CLI `cli.ts:138–144` 等 gateway/watch 后释放 lease；`instance-lock.ts:76–90,156–159` 创建后即关 fd，release 删除自己的 marker。因此旧投递结束前，新 CLI 可以取得同一配置的 lease。

**正常入口反证已核。** package bin 指向 CLI，CLI 是 Node 入口，317–320 只设 `exitCode`，没有强制 `process.exit`。Mimi 正常 middleware `gateway.ts:224–243` 调 `petChat`；`desktop-control-client.ts:101–118` 待完成轮询不接 CLI shutdown signal，request275–291仍创建局部 timeout；相反 watcher 的151–190/208–218确实接收并检查 shutdown signal。候选不依赖非法 DTO、任意 reject 或 attachment spool 故障。参见[准确范围与读前 pin](source-manifest.json)、[可恢复的已读关键源码](candidate-excerpts.json)、[入口补读](entry-lifecycle-display.json)及[watcher signal 反证](watch-signal-forwarding-display.json)。

**有限时间线。** 旧实例持久接受普通文本 A，正在等正常 Mimi 结果。SIGTERM 结束入站 polling 和空闲 watcher，CLI 释放 lease，但 A 的请求未被该 signal 取消。新实例用同配置启动、恢复队列并持久接受/ACK 新文本 B。旧 A 随后完成，用不含 B 的旧实例快照替换文件。此时 **B 仍可能在新实例内存中，后续 persist 可补回**；只有在恢复写入前异常退出/崩溃，下一次 load 才无法从这份队列文件恢复 B。这里指出的是 ACK 后的持久状态可被撤销，**不以 A 重复投递本身报 bug，不声称 B 每次永久丢失**。无 UI、进程存活时序、实际平台投递或磁盘故障的运行观察。完整条件、反例与边界见[分类](classification.json)。旧投递先结束、没有新实例、或新实例后来写回等均可避免/修复该状态。

**历史边界。** 复用共享5850份 MD/JSON、递归 value 含档案、排 formal58+ 的[路径/SHA导航投影](shared-history-projection.json)：delivery79/bound68均完整保存，cap100；机器访问不等于读完147窗口或全史原因。亲读旧 canonical 见[旧范围](prior-canonical-read.json)及[CHAT-R11原对象](entry-and-old-r11-display.json)：SWC-01账号顺序、SWC-02去重账号、SWC-03小附件 spool fallback、C8同实例重试顺序均保留旧分类；没有把它们再次计数。CHAT-R11-01实际是 notification-progress 首次 rejected load Promise 缓存，与本项不同。先前把该措辞混成失败fixture/Mimi缓存的口述已在[诊断](diagnostics.json)更正，未复跑任何旧验证。R24仅两个派生 bounded contexts 已读，不冒称其巨型文档或全部旧因已穷尽；Root另安排143独立源反证和144旧因复核，本作者冻结不借它们未冻的最终报告升级。

**阅读口径。** {totals['productFiles']}个产品源：{totals['productSemanticLines']}行声明语义，其中 bound-session-chat99行 full，其余8个 selected；2个既有测试只读声明{totals['testDeclarationLines']}行，0运行。产品/测试共显示{totals['semanticFilesDisplayedLines']}行，package入口元数据语义7/显示{totals['packageMetadataDisplayedLines']}行，另2 instruction hash-only。本次含旧审查重叠；不是全局唯一新覆盖，也不认证真实账号、路径保管、凭据、权限或平台机制。相邻 spool、Mimi cache、登录/服务选项等显示已明确排除。所有14个源/元数据/instruction pin 与所用旧文档及共享 batch 的结束字节均相同，见[ending](ending-checks.json)。[收据](reviewer-receipt.json)自排除，并冻结当前作者计数；Root 如晋升需另记、不倒写本包。
'''
(OUT/'report.md').write_text(report)
# Validate all ordinary internal report targets; receipt is deliberately generated last.
links=re.findall(r'\]\(([^)]+)\)',report)
missing=[t for t in links if t!='reviewer-receipt.json' and not (OUT/t).is_file()]
assert not missing,missing
checks={'checkedAt':now(),'reportInternalLinks':len(links),'allCurrentTargetsPresent':not missing,'selfReceiptTargetGeneratedLast':'reviewer-receipt.json','sourcePinCount':len(source_checks),'sourceUnchanged':all(s['unchanged'] for s in source_checks),'selectedHistoryPinCount':len(hchecks),'selectedHistoryUnchanged':all(s['unchanged'] for s in hchecks),'sharedBatchUnchanged':True,'rangeSubsetOfDisplayed':True,'totals':totals,'classificationCounts':classification['counts'],'productExecutions':0,'testsRun':0,'GitCalls':0,'receiptSelfExcluded':True}
write('checks.json',checks)
files=[]
for p in sorted(OUT.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes(); files.append({'path':p.name,'bytes':len(b),'sha256':digest(b)})
write('reviewer-receipt.json',{'frozenAt':now(),'root':str(OUT),'selfExcluded':True,'artifactCount':len(files),'files':files,'authorClassification':classification['counts'],'sourceTotals':totals,'productOrTestExecutions':0,'GitCalls':0})
assert all((OUT/t).is_file() for t in links)
for row in files:
 b=(OUT/row['path']).read_bytes();assert len(b)==row['bytes'] and digest(b)==row['sha256'],row['path']
print(json.dumps({'filesTotalIncludingReceipt':len(files)+1,'receiptRows':len(files),'totals':totals,'links':len(links),'anchors':[{ 'path':n,'bytes':len((OUT/n).read_bytes()),'sha256':digest((OUT/n).read_bytes())} for n in ['report.md','source-manifest.json','classification.json','reviewer-receipt.json']]},ensure_ascii=False))

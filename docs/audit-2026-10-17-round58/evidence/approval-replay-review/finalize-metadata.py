from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round142-approval-replay-review')
def sh(b):return hashlib.sha256(b).hexdigest()
def load(n):return json.loads((O/n).read_text())
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def ex(rs):return {i for a,z in rs for i in range(a,z+1)}
def compact(s):
 out=[]
 for i in sorted(s):
  if out and i==out[-1][1]+1:out[-1][1]=i
  else:out.append([i,i])
 return out
at=datetime.datetime.now(datetime.timezone.utc).isoformat();pins={}
for n in ['initial-pins.json','support-pins.json','counterevidence-pins.json']:
 for x in load(n)['files']:pins[x['path']]=x
P='packages/'
S={
 P+'server/src/mobile-remote/pending-approvals.ts':([[1,69]],[[1,69]],'full','Cache observe/resolve/replay and explicit worker setter, directed overlap with frozen author141 full69; not new unique coverage.'),
 P+'desktop/src/main/index.ts':([[1824,1843],[2094,2107],[2127,2133],[6957,6967]],[[1818,1850],[2085,2140],[6950,6970]],'selected','Actual outbound/native/Pet sampling and unconditional normal-init Pet start; other Pet approval/OS/custody code only navigation.'),
 P+'desktop/src/main/mobile-remote-orchestrator.ts':([[124,125],[245,268],[332,344],[366,367]],[[100,130],[245,268],[328,368]],'selected','Local snapshot callback, direct cache replay/resolution and callback wiring. Authority, credentials and disk session lookup implementations excluded.'),
 P+'desktop/src/main/mobile-remote/handle-client-event.ts':([[236,250],[282,315],[567,590]],[[233,319],[563,592]],'selected','Normal session.select/sync replay path and recovery/external interception call boundaries; not complete authentication/permission enforcement.'),
 P+'desktop/src/main/agent-bridge.ts':([[435,476],[478,479],[1145,1166],[1738,1748],[1781,1783],[1816,1818],[2014,2021],[2312,2325],[2333,2337]],[[420,490],[1140,1170],[1734,1755],[1775,1785],[1810,1820],[2010,2025],[2310,2340]],'selected','Exit/started callbacks, renderer/Pet publication, local snapshot/context and subscribe boundary. Core worker process/respawn, all observers and OS behavior not audited.'),
 P+'web/src/hooks/useRemoteSocket.ts':([[189,198],[245,253],[272,280]],[[189,211],[240,280]],'selected','Existing socket object guard, raw notification dispatch and normal visible-page resync boundary, not connection/auth mechanism certification.'),
 P+'web/src/hooks/useRemoteApp.ts':([[521,533],[735,753],[1251,1289],[1291,1295],[1349,1378]],[[510,545],[705,775],[1251,1310],[1340,1378]],'selected','Raw approval callback, selected epoch/terminal clearing and active-session resync; called approval helper/reducer internals not audited, no whole-client filtering absence claim.'),
 P+'desktop/src/main/pet/pet-im-decisions.ts':([[121,148],[156,163]],[[100,163]],'selected','Options.read, start immediate tick + 5000ms interval and tick initial read; no IM send/approve/publish or timer execution.'),
 P+'desktop/src/main/mobile-remote/output-recovery.ts':([[138,154],[174,185]],[[1,130],[138,190]],'selected','Selected event classification and accepted recovery reply boundary. Earlier broad displayed mirror/authorization code is navigation only, not full authority/journal certification.'),
 P+'desktop/src/main/mobile-remote/external-runtime-commands.ts':([[9,18],[56,87],[91,102]],[[1,145]],'selected','Persisted native/external route classification and selection boundary; authority calls/real external runtime execution not audited.'),
 P+'desktop/src/main/SessionSnapshotStore.ts':([[68,68],[179,205],[207,217]],[[62,74],[178,225]],'selected','Main-lifetime epoch, snapshot fields and onWorkerExit only marking owned run idle; persistence implementation excluded.'),
 P+'desktop/src/renderer/app/useHostSubscriptions.ts':([[966,989],[1054,1083]],[[963,992],[1050,1095]],'selected','Native mount restore and worker lifecycle clear of renderer Core cards; not a proof of synchronous Main cache clearing or all native effects.'),
 P+'desktop/src/renderer/pet/PetStateProvider.tsx':([[523,532]],[[520,544]],'selected','Existing renderer lifecycle callback applies worker-exit projection; no all-Pet callback guarantee.')
}
rows=[];capt=[];ending=[]
for p,x in pins.items():
 b=(R/p).read_bytes();ls=b.decode().splitlines();h=sh(b)
 ending.append({'path':p,'initialBytes':x['bytes'],'initialSha256':x['sha256'],'endingBytes':len(b),'endingSha256':h,'sameBytesAndSha256':len(b)==x['bytes'] and h==x['sha256']})
 if p not in S:continue
 sr,dr,coverage,purpose=S[p];ss=ex(sr);ds=ex(dr);assert ss<=ds and max(ds)<=len(ls)
 rows.append({**x,'coverage':coverage,'selectedLineRanges':sr,'semanticLines':len(ss),'displayedLineRanges':dr,'knownCapturedDisplayLines':len(ds),'displayCountIsLowerBound':True,'displayCoverageComplete':False,'additionalNavigationSnippetLines':[],'navigationOnlyDisplayedLineRanges':compact(ds-ss),'purpose':purpose,'newUniqueCoverageClaim':False,'initialSemanticReadSha256':x['sha256'],'finishSha256':h,'finishMatchesInitial':h==x['sha256']})
 capt.append({'path':p,'sha256':h,'atUTC':at,'captureTiming':'After actual bounded display; evidence reproduction only, not new semantic read or executable fixture','ranges':[{'start':a,'end':z,'lines':ls[a-1:z]} for a,z in sr]})
counts={'semanticFiles':len(rows),'full':sum(x['coverage']=='full' for x in rows),'selected':sum(x['coverage']=='selected' for x in rows),'productSemanticLines':sum(x['semanticLines'] for x in rows),'testDeclarationSemanticLines':0,'knownCapturedDisplayLineLowerBound':sum(x['knownCapturedDisplayLines'] for x in rows),'displayCoverageComplete':False,'newUniqueCoverageClaim':False,'navigationOnlyFiles':2,'instructionHashOnly':2}
nav=[{**pins[P+'desktop/src/main/mobile-remote/output-recovery-authority.ts'],'coverage':'navigation-only','knownNavigationLines':[20,38,105],'bodyRead':False,'purpose':'Only original rg snippets, not authority implementation review.'},{**pins[P+'desktop/src/main/main-output-publisher.ts'],'coverage':'navigation-only','knownNavigationLines':[123],'bodyRead':False,'purpose':'Only original rg snippet, no publisher implementation audit.'}]
save('source-manifest.json',{'atUTC':at,'role':'Independent targeted nonblind source reviewer of existing APPROVAL-R141-C1, not runtime verifier','rootReportedBaselineOnly':'f31a847f45e4805bce34aeb9e6db7efb503cfcb0','ownGitOperations':0,'files':rows,'navigationOnlyFiles':nav,'instructionHashOnlyFiles':[pins['AGENTS.md'],pins['CODESHELL.md']],'instructions':'Prior actual AGENTS5/CODESHELL217 reading carried under same SHA; no new semantic instruction read.','totals':counts,'displayLimitation':'One broad navigation output was truncated. Only clear bounded body display ranges counted; navigation not exhaustively reconstructed. Counts are display lower bound, not complete displayed union. All selected semantic ranges were fully visible later.','coverageOverlap':'Author141 frozen pending file full69 and selected callers are prior overlap; original older canonical R10 describes setter/restore selected. Directed hypothesis reread is not new unique coverage.','mechanismLimits':'Permission/identity/native worker spawning/authority/journal custody/real connection correctness not certified.'})
save('source-excerpts.json',{'files':capt,'productExecution':0})
hist=load('history-gate.json');author=load('author-input-pins.json');metadata=[]
for x in [hist['canonicalPin']]+author['files']:
 p=Path(x['path']);p=p if p.is_absolute() else R/p;b=p.read_bytes();metadata.append({'path':str(p),'initialSha256':x['sha256'],'finishSha256':sh(b),'sameBytesAndSha256':len(b)==x['bytes'] and sh(b)==x['sha256']})
p=Path(hist['sharedBatch']['path']);b=p.read_bytes()
save('ending-checks.json',{'atUTC':at,'sourceAndInstructionPins':ending,'all17SourceAndInstructionPinsSame':all(x['sameBytesAndSha256'] for x in ending),'canonicalAndAuthorInputs':metadata,'allCanonicalAndAuthorInputsSame':all(x['sameBytesAndSha256'] for x in metadata),'sharedBatch':{**hist['sharedBatch'],'endingBytes':len(b),'endingSha256':sh(b),'sameBytesAndSha256':len(b)==hist['sharedBatch']['bytes'] and sh(b)==hist['sharedBatch']['sha256']},'limits':'No own whole-history ending inventory or Git verification; shared batch byte equality is not verification of all 5850 members.'})
save('candidate-review.json',{'id':'APPROVAL-R141-C1','reviewRole':'Independent nonblind directed source review','opinion':'Withdraw original persistent-cache trigger; source defect not established, 0 active candidate in this review','confirmedFormal':False,'decisiveCounterevidence':[{'source':'packages/desktop/src/main/index.ts','ranges':[[2094,2107],[2127,2127]],'meaning':'Normal Main setup unconditionally starts PetImDecisions whose read samples worker alive/generation and clears cache.'},{'source':'packages/desktop/src/main/pet/pet-im-decisions.ts','ranges':[[139,143],[156,160]],'meaning':'start schedules immediate tick plus 5000ms interval; tick calls options.read before decisions.'}],'residualSourceFacts':[{'source':'packages/desktop/src/main/SessionSnapshotStore.ts','ranges':[[68,68],[207,217]],'meaning':'Main snapshot epoch is stable across one worker exit, onWorkerExit only sets run idle.'},{'source':'packages/web/src/hooks/useRemoteApp.ts','ranges':[[735,753],[1251,1289]],'meaning':'Selected epoch reset and raw callback do not independently prove all stale requests are filtered; called helper/reducer internals and complete timing not certified.'}],'limits':['A possible replay before next poll is not promoted as a new timing bug. No immediate consistency requirement and complete deterministic ordinary stale-card trigger established in this bounded read.','5000ms interval registration is not an observed or guaranteed cleanup deadline. No real worker crash, timer, socket, React or approval experiment.','No proof or claim of permission bypass, successor accepting predecessor requests, successful stale decisions, or all-client lifecycle correctness.'],'formalCounts':{'newFormal':0,'activeCandidate':0,'newRelated':0},'rootFinalDisposition':'Root decides archival disposition separately; frozen author141 candidate remains unchanged.'})
save('classification.json',{'newFormalFindings':[],'activeCandidates':[],'newRelated':[],'counts':{'newFormal':0,'newCandidate':0,'newRelated':0},'existingCandidateUpdate':{'id':'APPROVAL-R141-C1','opinion':'Withdraw original unbounded/no-other-read rationale on actual scheduled-reader counterevidence; no source-established defect in this bounded review.'},'oldCause':'R19 alive-worker approval delivery timeout and error-local lost card is a separate known cause, neither repeated nor cleared.'})
save('history-read-windows.json',{'sharedHistoryScope':hist['scope'],'pendingPathMatches':36,'cap':100,'all36Retained':len(next(iter(hist['hits'].values())))==36,'actualCanonical':{'path':hist['canonicalPin']['path'],'lineRanges':[[55,81]],'decisiveLines':[67,69,71,76,77,79,81],'meaning':'R10 R19 is same alive worker still pending after delivery failure; dead/newgen setter protection is conditional on actual callers and does not itself prove all sampling coverage.'},'authorMetadata':{'directory':'/tmp/codeshell-audit-round141-pairing/','read':['report.md whole','candidate.json whole','source-manifest.json selected row fields for all files and keys, not excerpts/body']},'notRead':'No new whole-corpus semantic scan; no author source-excerpts/test/runtime log; no raw output expanded from derived coverage claims.','directedOverlap':'Older R10 selected setter/resync discussion and current frozen141 full69/selected caller overlap retained; no claim these source bytes were previously unread.','permanentFailedDirections':'All old failed dynamic directions remain skipped; no worker crash/native/approval replay fixture attempted.'})
save('diagnostics.json',{'firstWideNavigation':{'commandDescription':'rg snapshot/Pet references plus support pins then overly broad read/on patterns across three pinned files','warning':'Warning: truncated output (original token count: 11150); total output lines 404; max output budget 3700','nestedExitCode':'Not printed by wrapper; do not infer a captured exit code','disposition':'Preserved first diagnostic. Missing middle navigation lines are not counted as observed. Later bounded body reads were fully visible, no product rerun.'},'productAttempts':0,'productFailures':0,'metadataGenerationErrors':[],'scope':'This truncation is metadata/source navigation output, not a product failure or source behavior observation.'})
save('validation.json',{'productExecution':0,'helperExecution':0,'productImports':0,'fixturesRun':0,'testsRun':0,'ReactDomTimerRun':0,'networkNativeModelRealWorkerCrash':0,'gitOperations':0,'testDeclarationsRead':0,'metadataProcessing':'Own Python standard-library JSON/hash/range/link/receipt processing only; not execution of product methods or author scan method.','checks':{'files':[]},'runtimeConclusion':'No runtime candidate verification or fix confirmation; old candidate source premise countered statically, no whole approvals subsystem clearance.'})
report=f'''# prep142：手机 pending 审批重放候选的独立反证复核

**建议撤回 APPROVAL-R141-C1 原“worker 退出后没有其它读取便长期保留缓存”的触发论证；本复核 0 新正式、0 活跃候选、0 new-related。** 这是已知假设的独立源码复核，已读冻结141的报告、候选和 manifest 元数据，非盲审。没有运行 worker、审批、React、timer、网络或测试。

关键反证是实际无条件启动的周期 reader，而非推测消费者可能读：Main `index.ts:2094–2107` 构造 PetImDecisions 的 `read`，先用 Bridge alive/generation 调用 `setWorkerState`，随后读 cache；`:2127` 正常初始化立即 `start()`。`pet-im-decisions.ts:139–143` 安排即时 tick 与5000ms interval；`:156–160` tick 的第一项工作就是 `options.read()`。所以原来“没有 outbound/native/Pet read 就无限残留”的缺省情景遗漏了真实周期读取。interval 注册并不是本轮观察到的清理时限或严格5秒 SLA。

## 亲读支持与限制

- `pending-approvals.ts:13–16` 在 dead/newgen 清 cache；`:57–63` replay 自身不采样，Root141 这项源码观察仍成立。Main `:1826–1831` outbound、`:6957–6966` native pending IPC、`:2097–2105` Pet read 是采样入口；不能从前两个入口不触发推断第三个不触发。
- 手机 `handle-client-event.ts:236–250/282–315/567–590` 的 select/sync，经实际 callback `mobile-remote-orchestrator.ts:245–268/332–367` 重放 cache。selected external route/recovery 源码未显示普通 native replay 前必定采样 worker；但这些选段不认证完整 authority/journal/连接机制，也不独立构成缺陷。
- Bridge `:435–479` 的 exited/spawn-error 分支发 renderer lifecycle 与 Pet projection，并维护 snapshots；所读 `safeSend:1145–1166` 为 renderer 通道。`getSnapshot:2019–2021` / last context `:2335–2337` 是本地数据。没有以单个 onExit 未直接调用 setter 证明所有 observer 缺失。
- `SessionSnapshotStore.ts:68/207–217` 表明 snapshot epoch 属 Main store，worker exit 只将所属 run 标 idle。手机 selected `useRemoteApp.ts:735–753` 在 epoch 改变时清卡，`:1251–1289` raw callback构造 approval；`useRemoteSocket.ts:189–198/245–253` 路由 raw notification。**这些范围不足证明完整客户端不会过滤旧卡**，因为被调用 helper/reducer及全部生命周期未展开。它们也不足把下一次 poll 之前的可能窗口单独升级为明确正常缺陷。
- 原生 renderer `useHostSubscriptions.ts:1054–1060` 在退出时清本地 Core cards；其 mount restore `:966–989` 有 invalidation 防护。Pet renderer selected lifecycle也会投影退出。这里没有声称原生清卡一定同步清 Main cache，或手机与原生实现相同。

因此保留“直接 replay 不自行采样”的局部事实，但不为了保住候选扩成任意5秒时序。当前缺少该窗口的完整确定普通触发、立即重放一致性合同及客户端长期残留闭环；未制造特殊调度、崩溃或坏 DTO，未声称死 worker 的旧审批成功执行、跨 generation 权限绕过或继任者接受前任请求。Root 可单独归档最终 disposition；冻结141原候选不回写。详见[候选复核](candidate-review.json)和[分类](classification.json)。

## 旧因、范围与冻结

亲读旧 `approval-quality-round10.md:55–81`：R19限定相同 alive worker 仍在等待、交付失败后普通卡消失；`:76` dead setter、`:77` resync 是相关保护。该旧条目不等于本候选已成立，也不因本轮轮询反证被清除。Root 共享[历史gate](history-gate.json)为5850 MD/JSON、4251467递归 JSON value scalar、0 parse error，纳冻57排58+；pending36命中均保留、cap100，机器扫描不是全史语义。实际窗口见[历史范围](history-read-windows.json)。没有再扫百万scalar或恢复旧失败实验。

[源 manifest](source-manifest.json)是{counts['semanticFiles']}产品文件：{counts['full']}full（pending69与冻结141同SHA全文重叠）+{counts['selected']}selected，{counts['productSemanticLines']}普通语义行，0测试声明；另2文件仅导航、2指令沿用旧实际读并核同SHA。显示已明确捕获的下限{counts['knownCapturedDisplayLineLowerBound']}行；首次宽导航11150tokens输出截断，未知中段不算已读，见[首诊断](diagnostics.json)。后续用于语义结论的有界body均完整可见；机制边界实际显示不扩成全机制审查，不宣称新增唯一覆盖。

[初始pin](initial-pins.json)、[支持pin](support-pins.json)、[反证pin](counterevidence-pins.json)均先于本读者该源body/行号导航。[选段证据](source-excerpts.json)为实际显示后复制的已读范围，不运行其中表达式。[结束核对](ending-checks.json)17个源/指令pin、4个原历史/作者输入和共享batch全部同字节；不据此认证未来 Git 或全部历史成员。Root提供基线 `f31a847f45e4805bce34aeb9e6db7efb503cfcb0` 仅上下文，自身Git0。

[验证边界](validation.json)、[冻结检查](freeze-checks.json)、[作者输入pin](author-input-pins.json)、[自排除收据](reviewer-receipt.json)保留；元数据的 `checks.files=[]` 不冒充新的源码阅读或运行确认。
'''
(O/'report.md').write_text(report)
# Planned self-generated links are checked again after receipt; no source runtime.
links=re.findall(r'\]\(([^)]+)\)',report)
assert all((O/x).is_file() for x in links if x not in ['freeze-checks.json','reviewer-receipt.json'])
save('freeze-checks.json',{'atUTC':at,'checks':{'files':[]},'role':'Own reviewer metadata finalization, not new independent source reading','rangeChecks':{'semanticSubsetOfCapturedDisplayed':True,'withinPinnedLineBounds':True,'totals':counts},'links':[{'target':x,'insideOwnedDir':(O/x).resolve().is_relative_to(O.resolve()),'existsOrSelfGenerated':(O/x).exists() or x in ['freeze-checks.json','reviewer-receipt.json']} for x in links],'plannedSelfGenerated':['freeze-checks.json','reviewer-receipt.json'],'allSourcePinsSame':all(x['sameBytesAndSha256'] for x in ending),'allCanonicalAndAuthorPinsSame':all(x['sameBytesAndSha256'] for x in metadata),'productExecution':0,'git':0})
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':sh(b)})
save('reviewer-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'role':'Independent targeted source review; receipt author metadata only','files':files})
for x in links:assert (O/x).is_file() and (O/x).resolve().is_relative_to(O.resolve())
for x in files:
 b=(O/x['path']).read_bytes();assert len(b)==x['bytes'] and sh(b)==x['sha256']
print('COUNTS',json.dumps(counts));print('ARTIFACTS',len(files)+1,'ROWS',len(files),'LINKS',len(links))
for n in ['report.md','source-manifest.json','reviewer-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),sh(b))

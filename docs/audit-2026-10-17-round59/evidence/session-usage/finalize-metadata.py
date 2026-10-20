from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round147-session-usage')
def h(b):return hashlib.sha256(b).hexdigest()
def load(n):return json.loads((O/n).read_text())
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def ex(rs):return {i for a,z in rs for i in range(a,z+1)}
def compact(s):
 r=[]
 for i in sorted(s):
  if r and i==r[-1][1]+1:r[-1][1]=i
  else:r.append([i,i])
 return r
at=datetime.datetime.now(datetime.timezone.utc).isoformat();pins={}
for n in ['initial-pins.json','support-pins.json','producer-pins.json','response-producer-pin.json']:
 for x in load(n)['files']:pins[x['path']]=x
S={
 'packages/core/src/session/usage.ts':([[1,149]],[[1,149]],'full','product','Directed reread of known same-SHA R19 full leaf, not new unique coverage. Pure additive/fold/versioned foreground cache contract; no pricing/provider behavior execution.'),
 'packages/core/src/engine/run-accounting.ts':([[21,118],[145,159]],[[1,174]],'selected','product','Foreground vs external billed response counters, normal model facade totals and summarize returned usage funnel; budget termination/assertion mechanism not certified.'),
 'packages/core/src/engine/run-state-persistence.ts':([[1,110]],[[1,110]],'full','product','Ordinary captured-minus-committed merge and output fields; manager CAS/FS/locks/ownership enforcement implementation not read or certified.'),
 'packages/core/src/engine/engine.ts':([[1776,1786],[2083,2087],[2771,2778],[2790,2794],[3480,3481],[3555,3569],[3583,3593],[3890,3919],[3955,3965]],[[1776,1789],[2078,2088],[2768,2800],[3468,3485],[3555,3600],[3870,3930],[3950,3968]],'selected','product','Actual per-run ownUsage/ownCacheUsage bindings, accounting constructor, response callback wiring, heartbeat, late auxiliary checkpoint and persistence call. Nearby owner/lease/finalizer/authority routes navigation only.'),
 'packages/core/src/engine/model-facade.ts':([[307,309]],[[300,310]],'selected','product','Actual getUsage delegates to per-run client tracker; client/provider implementation and network not read.'),
 'packages/core/src/engine/run-finalize.ts':([[360,370],[383,393]],[[355,395]],'selected','product','Final cumulative field commit before usage publication, separate foreground single-turn cache metrics; transcript flush/hook mechanics navigation only.'),
 'packages/core/src/engine/turn-loop.ts':([[816,834],[836,889],[1202,1206]],[[802,889],[1183,1212],[1344,1375]],'selected','product','Normal response usage records run/session counters and emits provider/single-turn/session cumulative fields. Other abort, truncation, Goal and clock sections navigation only.'),
 'packages/core/src/engine/run-state-persistence.test.ts':([[27,47],[54,56],[61,99]],[[1,99]],'selected','test-declaration','Two existing cases assert independent billed/cache checkpoints, heartbeat idempotence, other-owner auxiliary additions and failed-write checkpoint retention. Fixture setup/native calls displayed only, never executed.')
}
extra={
 'packages/core/src/engine/engine.ts':[31,106,108,109,1782,1783,2054,2084,2085,2086,2121,2158,2167,2178,2195,2200,2219,2742,2744,2771,2774,2777,2790,2828,2830,2956,2957,3000,3358,3359,3383,3384,3480,3562,3568,3585,3590,3673,3715,3904,3909,3910,3916,3917,3958],
 'packages/core/src/engine/run-finalize.ts':[18,27,149,150,175,187,250,255,361,362,367,369,385],
 'packages/core/src/engine/model-facade.ts':[307,308],
 'packages/core/src/engine/turn-loop.ts':[170,823,836,1204,1205,1337,1370,1371,2054,2055]
}
rows=[];ends=[];snips=[]
for p,x in pins.items():
 b=(R/p).read_bytes();ls=b.decode().splitlines();hh=h(b);ends.append({'path':p,'initialBytes':x['bytes'],'initialSha256':x['sha256'],'finishBytes':len(b),'finishSha256':hh,'sameBytesAndSha256':len(b)==x['bytes'] and hh==x['sha256']})
 if p not in S:continue
 sr,dr,cov,kind,purpose=S[p];ss=ex(sr);ns=set(extra.get(p,[]));ds=ex(dr)|ns;assert ss<=ds and max(ds)<=len(ls)
 rows.append({**x,'coverage':cov,'sourceKind':kind,'selectedLineRanges':sr,'semanticLines':len(ss),'displayedLineRanges':dr,'additionalNavigationSnippetLines':sorted(ns-ex(dr)),'uniqueDisplayedLines':len(ds),'navigationOnlyDisplayedLineRanges':compact(ds-ss),'purpose':purpose,'fullFileReadingClaimed':cov=='full','priorCoverage':'Usage same-SHA full established; run-accounting prior selected established; other overlap not exhaustively reconstructed. No new unique coverage claim.','newUniqueCoverageClaim':False,'initialSemanticReadSha256':x['sha256'],'finishSha256':hh,'finishMatchesInitial':hh==x['sha256']})
 snips.append({'path':p,'sha256':hh,'capturedUTC':at,'timing':'After actual bounded display; evidence reproduction only, no additional semantic read/execution','ranges':[{'start':a,'end':z,'lines':ls[a-1:z]} for a,z in sr]})
nav=[{**pins['packages/core/src/engine/engine.primary-cache-accounting.test.ts'],'coverage':'navigation-only','navigationLines':[153,249],'semanticLines':0,'purpose':'Only two existing test titles located, no case body read or run.'}]
hashonly=[pins[p] for p in ['packages/core/src/session/stream-timing.ts','packages/core/src/session/usage.test.ts','packages/core/src/session/stream-timing.test.ts','packages/core/src/session/output-publisher.ts']]
counts={'semanticFiles':len(rows),'full':sum(x['coverage']=='full' for x in rows),'selected':sum(x['coverage']=='selected' for x in rows),'productSemanticLines':sum(x['semanticLines'] for x in rows if x['sourceKind']=='product'),'testDeclarationSemanticLines':sum(x['semanticLines'] for x in rows if x['sourceKind']=='test-declaration'),'uniqueDisplayedLines':sum(x['uniqueDisplayedLines'] for x in rows)+2,'displayCoverageComplete':True,'navigationOnlyFiles':len(nav),'hashOnlyFiles':len(hashonly),'instructionHashOnly':2,'newUniqueCoverageClaim':False}
save('source-manifest.json',{'atUTC':at,'rootReportedBaselineOnly':'c39eb6f987b7bd5d740fee6d8ab5b46718f9c9af','role':'Independent bounded normal producer→per-run counters→session commit→usage event source reviewer, not runtime verifier','files':rows,'navigationOnly':nav,'hashOnly':hashonly,'instructionHashOnly':[pins['AGENTS.md'],pins['CODESHELL.md']],'instructions':'Prior actual AGENTS5/CODESHELL217 reading carried under unchanged SHA, no semantic reread this task.','counts':counts,'scopeLimits':'No provider SDK/timer/model/clock experiment, real session files/config, manager lock/CAS/permission/identity/custody or full UI consumer review. Stream timing body excluded before read as old same-SHA full.'})
save('source-excerpts.json',{'files':snips,'productExecution':0})
can=[]
for n in ['canonical-before-pins.json','old-cause-before-pin.json']:
 can.extend(load(n)['files'])
navhits=load('targeted-history-navigation.json')['files'];histend=[]
for x in can+navhits:
 b=(R/x['path']).read_bytes();histend.append({'path':x['path'],'initialSha256':x['sha256'],'finishSha256':h(b),'sameBytesAndSha256':len(b)==x['bytes'] and h(b)==x['sha256']})
batch=load('shared-history-projection.json')['sharedBatch'];bb=Path(batch['path']).read_bytes()
save('ending-checks.json',{'atUTC':at,'sourceAndInstructionPins':ends,'all15SourceAndInstructionPinsSame':all(x['sameBytesAndSha256'] for x in ends),'canonicalAndRawNavigationPins':histend,'all5CanonicalAnd31NavigationPinsSame':all(x['sameBytesAndSha256'] for x in histend),'sharedBatch':{**batch,'finishBytes':len(bb),'finishSha256':h(bb),'sameBytesAndSha256':len(bb)==batch['bytes'] and h(bb)==batch['sha256']},'limits':'No Git query or full-history ending inventory; equality of shared batch does not reverify every6010 historical member.'})
save('gate-decision.json',{'usage':{'currentSha256':pins['packages/core/src/session/usage.ts']['sha256'],'canonical':'docs/audit-2026-10-17-round19/evidence/root-source-manifest.json#/files/4','exactScope':'Full static leaf; prior round9 accounting direction excluded, no runtime.','decision':'Same-SHA old full; later directed body reread expressly retained as overlap, no new unique coverage.'},'timing':{'currentSha256':pins['packages/core/src/session/stream-timing.ts']['sha256'],'canonical':'docs/audit-2026-10-17-round19/evidence/timing-source-manifest.json#/files/0','md':'docs/audit-2026-10-17-round19/timing.md:7','decision':'Same-SHA explicit full1–41; body-before gate exclusion, current body0.'},'actualProducerScope':'Root retained actual producer→session cumulative field problem. Directed run-accounting/run-state-persistence + necessary selected Engine/TurnLoop/finalize/ModelFacade read; no mechanical fallback leaf.','canonicalWindows':[{'path':can[0]['path'],'pointers':['/files/17','/files/21']},{'path':can[1]['path'],'pointers':['/files/4']},{'path':can[2]['path'],'pointers':['/files/0','/files/5']},{'path':'docs/audit-2026-10-17-round19/timing.md','lineRanges':[[1,42]]},{'path':'docs/audit-2026-10-17-round9/usage.md','lineRanges':[[1,26]]}],'unknownIsUnread':False,'hashIsSemanticCoverage':False})
save('classification.json',{'formalFindings':[],'candidates':[],'newRelated':[],'counts':{'newFormal':0,'newCandidate':0,'newRelated':0},'oldCauseScopeExclusions':[{'id':'COST-R9-01','actualCanonicalRead':'round9/usage.md5–13','cause':'Unbound standalone CostTracker canonicalizes away full model pricing ID, not current normal session ledger/counter merge; no revalidation or cleared status claimed.'},{'label':'OM3/OM4','source':'Root assigned permanent scope exclusions; original OM metadata not newly semantically reviewed here','disposition':'Timing helper body skipped, no timezone-history ordering or parallel-tool-start issue investigated/reported.'},{'label':'Old pricing/cached-token accounting and failed clock/token-capacity directions','disposition':'No new issue proposed from these old families; no pricing refresh, billing computation test, fake NaN/time/capacity or failed dynamic experiment resumed.'}],'boundedConclusion':'No new normal field-drop/duplicate-accumulation counterexample established in selected producer/session checkpoint contract. Not whole accounting or concurrent storage certification.'})
save('validation.json',{'productExecution':0,'helperExecution':0,'imports':0,'fixturesRun':0,'testsRun':0,'modelClockTimerNetworkNativeGit':0,'existingDeclarationScope':'run-state-persistence.test.ts two test declarations selected; four additional test titles/old test results are not current execution. No old pass borrowed.','mechanismBoundary':'updateSessionRunState success/throw boundary and provided latest/captured fields read, not full manager lock/CAS/authority implementation or disk behavior.','metadataOnlyFinalization':{'checks.files':[],'method':'Python standard-library range, byte/hash, JSON, excerpt reproduction, link and self-excluded receipt processing.'}})
save('diagnostics.json',{'productAttempts':0,'productFailures':0,'navigationFailures':[],'metadataGenerationErrors':[],'truncations':[],'note':'All actual bounded source/canonical outputs used for reading completed under tool budget, no observed nonzero/truncated prep147 direction; no replacement product run. Waited for Root148 final batch signal before canonical/source body.'})
report=f'''# prep147：普通 run usage 到 session 累计字段静态复核

**有限0新正式问题、0候选、0new-related。** 实际 producer→foreground/external run计量→session增量提交→usage event字段链未建立正常输入下的丢字段或重复累计反例。本轮产品/helper/import/fixture/test/模型/时钟/timer/native/网络/Git执行均0。

Root提供冻结上下文 `c39eb6f987b7bd5d740fee6d8ab5b46718f9c9af`。指令沿用此前实际AGENTS5/CODESHELL217阅读并核同SHA；不认证Git。逐源[初始pin](initial-pins.json)、[支持pin](support-pins.json)、[真实producer pin](producer-pins.json)、[response producer pin](response-producer-pin.json)均先于各自body或行号导航。

## 原全文与定向范围

亲核原对象后，usage同SHA在R19 `root-source-manifest#/files/4`明确full static leaf；R9该对象只selected，不能以R9替代后来的全文。stream-timing在R19 `timing-source-manifest#/files/0`与`timing.md:7`明确同SHA全文1–41，因此本轮不读timing正文。后续按Root保留的实际生产计量链，usage149行只是定向重读旧full，不宣称新增唯一覆盖。run-accounting原R9 `/files/21`只有selected；旧publisher full175行SHA与当前176行不同，未套同SHAfull且未机械转读publisher。见[gate](gate-decision.json)。

## 实际链与反证

- Engine `:2771–2778/3480–3481`创建并传递真实计量回调；TurnLoop `:1202–1206`在正常provider response有usage时调用 `recordResponseUsage`，`:816–834`同时累计run并回调session foreground。`emitCtxFromUsage:836–889`区分provider当前prompt、single-turn字段与session cumulative/legacy alias；没有把固定prompt大小当作停止累计的条件。
- `run-accounting.ts:33–87`将foreground response加入runCacheUsage与session cache计数；辅助billed usage用独立externalRunUsage，正常`getRunUsage:106–118`才把它加入全部计费token总量。`:145–159`普通aux summary返回usage的接线也走该独立通道。foreground cache与所有billed输入不同是明确注释/字段合同，不据此报漏计。
- Engine `:1776–1786/2083–2087`为具体run建立两个零检查点与ownUsage/ownCacheUsage；`run-state-persistence.ts:43–99`捕获own计数，提交captured-minus-committed到最新state的tokenUsage和独立cache累计，成功后才推进两个checkpoint。普通异常分支返回false且不推进checkpoint；失败提交不被当作成功累计。本读者没有运行失败注入或认证manager内部CAS/锁/FS机制。
- Engine heartbeat `:3555–3569`与finalize `:360–370`先调用持久化，成功后才发 `sessionCumulativeUsageUpdate`。后者`:11–26`以提交后的session state生成cumulative与session*别名，避免只发布原run本地临时计数。`run-finalize:383–393`另发single-turn foreground cache；两种指标用途不同。
- late auxiliary路径 Engine `:3890–3919`先将该delta交session manager，再仅对匹配源run推进已提交usage，保持foreground cache checkpoint独立。这里只核给出的参数/字段及成功后数据流，没有认证其他进程、真实并发、账单或用户数据。
- usage中的add、fold与cache migration已有同SHA全文旧读，本轮确认引用合同而不恢复旧pricing/cached-token实验。`foldRunUsage`明确baseline+current，而提交层再只采用本run未提交delta；不能把同一heartbeat内出现两种表达直接当作重复累加。

既有 `run-state-persistence.test.ts`两项声明对照heartbeat幂等、不同owner辅助增量、billed/cache分离与失败写入不推进checkpoint；仅阅读声明，**未运行**。其FS fixture setup只作导航，不由这些断言证明本轮系统行为。

## 去重、计数与冻结

亲读 `round9/usage.md:1–26`：COST-R9-01限未绑定账本的独立CostTracker完整模型ID丢失，不扩大到当前主流程或实际账单；旧R19 `timing.md:1–42`的受控时钟/旧pass仅历史元数据。OM3时区排序、OM4并行工具起点及旧pricing/cache家族为本批范围排除，未重读原OM报告或重报。已有失败clock/token容量/native方向继续跳过。

Root148[历史投影](shared-history-projection.json)含冻58排59+：6010 MD/JSON、4291442递归JSON value scalar、0parse，含archive不查keys。usage87/timing59均低于cap100且保留全部；机器命中不是全史语义穷尽。另31份[原始路径/SHA导航](targeted-history-navigation.json)仅字节pin。原[canonical pin](canonical-before-pins.json)与[旧因pin](old-cause-before-pin.json)保存准确原窗口，未导入作者方法或旧fixture。

[源manifest](source-manifest.json)：{counts['semanticFiles']}语义文件，{counts['full']}full（usage149明确旧重叠）/{counts['selected']}selected，{counts['productSemanticLines']}产品语义行+{counts['testDeclarationSemanticLines']}测试声明行，实际显示联合{counts['uniqueDisplayedLines']}行；另1文件仅导航、4文件仅hash、2指令hash。不宣称新增唯一覆盖或全会计机制无bug。[摘录](source-excerpts.json)在实际显示后仅复制已读范围。

[首诊断](diagnostics.json)本轮无失败/截断，未运行任何产品实验。[结束核对](ending-checks.json)15源/指令pins、5canonical及31原导航pins、共享batch全部同字节；不据此验证全部6010成员或未来Git。[分类](classification.json)、[验证边界](validation.json)、[冻结检查](freeze-checks.json)、[自排除收据](reviewer-receipt.json)保留。
'''
(O/'report.md').write_text(report);links=re.findall(r'\]\(([^)]+)\)',report);planned=['freeze-checks.json','reviewer-receipt.json'];assert all((O/x).is_file() for x in links if x not in planned)
save('freeze-checks.json',{'role':'Author metadata finalization only, no new source read or execution','checks':{'files':[]},'rangeChecks':{'semanticSubsetOfDisplayed':True,'withinPinnedLines':True,'counts':counts},'links':[{'target':x,'insideOwnedDir':(O/x).resolve().is_relative_to(O.resolve()),'existsOrPlannedSelfGenerated':(O/x).is_file() or x in planned} for x in links],'plannedSelfGenerated':planned,'allSourcePinsSame':all(x['sameBytesAndSha256'] for x in ends),'allHistoryPinsSame':all(x['sameBytesAndSha256'] for x in histend),'productExecution':0,'git':0})
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':h(b)})
save('reviewer-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'role':'Independent bounded source review, own metadata receipt only','files':files})
assert all((O/x).is_file() and (O/x).resolve().is_relative_to(O.resolve()) for x in links)
for x in files:
 b=(O/x['path']).read_bytes();assert len(b)==x['bytes'] and h(b)==x['sha256']
print('COUNTS',json.dumps(counts));print('ARTIFACTS',len(files)+1,'RECEIPTROWS',len(files),'LINKS',len(links))
for n in ['report.md','source-manifest.json','reviewer-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),h(b))

from pathlib import Path
from datetime import datetime,timezone
import json,hashlib,re,subprocess
repo=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round64-tui-status');now=datetime.now(timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,x): (out/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def size(rr):return len({i for a,z in rr for i in range(a,z+1)})
pins=json.loads((out/'source-display-pins.json').read_text());initial=json.loads((out/'initial-pins.json').read_text());history=json.loads((out/'history.json').read_text())
ranges={
'packages/tui/src/ui/components/StatusLine.tsx':[[17,49],[125,126],[136,146],[157,177],[180,227]],
'packages/tui/src/ui/App.tsx':[[213,218],[292,293],[355,363],[389,393],[436,439],[446,446],[701,705],[711,711],[739,741],[800,803],[1063,1063],[1066,1066],[1070,1073],[1078,1082],[1543,1544],[1547,1547],[1559,1564],[1626,1629],[1636,1652],[1666,1681],[1717,1721],[2286,2297]],
'packages/tui/src/ui/components/StatusLine.test.tsx':[[1,23]],
'packages/core/src/tool-system/builtin/agent-registry.ts':[[120,133],[148,157],[176,177],[360,362],[370,370]],
'packages/core/src/tool-system/builtin/agent.ts':[[230,236],[269,273],[487,492],[499,499],[711,720]]}
notes={
'packages/tui/src/ui/components/StatusLine.tsx':'Ordinary props/context/elapsed/model/cost text only. Whole 227 lines displayed, 115 selected semantic lines; interval, perf instrumentation, logging/UI-event and renderer/TTY mechanism excluded. No full-file claim.',
'packages/tui/src/ui/App.tsx':'Ordinary prop/event/ref flow and foreground submission/response/duration labels only. QueryGuard internals, cancellation ownership, permission UI, transport, renderer and native mechanisms not reviewed. Initial rg navigation matches preceded dedicated pin, conservatively initialSemanticReadSha256=null; dedicated pin preceded selected block display.',
'packages/tui/src/ui/components/StatusLine.test.tsx':'Full 23-line existing test declaration text read; mounts/flush/assertions never executed. This is not a pass/result.',
'packages/core/src/tool-system/builtin/agent-registry.ts':'Only status aggregation, collection insertion/snapshot notification, terminal status/date fields. Adjacent 363–369 lease/direction fields accidentally displayed and excluded from semantic read; no authority/custody assessment. Initial navigation preceded dedicated pin; semantic selected body followed pin.',
'packages/core/src/tool-system/builtin/agent.ts':'Only declared ordinary background option, registration fields/status and foreground notification return/yield. Identity/session-tag/owner/abort/spawn/engine/transport mechanisms not reviewed. Initial navigation preceded dedicated pin; selected semantic blocks followed pin.'}
files=[]
for p in pins:
 rel=p['path'];b=(repo/rel).read_bytes();rr=ranges[rel];disp=p['displayedLineRanges'][:]
 if rel.endswith('agent.ts'):disp+=[[499,499]]
 if rel.endswith('agent-registry.ts'):disp+=[[176,177]]
 row={**p,'coverage':'full-test-declaration-text' if rel.endswith('StatusLine.test.tsx') else 'selected','selectedLineRanges':rr,'semanticLineCount':size(rr),'displayedLineRanges':disp,'displayedLineCount':size(disp),'purpose':notes[rel],'endingBytes':len(b),'endingSha256':sha(b),'unchanged':len(b)==p['bytes'] and sha(b)==p['sha256'],'endingCheckedUTC':now}
 row.pop('semanticRead',None)
 if rel.endswith('App.tsx'):row['initialSemanticReadSha256']=None;row['initialTextObservation']='unpinned rg navigation before dedicated pin; no first-read hash invented'
 else:row['initialSemanticReadSha256']=p['sha256'];row['initialTextObservation']='leaf/test before content pin; core files initial navigation before dedicated semantic pin disclosed in purpose'
 files.append(row)
current_paths=sorted(x for x in subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=repo,capture_output=True,text=True,check=True).stdout.splitlines() if not re.search(r'(^|/)audit-2026-10-17-round(?:47|48|49|50|51|52|53|54|55|56|57|58|59|60|61|62|63|64|65)(/|$)',x))
old={r['path']:r for r in history['inventory']};changed=[]
for rel,row in old.items():
 b=(repo/rel).read_bytes()
 if sha(b)!=row['sha256']:changed.append({'path':rel,'beforeSha256':row['sha256'],'endingSha256':sha(b),'beforeBytes':row['bytes'],'endingBytes':len(b)})
end={'checkedUTC':now,'scope':'Original 4255-member history, same dated exclusions; no backfill of newly frozen47. Metadata hashing only.','memberCount':len(old),'currentFilteredCount':len(current_paths),'added':sorted(set(current_paths)-set(old)),'removed':sorted(set(old)-set(current_paths)),'changed':changed,'sourceFileCount':len(files),'sourceUnchangedCount':sum(x['unchanged'] for x in files),'productSemanticNewReadThisFinalization':0}
write('ending-checks.json',end)
manifest={'schema':'static-source-manifest-v1','createdUTC':now,'rootReportedInitialContext':'c3a9ece2e6f183671b00e07322a9722fad6bda54','rootReportedLateContext':'2735100f81f4d12cbb3e610da0e3977eaf74727c','contextVerification':'Parent reported contexts only; reviewer performed no Git. Late change reportedly docs47 only; initial history snapshot not rewritten.','files':files,'summary':{'sourceRows':len(files),'fullProductRows':0,'selectedProductRows':4,'fullTestDeclarationTextRows':1,'productSemanticLines':sum(x['semanticLineCount'] for x in files if not x['path'].endswith('.test.tsx')),'testDeclarationSemanticLines':23,'allSemanticLines':sum(x['semanticLineCount'] for x in files),'allDisplayedLines':sum(x['displayedLineCount'] for x in files),'uniqueAcrossAuditClaim':False},'historyReads':{'pinSource':'history.json inventory pins precede saved windows','initialGate':'8 explicit metadata rows +17 path windows +7 SHA windows read; duplicate locators do not create independent coverage','focusedSelectedRows':14,'focusedReadFile':'history-focused-selected.json','notClaimed':'No semantic exhaustion of full MD/JSON corpus, full original giant scalar values, all cap30 windows or every old cause.'},'exclusions':['No product execution or Git','No authority/identity/custody mechanisms','No timer/React/Ink/TTY renderer behavior observed','Existing permanent failed runtime directions not reopened']}
write('source-manifest.json',manifest)
candidate={'id':'STATUSLINE-R64-C1','classification':'static-candidate','suggestedPriority':'P3','formalCount':0,'candidateCount':1,'newRelatedCount':0,'title':'同一前台查询仍运行时，后台忙闲变化重置共享耗时起点','ordinaryCondition':['A normal foreground query remains active. A normal background agent was already running.','The last background agent finishes, so hasRunningBgAgents changes true to false while isQueryActive stays true.','The ordinary UI commits this store-state change before that same foreground query ends. No forced React scheduling or actual frame was observed.'],'cause':'App.tsx436–439/446 depends on isRunning, isQueryActive and hasRunningBgAgents and rewrites runStartRef whenever any dependency changes while isRunning. OR remains true, but changing the background flag alone still rewrites the origin.','consumers':['StatusLine.tsx125–126/167–171 computes and displays current elapsed from this ref.','App.tsx1669–1681 uses the same ref for the system turn_duration entry.'],'symbolicConsequence':'For one foreground query with original origin t0, background completion committed at t1 and foreground completion at t2 (t0<t1<t2), these consumers use t1 instead of t0 and omit t1-t0. This is source arithmetic, not an executed fixture or observed UI trace.','counterevidence':['Starting a new foreground query legitimately needs a new origin and is not this proposed bug.','Stable running/query/background flags do not retrigger this effect.','Background Agent path requests runYield after the tool batch (agent.ts711–714); not every first-spawn transition is asserted to have a separately committed visible render.','No continuous session-wide or background-agent lifetime timing contract is asserted.','No React/Ink timing, actual elapsed display, task execution, persistent session message damage or billing impact was validated.'],'dedup':'Fresh4255 history, literal path/hash and focused ordinary elapsed/cost queries. No exact same-condition old issue established in actually read bounded windows. Old COST-R9-01 model-id pricing, old ctx run/runs and permanent rendering/import failures excluded; this does not prove all history semantically exhausted.','status':'Proposal only; parent targeted review may retain, narrow, withdraw or formalize separately. No formal ID issued here.'}
write('candidate.json',candidate)
write('validation.json',{'productExecutions':0,'productImports':0,'productHelperCalls':0,'testsRun':0,'fixturesRun':0,'reactInkTTYRendererRuns':0,'timerExperiments':0,'realProcessesOrTasks':0,'nativeOrNetworkCalls':0,'gitCalls':0,'metadataOnlyTools':'rg file/navigation searches; Python stdlib reads/hashes/JSON/scalar text indexing and artifact writing; no product code loaded.','recordedMetadataErrors':0,'metadataOutputTruncation':{'count':1,'exitCode':0,'diagnostic':'history-selected.first-output-diagnostic.json','repair':'Exact saved selected background-elapsed/index24 window reprinted; original selected JSON preserved, no history rescan.'},'endingCheck':'ending-checks.json','allCommandsWithObservedCompletionExit':'0; no test pass implied by any command success.'})
report='''# TUI StatusLine 普通数据静态前置审查

结果：0 formal / 1 static candidate / 0 new related。候选 **STATUSLINE-R64-C1（建议 P3）**：同一前台查询持续 active 时，最后一个后台任务完成若被普通 UI 提交，会重置共享耗时起点。保持候选提案，未观察真实帧，未执行任何产品、测试或计时器。

## 普通数据链与候选边界

`App.tsx213–218` 把前台查询与后台聚合忙闲状态 OR 成 `isRunning`；`436–439/446` 的 effect 同时依赖三者，任一变化后只要 OR 仍真就重写 `runStartRef`。`StatusLine.tsx125–126/167–171` 用该 ref 算运行耗时，`App.tsx1669–1681` 还把同一差值写为 `turn_duration`。正常后台选项、注册 running、snapshot 通知和终态 status/时间赋值已有限选读，详见[源码范围](source-manifest.json)、[摘录](source-excerpts.txt)和[单行生产字段](producer-status-selected.json)。

限定 case 是已有后台任务时开始一个前台查询，前台仍在进行而最后后台任务完成，bg true→false、query 保持 true，且状态变化在当前前台查询结束前被 UI 提交。起点 t0 被 t1 覆盖，结束 t2 的 footer 与 turn-duration 数据便减 t1，遗漏 t1−t0。这里只作源码算术推导，不是语言 fixture、真实时序或帧观察。详见[候选记录](candidate.json)。

反证与限制：新前台查询开始时重置合理，不作为 bug；稳定 flags 不重触 effect；Agent 后台路径 `711–714` 有 runYield，因此不声称每次首 spawn 都会出现独立可见帧。不推断 session 全程计时、后台任务生命周期计时、持久会话损坏或账单影响。QueryGuard、lease、owner、transport、模型与真实任务机制均未展开。Parent 将另做知情针对性复核，不因本提案自动升级。

## 其他普通显示检查

StatusLine 的 context 只用 App 的 base/max 比值并上限 100%；所读 App 事件把 promptTokens/compact after 传入，对 session_cumulative 有过滤。cost 字符串由 App 传入后直接显示；既有 23 行测试声明保留 unknown/partial 文本，本轮仅读声明，零执行。model 简写、token 缩写与 elapsed 文本有限阅读；未用非法 NaN/Infinity/乱码造反例。未另立问题，也不宣称全行为正确。

## 历史与覆盖口径

[完整机器库存](history.json)在 2026-10-17 15:49:52–55 UTC 记录 4255 个 docs/bugs MD/JSON（1423/2832，1765237 string values、2662013 scalar values，169 archive/_archive 路径，0 JSON parse errors）。纳已冻46、排47–65；完整递归 scalar 机器扫描不是人工全文语义阅读。当前 leaf 227 行/7462B，SHA `59bef2bd5014ce72d2d2d63e24ed7e10c20efb7e2355601a0264202cf8582c43`。

[首读 pin](initial-pins.json)、[显示前 pin](source-display-pins.json)、[覆盖 gate](coverage-gate-rows.json)与[路径/SHA窗口](history-contexts.json)记录 path17/SHA7、8 个库存或导航元数据行，未建立 same-SHA full；不把 rank/no-row 当未读。整 leaf 227 行被显示，但 interval/perf/记录/TTY 机制排除，故仅 selected 普通语义，不登记 product full。App 首次 rg 导航早于 dedicated pin，保守保留 initialSemanticReadSha256=null；后续所选正文在 dedicated pin 后读取。

[补充查询方法](history-focused-method.py)只针对原库存字面/AND，runStart1、status+elapsed3、background+elapsed31、cost-model50，cap30 保存1/3/30/30；实际选读[14个有限窗口](history-focused-selected.json)，不把命中或保存 cap 当历史穷尽。旧 COST-R9-01 模型 ID 定价、旧非 REPL ctx run/runs、i18n/diff/终端渲染与既有失败动态方向不重报。[原扫描方法](history-method.py)保留。

## 诊断、时点和冻结

首次 focused 选读显示 6512 tokens 超过6200输出限，命令 exit0；[首诊断](history-selected.first-output-diagnostic.json)与完整 selected JSON保留，随后仅补读被省略的 index24 窗口，无产品错误或重跑。registry360–370 意外显示相邻363–369 lease字段，仅360–362/370登记普通语义，不再进入机制。

Root 最初报告 c3a9ece…，后报告2735100…仅新增正式47 docs；本审查 Git0，不独立认证该提交。原4255纳46排47时点不倒填。[结束哈希](ending-checks.json)与[验证口径](validation.json)另列；finalize 仅元数据，不产生第二次源阅读。所有文件由[冻结收据](reviewer-receipt.json)固定，收据自排除。
'''
(out/'report.md').write_text(report)
# Frozen self-excluded metadata receipt; no author/product files modified.
receipt={'frozenUTC':datetime.now(timezone.utc).isoformat(),'directory':str(out),'selfExcluded':'reviewer-receipt.json','classification':{'formal':0,'candidate':1,'newRelated':0},'files':[]}
for p in sorted(out.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();receipt['files'].append({'path':p.name,'bytes':len(b),'sha256':sha(b)})
write('reviewer-receipt.json',receipt)
print(json.dumps({'summary':manifest['summary'],'ending':end,'artifacts':len(receipt['files'])+1,'report':{'bytes':(out/'report.md').stat().st_size,'sha256':sha((out/'report.md').read_bytes())},'manifest':{'bytes':(out/'source-manifest.json').stat().st_size,'sha256':sha((out/'source-manifest.json').read_bytes())},'receipt':{'bytes':(out/'reviewer-receipt.json').stat().st_size,'sha256':sha((out/'reviewer-receipt.json').read_bytes())}},ensure_ascii=False))

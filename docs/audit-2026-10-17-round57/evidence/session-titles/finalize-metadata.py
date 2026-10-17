from pathlib import Path
import json,hashlib,datetime,re
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round134-session-titles')
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,x):
 (OUT/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def line_set(ranges):return {n for a,b in ranges for n in range(a,b+1)}
def union_ranges(nums):
 z=[]
 for n in sorted(set(nums)):
  if z and n==z[-1][1]+1:z[-1][1]=n
  else:z.append([n,n])
 return z
pins={}
for name in ['initial-pins.json','consumer-before-pins.json']:
 for x in json.loads((OUT/name).read_text())['files']:pins[x['path']]=x
x=json.loads((OUT/'test-before-pin.json').read_text());pins[x['path']]=x
ui=json.loads((OUT/'ui-before-pins.json').read_text())
for x in ui['files']:pins[x['path']]={**x,'pinnedBeforeBodyUTC':ui['at']}
specs=[
 ('packages/server/src/session-titles-store.ts','product',[[13,24],[36,55],[121,150],[169,189]],[[1,189]],[], 'Entire physical file displayed; selected ordinary value/parser/queue/latest-map/CAS/clear contract. FS load/save, path/ID validation and lock/native enforcement are displayed boundaries, not semantic full or runtime certification.'),
 ('packages/server/src/index.storage.ts','product',[[11,11]],[[1,13]],[], 'Actual storage barrel export only; other exported services not reviewed.'),
 ('packages/desktop/src/main/session-titles-store.ts','product',[[6,7],[13,14]],[[1,14]],[], 'Desktop ordinary wrapper/default location boundary; test-only reset hook not activated.'),
 ('packages/desktop/src/main/activity-history-ipc.ts','product',[[27,35]],[[1,59]],[], 'sessions:list/titles/rename handlers; archive, transcript, usage and IPC authority plumbing displayed only.'),
 ('packages/server/src/hub/session-management.ts','product',[[155,157],[181,202],[205,213],[227,251],[275,278],[309,332],[338,339],[341,356]],[[150,357]],[14,373,395,396], 'Title-store choice, custom > durable-title > preview > default priority, bounded ordinary list projection, GET/PATCH/CAS/409/onChanged. Authorization/ownership/export/actual SessionManager and IO enforcement stop at displayed call boundaries.'),
 ('packages/desktop/src/renderer/sessions/SessionsView.tsx','product',[[101,112],[116,140],[254,278],[282,284]],[[101,140],[254,284]],[36,45,59,65,70,71,90,162,177,246,439,442,443,462,471,544,561,580,599,632,649,667,668,674,678,689,768], 'Ordinary list+override merge, stale-read version checks, await rename then callback/local projection, clear fallback and error handling. DOM/focus implementation and actual component mounting not exercised.'),
 ('packages/desktop/src/renderer/app/useSessionHistorySync.ts','product',[[40,64]],[[1,67]],[126], 'Successful rename callback implementation targets loaded aliases and marks manual; App hookup, delete callback body and cross-window lifecycle not newly reviewed.'),
 ('packages/web/app/HubSessions.tsx','product',[[284,309],[359,426],[428,455],[556,565],[632,644],[711,716]],[[261,316],[353,426],[428,455],[550,568],[630,644],[707,720]],[24,124,130,163,242,258,259,619,700,701], 'Editor baseline from customTitle; save/reset PATCH expectedTitle, 409 retains edit, explicit refresh updates baseline, successful reload and ordinary list effect. No HTTP/DOM/React/timer or real state execution.'),
 ('packages/server/src/session-titles-store.test.ts','test-declaration',[[19,29],[31,44],[46,51],[71,81]],[[1,81]],[], 'Existing bounded writes, malformed-map, null-prototype and CAS/reset declarations only. Setup/native permission branch shown but not semantically relied on; no test run or borrowed historical pass.'),
]
rows=[]; extracts=[]
for path,kind,selected,body,nav,scope in specs:
 pin=pins[path]; raw=(ROOT/path).read_bytes(); lines=raw.decode().splitlines()
 sem=line_set(selected); shown=line_set(body)|set(nav)
 assert sem<=shown and max(shown)<=len(lines)
 assert sha(raw)==pin['sha256']
 nav=sorted(set(nav)-line_set(body))
 row={'path':path,'bytes':len(raw),'sha256':sha(raw),'lineCount':len(lines),'kind':kind,'coverage':'selected-static; not-full semantic review' if kind=='product' else 'selected-existing-test-declarations; execution0','selectedLineRanges':selected,'selectedLineCount':len(sem),'bodyDisplayedLineRanges':body,'bodyDisplayedLineCount':len(line_set(body)),'additionalNavigationSnippetLines':nav,'displayedLineRanges':union_ranges(shown),'displayedLineCount':len(shown),'initialSha256':pin['sha256'],'initialPinUTC':pin['pinnedBeforeBodyUTC'],'initialPinTiming':'before own product body/navigation snippets','scope':scope,'originalPinRow':pin}
 rows.append(row)
 extracts.append(path+'\n'+'\n'.join(f'{n}: {lines[n-1]}' for n in sorted(shown)))
for path in ['CODESHELL.md','AGENTS.md']:
 p=pins[path];rows.append({'path':path,'bytes':p['bytes'],'sha256':p['sha256'],'lineCount':p['lines'],'kind':'instruction-reuse','coverage':'hash-only-this-packet; prior full instruction read reused','selectedLineRanges':[],'selectedLineCount':0,'bodyDisplayedLineRanges':[],'bodyDisplayedLineCount':0,'additionalNavigationSnippetLines':[],'displayedLineRanges':[],'displayedLineCount':0,'initialPinUTC':p['pinnedBeforeBodyUTC'],'originalPinRow':p})
counts={'productSelectedLines':sum(r['selectedLineCount'] for r in rows if r['kind']=='product'),'testDeclarationSelectedLines':sum(r['selectedLineCount'] for r in rows if r['kind']=='test-declaration'),'selectedTotalLines':sum(r['selectedLineCount'] for r in rows),'displayedUniqueSourceLines':sum(r['displayedLineCount'] for r in rows),'productRows':8,'testDeclarationRows':1,'instructionHashOnlyRows':2,'semanticFullRows':0,'runtimeValidationAttempts':0}
write('source-manifest.json',{'schema':'purpose-bounded-static-source-ranges/v1','createdAt':now(),'rootReportedBaseline':'1ba606416f4fc94c081159bb3fd10e58cd8d87f0','baselineIndependentlyGitCertified':False,'files':rows,'counts':counts,'rangeConvention':'One-based inclusive. Canonical display union = body + additional navigation. Selected is subset. Repeated displays counted once per file. Entire physical display is not semantic full. Old overlapping selected work not first/new unique full coverage.','overlap':{'R22':'/sources/9 same SHA selected120–189; explicit fs/lock no-execution boundary','R48':'/files/0 same SHA selected54 of189, our own old prep65 DTO-only report; not independent author','globalCoverageUpdated':False}})
(OUT/'source-excerpts.txt').write_text('\n\n'.join(extracts)+'\n')
# Exact old objects already personally read; no old author method executed.
p='docs/audit-2026-10-17-round22/evidence/title-source-manifest.json';b=(ROOT/p).read_bytes();x=json.loads(b)
old={'createdAt':now(),'files':[{'path':p,'bytes':len(b),'sha256':sha(b),'readJsonPointers':['/sources/9'],'canonicalRow':x['sources'][9],'firstHashTiming':'same own earlier input read before bounded JSON output'},{'path':'docs/audit-2026-10-17-round22/title-report.md','readLineRanges':[[1,15]],'initialSha256':None,'firstHashTiming':'late after bounded old-MD display; not backfilled as before-read pin'}],'purpose':'Exact old source overlap and existing dual-title/manual-guard counterevidence, not reused runtime evidence.'}
p=old['files'][1]['path'];b=(ROOT/p).read_bytes();old['files'][1].update(bytes=len(b),sha256=sha(b),lineCount=len(b.splitlines()))
write('prior-r22-metadata.json',old)
write('classification.json',{'formalFindings':[],'candidates':[],'relatedFindings':[],'counts':{'formal':0,'candidates':0,'related':0},'decision':'Finite negative for selected ordinary title-write/list/update contract. No proved ordinary new counterexample; no whole-store/permission/lock/runtime correctness conclusion.','exclusions':['Old manual-title vs automatic-title/double-source observations are existing evidence, not a new finding.','No invented requirement that Desktop optional CAS must be exposed or all list snapshots be globally transactional.','Title override removal via empty string differs from session archive/deletion. Full session deletion, account/owner semantics and underlying lock/native efficacy are outside this review.']})
write('diagnostics.json',{'metadataFailures':[],'productFailures':[],'presentationTruncations':[],'normalNoMatchResults':[],'runtimeAttempts':0,'gitCalls':0,'networkCalls':0,'productCalls':0,'existingTestsExecuted':0,'firstOutputPolicy':'No metadata command failures or output truncations occurred in this packet; no synthetic raw transcript output is invented. Commands used rg filename/line navigation and Python stdlib reads/metadata only.','bodyReadToolReferences':['8f1d84','a10509','c41551','f90d04','8e7ff4','36c50f','212c13'],'historyTiming':'Pinned leaf before own body; exact R48 old canonical/report read before leaf. Shared423-hit projection was obtained after first leaf body, not backdated as prebody. Additional old R22 object/report read later, finite range.','historyLimits':'Shared batch5676 MD/JSON includes frozen56 excludes57+, recursive values with archives.423 target hits retained100 cap100. Navigation only; no independent exhaustive semantic history review, no novelty inferred from absence. No rerun shared method.'})
# Ending checks only for own11 pins and bounded metadata inputs. Do not assert all5676 history files rehashed.
checks=[]
for path,pin in pins.items():
 raw=(ROOT/path).read_bytes();checks.append({'path':path,'bytes':len(raw),'sha256':sha(raw),'initialSha256':pin['sha256'],'sameSha256':sha(raw)==pin['sha256']})
meta=[]
prior=json.loads((OUT/'prior-canonical.json').read_text());meta.append((prior['document'],prior['sha256']))
x=json.loads((OUT/'prior-report-metadata.json').read_text());meta.append((x['path'],x['sha256']))
meta.append((old['files'][0]['path'],old['files'][0]['sha256']))
ref=json.loads((OUT/'shared-history-reference.json').read_text());meta.append((ref['source'],ref['sha256']))
mc=[]
for p,h in meta:
 raw=(Path(p) if p.startswith('/') else ROOT/p).read_bytes();mc.append({'path':p,'bytes':len(raw),'sha256':sha(raw),'initialSha256':h,'sameSha256':sha(raw)==h})
assert all(x['sameSha256'] for x in checks+mc)
write('ending.json',{'at':now(),'sourceAndInstructionChecks':checks,'all11SourceInstructionPinsSameSha256':True,'boundedMetadataChecks':mc,'all4ComparableMetadataInputsSameSha256':True,'lateMetadataOnly':[old['files'][1]],'historyInventoryRehashed':False,'scope':'No Git. Not an ending hash of all5676 original history entries; shared frozen batch bytes and four bounded comparable inputs only.'})
report=f'''# 会话标题读写与列表更新静态审查

结论：正式问题 **0**、候选 **0**、关联 **0**。本次检查普通 rename、空字符串清除 override、列表优先级与并发保存的源合同，未确认新的正常反例。产品、helper、测试、真实文件/会话、网络、模型及 Git 执行均为 **0**；没有修改产品。

存储层 [source ranges](source-manifest.json) 显示每实例队列把后续写入接在前次结算之后，并把拒绝隔离给该调用；`listTitles` 等待本实例队列后重新加载。写入同步临界段内先读最新 map，再检查可选 `expectedTitle`，非空赋值、空值删除 override，`finally` 释放锁。这里仅核调用顺序/值规则，未验证底层锁、原子文件系统操作、跨进程并发或权限有效性。

Hub 的普通 PATCH 传入比较基线，冲突映射为409；list/GET 用 customTitle > durable title > preview > 默认值。Web 编辑器从 customTitle 捕获基线，409保留草稿，只有显式读取才更新基线，成功写入触发 reload。Desktop 的历史页等待 rename IPC 写入成功后回填页面和 rename callback；空 override 立即回退 durable title。两入口合同不同，未凭 Desktop 不暴露可选 CAS 就推断缺陷。`useSessionHistorySync` 的回调实现选读，App hookup 未在本次重读；session 实体删除/归属与 archive 机制也不由 title-clear 规则认证。

旧证据见 [R48 canonical](prior-canonical.json)、[旧有限报告](prior-report-metadata.json) 和 [R22 原对象/窗口](prior-r22-metadata.json)：same-SHA 既有 selected/手动标题保护/双来源观察保留，不能称首次或全局新覆盖；R48 prep65 与本次为同一作者。共享 [history projection](history-projection.json) 只提供路径/SHA导航：5676 MD/JSON、含冻56排57+、recursive values及archives，423命中仅前100，0parse错误（批次由 Root 归档）。该批投影晚于首次叶子正文，不倒填前置时点；没有从无命中推断新颖，也未再次全史扫描。

范围：8产品 selected 行合计 **{counts['productSelectedLines']}**，测试声明 selected **{counts['testDeclarationSelectedLines']}**（不执行），总 **{counts['selectedTotalLines']}**；去重 display **{counts['displayedUniqueSourceLines']}**。store物理189行显示不等于语义全文；selected/body/nav/hash、边界和旧重叠逐项列于 manifest。未发现需晋升的普通反例；这不是整个 title/会话/生命周期系统正确性证明。见 [分类](classification.json)、[首次诊断与限制](diagnostics.json)、[ending](ending.json)；11源码/指令 pin与4个可比元数据输入 SHA 均保持，R22 MD为如实 late hash，不称初末一致。 [自排除交付收据](artifact-receipt.json) 记录冻结集合。
'''
(OUT/'report.md').write_text(report)
# Minimal metadata/link consistency checks; not product tests or author method execution.
links=re.findall(r'\[[^\]]*\]\(([^)]+)\)',report)
assert all((OUT/p.split('#',1)[0]).exists() or p=='artifact-receipt.json' for p in links)
write('metadata-checks.json',{'at':now(),'kind':'own stdlib metadata only; not product validation','rangeSubsetAndEOFChecks':True,'canonicalDisplayUnionChecks':True,'sourceSameSHA11':True,'boundedMetadataSameSHA4':True,'reportLinkCount':len(links),'reportLinks':links,'receiptSelfLinkWillExistAtFreeze':True,'sourceOrTestsExecuted':False})
print(json.dumps({'counts':counts,'links':len(links),'sourceChecks':len(checks),'metadataChecks':len(mc)},ensure_ascii=False))

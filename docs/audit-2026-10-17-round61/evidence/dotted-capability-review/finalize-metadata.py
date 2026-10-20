from pathlib import Path
import datetime
import hashlib
import json
import re

REPO=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round158-dotted-capability-review')
NOW=datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(b):
    return hashlib.sha256(b).hexdigest()

def save(name,value):
    (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')

def nums(rs):
    return {n for a,b in rs for n in range(a,b+1)}

def spans(ns):
    result=[]
    for n in sorted(set(ns)):
        if result and result[-1][1]+1==n:
            result[-1][1]=n
        else:
            result.append([n,n])
    return result

initial=json.loads((OUT/'initial-pins.json').read_text())
pins=initial['files']+[json.loads((OUT/'project-pin.json').read_text())]
archive='docs/archive/bug-followups-2026-08-13.md'
service='packages/core/src/capability-control/service.ts'
overlay='packages/core/src/capability-control/overlay.ts'
manager='packages/core/src/settings/manager.ts'
project='packages/core/src/capability-control/project.ts'
form='packages/desktop/src/renderer/settings/McpSection.tsx'
body={service:[[69,74],[87,92],[105,120],[133,180]],overlay:[[18,64]],manager:[[58,112],[137,165],[568,590]],project:[[52,81]],form:[[415,455],[1256,1288],[1315,1342],[1371,1401]]}
selected={service:[[69,74],[89,92],[107,117],[133,164],[168,179]],overlay:[[18,64]],manager:[[83,92],[144,155],[572,584]],project:[[52,81]],form:[[422,425],[443,453],[1321,1337],[1393,1401]]}
nav_files={service:['service-navigation.first.stdout'],overlay:['overlay-navigation.first.stdout'],manager:['manager-navigation.first.stdout','manager-write-navigation.first.stdout'],project:['project-navigation.first.stdout'],form:['form-navigation.first.stdout']}
rows=[]
for pin in pins:
    p=pin['path']
    if p==archive:
        continue
    b=(REPO/p).read_bytes();assert sha(b)==pin['sha256'],p
    row=dict(pin)
    row['selectedLineRanges']=selected.get(p,[])
    row['semanticLineCount']=len(nums(row['selectedLineRanges']))
    row['bodyDisplayedLineRanges']=body.get(p,[])
    row['bodyDisplayedLineCount']=len(nums(row['bodyDisplayedLineRanges']))
    nav=[]
    for name in nav_files.get(p,[]):
        nav.extend(int(m.group(1)) for m in re.finditer(r'^(\d+):',(OUT/name).read_text(),re.M))
    row['additionalNavigationSnippetLineRanges']=spans(set(nav)-nums(row['bodyDisplayedLineRanges']))
    row['displayedLineRanges']=spans(nums(row['bodyDisplayedLineRanges'])|set(nav))
    row['displayedLineCount']=len(nums(row['displayedLineRanges']))
    row['coverage']='selected' if p in selected else 'hash-only'
    row['semanticFull']=False
    row['category']='product-selected' if p in selected else ('instruction-hash-reuse' if p in ('CODESHELL.md','AGENTS.md') else 'unused-test-or-fixture-hash-only')
    row['scopeBoundary']='Ordinary name/opaque key, dotted-path setter and flat-record reader only. Adjacent settings I/O, OAuth, identity, permission and host mechanisms displayed incidentally are not certified.' if p in selected else 'No body or test declaration read; hash is not semantic coverage.'
    rows.append(row)
product=[r for r in rows if r['category']=='product-selected']
summary={'sourceRows':len(rows),'productSelectedRows':len(product),'productSemanticLines':sum(r['semanticLineCount'] for r in product),'productBodyDisplayLines':sum(r['bodyDisplayedLineCount'] for r in product),'productDisplayUnionLinesIncludingNavigation':sum(r['displayedLineCount'] for r in product),'semanticFullRows':0,'instructionHashOnlyRows':2,'unusedTestFixtureHashOnlyRows':sum(r['category']=='unused-test-or-fixture-hash-only' for r in rows),'testDeclarationLines':0,'testExecution':0}
save('source-manifest.json',{'atUTC':NOW,'rootReportedBaseline':initial['rootReportedBaseline'],'gitCertified':False,'files':rows,'summary':summary})

archive_pin=next(p for p in pins if p['path']==archive)
archive_lines=(REPO/archive).read_text().splitlines()
save('legacy-archive-read.json',{'input':archive_pin,'bodyDisplayedLineRanges':[[1,18],[30,50]],'bodyDisplayedLineCount':39,'semanticScopeLineRanges':[[1,7],[36,45]],'semanticScopeLineCount':17,'excerpts':[{'line':i,'text':archive_lines[i-1]} for i in list(range(1,8))+list(range(36,46))],'statusInterpretation':'Original heading says completed on 2026-08-25 and that the archive preserves pre-fix issues/acceptance basis. It explicitly mentions rejecting dotted names. Section 2 names plugin/Skill inputs and recommends either rejecting dots or a non-dotted key write. This dated status does not establish that the currently read MCP/project-override variant is fixed, nor that all current settings mechanisms are defective.','coverageLimitation':'One personally read original archive, not an independent full-history scan. Parent supplied the candidate to compare; no mutable/final prep155 report was read.'})

save('classification.json',{'counts':{'formal':0,'candidates':1,'newRelated':0},'formal':[],'candidates':[{'alias':'prep155 current dotted MCP/project override lead','priorityRecommendation':'P3','newIndependentId':False,'evidence':'Static current input/representation mismatch; no runtime or actual settings write','finalClassificationOwner':'Root'}],'newRelated':[],'reviewedAlias':'prep155 dotted MCP/project override lead; no new ID','decision':'retain-current-lead-not-safe-to-dedup-on-archive-alone','legacyCausalFamily':{'canonical':archive+':36-45','oldLocation':'install-capability plugin/Skill name in capabilityOverrides.plugins.<opaque-name>','currentLocation':'capability-control service project override in capabilityOverrides.mcp.<opaque-server-name>','sharedRepresentationFailure':'Opaque token is concatenated into a dotted setting path; manager splits every dot into nested properties; overlay reads the token as one literal record key.','importantContractDifference':'Archive section2 explicitly names plugin/Skill admission. The completed historical rejection of dotted names does not cover MCP names still admitted by the current editor or establish a generic opaque-key write fix. A current repair must reach this caller/input contract.','currentFixStatus':'Not certified or inferred from archive completion. Current selected source still shows the MCP dotted-name route.','newRelatedRecordCount':0},'counterevidence':['McpSection full-editor name validation checks trimmed nonempty/duplicate, not dots; it builds name:trimmedName and the same component saver uses [next.name] structured MCP settings record. Ordinary dotted names are not inherently invalid input. No real configuration was written.','projectMcp constructs descriptors even for unconnected configured servers; the id is mcp:<serverName> and token is that unchanged name. No actual MCP connection is needed to explain the ordinary descriptor producer.','Current global MCP path saves the whole mcpServers record and is not this project dotted override trigger; the report does not claim every toggle/save fails.','No claim of security bypass, external host behavior, actual file corruption, runtime success/failure, or all-history uniqueness.','The project-toggle UI-to-service complete invocation path was not independently retraced here; Root/155 production reachability evidence remains separate from this limited old-cause review.'],'opinionRevision':'decision-history.json'})

save('diagnostics.json',{'productHelperImportFixtureTestExecution':0,'gitCommands':0,'settingsFsWriteOrActualUserDataRead':0,'networkNativeExecution':0,'firstInventoryExit':0,'metadataFailure':None,'outputTruncation':False,'unusedPins':'Inventory patterns selected several manager/Mcp test and fixture filenames; they were byte/hash-pinned only, with body/test declaration/execution all zero. They are not promoted to source semantic coverage.','adjacentBoundary':'OAuth lines1256-1288 and settings trust-root/no-repo/I/O snippets were displayed while locating the normal name/setter chain; they are outside semantic opinion, with no actions executed.','opinionRevision':'Initial broad duplicate-exclusion opinion revised after considering the historical localized rejection fix and current admitted MCP input contract. Original unexecuted finalizer draft preserved; no first report/receipt had been generated and no old packet changed. See decision-history.json.','newProductReadsAfterRevision':0,'sourceReadingEnded':NOW,'validation':'Own stdlib metadata range/hash/receipt checks only; no author methods or product functions run.'})

ending=[]
for pin in pins:
    b=(REPO/pin['path']).read_bytes();ending.append({'path':pin['path'],'beforeSha256':pin['sha256'],'endingSha256':sha(b),'endingBytes':len(b),'unchanged':sha(b)==pin['sha256']})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json',{'atUTC':NOW,'files':ending,'sourceInstructionChecks':len(rows),'boundedOriginalArchiveChecks':1,'allUnchanged':True,'gitOrBlobVerification':False,'scope':'Only own pinned source/instructions and exact original archive. No current-SHA certification of other packets/history or full-history ending rescan.'})

report=f'''# 点号 MCP 名称线索：旧因归属有限复核

**保留 prep155 当前线索；不能只凭旧归档直接排重。** 复核口径为0 formal /1同项 candidate /0 newRelated，不另发ID；Root决定最终formal/known分类。Root基线 `{initial['rootReportedBaseline']}` 仅作上下文，本代理Git0；未读prep155可变或终态报告，不修改旧包。

亲读原 archive `bug-followups-2026-08-13.md`1–18、30–50。36–45 已记录插件/Skill 的不透明名称进入点分设置键，manager 按点号拆层级，overlay 按完整名称查扁平Record。当前MCP具有相同表示失配家族，但这不足以证明相同输入/入口已登记并修复。

最小正常 producer 对照：McpSection1321–1337 对 full editor 的名称只查 trim 后非空/重复，1393–1401 将 trimmedName 放入正常 MCP DTO；443–453 用 `[next.name]` 写 structured record。projectMcp52–81 明确所有已配置服务器（包括未连接）都有 descriptor，66–77 生成 `mcp:${{serverName}}`。普通 `team.docs` 因而不是伪造坏 DTO 或必须建立网络连接才能成立的名字。

当前链：service161–164 拼 `capabilityOverrides.${{bucket}}.${{token}}`；manager84、149–154 和572–584 将该 key 分段写入；overlay49–63 保留冒号后的完整 token 并以 `[token]` 读值。未看到这条 project 路径转为字面 key 写入的反证。另一个明确边界是 service174–179 的 global MCP 写法使用整 record，不能称所有 MCP toggle/save 都受影响。

**归档状态与修复范围必须保留**：原1–7称“已完成（2026-08-25）”，下方保留修复前问题，并提到“拒绝点号名称假成功”；具体问题/建议针对插件与Skill。拒绝旧输入名字中的点号，不足以修复当前仍合法接受点号的MCP producer；归档没有明确覆盖当前MCP入口，也没有证明通用opaque-key写入方式已改变。因此当前caller/输入合同仍需被修复触达，不能仅据helper或bucket形状将线索排除；也不据历史完成标记称当前已修。

初步曾建议同因直接排除；反方核对上述局部修复范围后修正，保留[意见时序](decision-history.json)与未执行的首draft脚本。此处未新读产品或运行验证。仅为有限旧因归属意见，未重新追完整project-toggle UI调用链或全历史；155/Root的实际入口证据另计。

范围见 [manifest](source-manifest.json)：5 个产品 selected rows、{summary['productSemanticLines']} 行，body 显示 {summary['productBodyDisplayLines']} 行，含导航逐文件 union {summary['productDisplayUnionLinesIncludingNavigation']} 行；semantic-full 0，指令 hash-only2，未使用 tests/fixture 仅 hash-only{summary['unusedTestFixtureHashOnlyRows']}，测试声明/执行0。相邻 OAuth、权限、I/O/native/Host 不作正确性结论。无产品/helper/import/fixture/test/真实配置/FS 写/网络/native/Git 执行，无首错或截断。[原归档](legacy-archive-read.json)、[分类](classification.json)、[诊断](diagnostics.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。{len(rows)} 源/指令与1原归档 ending SHA 均未变，非全史重扫。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json',{'atUTC':NOW,'selfExcluded':'artifact-receipt.json','files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='artifact-receipt.json'],'productExecution':0,'gitCommands':0,'note':'Own metadata-only finalization; no product/helper/test or other author method executed.'})
print(json.dumps({'summary':summary,'packetFiles':len(list(OUT.iterdir())),'endingChecks':len(ending)},ensure_ascii=False))
for n in ('report.md','source-manifest.json','artifact-receipt.json'):
    b=(OUT/n).read_bytes();print(n,len(b),sha(b))

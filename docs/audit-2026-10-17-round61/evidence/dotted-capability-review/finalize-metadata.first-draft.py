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

save('classification.json',{'counts':{'formal':0,'candidates':0,'newRelated':0},'formal':[],'candidates':[],'newRelated':[],'reviewedAlias':'prep155 dotted MCP/project override lead; no new ID','decision':'same-cause-excluded','sameCause':{'canonical':archive+':36-45','oldLocation':'install-capability plugin/Skill name in capabilityOverrides.plugins.<opaque-name>','currentLocation':'capability-control service project override in capabilityOverrides.mcp.<opaque-server-name>','sharedRepresentationFailure':'Opaque token is concatenated into a dotted setting path; manager splits every dot into nested properties; overlay reads the token as one literal record key.','nonDispositiveDifference':'Different admitted producer and bucket do not change the previously recorded delimiter/opaque-key cause.','currentFixStatus':'Not certified. Archive completion status describes the historical issue; current selected source still shows the MCP dotted-name route.','noNewRelatedCount':True},'counterevidence':['McpSection full-editor name validation checks trimmed nonempty/duplicate, not dots; it builds name:trimmedName and the same component saver uses [next.name] structured MCP settings record. Ordinary dotted names are not inherently invalid input. No real configuration was written.','projectMcp constructs descriptors even for unconnected configured servers; the id is mcp:<serverName> and token is that unchanged name. No actual MCP connection is needed to explain the ordinary descriptor producer.','Current global MCP path saves the whole mcpServers record and is not this project dotted override trigger; the report does not claim every toggle/save fails.','No claim of security bypass, external host behavior, actual file corruption, runtime success/failure, or all-history uniqueness.']})

save('diagnostics.json',{'productHelperImportFixtureTestExecution':0,'gitCommands':0,'settingsFsWriteOrActualUserDataRead':0,'networkNativeExecution':0,'firstInventoryExit':0,'metadataFailure':None,'outputTruncation':False,'unusedPins':'Inventory patterns selected several manager/Mcp test and fixture filenames; they were byte/hash-pinned only, with body/test declaration/execution all zero. They are not promoted to source semantic coverage.','adjacentBoundary':'OAuth lines1256-1288 and settings trust-root/no-repo/I/O snippets were displayed while locating the normal name/setter chain; they are outside semantic opinion, with no actions executed.','sourceReadingEnded':NOW,'validation':'Own stdlib metadata range/hash/receipt checks only; no author methods or product functions run.'})

ending=[]
for pin in pins:
    b=(REPO/pin['path']).read_bytes();ending.append({'path':pin['path'],'beforeSha256':pin['sha256'],'endingSha256':sha(b),'endingBytes':len(b),'unchanged':sha(b)==pin['sha256']})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json',{'atUTC':NOW,'files':ending,'sourceInstructionChecks':len(rows),'boundedOriginalArchiveChecks':1,'allUnchanged':True,'gitOrBlobVerification':False,'scope':'Only own pinned source/instructions and exact original archive. No current-SHA certification of other packets/history or full-history ending rescan.'})

report=f'''# 点号 MCP 名称线索：旧因归属有限复核

**同根因排除，不新增 formal/candidate/related（0/0/0）**。Root 基线 `{initial['rootReportedBaseline']}` 仅作上下文，本代理 Git 0；未读 prep155 可变或终态报告，不修改任何旧包。

亲读原 archive `bug-followups-2026-08-13.md`1–18、30–50。36–45 已精确记录插件/Skill 的不透明名称进入点分设置键，manager 按点号拆层级，而 overlay 按扁平 Record 的完整名称读回，结果归一为 inherit。这与当前 MCP 线索的表示失配相同；更换 `plugins`→`mcp` bucket 和名称 producer 不足以另发 ID。

最小正常 producer 对照：McpSection1321–1337 对 full editor 的名称只查 trim 后非空/重复，1393–1401 将 trimmedName 放入正常 MCP DTO；443–453 用 `[next.name]` 写 structured record。projectMcp52–81 明确所有已配置服务器（包括未连接）都有 descriptor，66–77 生成 `mcp:${{serverName}}`。普通 `team.docs` 因而不是伪造坏 DTO 或必须建立网络连接才能成立的名字。

当前链：service161–164 拼 `capabilityOverrides.${{bucket}}.${{token}}`；manager84、149–154 和572–584 将该 key 分段写入；overlay49–63 保留冒号后的完整 token 并以 `[token]` 读值。未看到这条 project 路径转为字面 key 写入的反证。另一个明确边界是 service174–179 的 global MCP 写法使用整 record，不能称所有 MCP toggle/save 都受影响。

**归档状态必须保留**：原1–7称“已完成（2026-08-25）”，说明下方保留修复前问题并提到“拒绝点号名称假成功”。原具体问题和建议针对插件/Skill 旧入口，既不能据此断言当前 MCP 已修，也不能因当前 variant 仍可静态说明同类失配而重新计数。此结论是旧因归属核对，不是全部历史或修复提交验证。

范围见 [manifest](source-manifest.json)：5 个产品 selected rows、{summary['productSemanticLines']} 行，body 显示 {summary['productBodyDisplayLines']} 行，含导航逐文件 union {summary['productDisplayUnionLinesIncludingNavigation']} 行；semantic-full 0，指令 hash-only2，未使用 tests/fixture 仅 hash-only{summary['unusedTestFixtureHashOnlyRows']}，测试声明/执行0。相邻 OAuth、权限、I/O/native/Host 不作正确性结论。无产品/helper/import/fixture/test/真实配置/FS 写/网络/native/Git 执行，无首错或截断。[原归档](legacy-archive-read.json)、[分类](classification.json)、[诊断](diagnostics.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。{len(rows)} 源/指令与1原归档 ending SHA 均未变，非全史重扫。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json',{'atUTC':NOW,'selfExcluded':'artifact-receipt.json','files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='artifact-receipt.json'],'productExecution':0,'gitCommands':0,'note':'Own metadata-only finalization; no product/helper/test or other author method executed.'})
print(json.dumps({'summary':summary,'packetFiles':len(list(OUT.iterdir())),'endingChecks':len(ending)},ensure_ascii=False))
for n in ('report.md','source-manifest.json','artifact-receipt.json'):
    b=(OUT/n).read_bytes();print(n,len(b),sha(b))

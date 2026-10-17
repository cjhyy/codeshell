from pathlib import Path
import datetime
import hashlib
import json
import re

REPO=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round161-mcp-dot-readback-review')
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
pins=initial['files']+json.loads((OUT/'chain-pins.json').read_text())+[json.loads((OUT/'migration-pin.json').read_text())]
manager='packages/core/src/settings/manager.ts'
schema='packages/core/src/settings/schema.ts'
migration='packages/core/src/settings/migrate-config.ts'
ui='packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx'
preload='packages/desktop/src/preload/index.ts'
main='packages/desktop/src/main/index.ts'
desktop='packages/desktop/src/main/capabilities-service.ts'
service='packages/core/src/capability-control/service.ts'
overlay='packages/core/src/capability-control/overlay.ts'
body={
 manager:[[1,31],[83,92],[94,112],[144,155],[182,205],[218,259],[261,366],[375,395],[398,452],[488,526],[572,585],[690,783],[793,849],[866,938],[977,1037],[1103,1139]],
 schema:[[54,81],[470,480],[723,731]],
 migration:[[91,147]],
 ui:[[253,279]],preload:[[1116,1125]],main:[[3835,3852]],desktop:[[40,124]],service:[[105,124],[151,165]],overlay:[[181,211]],
}
selected={
 manager:[[21,21],[83,92],[94,112],[144,155],[186,192],[225,240],[261,310],[325,348],[375,393],[405,437],[442,452],[501,502],[524,526],[572,585],[701,741],[793,799],[807,832],[834,844],[872,891],[921,934],[979,1002],[1017,1029],[1109,1139]],
 schema:[[57,78],[477,477],[729,731]],migration:[[17,17],[91,102],[119,147]],
 ui:[[261,279]],preload:[[1119,1123]],main:[[3840,3847]],desktop:[[51,80],[114,120]],service:[[107,117],[151,165]],overlay:[[184,211]],
}
nav_files={manager:['manager-navigation.first.stdout','manager-load-navigation.first.stdout','read-write-navigation.first.stdout','final-call-navigation.first.stdout'],schema:['schema-navigation.first.stdout'],migration:['migration-navigation.first.stdout']}
rows=[]
for pin in pins:
    p=pin['path'];b=(REPO/p).read_bytes();assert sha(b)==pin['sha256'],p
    row=dict(pin)
    row['selectedLineRanges']=selected.get(p,[])
    row['semanticLineCount']=len(nums(row['selectedLineRanges']))
    row['bodyDisplayedLineRanges']=body.get(p,[])
    row['bodyDisplayedLineCount']=len(nums(row['bodyDisplayedLineRanges']))
    nav=[]
    for f in nav_files.get(p,[]):
        nav.extend(int(m.group(1)) for m in re.finditer(r'^(\d+):',(OUT/f).read_text(),re.M))
    row['additionalNavigationSnippetLineRanges']=spans(set(nav)-nums(row['bodyDisplayedLineRanges']))
    row['displayedLineRanges']=spans(nums(row['bodyDisplayedLineRanges'])|set(nav))
    row['displayedLineCount']=len(nums(row['displayedLineRanges']))
    row['coverage']='selected' if p in selected else 'hash-only'
    row['semanticFull']=False
    row['category']='product-selected' if p in selected else 'instruction-hash-reuse'
    row['scopeBoundary']='Ordinary settings write/merge/parse/readback and explicit RPC value forwarding only. Adjacent files/locks/trust/credentials/native/hook provenance shown in body are not certified. Existing prep158/source-history overlap is not new unique or first coverage.' if p in selected else 'Same-SHA previously fully read instructions reused; no instruction body prep161.'
    rows.append(row)
product=[r for r in rows if r['category']=='product-selected']
summary={'sourceRows':len(rows),'productSelectedRows':len(product),'productSemanticLines':sum(r['semanticLineCount'] for r in product),'bodyDisplayedLines':sum(r['bodyDisplayedLineCount'] for r in product),'displayedUnionLinesIncludingNavigation':sum(r['displayedLineCount'] for r in product),'semanticFullRows':0,'instructionHashOnlyRows':2,'testDeclarationLines':0,'productTestExecution':0}
save('source-manifest.json',{'atUTC':NOW,'rootReportedBaseline':initial['rootReportedBaseline'],'gitCertified':False,'files':rows,'summary':summary})

save('classification.json',{'counts':{'formal':0,'candidates':1,'newRelated':0},'formal':[],'candidates':[{'alias':'Root159 current dotted MCP project override (same prep155/158 item)','priorityRecommendation':'P2','newIndependentId':False,'evidence':'Static ordinary producer, unchecked save and schema readback mismatch; no product execution','finalClassificationOwner':'Root'}],'newRelated':[],'decision':'support-current-settings-readback-failure-not-merely-silent-inherit','rootFinalDecision':{'id':'MCP-R61-01','priority':'P2','evidenceLevel':'static-confirmed, not runtime reproduced','countOnceByRoot':True,'sameItemAsPrep155158159':True},'normalPreconditions':['Existing normal project with readable valid current-version settings; ordinarily configured dotted MCP name and a real project capability row, as previously source-reviewed in prep158.','Project override on/off operation completes its ordinary settings write successfully; no filesystem/lock failure is assumed or tested.','No higher-priority explicit null removal masking this subtree. Current configVersion=2 scenario is sufficient; not a claim about every migration/input.'],'sourceCausalChain':[{'path':ui,'ranges':[[261,279]],'fact':'Awaits setCapabilityOverride for normal selected capability id/state, then load(); errors have a UI error path.'},{'path':preload,'ranges':[[1119,1123]],'fact':'Forwards target/id/state to capabilities:setOverride.'},{'path':main,'ranges':[[3840,3847]],'fact':'Resolves target cwd, checks id string and allowed state, then calls setCapabilityOverride; no dot-specific rejection shown.'},{'path':desktop,'ranges':[[114,120]],'fact':'Delegates to Core project setOverride.'},{'path':service,'ranges':[[151,165]],'fact':'Builds dotted capabilityOverrides.<bucket>.<token> setting path.'},{'path':manager,'ranges':[[83,92],[144,155],[572,585],[834,844],[872,891]],'fact':'Splits the key, mutates nested properties, writes JSON and invalidates cache. No settings-shape validation in this save route.'},{'path':manager,'ranges':[[94,112],[701,741],[793,799],[979,1002],[1109,1139]],'fact':'Ordinary valid JSON parser/sanitizer/merge preserve a nested ordinary object; getForScope calls validateSettings without a catch.'},{'path':schema,'ranges':[[57,78],[477,477],[729,731]],'fact':'mcp is a Record of enum strings inherit/on/off, and outer SettingsSchema.parse is called; generated object value is outside that declared contract.'},{'path':desktop,'ranges':[[51,80]],'fact':'Next normal capability listing constructs a manager and calls settings.get before Core overlay fallback.'},{'path':manager,'ranges':[[261,310],[325,348],[375,393],[442,452],[501,502],[921,934]],'fact':'Ordinary load merges project layer and validates; cached merged value is absent after invalidation/new manager.'}],'counterevidenceAndLimits':[{'counterevidence':'Merge might clean invalid values.','result':'It filters forbidden property names/nulls, otherwise recursively preserves object values; team/docs ordinary keys survive.'},{'counterevidence':'Corrupt-file parser might skip the layer.','result':'Generated JSON is syntactically valid and an object. Schema validation is later than JSON parsing, so this is not a parseConfigFile corrupt-JSON fallback.'},{'counterevidence':'The save path might validate before write.','result':'saveProjectSetting→mutateSettingsFile→atomicWriteJson has ordinary bounded-target/JSON serialization checks, not SettingsSchema validation. No actual write observed.'},{'counterevidence':'effectiveProjectOverrides catches read errors.','result':'Yes, the helper catches; but Desktop makeService loads settings first and Core list directly calls getForScope at107–109 outside that helper catch. Do not claim every caller throws.'},{'counterevidence':'Migrations might clean the generated object.','result':'For current configVersion=2, registered migration steps0→1→2 have no from2 step, preserve the original fields, and manager applyConfigMigration exits when unchanged. Only this normal current-version scenario is certified statically.'},{'counterevidence':'Untrusted project stripping could remove the malformed subtree.','result':'The selected dangerous-field list does not include capabilityOverrides; this is an ordinary field-retention observation, not trust/authority certification.'}],'runtimeLimits':['No Zod parse, merge, settings manager, renderer/IPC, filesystem write/read of user data, test/fixture, native or network operation executed.','No exact runtime exception text/stack or app crash/restart failure observed. Impact is statically rejected current project settings/readback, not all projects/global config or irrecoverable data loss.','Old archive/fix-scope decision is left in frozen prep158 and not rescanned or altered here.','No prep159 report/raw method read; parent supplied file/range navigation only.']})

save('diagnostics.json',{'productHelperImportFixtureTestExecution':0,'gitCommands':0,'actualUserConfigurationReadOrWrite':0,'networkNativeExecution':0,'firstInventoryExit':0,'firstMetadataFailure':None,'outputTruncation':False,'preliminarySourceEndMarkers':'After the initial bounded read, only minimal final load validation/JSON call binding and current-version migration counterevidence were added under before pins. No product retry or broad new mechanism; final ranges include all actual displays.','sourceReadingEnded':NOW,'foreignDiagnosticBoundary':'Root159 source display IndexError was parent-reported, not an own failure, test result or source read; no foreign raw log was copied or attributed here.','validation':'Own stdlib metadata hashing/range/receipt only. Zod enum/object mismatch is a static schema-contract conclusion, not an executed fixture/pass.'})

ending=[]
for pin in pins:
    b=(REPO/pin['path']).read_bytes();ending.append({'path':pin['path'],'beforeSha256':pin['sha256'],'endingSha256':sha(b),'endingBytes':len(b),'unchanged':sha(b)==pin['sha256']})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json',{'atUTC':NOW,'files':ending,'sourceInstructionChecks':len(pins),'allUnchanged':True,'gitOrFrozenBlobVerification':False,'scope':'Own pins only; no full-history ending scan, archive reread or certification of foreign packet current SHA.'})

report=f'''# MCP 点号 project override：当前读回影响复核

**支持当前 P2 静态影响：保存后配置读回可被 schema 拒绝，不能只写成旧归档的静默 inherit。** 复核为0 formal /1同项candidate /0 newRelated，不另发ID，Root已采纳同项`MCP-R61-01/P2`静态确认，只计一次，未运行复现。基线 `{initial['rootReportedBaseline']}` 为Root上下文，Git0；旧158保持冻结，未读159报告/原日志。

普通链已亲读：UI261–279→preload1119–1123→main3840–3847→Desktop capabilities-service114–120→Core service151–165。`team.docs` 的正常名称准入沿已冻158源码结论；这次服务端只核 id 为string、state为枚举，没有点号保护。writer拼 `capabilityOverrides.mcp.team.docs`，manager84/149–154分段，572–585→872–891→834–844把嵌套值序列化写入并invalidate，**没有在此保存路径做settings shape校验**。此为成功普通写入条件下的源码推导，未实际写盘。

普通JSON parser只核合法object并递归去forbidden property names；merge1109–1139同样只滤forbidden/null并递归保留对象。因此生成的`mcp.team`对象不会变成允许的字符串。schema57–78、477要求`mcp: record(enum("inherit","on","off"))`，729–731直接parse；getForScope701–709在merge后直接validate，无catch，不能按旧overlay逻辑先变成inherit。

真实后续读：UI保存后load；Desktop makeService51–54/74–80先调用SettingsManager.get/load，普通load393→validateMerged502也会触达schema。Core list107–109直接getForScope也在overlay helper的catch之外。**反证保留**：effectiveProjectOverrides184–211确实catch并返回undefined，所以不称每个consumer都会抛错；但它不能保护这些前置读。

迁移反证限定：已亲读migrate-config91–147及manager405–437；正常已有当前`configVersion=2`的配置没有待跑step，原子树保留，不能自动修复该值。范围仅普通可读当前版本项目配置、成功写入且无更高层null显式删除该子树；不认证全部迁移、其他provider/Host、权限、锁或持久化安全。不报告实际错误文本、崩溃、所有项目启动失败或不可恢复损失。

[manifest](source-manifest.json)：{summary['productSelectedRows']}产品selected rows、{summary['productSemanticLines']}语义行，body显示{summary['bodyDisplayedLines']}、含导航逐文件union {summary['displayedUnionLinesIncludingNavigation']}；semantic-full0、指令hash-only2，测试声明/执行0。现有源重叠不称新增唯一覆盖。所有产品/helper/import/fixture/test/真实配置/网络/native/Git执行0；首元数据失败/截断均无，Root159的IndexError不归于本包。[分类与反证](classification.json)、[诊断](diagnostics.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。{len(pins)}个源/指令结束SHA全同；未重扫archive或全历史。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json',{'atUTC':NOW,'selfExcluded':'artifact-receipt.json','files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='artifact-receipt.json'],'productExecution':0,'gitCommands':0,'note':'Own metadata-only finalization, no product/schema/helper/test or foreign author method executed.'})
print(json.dumps({'summary':summary,'packetFiles':len(list(OUT.iterdir())),'endingChecks':len(ending)},ensure_ascii=False))
for n in ('report.md','source-manifest.json','artifact-receipt.json'):
    b=(OUT/n).read_bytes();print(n,len(b),sha(b))

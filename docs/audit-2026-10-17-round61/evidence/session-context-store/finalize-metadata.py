from pathlib import Path
import datetime
import hashlib
import json
import re

REPO = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT = Path('/tmp/codeshell-audit-round156-session-context-store')
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(name, value):
    (OUT/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')

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
pins=initial['files']+json.loads((OUT/'chain-pins.json').read_text())+[json.loads((OUT/'desktop-caller-pin.json').read_text())]
prefix='packages/coding/src/external-runtimes/'
target=prefix+'shared/session-context-store.ts'
factory=prefix+'session-factory.ts'
bridge=prefix+'shared/mcp-bridge.ts'
index=prefix+'index.ts'
test=prefix+'shared/session-context-store.test.ts'
desktop='packages/desktop/src/main/external-runtime-service.ts'
semantic={
 target:[[19,58],[71,83],[91,123],[133,152]],
 factory:[[35,35],[48,51],[72,78],[97,101],[124,153],[157,159],[177,196],[209,219],[228,242]],
 bridge:[[94,105],[132,143],[207,213],[276,280],[299,330]],
 desktop:[[708,714],[905,911],[925,934]],
 test:[[160,190]],
}
body={target:[[1,153]],factory:[[1,263]],bridge:[[94,108],[130,149],[199,219],[266,335]],desktop:[[699,718],[900,941]],test:[[160,190]]}
nav_files={factory:'factory-navigation.first.stdout',bridge:'bridge-navigation.first.stdout',index:'index-navigation.first.stdout',test:'test-navigation.first.stdout',desktop:'desktop-caller-navigation.first.stdout'}
rows=[]
for pin in pins:
    p=pin['path'];data=(REPO/p).read_bytes();assert sha(data)==pin['sha256'],p
    row=dict(pin)
    row['selectedLineRanges']=semantic.get(p,[])
    row['semanticLineCount']=len(nums(row['selectedLineRanges']))
    row['bodyDisplayedLineRanges']=body.get(p,[])
    row['bodyDisplayedLineCount']=len(nums(row['bodyDisplayedLineRanges']))
    nav=[]
    if p in nav_files:
        nav=[int(m.group(1)) for m in re.finditer(r'^(\d+):',(OUT/nav_files[p]).read_text(),re.M)]
    row['additionalNavigationSnippetLineRanges']=spans(set(nav)-nums(row['bodyDisplayedLineRanges']))
    row['displayedLineRanges']=spans(nums(row['bodyDisplayedLineRanges'])|set(nav))
    row['displayedLineCount']=len(nums(row['displayedLineRanges']))
    row['semanticFull']=False
    row['category']='instruction-hash-reuse' if p in ('CODESHELL.md','AGENTS.md') else ('test-declaration' if p==test else ('navigation-only' if p==index else 'product-selected'))
    row['coverage']='hash-only' if row['category']=='instruction-hash-reuse' else ('navigation-only' if p==index else 'selected')
    if p in (target,factory):
        row['fullBodyDisplayedButNotFullSemanticClaim']=True
    row['scopeBoundary']='Ordinary key/value mapping and option forwarding only. Source shows adjacent generation/host-dispatch/permissions or I/O, but this packet does not certify identity provenance, authorization, process lifetime, durable binding correctness or custody.'
    if row['category']=='instruction-hash-reuse':
        row['scopeBoundary']='Same-SHA previously fully read instructions reused; no new instruction body prep156.'
    rows.append(row)

product=[r for r in rows if r['category']=='product-selected']
test_rows=[r for r in rows if r['category']=='test-declaration']
summary={'sourceRows':len(rows),'productSelectedRows':len(product),'productSemanticLines':sum(r['semanticLineCount'] for r in product),'testDeclarationRows':len(test_rows),'testDeclarationLines':sum(r['semanticLineCount'] for r in test_rows),'semanticFullRows':0,'navigationOnlyRows':1,'instructionHashOnlyRows':2,'boundedBodyDisplayLines':sum(r['bodyDisplayedLineCount'] for r in rows),'displayedUnionLinesIncludingNavigation':sum(r['displayedLineCount'] for r in rows),'note':'Body plus additional navigation union per file. Full text display does not imply all mechanism contracts semantically certified. No global coverage updates.'}
save('source-manifest.json',{'atUTC':NOW,'rootReportedBaseline':initial['rootReportedBaseline'],'gitCertified':False,'files':rows,'summary':summary})

original='docs/audit-2026-10-17-round28/evidence/coverage-prep/package-inventory.json'
original_row=json.loads((REPO/original).read_text())['files'][186]
save('canonical-original-read.json',{'actuallyRead':[{'path':original,'pointer':'/files/186','value':original_row,'interpretation':'Path/bytes/lines/SHA inventory only; no semantic scope or full claim.'},{'path':'docs/audit-2026-10-17/root.md','bodyLineRanges':[[7,15]],'additionalNavigationLines':[35,41,123],'oldCause':'R2-01 Claude project encodeCwd collision in discovery/history. No reader/import/CLI rerun or old pass borrowed.'}],'derivedCanonicalObjects':'canonical-read.json','sharedProjection':'history-projection.json','gateDecision':'25 machine path/SHA hits fully retained cap100. Personally read derived claims929/930,index495 and original R28/files186: no explicit semantic-full scope in those objects. Unknown/inventory-only is not historical unread or first-reading proof. Existing undocumented or differently described historical overlap remains possible.','permanentlySkipped':['SDK resolver/session-import failed dynamic directions; no import, fixture, CLI, runtime or replacement-entry validation.']})

save('classification.json',{'counts':{'formal':0,'candidates':0,'newRelated':0},'formal':[],'candidates':[],'newRelated':[],'oldExcluded':[{'id':'R2-01','canonical':'docs/audit-2026-10-17/root.md:7','cause':'Claude project bucket encoding collision; not this in-memory pinned host map','countedAsNewRelated':False}],'negative':'No normal producer/consumer mismatch established in the selected in-memory key/value routing and option-forwarding chain. This is not persistent context recovery or identity/authorization certification.','counterevidence':['Actual factory creates a fresh store and per-session bridge; one codeshell-${businessSessionId} key is passed both as bridge pin and registration key. No cwd encoding or persisted context record in this store.','Factory registers before runtime startup and close path invokes unregister first; actual execution/close failures were not tested or fully certified.','Pinned bridge resolves its pin and current store generation before host tools/list/tools/call branches. External metadata authenticity is outside scope.','Desktop passes a persisted runtimeSessionId only when selected kind/cwd/model conditions match. Binding reader/writer internals and resumed-runtime behavior were not semantically reviewed.','Helper offers bumpGeneration, but no actual restart-generation contract is inferred from comments/tests. The personally read production factory uses a fresh store.']})

save('diagnostics.json',{'productExecution':0,'gitCommands':0,'helperImportFixtureTestCliModelNativeNetworkExecution':0,'actualUserDataRead':0,'firstInventoryExit':0,'firstMetadataFailure':{'operation':'Filename-only old R2 inventory using guessed docs/audit-2026-10-17-round2 directory','exitCode':2,'stdout':'old-r2-inventory.first.stdout','stderr':'old-r2-inventory.first.stderr','exit':'old-r2-inventory.first.exit.json','cause':'Directory does not exist. Product files were not addressed by this failed navigation.','correction':'Filename-only R2-01 locator identified original docs/audit-2026-10-17/root.md; it was pinned before bounded read. No product retry.'},'outputTruncation':False,'sourceReadingEnded':NOW,'domainCorrection':'Task name suggested ordinary persisted session/context/cwd storage. Actual target is memory-only live host routing. The report limits its opinion accordingly and does not substitute map shape for authority/custody enforcement.','noNewSemanticReadingDuringFinalization':True,'validation':'Own stdlib metadata hashing/ranges/receipt only; no product method or historical test execution.'})

canonical_pins=json.loads((OUT/'canonical-pins.json').read_text())+json.loads((OUT/'canonical-original-pins.json').read_text())
shared=json.loads((OUT/'history-projection.json').read_text())['sharedBatch']
metadata_pins=canonical_pins+[shared]
ending=[]
for pin in pins+metadata_pins:
    path=Path(pin['path']) if Path(pin['path']).is_absolute() else REPO/pin['path']
    b=path.read_bytes();ending.append({'path':pin['path'],'beforeSha256':pin['sha256'],'endingSha256':sha(b),'endingBytes':len(b),'unchanged':pin['sha256']==sha(b)})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json',{'atUTC':NOW,'files':ending,'sourceInstructionChecks':len(pins),'boundedCanonicalSharedMetadataChecks':len(metadata_pins),'allUnchanged':True,'scope':'Not a full history rescan/ending rehash of 6244 historical documents; no Git/frozen blob verification.'})

report=f'''# 外部运行时会话上下文表：有限静态审查

新增 **0 formal / 0 candidate / 0 related**。Root 给定基线 `{initial['rootReportedBaseline']}`；本代理未执行 Git 或任何产品函数。

实际目标是 **memory-only 的 thread/key→live ToolHostRef Map**，不是 cwd/会话内容持久化存储。目标全文显示 153 行，但普通 Map 数据规则与机制边界分账，未把完整显示升级为全部身份/权限合同审完。

真实链：Desktop `external-runtime-service.ts` 708–714 仅在已读 kind/cwd/model 条件相等时选择 persisted runtimeSessionId；907–934 将 request.sessionId、cwd、恢复 ID 与 initialContext 传给 factory。factory 129–179 每次创建 fresh store 和独立 bridge，使用同一个 `codeshell-${{businessSessionId}}` 作 pin 与 register key，注册后才启动 runtime；144–153 的 close 先注销。bridge 132–143 优先用该 pin，277–280/318–319 以同 store 的当前 generation 查表；注销或缺键返回的拒绝数据分支可见。未建立正常 producer 与消费者之间的新字段/键不吻合。

helper 的 bumpGeneration 清表 API、替换/clear/JSON 输出规则在已读范围内；实际 production factory 是 fresh store，不能借 helper 注释或测试声明声称已验证重启 fencing。持久 binding reader/writer、恢复后的 runtime、权限/metadata 来源真实性、相邻 host execute 与 I/O/process 生命周期仅到显示边界，未认证其正确性。未以伪造 ID/null/store 或坏路径造反例。

共享历史机器导航含 6244 MD/JSON、4350476 递归 value scalars，纳冻 60/排 61+、含 archive；本目标 25 命中全保存 cap100、errors[]。亲读原 R28 inventory `/files/186` 只有 bytes/lines/SHA，派生 claims929/930 与 index495 也无 semantic-full 范围；这不能证明历史未读。旧 R2-01 原 `root.md`7–15 是 Claude encodeCwd 项目 bucket 碰撞，单独排除，不重复登记；原历史测试结果不借作本次 pass。旧 SDK resolver/会话导入失败动态方向继续跳过。

范围见 [manifest](source-manifest.json)：产品 selected {summary['productSemanticLines']} 行，现有测试仅声明 {summary['testDeclarationLines']} 行，nav-only 1、指令 hash-only 2、semantic-full 0；body 显示 {summary['boundedBodyDisplayLines']} 行，连同导航的逐文件 union {summary['displayedUnionLinesIncludingNavigation']} 行。首次猜测旧目录失败为 metadata rg exit2，原 stdout/stderr/exit 和纠正路径见 [diagnostics](diagnostics.json)，无产品重试或截断。产品/helper/import/fixture/test/CLI/model/native/network/Git 执行均 0，未读真实用户存储、会话或配置数据。

{len(pins)} 个源/指令和 {len(metadata_pins)} 个有限 canonical/shared 输入结束 SHA 均未变，非全历史重新扫描。[history](canonical-original-read.json)、[projection](history-projection.json)、[classification](classification.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json',{'atUTC':NOW,'selfExcluded':'artifact-receipt.json','files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='artifact-receipt.json'],'productExecution':0,'gitCommands':0,'note':'Own metadata-only receipt; no product/author-method execution.'})
print(json.dumps({'summary':summary,'packetFiles':len(list(OUT.iterdir())),'endingChecks':len(ending)},ensure_ascii=False))
for name in ('report.md','source-manifest.json','artifact-receipt.json'):
    b=(OUT/name).read_bytes();print(name,len(b),sha(b))

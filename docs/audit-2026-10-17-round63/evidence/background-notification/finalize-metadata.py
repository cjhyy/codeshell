from pathlib import Path
import datetime
import hashlib
import json
import re

REPO=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round169-background-notification')
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
pins=initial['files']+json.loads((OUT/'chain-pins.json').read_text())+json.loads((OUT/'click-consumer-pins.json').read_text())+json.loads((OUT/'mount-pins.json').read_text())
prefix='packages/desktop/src/'
content=prefix+'main/background-notification-content.ts'
routes=prefix+'main/desktop-notification-routes.ts'
native=prefix+'main/native-desktop-notification.ts'
main=prefix+'main/index.ts'
notifier=prefix+'main/desktop-notifier.ts'
producer='packages/core/src/tool-system/builtin/agent-notifications.ts'
api=prefix+'preload/notification-navigation-api.ts'
hook=prefix+'renderer/app/useNotificationSessionNavigation.ts'
body={content:[[1,173]],routes:[[1,172]],native:[[1,34]],main:[[3438,3485],[3738,3747]],notifier:[[1,35],[121,151],[186,202]],producer:[[55,88],[360,425],[557,574],[600,628],[634,644],[922,951]],api:[[1,38]],hook:[[1,84]]}
selected={content:[[3,24],[38,43],[48,124],[127,173]],routes:[[14,38],[96,172]],native:[[1,34]],main:[[3441,3473],[3741,3743]],notifier:[[8,15],[29,32],[121,146],[190,198]],producer:[[63,79],[383,414],[560,569],[637,643],[928,951]],api:[[1,38]],hook:[[14,19],[22,84]]}
nav_files={main:['main-navigation.first.stdout'],notifier:['notifier-navigation.first.stdout'],producer:['producer-navigation.first.stdout','publish-navigation.first.stdout']}
for i,row in enumerate(json.loads((OUT/'click-consumer-pins.json').read_text())):
    nav_files[row['path']]=['click-'+str(i)+'-navigation.first.stdout']
for i,row in enumerate(json.loads((OUT/'mount-pins.json').read_text())):
    nav_files[row['path']]=['mount-'+str(i)+'-navigation.first.stdout']
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
    test='.test.' in p
    instruction=p in ('CODESHELL.md','AGENTS.md')
    row['semanticFull']=p in (native,api)
    row['coverage']='full' if row['semanticFull'] else ('selected' if p in selected else ('navigation-only' if nav else 'hash-only'))
    row['category']='product-semantic' if p in selected else ('instruction-hash-reuse' if instruction else ('test-navigation-only' if test and nav else ('unused-test-hash-only' if test else 'product-navigation-only')))
    row['scopeBoundary']='Normal terminal result field/visible identity/click target forwarding only. Source shown is not actual OS delivery/click, Electron/React execution, durable receipt correctness, all windows/ownership/identity resolution or security-redaction certification. No historical unread/first-coverage claim.' if p in selected else 'Only hash or exact navigation snippets, no full body/semantic coverage.'
    if test:
        row['testDeclarationLines']=0
        row['incidentalTestBodyNavigationLines']=row['displayedLineCount']
        row['testSemanticReviewLines']=0
        row['testExecution']=0
    if instruction:
        row['scopeBoundary']='Same-SHA previously fully read instructions reused; no new instruction body169.'
    rows.append(row)
product=[r for r in rows if r['category']=='product-semantic']
summary={'sourceRows':len(rows),'semanticProductRows':len(product),'semanticProductLines':sum(r['semanticLineCount'] for r in product),'fullStaticAdapterRows':2,'otherSelectedProductRows':6,'bodyDisplayLines':sum(r['bodyDisplayedLineCount'] for r in rows),'displayUnionLinesIncludingAllNavigation':sum(r['displayedLineCount'] for r in rows),'productNavigationOnlyRows':sum(r['category']=='product-navigation-only' for r in rows),'testNavigationOnlyRows':sum(r['category']=='test-navigation-only' for r in rows),'incidentalTestBodyNavigationLines':sum(r.get('incidentalTestBodyNavigationLines',0) for r in rows),'unusedTestHashOnlyRows':sum(r['category']=='unused-test-hash-only' for r in rows),'instructionHashOnlyRows':2,'testDeclarationLines':0,'testSemanticReviewLines':0,'testExecution':0}
save('source-manifest.json',{'atUTC':NOW,'rootReportedBaseline':initial['rootReportedBaseline'],'gitCertified':False,'files':rows,'summary':summary,'eofNote':'Bodies are recorded through actual EOF, not source command upper bounds. API was printed with upper100 but actualEOF38; hook upper110 but actualEOF84. No nonexistent rows counted.'})

save('gate-and-old-cause.json',{'sharedHistoryProjection':'history-projection.json','canonicalJsonRead':'canonical-read.json','originalMetadataReads':[{'path':'docs/review-2026-10-12/notification-round14.md','lineRanges':[[1,30]],'meaning':'Original R63/N1 priority/rate-wait queue cause and prior test/OS boundaries. No historical fixture/log executed or pass borrowed.'},{'path':'docs/review-2026-10-12/notification-quality-round14.md','lineRanges':[[1,51]],'meaning':'Original selected routes/Main producer support and urgent queue counterevidence; no old Git/native/fixture operations repeated.'}],'inspectedCoverageDecision':'R44 original claims7405/7406,7760/7761,8291/8292 are inventory/pin objects with no scope/ranges. Old R14 prose is selected route/caller coverage without a current same-SHA full binding here. No inspected explicit same-SHA full gate, but unknown is never unread or first-read proof.','oldReferences':[{'id':'R63/N1','cause':'Ordinary waitForRateSlot holds notifier mutation queue ahead of later urgent route.','countedAsNewRelated':False,'limit':'Notifier queue/rate scheduler not audited anew or executed; route content/flags alone do not refute or reconfirm this old queue bug.'},{'id':'R11 notification click capability exclusion','sourceOfReference':'R14 original report26 and quality47 only','directR11OriginalRead':False,'countedAsNewRelated':False,'limit':'Do not claim original R11 was directly read. Current own source has immutable click target closure; prior absence is historical context, not a new bug or native acceptance result.'}],'fullHistorySemanticClaim':False,'oldRuntimeLogsOrMethodsExecuted':False})

save('classification.json',{'counts':{'formal':0,'candidates':0,'newRelated':0},'formal':[],'candidates':[],'newRelated':[],'negative':'No ordinary data/visible identity/click target mismatch established in selected producer→route→notifier→native/preload/hook source chain. Not all notification scheduling/OS presentation/window ownership/session resolution correctness.','normalChain':['Core ResultPayload plus legacyItemToDraft retain workId/name/description/status/kind/optionalcommand,error,exit,signal and recipient sessionId; actual enqueue publishes to bus after queue commit.','Main subscribes actual bus to notifyBackgroundResult. Routes validate ordinary terminal fields and use recipient to.sessionId as click target; content formatting and delivery key include work/status identity fields.','DesktopNotifier forwards that sessionId; native instance captures it before registering click callback. Main sends the same id on notification:open-session, preserving it through preload listener/buffer and renderer hook.','Preload index and App import/mount calls were confirmed by exact navigation only, not whole module or application execution.','Renderer hook calls normal session-resolution/navigation seams with same id and generation guard; full resolver, user disk data and cross-window custody were not reviewed.','Content redaction/delegate and notifier receipt/rate-limit mechanisms are adjacent boundaries, not certification or speculative new security findings.']})

save('diagnostics.json',{'productHelperImportFixtureTestExecution':0,'gitCommands':0,'actualSystemNotificationElectronReactOrUserSessionExecution':0,'realUserConfigurationDataRead':0,'networkNativeExecution':0,'firstInventoryExit':0,'firstMetadataFailure':None,'outputTruncation':False,'testNavigationExposure':'Click consumer filename inventory also matched two tests. They were before-pinned and rg-n displayed five preload fixture-call lines plus one hook fixture callback line, not test titles or meaningful test review. No separate body-range display, test title/declaration, meaningful semantic review or execution was performed; exact six actual test-body navigation snippets are counted separately. Initial routes/native tests stay unused hash-only.','eofLimitation':'API/read hook commands had larger upper bounds; manifest stores actual38/84 EOF, not100/110.','sourceReadingEnded':NOW,'validation':'Own stdlib metadata range/hash/receipt only; no OS callback/helper/renderer/preload/product or historical author method executed.'})

metadata_pins=json.loads((OUT/'canonical-pins.json').read_text())+[json.loads((OUT/'history-projection.json').read_text())['sharedBatch']]
ending=[]
for pin in pins+metadata_pins:
    path=Path(pin['path']) if Path(pin['path']).is_absolute() else REPO/pin['path']
    b=path.read_bytes();ending.append({'path':pin['path'],'beforeSha256':pin['sha256'],'endingSha256':sha(b),'endingBytes':len(b),'unchanged':sha(b)==pin['sha256']})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json',{'atUTC':NOW,'files':ending,'sourceInstructionChecks':len(pins),'boundedCanonicalSharedMetadataChecks':len(metadata_pins),'allUnchanged':True,'gitOrFrozenBlobVerification':False,'scope':'Own pinned files and actual bounded historical inputs/shared batch only; no full6669-file historical ending scan.'})

report=f'''# 后台系统通知：有限普通数据链审查

新增 **0 formal /0 candidate /0 related**。Root给定基线`{initial['rootReportedBaseline']}`；本代理Git0、产品不改。没有发送真实系统通知、调用Electron/React/native、读取用户会话或配置。

所核历史：共享批次6669 MD/JSON、4882650递归value scalars，纳冻62排63+、含archive，errors[]；content48/routes52/native48命中均完整保留cap100。原R44对象是inventory/hash，无semantic-full范围；旧R14原MD为路由/producer选段，不把unknown称未读或首次。原R63/N1是ordinary限流等待挡住urgent队列，本次不重复登记、不运行或借旧pass。R11“缺点击协议”只在原R14文本转述，未冒称亲读R11；当前源码已有click绑定，不能把旧缺能力当新问题。

真实普通链已读：Core ResultPayload/legacyItemToDraft→enqueue/bus fan-out→Main订阅→notifyBackgroundResult。终态status/name/command与recipient sessionId一致透传；内容生成终态标题、有限工作身份与结果详情，未得到普通producer输入的字段错配。notifier.show透传recipient sessionId，native实例先捕获该值再注册click；Main按此值发送`notification:open-session`，preload buffer和renderer hook继续用同id走正常session navigation。preload/index和App真实安装/调用只做nav确认，不冒称整模块/应用执行。

范围不覆盖实际OS送达/点击、所有窗口焦点与owner/custody、磁盘session resolver、receipt/队列时序或全部脱敏安全性质。没有伪造非法envelope、恶意ID或不存在session造反例；旧失败动态方向均未恢复。旧urgent排队问题与本次正常字段/目标一致可同时成立。

[manifest](source-manifest.json)：{summary['semanticProductRows']}产品semantic rows共{summary['semanticProductLines']}行（native34/preload-api38两个完整静态adapter，其余6 selected）；body显示{summary['bodyDisplayLines']}，全部导航union {summary['displayUnionLinesIncludingAllNavigation']}。另product-nav-only3，test-nav-only2偶显fixture调用片段{summary['incidentalTestBodyNavigationLines']}行，test声明/语义/执行0，未用test hash2、指令hash2。API/hook范围止于实际EOF38/84，不算命令上界100/110。首metadata失败/截断0，产品/helper/import/fixture/test/网络/native/Git执行0。[旧范围/cause](gate-and-old-cause.json)、[历史投影](history-projection.json)、[分类](classification.json)、[诊断](diagnostics.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。{len(pins)}源/指令与{len(metadata_pins)}有限canonical/shared输入结束SHA均同；非全仓/所有通知无bug结论。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json',{'atUTC':NOW,'selfExcluded':'artifact-receipt.json','files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='artifact-receipt.json'],'productExecution':0,'gitCommands':0,'note':'Own metadata-only finalization, no product/helper/test or foreign method executed.'})
print(json.dumps({'summary':summary,'packetFiles':len(list(OUT.iterdir())),'endingChecks':len(ending)},ensure_ascii=False))
for n in ('report.md','source-manifest.json','artifact-receipt.json'):
    b=(OUT/n).read_bytes();print(n,len(b),sha(b))

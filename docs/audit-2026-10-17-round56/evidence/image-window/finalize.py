from pathlib import Path
import json,hashlib,re,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round130-image-window');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat();sha=lambda b:hashlib.sha256(b).hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def ex(rs):return {i for a,b in rs for i in range(a,b+1)}
def unionranges(ns):
 out=[]
 for n in sorted(ns):
  if out and n==out[-1][1]+1:out[-1][1]=n
  else:out.append([n,n])
 return out
pins={}
for name in ['initial-pins.json','consumer-before-pins.json']:
 for x in json.loads((O/name).read_text())['files']:pins[x['path']]=dict(x,initialPinArtifact=name)
x=json.loads((O/'helper-before-pin.json').read_text());pins[x['path']]=dict(x,initialPinArtifact='helper-before-pin.json')
loopbody=[[486,500],[564,590],[648,663],[720,736],[750,769],[1055,1066],[1225,1240],[1317,1334],[1726,1737],[2039,2069],[2286,2301]]
loopnav=[45,91,272,294,520,934,1141,1142,1159,1358,1969,2018,2072,2107,2157,2205,2279]
loopsel=[[45,45],[91,91],[294,294],[495,497],[572,574],[581,582],[657,657],[731,733],[763,765],[1058,1061],[1141,1141],[1232,1233],[1320,1330],[1731,1735],[2044,2052],[2063,2068],[2293,2297]]
config=[
 ('packages/core/src/context/image-history-window.ts','product','targeted-selected old-full overlap',[[1,86]],[],[[1,2],[4,84]],'Physical entire86-line leaf redisplayed; ordinary fresh/expiry/order/count/byte retention logic only, not new unique or first full coverage'),
 ('packages/core/src/context/compaction.ts','product','selected',[[32,58],[60,184]],[],[[40,58],[60,88],[107,179]],'Only content-block collection, preserve references, occurrence queues and placeholders in current history; complete compaction/reload/provider mechanism not audited'),
 ('packages/core/src/engine/turn-loop.ts','product','selected',loopbody,loopnav,loopsel,'Only ordinary fresh-message tracking and prepare/consume call sites; model, SDK, real session, authority/identity, notes rollover, callbacks and fallback/error lifecycle not executed or globally certified'),
 ('packages/core/src/context/image-history-window.test.ts','test-declaration','full existing test source as declarations only',[[1,99]],[],[[1,99]],'Entire existing99-line test source read as declarations; no Bun import/helper/Array fixture/repeat/image allocation or test execution'),
]
rows=[]
for p,kind,cov,body,nav,sel,purpose in config:
 q=pins[p];shown=ex(body)|set(nav);selected=ex(sel);assert selected<=shown and max(shown)<=q['lines']
 rows.append(dict(path=p,bytes=q['bytes'],sha256=q['sha256'],lineCount=q['lines'],kind=kind,coverage=cov,selectedLineRanges=sel,semanticLineCount=len(selected),displayedBodyLineRanges=body,additionalNavigationSnippetLines=sorted(set(nav)-ex(body)),displayedLineRanges=unionranges(shown),displayedLineCount=len(shown),purpose=purpose,firstPinUTC=q['pinnedBeforeBodyUTC'],firstReadSha256=q['sha256'],initialPinArtifact=q['initialPinArtifact'],firstEverSemanticReadPin=None))
prod=sum(x['semanticLineCount']for x in rows if x['kind']=='product');tests=sum(x['semanticLineCount']for x in rows if x['kind']=='test-declaration');display=sum(x['displayedLineCount']for x in rows)
manager=pins['packages/core/src/context/manager.ts'];hashonly=[dict(**manager,coverage='hash-only; combined symbol search found no image-window direct reference, body0',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0)]
save('source-manifest.json',dict(createdAt=now(),rootReportedBaseline='ae7bd786f133f9c42d212d41110b54eb18c4a9e4',gitCertified=False,files=rows,hashOnlyFiles=hashonly,instructionPins=[dict(**pins[p],coverage='hash-only this packet; prior same-SHA instruction reading reused')for p in ['CODESHELL.md','AGENTS.md']],productSemanticLineCount=prod,testDeclarationLineCount=tests,semanticLineCount=prod+tests,displayedLineCount=display,physicalFullLeafRedisplay=86,oldSameShaFullOverlap=True,newUniqueCoverageClaim=False,globalCoverageUpdated=False,sourceReadingEnded=True,limits=['OldR4/R21 explicit same-SHA full sources retained; current re-review is only the supplied ordinary window/message-order hypothesis, not unread/first coverage.','Current-history index/placeholder behavior is distinct from old full-transcript reload mismatch; no claim that old compaction/reload issue is fixed.','Existing test declaration scope is not runtime pass or allocated image bytes; provider/nonvision stripVision127 causes and runtime paths are not reopened.']))
ref=json.loads((O/'shared-history-reference.json').read_text());shared=Path(ref['source']).read_bytes();assert len(shared)==ref['bytes']and sha(shared)==ref['sha256'];batch=json.loads(shared);inventory={x['path']:x for x in batch['inventory']};sourcechecks=[]
for p,q in pins.items():
 raw=(R/p).read_bytes();sourcechecks.append(dict(path=p,bytes=len(raw),sha256=sha(raw),matchesInitial=len(raw)==q['bytes']and sha(raw)==q['sha256']))
can=json.loads((O/'canonical-history.json').read_text());arc=json.loads((O/'archive-window.json').read_text());metapins=[]
for x in can['objects']:metapins.append(dict(path=x['document'],bytes=x['bytes'],sha256=x['sha256'],pinTiming='Canonical metadata hashed when selected before current source body'))
metapins.append(dict(path=arc['path'],bytes=arc['bytes'],sha256=arc['sha256'],pinTiming='Original archive finite window hashed before line presentation'))
md=[]
for p,shown,selected in [('docs/audit-2026-10-17-round4/context.md',[15,21,23,27,39],[39]),('docs/audit-2026-10-17-round4/candidates-and-skips.md',[8],[]),('docs/audit-2026-10-17-round21/coverage.md',[13,15],[])]:
 raw=(R/p).read_bytes();old=inventory.get(p,{});q=dict(path=p,bytes=len(raw),sha256=sha(raw),firstOwnMetadataHashTiming='Late own metadata hash after rg snippets; shared earlier batch inventory provenance retained, not backdated',sharedInventoryRow=old,displayedMetadataLines=shown,purposeSelectedMetadataLines=selected);md.append(q);metapins.append(dict(path=p,bytes=len(raw),sha256=sha(raw),pinTiming=q['firstOwnMetadataHashTiming'],matchesSharedInventory=old.get('sha256')==sha(raw)))
save('historical-metadata-ranges.json',dict(createdAt=now(),files=md,scope='Finite original report/archive navigation only, no machine-context or source semantic full inference'))
metachecks=[]
for q in metapins:
 raw=(R/q['path']).read_bytes();metachecks.append(dict(**q,endingSha256=sha(raw),matchesSelectedPin=len(raw)==q['bytes']and sha(raw)==q['sha256']))
assert all(x['matchesInitial']for x in sourcechecks)and all(x['matchesSelectedPin']for x in metachecks)
save('ending-checks.json',dict(createdAt=now(),sourceAndInstructionPins=sourcechecks,selectedHistoricalMetadata=metachecks,sharedBatch=dict(path=ref['source'],bytes=len(shared),sha256=sha(shared),matchesInitial=True),allSelectedBytesUnchanged=True,whole5584HistoryIndependentlyRehashed=False,sourceBodyReadForEnding=False,gitExecuted=False))
save('classification.json',dict(createdAt=now(),formal=[],candidates=[],newRelated=[],counts=dict(formal=0,candidates=0,newRelated=0),assessment='Finite negative for ordinary retained image count/encoded length/response-age/order in current working history',oldSameShaFullDirectionsTargeted=1,oldCauseExclusions=[dict(cause='Compaction/reload image numbering mismatch',evidence='archive-window.json original22/240-267 plusR4 context39',decision='Explicit historical finding, not new; window code same-history numbering is not proof of transcript reload identity correctness'),dict(cause='127 stripVision/nonvision/providerKind/dataURL',decision='Previous direction excluded; no substitute entry or dynamic retry')],normalCounterexamplesNotEstablished=['Fresh batch exceeds caps intentionally for first request, per source contract; not a cap bug.','Repeated shared block references counted by serialized occurrences; retaining fewer than4 is not a requirement to fill4slots.','Compacted-away block keys removed and not silently reactivated; container copies preserve retained block reference.'],currentGlobalCorrectnessClaim=False))
save('diagnostics.json',dict(createdAt=now(),metadataCommandFailures=0,metadataOutputTruncations=0,productExecutionFailures=0,productRetries=0,oldFailedDynamicDirectionsRestored=False,historyContextCap='Shared target381 hits, first100 only; path/SHA navigation not exact cause semantic exhaustion',metadataPinTiming='Three report rg snippets own hashes recorded late; earlier shared inventory rows retained. No initial source pin was backfilled.'))
save('validation.json',dict(createdAt=now(),productExecutions=0,helperExecutions=0,importExecutions=0,testExecutions=0,fixtureExecutions=0,modelSDKAccountSessionImageFileTimerNativeNetworkGitExecutions=0,authorSharedBatchMethodExecuted=False,historyStrategy='Reuse Root frozen shared batch, no duplicate millionscalar history scan',productSemanticLineCount=prod,testDeclarationLineCount=tests,displayedLineCount=display,guardedTestPlan='No new ordinary defect established; no new runtime plan proposed.'))
report=f'''# 图片历史窗口：普通内容与顺序有限复核

**0正式 / 0候选 / 0新增关联。** 复核正常fresh图片、保留数量/encoded length、成功响应窗口、嵌套图片与当前history占位顺序，未建立新反例。所有模型/SDK/账户/真实会话或图片/计时/native/network/Git/产品/helper/import/fixture/test执行0；既有测试只读声明。

普通合同与反证：fresh输入先获得一次请求机会，之后旧图按逆track顺序在4图/8MiB cap内选择；fresh批次首轮超过cap是明确策略。consume对已发送block集合使fresh=false并递减remaining；prepare移除已不在history或到期引用。重复同block按序列化出现次数计cap，并无“必须填满4个槽”合同。compaction helper为每次出现排队编号，保留block原引用，只在替换时复制容器，当前history占位顺序得以延续；不据此证明完整transcript reload编号正确。

实际接线：TurnLoop495–497只track配置给定freshImageMessages；1731–1733在正常tool result追加后track，2293–2297对新用户消息同样处理。prepare/consume wrapper572–582、731–733进入实际普通请求分支；continuation1320–1330、summary2044–2068在正常await返回后消费。窗口fresh状态也参与notes rollover guard。模型/error/权限/notes机制仅显示到边界，不认证全部重试、abort或host生命周期。manager.ts仅hash+定位，正文0。

[原canonical](canonical-history.json)中R4 `/sources/5` full、R21 `/files/10` Full static source only同SHA；本次86行叶子完整显示、按指定窗口/顺序问题定向重读，旧重叠不计首次或新增唯一覆盖。R4 context.md39与[archive原22/240–267](archive-window.json)已明确compaction后的working编号与完整transcript reload错位，排除不重报；上轮127 stripVision/nonvision、providerKind/dataURL旧因不重开。

[范围清单](source-manifest.json)：3个产品文件定向选读{prod}语义行，1份既有test源完整99行仅作声明；合计{prod+tests}语义/{display}唯一display。测试已有六次成功与retry不aging、fresh6→newest4、字节cap、嵌套/容器copy、compaction移除不复活、重复引用计数等声明，未执行，也不移用旧pass。指令同SHA复用，只hash；源码/旧作者范围重叠不相加到全局覆盖。

[共享batch投影](history-projection.json)为Root5584份MD/JSON（纳55排56+、4182993递归JSONvalue scalars、archives包含、0parse错）的path/SHA导航，381命中只存前100，非完整旧因语义查重；本review只亲读原对象、有限报告/29行archive，不重扫百万scalar。Root原件SHA与时点见[引用](shared-history-reference.json)，Root归档一次。[ending](ending-checks.json)核7source/指令pins、6选读旧metadata及共享batch全部未变，不声称独立复验5584全history。报告snippet自身hash为晚记，保留shared早期inventory，不回填时序。[诊断](diagnostics.json)命令失败/截断0；分类和执行边界见[classification](classification.json)、[validation](validation.json)。只写exact tmp，未改产品。
'''
(O/'report.md').write_text(report)
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 q=(O/m.group(1)).resolve();links.append(dict(target=m.group(1),exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists']and x['insidePacket']for x in links)
save('checks.json',dict(createdAt=now(),files=[],sourceAndInstructionPins=len(sourcechecks),selectedMetadataPins=len(metachecks),allSelectedBytesUnchanged=True,localLinks=links,allValid=True,productSemanticLineCount=prod,testDeclarationLineCount=tests,displayedLineCount=display,classification='0/0/0',productExecutions=0,Git=0))
receipt=[]
for p in sorted(O.iterdir()):
 if p.is_file()and p.name!='artifact-receipt.json':
  raw=p.read_bytes();receipt.append(dict(path=p.name,bytes=len(raw),sha256=sha(raw)))
save('artifact-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding this self-receipt; shared root history referenced/projected, no author method/product execution',files=receipt))
for n in ['report.md','source-manifest.json','artifact-receipt.json']:
 raw=(O/n).read_bytes();print(n,len(raw),sha(raw))
print(json.dumps(dict(files=len(receipt)+1,receipt=len(receipt),links=len(links),sourcePins=len(sourcechecks),metadataPins=len(metachecks),productSemantic=prod,testDeclaration=tests,totalSemantic=prod+tests,display=display,classification='0/0/0'),ensure_ascii=False))

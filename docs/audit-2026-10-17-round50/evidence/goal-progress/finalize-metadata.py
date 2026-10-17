from pathlib import Path
import json,hashlib,datetime,re
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');d=Path('/tmp/codeshell-audit-round91-goal-progress');now=datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def put(n,a):
 p=d/n;assert not p.exists(),n;p.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
def union(rs):return {n for a,b in rs for n in range(a,b+1)}
pins={}
for name in ['selection-initial-pins.json','consumer-initial-pins.json','entry-initial-pins.json','controller-initial-pin.json','reply-contract-initial-pins.json','protocol-initial-pins.json','group-initial-pin.json','producer-initial-pin.json']:
 for a in json.loads((d/name).read_text())['files']:pins[a['path']]=a
ranges={
'packages/desktop/src/renderer/messages/GoalProgressView.tsx':[[1,130]],
'packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx':[[187,192]],
'packages/desktop/src/renderer/MessageStream.tsx':[[84,89],[426,443],[450,462],[594,598]],
'packages/desktop/src/renderer/types.ts':[[189,202],[542,618],[1258,1276],[1774,1818],[1821,1866]],
'packages/desktop/src/renderer/App.tsx':[[906,911],[1051,1069],[2578,2580],[2657,2657]],
'packages/desktop/src/renderer/ChatView.tsx':[[1801,1803]],
'packages/desktop/src/renderer/app/useRunController.ts':[[1114,1127]],
'packages/desktop/src/preload/index.ts':[[609,626]],
'packages/desktop/src/preload/types.d.ts':[[1124,1140]],
'packages/desktop/src/main/external-runtime-goal-rpc.ts':[[130,148]],
'packages/core/src/protocol/server.ts':[[2231,2295]],
'packages/desktop/src/renderer/messages/streamGroups.ts':[[219,225],[306,308],[413,517],[531,546]],
'packages/core/src/engine/turn-loop.ts':[[454,477],[1054,1056],[1559,1562]]}
displays={}
for p in d.glob('*excerpts*.json'):
 a=json.loads(p.read_text());rows=a.get('files',[a]) if isinstance(a,dict) else a
 for row in rows:
  if row.get('path') in pins:
   displays.setdefault(row['path'],[]).extend(row.get('displayedLineRanges',[]))
for n in ['goal-lifecycle-display.json','group-source-supplement.json']:
 a=json.loads((d/n).read_text());displays.setdefault(a['path'],[]).extend(a['displayedLineRanges'])
# Supplement was printed before this frozen capture; it is not a before-read snapshot.
for rel,rs in ranges.items():
 assert union(rs)<=union(displays.get(rel,[])),(rel,sorted(union(rs)-union(displays.get(rel,[]))))
files=[];nav=[]
for rel,pin in pins.items():
 b=(r/rel).read_bytes();assert len(b)==pin['bytes'] and sha(b)==pin['sha256'];rs=ranges.get(rel,[])
 row={**pin,'coverage':('full' if rel.endswith('/GoalProgressView.tsx') else 'selected') if rs else 'navigation-only','selectedLineRanges':rs,'semanticLineCount':len(union(rs)),'displayedLineRanges':displays.get(rel,[]),'bodyDisplayedLineCount':len(union(displays.get(rel,[]))),'endingBytes':len(b),'endingSha256':sha(b),'endingUTC':now,'currentSourceUnchanged':True,'scope':'Static ordinary rendering/data/return contract for this proposal; adjacent auth/identity/lifecycle implementation, Host/native/transport enforcement, pricing, actual layout/event ordering remain outside certification. Targeted existing consumers are not new/unread/frontier or whole-module claims.'}
 (files if rs else nav).append(row)
h=json.loads((d/'history.json').read_text())
for v in h['inventory']:assert sha((r/v['path']).read_bytes())==v['sha256']
instr=[]
for rel in ['CODESHELL.md','AGENTS.md']:
 b=(r/rel).read_bytes();instr.append({'path':rel,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':sha(b),'coverage':'hash-only this prep; earlier instruction reading retained'})
manifest={'rootReportedReadBaseline':'7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b','files':files,'navigationOnlyFiles':nav,'instructionHashOnly':instr,'counts':{'full':sum(x['coverage']=='full' for x in files),'selected':sum(x['coverage']=='selected' for x in files),'semanticLines':sum(x['semanticLineCount'] for x in files),'bodyDisplayedLines':sum(x['bodyDisplayedLineCount'] for x in files),'testDeclarations':0},'historyReading':{'filesMachineScanned':4693,'pathHits':12,'shaHits':5,'exactObjectsRead':6,'broadGoalCauseHits':962,'broadCap':60,'broadFirstPresentationTruncated':True,'notAllBroadContextsRead':True,'focusedExtendHits':30,'focusedExtendCap':100,'focusedExtendHitIndicesActuallyRead':[0,1,26,27,28,29],'focusedGroupCauseHits':0,'allHistorySemanticExhausted':False},'coverageLimit':'Current130-line leaf is full static source read, not first-ever or module-correctness certification. Other consumers were read for a new specific question and retain known earlier partial/full possibility. No global coverage snapshot update.','productRuns':0}
put('source-manifest.json',manifest)
put('metadata-diagnostics.json',{'productFailures':0,'diagnostics':[{'toolChunk':'514bdd','kind':'own metadata presentation truncated','exitCode':0,'observedOriginalTokens':15487,'maxOutputTokens':6500,'scope':'6 exact coverage objects printed before broad962-cause windows; only visible windows/selected later6 counted, no claim all contexts read.'},{'toolChunk':'31fdc2','kind':'incorrect guessed navigation path','exitCode':2,'missingPath':'packages/desktop/src/renderer/messages/groupMessages.ts','stderr':'rg: packages/desktop/src/renderer/messages/groupMessages.ts: No such file or directory (os error 2)','scope':'No product operation; subsequent filename inventory found actual streamGroups.ts. Existing output was not treated as a complete successful three-file search.'}]})
proposal={'id':'GOAL-R91-C1','proposedFormalId':'DESKTOP-R50-01','priority':'P3','title':'工具回合的过程分组丢失目标“再续”按钮回调','file':'packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx','startLine':190,'endLine':191,'status':'static-source proposal for formal50; independent92 review separately required before promotion','condition':'Same unfinished user turn already contains a visible non-bookkeeping tool; ordinary approaching_limit goal marker remains, then a top-level model stream has busy=true and nonnull streamingAssistantId, so liveTurnActive=true and authoritative user turnTiming not completed.','observedSourceResult':'foldTurnProcess places the approaching marker in innerItems. MessageStream process-card branch does not pass onExtendGoal, and inner GoalProgressView has no onExtend. Leaf77 therefore omits its entire extend button region.','expected':'The goal approaching marker retains its offered extension action while this normal goal/tool turn remains active, as flat renderer and emitter explicitly provide.','counterexamples':['No-tool turn renders flat with the callback.','Closed/non-live turn may expose trailing marker after lastTool; no claim every frame/all phases lose the action.','No approaching marker or intentionally callback-free historical contexts are not this trigger.','Other possible Goal controls are not certified or claimed unavailable.'],'oldCauseDisposition':'Focused group-callback query0 of4693 current frozen history MD+recursive JSON scalar files; canonical112 catalogue has no item of this cause. Old July test-coverage gap mentions server extension failures/legacy routing, not this grouping callback. Existing B2 source comment concerns not_met pruning the marker, whereas this branch retains marker and omits callback. Limited search is not exhaustive semantic reading of all history.','validation':'Static source only. No React/DOM/helper/product/test/network execution; no observed frame, frequency or user-loss measurement.','originalFalseSuccessHypothesis':'Not promoted: clicked-before-result path observed in static source, but ordinary failure/UI manifestation was not separately established; do not count a second finding.'}
put('proposal.json',proposal)
put('validation.json',{'formal':0,'candidate':1,'newRelated':0,'proposalIds':['GOAL-R91-C1'],'productRuns':0,'helperRuns':0,'testRuns':0,'testDeclarations':0,'fixtureRuns':0,'reactDomRuns':0,'timerRuns':0,'businessNetworkRuns':0,'nativeRuns':0,'testPassClaims':0,'gitMutationsWithinPrep':0})
put('ending-checks.json',{'atUTC':now,'sourcePinsSame':len(pins),'instructionsSame':len(instr),'originalHistoryFilesSameBytes':4693,'historySetRescanned':False,'scope':'Original inventory bytes only; formal50 newly created paths excluded by original filter and never backfilled.'})
report='''# Root91：工具回合中目标“再续”动作丢失\n\n提出1条P3静态发现 GOAL-R91-C1，拟在正式50单次登记DESKTOP-R50-01；待独立92复核后才晋升，不是两个bug。[提案](proposal.json)列精确条件、反例和限制。\n\n实际值流：turn-loop454–477发approaching_limit，1054–1056/1559–1562为正常运行调用；types1774–1818保存marker。普通下一次主模型stream_request_start在1258–1275建立未完成assistant和streamingAssistantId；App907–911可令liveTurnActive=true，经App2580/ChatView1801到MessageStream432。fresh user的turnTiming没有完成标记，不能用旧快照assistant.done兼容分支反驳。\n\n同一未完成用户回合已含一个普通可见、非bookkeeping工具时，streamGroups413–509在live情况下innerEnd=end，把该marker放进过程分组。MessageStream451–461未把onExtendGoal传给分组，TurnProcessGroupCard190–191裸渲GoalProgressView；后者77只有onExtend存在才渲再续区域，因此用户正在等待下一次模型流时缺少该入口。flat分支MessageStream597实际有callback，构成范围反例：无工具回合、非live时lastTool之后的尾部不应算同一触发；不声称所有帧或其他Goal控制入口都不可用。\n\n最初考虑clicked先显示已续的失败反馈线索。虽然当前useRunController1116–1126只void调用并log失败，preload返回Promise且server2231–2294有真实无active-run错误合同，本稿没有建立另一条普通失败UI表现，故不晋升、不计第二项，也未制造任意reject/SDK入口或时序。\n\nGate：自有fresh4693文件（1457MD、3236JSON，recursive value scalars）纳49排50+，path12/SHA5，6exact对象只库存/派生，未建目标sameSHA old-full。宽goal cause962/cap60首次输出截断，不称所有context已读；后续extend focus30/cap100仅6窗口实际语义阅读（其余仅定位），group/callback focus0，原库存4693初末字节一致。旧July测试缺口与B2 marker-pruning先因不同，不拿旧pass证明现状。查询范围不等于全历史不存在的证明。\n\n目标leaf130行全文静态阅读，其他消费者选段；[manifest](source-manifest.json)逐项区分范围、[初始pin](selection-initial-pins.json)、[实际分组源码](group-source-excerpts.json)、[完成判定](group-source-supplement.json)、[普通主请求](stream-request-source-excerpts.json)、[live入口](live-producer-source-excerpts.json)、[leaf源码](goal-source-excerpts.json)与[旧cause](group-cause-history.json)。邻接identity/auth/Host/native/bridge机制仅边界不认证。真实浏览器、React、布局、clock/timer、产品/helper/fixture/测试、网络与模型运行均0；没有修产品。首metadata截断与误猜路径[诊断](metadata-diagnostics.json)保存；[结束核对](ending-checks.json)、[验证](validation.json)、[冻结回执](reviewer-receipt.json)。\n'''
(d/'report.md').write_text(report)
links=re.findall(r'\]\(([^)]+)\)',report)
for link in links:assert (d/link).is_file() or link=='reviewer-receipt.json',link
artifacts=[]
for p in sorted(d.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();artifacts.append({'path':p.name,'bytes':len(b),'sha256':sha(b)})
put('reviewer-receipt.json',{'frozenUTC':now,'files':artifacts,'fileCount':len(artifacts),'localLinksChecked':len(links),'productRuns':0})
print(json.dumps({'files':len(artifacts)+1,'links':len(links),'sourcePins':len(pins),'counts':manifest['counts'],'proposal':proposal['id']},ensure_ascii=False))

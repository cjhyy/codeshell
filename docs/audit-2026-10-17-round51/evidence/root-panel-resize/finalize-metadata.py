from pathlib import Path
import json,hashlib,datetime,re
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');d=Path('/tmp/codeshell-audit-round97-panel-resize');now=datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def put(n,a):
 p=d/n;assert not p.exists(),n;p.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
def union(rs):return {i for a,b in rs for i in range(a,b+1)}
rel='packages/desktop/src/renderer/App.tsx';line=(r/rel).read_text().splitlines()[1149];put('app-hook-source-supplement.json',{'path':rel,'displayedLineRanges':[[1150,1150]],'text':'1150: '+line,'captureAfterEarlierNavigation':True})
pins={}
for n in ['selection-initial-pins.json','consumer-initial-pins.json','entry-initial-pins.json','panel-area-initial-pin.json']:
 for p in json.loads((d/n).read_text())['files']:pins[p['path']]=p
sem={
'packages/desktop/src/renderer/app/panelResize.ts':[[1,21],[29,40],[78,113],[117,138]],
'packages/desktop/src/renderer/app/usePanelBuckets.ts':[[734,766],[1019,1021]],
'packages/desktop/src/renderer/app/SessionPanelDock.tsx':[[45,46],[207,208]],
'packages/desktop/src/renderer/App.tsx':[[1139,1140],[1150,1150],[2764,2765]],
'packages/desktop/src/renderer/panels/PanelArea.tsx':[[540,557],[573,586]]}
displays={}
for n in ['source-excerpts.json','consumer-source-excerpts.json','panel-area-source-excerpts.json','app-hook-source-supplement.json']:
 a=json.loads((d/n).read_text());rows=a.get('files',[a])
 for p in rows:displays.setdefault(p['path'],[]).extend(p['displayedLineRanges'])
files=[];hashonly=[]
for rel,pin in pins.items():
 b=(r/rel).read_bytes();assert sha(b)==pin['sha256'];rs=sem.get(rel,[]);assert union(rs)<=union(displays.get(rel,[]))
 row={**pin,'coverage':'selected' if rs else 'hash-only','selectedLineRanges':rs,'displayedLineRanges':displays.get(rel,[]),'semanticLineCount':len(union(rs)),'bodyDisplayedLineCount':len(union(displays.get(rel,[]))),'endingSha256':sha(b),'endingBytes':len(b),'endingUTC':now,'scope':'Ordinary finite width clamp, gesture state/commit/cancel callback source and real handle/props chain only. Guest/native mouse ownership, browser event/frame ordering, actual layout/storage effects and Host lifecycle are not certified. Whole138 source displayed, selected semantic ranges do not imply full module review.'}
 (files if rs else hashonly).append(row)
instr=[]
for rel in ['CODESHELL.md','AGENTS.md']:
 b=(r/rel).read_bytes();instr.append({'path':rel,'bytes':len(b),'lines':len(b.decode().splitlines()),'sha256':sha(b),'coverage':'hash-only this prep; prior instruction reading retained'})
h=json.loads((d/'history.json').read_text())
for p in h['inventory']:assert sha((r/p['path']).read_bytes())==p['sha256']
put('source-manifest.json',{'rootReportedReadBaseline':'424ef9c8953eaaa295d24d63c49127aa8b3ea79e','files':files,'hashOnlyFiles':hashonly,'instructionHashOnly':instr,'counts':{'selected':len(files),'full':0,'semanticLines':sum(p['semanticLineCount'] for p in files),'bodyDisplayedLines':sum(p['bodyDisplayedLineCount'] for p in files),'testDeclarations':0},'historyReading':{'machineFiles':4895,'pathHits':39,'shaHits':20,'resizeCauseHits':68,'cap':60,'compactScopeRowsRead':34,'notAllRawObjectsOrCauseWindowsRead':True,'sameShaOldFullEstablished':False},'productRuns':0,'globalCoverageUpdated':False})
put('metadata-diagnostic.json',{'toolChunk':'bcc53e','ownExpandedHistoryPresenterExit':0,'truncated':True,'observedOriginalTokens':5973,'maxOutputTokens':5000,'originalMachineInventoryAndRowsRetained':True,'laterCompactProjectedRowsActuallyRead':34,'productRuns':0,'scope':'Do not claim all raw objects or retained cause windows were semantically read.'})
put('ending-checks.json',{'atUTC':now,'sourcePinsUnchanged':len(pins),'instructionHashes':instr,'originalHistoryFilesSameBytes':4895,'historySetRescanned':False,'scope':'Original4895 bytes only; newly created formal51 files excluded from original scan, no backfill.'})
put('validation.json',{'formal':0,'candidate':0,'newRelated':0,'productRuns':0,'helperRuns':0,'testRuns':0,'fixtureRuns':0,'reactDomRuns':0,'clockTimerRuns':0,'modelRuns':0,'nativeRuns':0,'networkRuns':0,'gitMutationsWithinPrep':0})
report='''# Root97：面板尺寸普通数据链\n\n有限0新增正式、0候选、0新增关联。没有把DOM/帧/native source的打印当成真实行为验证。\n\n自有fresh4895=1470MD+3425JSON，递归2281905 strings/3390555 scalars，含归档、纳冻结50排51+，parse0。目标path39/SHA20，34条scope紧凑投影实际阅读；原JSON多数inventory、incidental或50显式hash-only，没有建立sameSHA完整审读门槛，也不称此前未读。resize泛因68/cap60并未逐个语义读完，初次宽展示截断已保留[诊断](metadata-diagnostic.json)，[原库存](history.json)与[34投影](coverage-read.compact.json)分开。\n\n实际PanelArea579–584只接受左键，传event.clientX、width prop与handle.parentElement；SessionPanelDock207–208把同一width和beginPanelResize传入，App2764–2765来自usePanelBuckets。后者给min320、max=max(320,floor(window.innerWidth*.7))、onCommit setter/storage与cleanup ref，替换drag或卸载会调用前次cleanup。leaf普通有限值下的clamp、preview/coalescing source、finish的disposed门、commit/cancel宽度选择和监听清理没有建立新的普通反例。\n\n不把虚构bad max回调、异文档window、异常setter或任意DOM时序当生产输入；也不从本次0断言guest mouse ownership、frame取消、跨窗口拖拽、真实布局/viewport或storage异常正确。70%和min320以实际代码优先级保留，未推断极窄窗口下的真实可见布局。\n\n[manifest](source-manifest.json)5 selected、0full，168普通语义行，304正文显示行；target138全显示仅91语义，guest/native与frame效果邻接显示不认证。一个test仅hash、0声明/运行，指令只有当前hash沿用。原始[leaf](source-excerpts.json)、[调用链](consumer-source-excerpts.json)、[真实handle](panel-area-source-excerpts.json)、[App hook](app-hook-source-supplement.json)和[初始pin](selection-initial-pins.json)保持。已知消费者是本题定向复核，不作首次/全史新增覆盖；不更新全局台账。\n\n[结束检查](ending-checks.json)原4895历史字节与6 source/test+2指引pins全同；只比原库存bytes，不冒称新集合穷尽。[验证](validation.json)、[回执](reviewer-receipt.json)。产品/helper/fixture/test/React/DOM/clock/timer/model/native/network运行均0，未修产品。\n'''
(d/'report.md').write_text(report);links=re.findall(r'\]\(([^)]+)\)',report)
for link in links:assert (d/link).is_file() or link=='reviewer-receipt.json'
a=[]
for p in sorted(d.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();a.append({'path':p.name,'bytes':len(b),'sha256':sha(b)})
put('reviewer-receipt.json',{'frozenUTC':now,'files':a,'localLinksChecked':len(links),'productRuns':0})
print(json.dumps({'files':len(a)+1,'links':len(links),'semantic':sum(x['semanticLineCount'] for x in files),'displayed':sum(x['bodyDisplayedLineCount'] for x in files)}))

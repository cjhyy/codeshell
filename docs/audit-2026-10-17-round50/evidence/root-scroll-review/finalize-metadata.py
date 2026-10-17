from pathlib import Path
import json,hashlib,datetime,re
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round84-latest-scroll-review')
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def put(n,v):
 p=out/n;assert not p.exists(),n;p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def union(rs):return set(n for a,b in rs for n in range(a,b+1))
initial=json.loads((out/'selection-initial-pins.json').read_text())['files']+json.loads((out/'css-initial-pin.json').read_text())['files']
sem=[[[1,173]],[[155,164],[283,288],[342,348],[360,364],[755,788],[806,849],[861,894]],[[418,424],[444,512],[1090,1095]]]
display=[[[1,173]],[[147,166],[746,792],[849,905],[270,301],[330,366],[783,849]],[[417,520],[1080,1102]]]
purposes=[
'Full current173-line static hook module read, including output comparisons, unread transitions, follow/snap/onScroll and ResizeObserver source. Earlier83 selected97 and current85 overlap; not first-ever/unread or browser/React/layout certification.',
'Actual hook props/scope and active flag, textarea resize source, explicit resume on conversation/send, mounted hidden chat section, listRef/onScroll/contentRef, item switches and approval placement, jump button and announcement. Adjacent sidebar focus, unload/attachments/authority actions displayed only and not certified.',
'Selected structural viewport/messages/transcript sizing, overflow, jump button and announcement plus responsive padding/gap. No computed style or global stylesheet proof.'
]
rows=[]
for i,pin in enumerate(initial):
 data=(root/pin['path']).read_bytes();assert sha(data)==pin['sha256'];assert len(data)==pin['bytes']
 assert union(sem[i])<=union(display[i]);assert max(union(display[i]))<=pin['lines']
 rows.append({**pin,'coverage':'full' if i==0 else 'selected','selectedLineRanges':sem[i],'displayedLineRanges':display[i],'semanticLineCount':len(union(sem[i])),'bodyDisplayedLineCount':len(union(display[i])),'purpose':purposes[i],'firstEverSemanticReadSha256':None,'initialSemanticReadSha256':pin['sha256'],'endingSha256':sha(data),'endingBytes':len(data),'endingCheckedUTC':now,'unchanged':True})
h=json.loads((out/'history.json').read_text())
checks=[]
for row in h['inventory']:
 rel=row.get('path',row.get('file'));data=(root/rel).read_bytes();assert sha(data)==row['sha256'],rel
 checks.append({'path':rel,'unchanged':True})
instr=[]
for rel in ['CODESHELL.md','AGENTS.md']:
 data=(root/rel).read_bytes();instr.append({'path':rel,'bytes':len(data),'lines':len(data.decode().splitlines()),'sha256':sha(data),'coverage':'hash-only this prep; prior instruction-body reading retained','currentInstructionBodyRead':False})
manifest={'schema':'static-source-manifest-v1','rootReportedReadBaseline':'7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b','files':rows,'instructionHashOnly':instr,'counts':{'full':1,'selected':2,'semanticLines':sum(r['semanticLineCount'] for r in rows),'bodyDisplayedLines':sum(r['bodyDisplayedLineCount'] for r in rows),'testDeclarationLines':0},'historicalMetadataReads':{'machinePathObjects':75,'compactScopeRowsActuallyRead':12,'hookPathHits':190,'hookShaHits':56,'workbenchPathHits':184,'workbenchShaHits':28,'scrollCauseHits':198,'contextCapEach':60,'notAllRetainedWindowsRead':True,'sameShaPriorModuleFullEstablished':False,'knownPrior83SelectedHookLines':97},'scope':'Static source only. Root independently read own captures before85 frozen packet was inspected; not blind because prior83 source was known. No addition to global coverage snapshot, no summing overlapped reads as unique frontier. Source shown in adjacent callbacks remains boundary/display only. Actual browser/React/layout/event ordering not observed.','productRuns':0}
put('source-manifest.json',manifest)
put('ending-checks.json',{'atUTC':now,'sourcesUnchanged':len(rows),'historyFilesUnchanged':len(checks),'historySetDriftChecked':False,'historyLimit':'Original4693 inventory bytes checked, not a fresh set scan; original scan universe/caps retained.','instructions':instr})
put('validation.json',{'formal':0,'candidate':0,'newRelated':0,'productRuns':0,'helperRuns':0,'testRuns':0,'fixtureRuns':0,'browserRuns':0,'reactDomLayoutRuns':0,'timerRuns':0,'businessNetworkRuns':0,'nativeRuns':0,'testPassClaims':0,'metadataOnlyChecks':'Hash/byte/range and own evidence generation; no source imports or product functions executed.'})
report='''# Root84：消息滚动的有限静态复核\n\n本次0新增正式问题、0候选、0新增关联。此前112条历史问题不变。独立审读自己的源码捕获后才查看已冻结85的manifest，不称盲审；没有读取85可变材料。\n\n当前hook173行全文静态审读；Workbench与app.css仍只选段。真实调用给出items、workspace/activeId scope、connection/loading与active chat；section以hidden切换，scroll容器及transcript节点的ref绑定保持在同一实际结构。jump按钮调用resume/focus，打开会话和成功send显式resume。审批内容位于被观察transcript之内，textarea高度变化有list resize source路径。\n\n未建立普通源码反例。曾考虑的“审批增长完全在被观察容器外”被实际Workbench846位置排除；“切换view就替换滚动ref节点”不符合当前hidden结构。程序scroll标记与near-bottom判断中的实际事件顺序、浏览器scroll anchoring/ResizeObserver/React帧与布局均未执行，不能从源码有限0认定这些机制正确，也没有制造任意坐标或时序当作观察到的bug。CSS只审列明布局规则，不认证整个样式级联。\n\n既有83同SHA hook选读97行保留，当前全文不是首次阅读或全史新增173行；85另有重叠，不能相加唯一覆盖。fresh history机器扫描4693文件，12条scope紧凑投影实际阅读；190路径/56SHA/198cause命中及cap60不能代表所有历史语义已读。覆盖304/169/4170仍是dated45，不更新全局数量。\n\n范围与计数：[source manifest](source-manifest.json)；原始[hook](hook-excerpts.first.json)、[Workbench初摘](workbench-excerpts.first.json)、[布局补摘](layout-source-excerpts.json)与[导航](layout-navigation.first.txt)保持。历史[扫描](history.json)和[实际12行投影](coverage-review.compact.json)分别记录机器与语义范围。初末[检查](ending-checks.json)、[验证](validation.json)和[回执](reviewer-receipt.json)。产品、helper、fixture、测试、React/DOM、clock/timer、模型、真实数据、native及业务网络运行均0。\n'''
(out/'report.md').write_text(report)
files=[]
for p in sorted(out.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':sha(b)})
links=re.findall(r'\]\(([^)]+)\)',report)
for link in links:assert (out/link).exists() or link=='reviewer-receipt.json',link
put('reviewer-receipt.json',{'frozenUTC':now,'files':files,'fileCount':len(files),'localLinksChecked':len(links),'productRuns':0,'gitMutations':0})
print(json.dumps({'files':len(files)+1,'receiptEntries':len(files),'links':len(links),'counts':manifest['counts'],'findingCounts':[0,0,0]},ensure_ascii=False))

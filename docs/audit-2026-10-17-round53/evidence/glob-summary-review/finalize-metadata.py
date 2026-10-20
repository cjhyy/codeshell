from pathlib import Path
import hashlib,json,re,subprocess,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round112-glob-summary-review');now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(n,v):(O/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def expand(rs):return {n for a,b in rs for n in range(a,b+1)}
def ranges(ns):
 ns=sorted(ns);out=[]
 for n in ns:
  if out and n==out[-1][1]+1:out[-1][1]=n
  else:out.append([n,n])
 return out
pins={}
for f in ['initial-pins.json','consumer-before-pins.json','registry-before-pins.json']:
 for x in json.loads((O/f).read_text())['files']:pins[x['path']]=dict(x,initialPinArtifact=f)
for f in ['cli-before-pin.json','app-before-pin.json','virtual-list-before-pin.json']:
 x=json.loads((O/f).read_text());pins[x['path']]=dict(x,initialPinArtifact=f)
# Only ranges actually displayed before freeze; semantic ranges are purpose-bounded subsets of the union.
config=[
 ('packages/tui/src/ui/components/ToolCall.tsx','product',[[1,12],[28,34],[77,201],[224,270]],[42,69,287,292,293,306,309,315,316,317,330,333,338,339,347,350,355,356,364,376],[[32,32],[82,88],[98,174],[195,201],[244,263]],'ToolCallResult success/error/empty result, default and expanded handling, Glob status-line count; no general diff/ANSI audit'),
 ('packages/core/src/tool-system/builtin/glob.ts','product',[[1,19],[24,39],[70,121]],[],[[13,16],[29,34],[84,86],[103,111],[114,117]],'Ordinary Glob name, valid args/zero or small nonempty success text format; filesystem/path-policy/stat operations displayed only as boundary'),
 ('packages/tui/src/cli/output/renderer.ts','product',[[1,77],[108,163]],[],[[6,6],[14,24],[64,74],[119,125],[138,146]],'TextRenderer ordinary tool_result, factory text branch, compactSummary Glob; unrelated output events/classes displayed context only'),
 ('packages/tui/src/ui/app-helpers.tsx','product',[[232,274]],[15,25,29,33,37,52,59,70,83,103,114,118,133,140,168,189,204],[[15,15],[232,235],[261,272]],'renderEntry ordinary tool_result DTO forwarding only; other function-name matches navigation'),
 ('packages/tui/src/cli/commands/run.ts','product',[[1,20],[226,237]],[26],[[26,26],[232,236]],'Actual CLI output format default/text renderer and event forwarding only; initialization/runtime/identity mechanisms not assessed'),
 ('packages/tui/src/ui/App.tsx','product',[[883,908],[2158,2178]],[25,26,27,94,108,427,430,1933],[[883,905],[2166,2177]],'Main-agent tool_result fields and actual VirtualMessageList renderEntry prop binding only'),
 ('packages/tui/src/ui/components/VirtualMessageList.tsx','product',[[82,88],[160,168],[230,237]],[34,41,42],[[34,34],[41,42],[86,86],[166,167],[235,236]],'Default expanded and renderEntry prop forwarding only; no scroll/layout correctness conclusion'),
 ('packages/core/src/tool-system/builtin/index.ts','product',[[196,198],[206,210],[398,415]],[26,145,200,201,224,225,1142],[[26,26],[196,197],[206,209],[403,404],[413,413]],'Builtin Glob binding and ordinary success-string conversion; permission/path-policy mechanism displayed but not semantically audited'),
 ('packages/core/src/tool-system/registry.ts','product',[[238,267]],[17,94],[[17,17],[243,244],[251,267]],'Ordinary result DTO field preservation; cancellation/cleanup mechanisms boundary only'),
 ('packages/core/src/tool-system/builtin/glob.test.ts','test-declaration',[[19,35],[88,92]],[36,42,52,65,80,93,104,111],[[24,34],[88,91]],'Existing ordinary positive header/empty result test declarations only; test functions and filesystem fixtures never executed'),
 ('packages/tui/src/cli/output/renderer.test.ts','test-declaration',[[86,111]],[2,35,36,37,48,49,63,64,65],[[86,93],[95,110]],'Existing text/view_image and format test declarations only; no Glob assertion found in this file search, no execution'),
]
files=[];excerpts=[];ending=[]
for p,kind,body,nav,sel,purpose in config:
 pin=pins[p];b=(R/p).read_bytes();sha=hashlib.sha256(b).hexdigest();ls=b.decode().splitlines();shown=expand(body)|set(nav);selected=expand(sel);assert selected<=shown;assert max(shown)<=len(ls)
 same=len(b)==pin['bytes']and sha==pin['sha256'];ending.append(dict(path=p,bytes=len(b),sha256=sha,matchesInitial=same))
 row=dict(path=p,bytes=pin['bytes'],sha256=pin['sha256'],lineCount=pin['lines'],kind=kind,coverage='targeted-selected ordinary DTO/display cause re-review; not first/full coverage',selectedLineRanges=sel,semanticLineCount=len(selected),displayedBodyLineRanges=body,additionalNavigationSnippetLines=sorted(set(nav)-expand(body)),displayedLineRanges=ranges(shown),displayedLineCount=len(shown),firstPinUTC=pin['pinnedBeforeBodyUTC'],initialPinArtifact=pin['initialPinArtifact'],firstReadSha256=pin['sha256'],endingSha256=sha,matchesInitial=same,purpose=purpose)
 if kind=='test-declaration':row['testDeclarationLineCount']=len(selected)
 files.append(row);excerpts.append(dict(path=p,sha256=sha,selectedLineRanges=sel,displayedLineRanges=ranges(shown),lines=[dict(line=n,text=ls[n-1],selectedForPurpose=n in selected)for n in sorted(shown)]))
inst=[]
for p in ['CODESHELL.md','AGENTS.md']:
 q=pins[p];b=(R/p).read_bytes();sha=hashlib.sha256(b).hexdigest();same=len(b)==q['bytes']and sha==q['sha256'];ending.append(dict(path=p,bytes=len(b),sha256=sha,matchesInitial=same));inst.append(dict(**q,coverage='hash-only this packet; prior full instruction reading reused unchanged',selectedLineRanges=[],displayedLineRanges=[],semanticLineCount=0,displayedLineCount=0))
prod=sum(x['semanticLineCount']for x in files if x['kind']=='product');tests=sum(x['semanticLineCount']for x in files if x['kind']=='test-declaration');display=sum(x['displayedLineCount']for x in files)
save('source-excerpts.json',dict(createdAt=now(),purpose='Materialization only of already displayed/selected source lines; no new semantic reading or execution counted',files=excerpts))
save('source-manifest.json',dict(createdAt=now(),parentContext='524c0827a480132119b637aa87e16f0eab9895f3',parentContextSource='Root-provided; Git not queried',files=files,hashOnlyFiles=inst,productSemanticLineCount=prod,testDeclarationLineCount=tests,semanticLineCount=prod+tests,displayedLineCount=display,coverageNotes=['All file counts use per-file unique line union; selected includes only ordinary DTO/display purpose, not every displayed line. Shared producer/consumer and prior author/reviewer readings must not be summed into new global coverage.','Original same-SHA R7 source/test full and R21 renderer full-source declarations retained in canonical-history-decisions.json. This packet is a concrete-cause targeted re-review, never a first/full new coverage claim.','All initial source pins precede their first body/navigation snippet in this packet. CLI additional historical canonical lookup was performed after its pinned selected body read; see focused-history-gate.json.','Core path-policy/permission/runtime abort/identity/native mechanisms displayed at the boundary are not correctness conclusions; no real tool execution or user data used.']))
history=json.loads((O/'history-inventory.json').read_text());changed=[];missing=[]
for f in history['files']:
 p=R/f['path']
 if not p.exists():missing.append(f['path']);continue
 b=p.read_bytes();sha=hashlib.sha256(b).hexdigest()
 if len(b)!=f['bytes']or sha!=f['sha256']:changed.append(dict(path=f['path'],originalBytes=f['bytes'],originalSha256=f['sha256'],currentBytes=len(b),currentSha256=sha))
paths=sorted(set(subprocess.run(['rg','--files','docs','bugs','-g','*.md','-g','*.json'],cwd=R,capture_output=True,text=True,check=True).stdout.splitlines()))
def allowed(p):
 m=re.search(r'(?:^|/)audit-[^/]*-round(\d+)(?:/|$)',p);return not(m and int(m.group(1))>=53)
old={f['path']for f in history['files']};cur={p for p in paths if allowed(p)}
save('ending-checks.json',dict(createdAt=now(),sourceAndInstructionPins=ending,historyOriginalCount=len(old),historyCurrentIncludedCount=len(cur),historyChanged=changed,historyMissing=missing,historyAdded=sorted(cur-old),historyRemoved=sorted(old-cur),excludedCurrentPaths=[p for p in paths if not allowed(p)],gitExecuted=False))
save('metadata-diagnostics.json',dict(createdAt=now(),metadataCommandErrors=0,productExecutionFailures=0,outputTruncations=[dict(toolChunk='cc9592',exitCode=0,maxOutputTokens=4800,reportedOriginalTokenCount=29078,reportedOutputLines=90,scope='Historical source-row and broad cause context presentation; source products not executed',limit='Original tool result is the retained first presentation; no byte-original stdout file captured. Broad glob substring also recalled global; counts are not exact-cause absence.'),dict(toolChunk='921764',exitCode=0,maxOutputTokens=4500,reportedOriginalTokenCount=9745,reportedOutputLines=84,scope='Focused history previews and CLI original source rows presentation',limit='Full focused contexts saved in JSON; bounded matched windows subsequently selected without rerunning products.')],querySupplement='Word-boundary Glob query is an additional narrower metadata query, not a product retry or silent rewrite of first broad results. Exact helper-name query and literal zero-result string each return0 in frozen cohort.',additionalCanonicalGateTiming='CLI was pinned before selected source body; its additional historical source-row lookup is later and is not backdated.'))
save('review-decisions.json',dict(createdAt=now(),reviewedAlias='TUI-R111-C1',rootFormalIdentity='TUI-R53-01',sameItemDoNotDoubleCount=True,independentOpinion='Supports one P3 static ordinary consumer status-line-as-file count defect',newFindingIDs=[],reviewedCandidates=1,formalCreatedByThisPacket=0,newRelated=0,ordinaryCases=[dict(producer='glob.ts84-85; ordinary valid pattern with no matches',tuiStaticConsequence='ToolCall.tsx244-261 keeps nonnumeric status message as one file; summary1 files in default and expanded modes',cliStaticConsequence='compactSummary145-146 also counts the sole status line as one file'),dict(producer='glob.ts103-117; exactly one normal match within cap',cliStaticConsequence='Header plus path line counts2 files',tuiControl='Numeric matched header is removed, so ordinary one-match count remains1')],counterEvidence=['TUI keeps the explicit no-match body message, so the contradictory count is a display summary defect; no missing actual file/result or data loss inferred.','Empty content and error results use other component branches; no arbitrary invalid DTO/NaN/error text used.','CLI JSON/JSONL formats use other renderer classes; the claimed count applies to default/plain text.','TUI expanded mode uses the same pre-branch count, so changing expanded does not correct this zero-result count.','May30 /123 concerns producer formatting above200 and pluralization, not CLI/TUI consumer counting; R7 files/cross-review references are derivative pointers to that old item.','No new >200 finding, sorting contract finding, unused Core compactOutput reachability claim or old Slice/i18n/R7TUI/R14 dynamic retry.'],runtimeValidation=False))
save('validation.json',dict(createdAt=now(),productExecutions=0,helperExecutions=0,fixtureExecutions=0,testExecutions=0,reactDOMClockTimerNativeNetworkModelExecutions=0,gitExecutions=0,authorMethodsExecuted=0,runtimeValidation=False,evidenceLevel='Independent static source and metadata review; manual inference of branch behavior, no product or language fixture evaluation',productSemanticLineCount=prod,testDeclarationLineCount=tests,semanticLineCount=prod+tests,displayedLineCount=display))
report=f'''# Glob 状态行被计入文件数：独立静态复核

支持单项 **P3 静态显示问题**，沿用作者 alias **TUI-R111-C1**，Root 拟正式编号 **TUI-R53-01**；这是同一项的复核，不新增第二个 ID。普通成功结果中的说明行被当作匹配文件计数。没有运行产品、表达式样例、fixture、tests、TUI 或模型，以下输出均为源码分支推导。

| 正常 producer 结果 | 活跃 consumer | 静态可推导摘要 |
| --- | --- | --- |
| 有效 Glob pattern 无匹配：`glob.ts:84–85` 返回 `No files matched the pattern.` | TUI `ToolCall.tsx:244–261` 只过滤非空行和数字 matched header | 该说明行留在 files，显示 `1 files`；默认折叠和展开分支相同 |
| 恰好一个普通匹配：`glob.ts:103–117` 生成数字 header 加一个路径行 | CLI `renderer.ts:138–146` 计算所有非空行数 | 两行计为 `2 files`；零匹配字符串同样计为 `1 files` |

普通生产链有实际绑定：builtin `index.ts:403/413` 将 Glob 定义绑定 `globTool`，`:196–208` 的字符串结果协议把这两类文本作为成功结果，registry `:243–267` 保留 result。TUI App `:883–905` 接收主 agent 的 `tool_result` 并保存 `r.result`；`:2166–2177` 的 VirtualMessageList 经其 `:166–167/235–236` 调 `renderEntry`，app-helpers `:261–271` 将字段原样交给实际 **ToolCallResult**。组件 `:106–107` 默认 localExpanded=false，`:134–152` 在成功非空结果调用 Glob renderer 并展示摘要。CLI run `:232–236` 默认 text、把普通 stream event 送入 renderer；factory `:119–125` 选择 TextRenderer，`:64–72` 对成功 tool_result 调 compactSummary。

反证与影响限定：TUI 对普通正结果已经过滤数字 header，正常单匹配在 TUI 仍计 1；它也保留无匹配说明正文，用户能看见与摘要矛盾的提示。问题是摘要误导，不据此推断文件丢失、工具执行失败、目录扫描或数据损坏。错误/空内容有独立分支；CLI JSON/JSONL 不走这个文本摘要。展开模式不改变 TUI 的计数过滤。未扩大到 >200 footer、排序、权限、身份、真实文件系统或未证活跃的 Core compactOutput helper。

历史 gate：fresh [原库存](history-inventory.json) **5150 = 1489 MD + 3661 JSON**，纳已冻正式52、排正式53+；JSON 2430509 strings / 3611347 scalars，递归 value、不把键当文本；exact archive 段162、substring174。原 R7对 ToolCall/glob/既有 glob test 同 SHA明确 full，原 R21 renderer 记1–163全文并保留仅 JSON 动态调用限定，所以本次只是具体新问题 **targeted selected 复核**，不是首次/full 新覆盖。[canonical 对象与旧因决定](canonical-history-decisions.json)保存原 May30 `/123`：它是 >200 producer 缺标题/单复数问题；R7 files.md22 与 cross-review-tui.md14仅引用该旧项，不是当前消费者计数原因。

[首轮 gate](history-gate.json)宽 query有 global 等误召回及 cap100，不能报成精确0。追加[词边界 gate](focused-history-gate.json)计68个宽上下文；零结果完整字符串与具体 renderer/helper 名称计数 query均0。实际看了68条有界匹配窗口（62条另存 [remaining windows](remaining-cause-window-review.json)，6条先前定向查看），巨型 scalar 未全文；关键旧项回到原 `/123` 直读，不把重复嵌套文本当独立旧 finding，也不承诺语义穷尽。CLI 额外 canonical 检索晚于其已 pin 的选段阅读，时序如实保留，没有回填为读前。

范围见[源码清单](source-manifest.json)：**9 产品 selected，{prod} 产品语义行；2 既有测试文件选读 {tests} 行声明；合计 {prod+tests} 语义行 / {display} 唯一显示行**。导航、权限/取消机制边界及重复打印不增加语义；测试只读普通正结果/零结果声明和既有 CLI renderer 声明，未执行，也未称它们覆盖这次 UI count。[excerpts](source-excerpts.json)只保存已实际显示范围。两个指令文件本轮 hash-only，复用先前同字节阅读。源范围与旧作者/reviewer 可能重叠，不加到全局完整覆盖数。

[首诊断](metadata-diagnostics.json)保留两次历史元数据展示截断（退出均0，未伪造原始 raw）；后续仅自己的元数据范围/字节/链接检查，没有产品重试。[ending](ending-checks.json)保留原时点与当前字节；[validation](validation.json)记录所有产品/helper/fixture/test/React/DOM/clock/timer/native/network/model/Git执行0。父上下文 `524c0827a480132119b637aa87e16f0eab9895f3` 由 Root 提供，本 agent 未查 Git。旧 R7 TUI、R14/Slice 等失败动态方向均保持停止，没有转借旧 pass。
'''
(O/'review.md').write_text(report)
links=[]
for m in re.finditer(r'\[[^\]]*\]\(([^)]+)\)',report):
 q=(O/m.group(1)).resolve();links.append(dict(target=m.group(1),exists=q.is_file(),insidePacket=q.is_relative_to(O.resolve())))
assert all(x['exists']and x['insidePacket']for x in links)
assert all(x['matchesInitial']for x in ending)
assert not changed and not missing and not(cur-old)and not(old-cur)
save('checks.json',dict(createdAt=now(),files=[],sourceCheckCount=len(ending),sourcePinsAllUnchanged=True,historyFilesChecked=len(old),historyAllUnchanged=True,localLinks=links,allLinksValid=True,sourceRows=len(files),productRows=9,testDeclarationRows=2,productSemanticLineCount=prod,testDeclarationLineCount=tests,semanticLineCount=prod+tests,displayedLineCount=display,newFindingIDs=0,reviewedSameCandidate=1,productExecutions=0,gitExecutions=0))
receipt=[]
for p in sorted(O.iterdir()):
 if p.is_file()and p.name!='reviewer-receipt.json':
  b=p.read_bytes();receipt.append(dict(path=p.name,bytes=len(b),sha256=hashlib.sha256(b).hexdigest()))
save('reviewer-receipt.json',dict(createdAt=now(),frozen=True,scope='Exact packet files excluding this self-receipt; independent static cause review, no product execution or Git',files=receipt))
for n in ['review.md','source-manifest.json','reviewer-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),hashlib.sha256(b).hexdigest())
print(json.dumps(dict(files=len(receipt)+1,receipt=len(receipt),links=len(links),sourcePins=len(ending),semanticRows=len(files),productSemantic=prod,testDeclarations=tests,totalSemantic=prod+tests,displayed=display,history=len(old),excludedCurrentPaths=len([p for p in paths if not allowed(p)])),ensure_ascii=False))

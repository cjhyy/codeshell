from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
O=Path('/tmp/codeshell-audit-round139-relay-stream')
def sha(b):return hashlib.sha256(b).hexdigest()
def save(n,d): (O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def read(n):return json.loads((O/n).read_text())
def expand(rs):return set(i for a,b in rs for i in range(a,b+1))
def compact(s):
 z=[]
 for i in sorted(s):
  if z and i==z[-1][1]+1:z[-1][1]=i
  else:z.append([i,i])
 return z
at=datetime.datetime.now(datetime.timezone.utc).isoformat()
pins={}
for n in ['initial-pins.json','support-pins.json','test-support-pin.json','byte-test-support-pin.json']:
 for row in read(n)['files']:pins[row['path']]=row
# Actual prior tool-displayed lines, not inference from a whole-file byte hash.
D={
 'packages/server/src/remote-relay/byte-stream.ts':([[1,65]],[]),
 'packages/server/src/remote-relay/local-stream.ts':([[1,125]],[]),
 'packages/server/src/remote-relay/protocol.ts':([[1,70]],[]),
 'packages/server/src/remote-relay/connector.ts':([[1,44],[149,175],[190,247],[254,280]],[145,177]),
 'packages/server/src/remote-relay/relay.native.test.ts':([[1,51]],[]),
 'docs/device-relay.md':([[86,113]],[49,50,59,61,76,77,120,140,145]),
 'tests/fixtures/device-relay/byte-stream.mjs':([[1,69]],[]),
 'tests/fixtures/device-relay/runner.mjs':([[73,104],[272,309],[330,356],[376,385]],[11,69,107,109,117,231,236,245,246,256,266,268,315,316,326,327,328,361,362,363,365,366,367,368,370,371,373,393,394,396,399,400,401,404,405,416,435,463,480,481,494,497,500])
}
S={
 'packages/server/src/remote-relay/byte-stream.ts':([[1,65]],'full','product','Raw byte forwarding, serial write callback chunks, EOF/close; same-SHA full overlap with Round14.'),
 'packages/server/src/remote-relay/local-stream.ts':([[13,87],[97,125]],'selected','product','Ordinary connect/pipe/close/done settlement and bounded early-response drain; URL/header/authority construction excluded.'),
 'packages/server/src/remote-relay/protocol.ts':([[2,17],[38,70]],'selected','product','Constants, control DTO projection/switch and recognized directions. Token/host/origin enforcement bodies excluded; no protocol/authority certification.'),
 'packages/server/src/remote-relay/connector.ts':([[1,3],[17,24],[37,44],[153,153],[159,164],[192,203],[214,240],[254,256],[261,275]],'selected','product','Actual text control receiver/JSON responses, stream ownership completion/removal, closure waiting. Credential acquisition/authority/generation enforcement not certified.'),
 'docs/device-relay.md':([[90,110]],'selected','contract-document','Declared binary chunk limits, HTTP framing vs whole-connection EOF and drain/cancel contract, not externally verified.'),
 'tests/fixtures/device-relay/byte-stream.mjs':([[27,43],[51,62]],'selected','test-declaration','Five delayed-reader payload lengths plus abrupt disconnect declaration; no fixture/function/timer/stream executed.'),
 'tests/fixtures/device-relay/runner.mjs':([[73,104],[272,300],[330,354],[376,385]],'selected','test-declaration','Existing HTTP request-end vs connection lifetime, early response/truncation, large/Range/backpressure/cancel and invalid-frame declarations; no native/network execution.')
}
rows=[]; excerpts=[]; ends=[]
for path,pin in pins.items():
 b=(R/path).read_bytes(); digest=sha(b); lines=b.decode().splitlines()
 ends.append({'path':path,'bytes':len(b),'sha256':digest,'initialBytes':pin['bytes'],'initialSha256':pin['sha256'],'sameBytesAndSha256':len(b)==pin['bytes'] and digest==pin['sha256']})
 if path not in S:continue
 sr,cov,kind,purpose=S[path]; dr,nav=D[path]; ds=expand(dr)|set(nav); ss=expand(sr)
 assert ss<=ds and max(ds)<=len(lines)
 row={**pin,'coverage':cov,'sourceKind':kind,'selectedLineRanges':sr,'semanticLines':len(ss),'displayedLineRanges':dr,'additionalNavigationSnippetLines':nav,'uniqueDisplayedLines':len(ds),'navigationOnlyDisplayedLineRanges':compact(ds-ss),'purpose':purpose,'fullFileReadingClaimed':cov=='full','finishSha256':digest,'finishMatchesInitial':digest==pin['sha256'],'initialSemanticReadSha256':pin['sha256']}
 if path.endswith('/byte-stream.ts'):row['priorCoverage']={'sameShaFull':True,'canonicalManifest':'docs/audit-2026-10-17-round14/evidence/bytes-source-manifest.json#/files/5','canonicalReport':'docs/audit-2026-10-17-round14/bytes.md:18','newUniqueReadingClaim':False}
 else:row['priorCoverage']={'currentReadNotClaimedAsNewUniqueCoverage':True,'reason':'No exhaustive semantic reconstruction of all historical coverage for dependencies; explicit overlap retained; unknown is not unread.'}
 rows.append(row)
 excerpts.append({'path':path,'sha256':digest,'capturedUTC':at,'captureTiming':'After actual source display; metadata reproduction, no new semantic read or execution','ranges':[{'start':a,'end':z,'lines':lines[a-1:z]} for a,z in sr]})
navonly=[]
for path,(dr,nav) in D.items():
 if path in S:continue
 pin=pins[path];navonly.append({**pin,'displayedLineRanges':dr,'additionalNavigationSnippetLines':nav,'uniqueDisplayedLines':len(expand(dr)|set(nav)),'semanticLines':0,'coverage':'navigation-only','purpose':'One existing native test launcher declaration observed, full launcher displayed; build/subprocess/native behavior not audited or executed.'})
counts={'semanticFiles':len(rows),'full':sum(x['coverage']=='full' for x in rows),'selected':sum(x['coverage']=='selected' for x in rows),'semanticLines':sum(x['semanticLines'] for x in rows),'productSemanticLines':sum(x['semanticLines'] for x in rows if x['sourceKind']=='product'),'testDeclarationSemanticLines':sum(x['semanticLines'] for x in rows if x['sourceKind']=='test-declaration'),'contractDocumentSemanticLines':sum(x['semanticLines'] for x in rows if x['sourceKind']=='contract-document'),'uniqueDisplayedLines':sum(x['uniqueDisplayedLines'] for x in rows)+sum(x['uniqueDisplayedLines'] for x in navonly),'displayCoverageComplete':True,'navigationOnlyFiles':len(navonly),'instructionHashOnly':2}
manifest={'atUTC':at,'role':'Independent ordinary stream source reviewer; not runtime verifier','rootReportedBaselineOnly':read('initial-pins.json')['rootReportedBaselineOnly'],'ownGitOperations':0,'files':rows,'navigationOnly':navonly,'instructionHashOnly':[pins[x] for x in ['AGENTS.md','CODESHELL.md']],'instructionsCarried':'Prior actual AGENTS5/CODESHELL217 read under same SHA, not repeated semantic reading.','counts':counts,'noUniqueNewCoverageClaim':True,'authorityScope':'Neither selected DTO parsing nor displayed guards certify whole handshake, identity, credential, authority, native or external relay behavior.'}
save('source-manifest.json',manifest);save('source-excerpts.json',{'files':excerpts,'productExecution':0,'note':'Selected evidence reproduction only, not executable fixtures.'})
hp=read('shared-history-projection.json');targeted=read('targeted-history-hits.json')
hist=[]
for x in targeted['files']+read('history-support-pins.json')['files']:
 b=(R/x['path']).read_bytes();hist.append({'path':x['path'],'initialSha256':x['sha256'],'finishSha256':sha(b),'sameBytesAndSha256':len(b)==x['bytes'] and sha(b)==x['sha256']})
bp=Path(hp['sharedBatch']['path']);bb=bp.read_bytes()
save('ending-checks.json',{'atUTC':at,'sourceAndInstructionFiles':ends,'allSourceAndInstructionPinsSame':all(x['sameBytesAndSha256'] for x in ends),'targetedHistoryMemberChecks':hist,'allTargetedHistoryPinsSame':all(x['sameBytesAndSha256'] for x in hist),'sharedBatch':{**hp['sharedBatch'],'endingBytes':len(bb),'endingSha256':sha(bb),'sameBytesAndSha256':len(bb)==hp['sharedBatch']['bytes'] and sha(bb)==hp['sharedBatch']['sha256']},'limits':'Shared batch equality is not own verification of every historical corpus member; no Git read or product runtime.'})
save('history-read-windows.json',{'scope':hp['scope'],'counts':hp['counts'],'retainedHits':{k:len(v) for k,v in hp['hits'].items()},'cap':100,'actualCanonicalWindows':[{'path':'docs/audit-2026-10-17-round14/evidence/bytes-source-manifest.json','jsonPointers':['/files/5','/files/6','/scope'],'displayed':'Whole 3322-byte metadata file; actual coverage decision uses these original objects and scope.'},{'path':'docs/audit-2026-10-17-round14/bytes.md','readLineRanges':[[1,32]],'decisiveLine':18},{'path':'docs/review-2026-10-12/server-preflight-round23.md','displayedLineRanges':[[14,26],[37,42]],'decisiveOrdinaryOverlapLines':[23,25,41],'limits':'Historical authority claims contextual only, not independently reaffirmed.'},{'path':'docs/todo/platform-s0-quick-fixes-plan.md','navigationLines':[39,273,333,379,380],'limits':'Plan/proposed contract-version edits are not current implementation or semantic coverage proof.'}],'projectionRead':'Filtered MD and canonical Round14 hit contexts displayed, not all 152 hits semantically read. Derived inventories/claims/hash rows and copied original alias are not independent semantic evidence.','ownTargetedRawNavigation':'22 raw path/SHA hit files pinned, not a second full recursive-scalar scan.','causeDecision':'No new candidate to deduplicate. Existing R68 backlog issue belongs paired Host live output; canonical preflight line41 explicitly distinguishes relay write-callback/backpressure. It is not invalidated, retested, or newly reported.','permanentSkip':['ChromeNative failures','old UTF8 candidates/failed directions','failed NDJSON timer direction'],'noFullHistorySemanticExhaustivenessClaim':True})
save('gate-decision.json',{'byteStreamSameShaOldFull':True,'byteStreamEvidence':'Round14 bytes-source-manifest/files/5 same SHA + bytes.md18 explicitly whole file','protocolPriorScope':'Related protocol contract only; manifest alone does not imply whole-file semantic read.','localPriorScope':'Preflight links and selected lifecycle/lease discussion, no explicit same-SHA full proof from read canonical windows.','decision':'Directed normal send/close/message-boundary contract review with explicit prior overlap; not newly-unread frontier coverage.','unknownIsUnread':False,'fullCoverageIsCorrectnessProof':False})
save('classification.json',{'formalFindings':[],'candidates':[],'newRelated':[],'counts':{'newFormal':0,'newCandidate':0,'newRelated':0},'existingCauseExclusions':[{'reference':'R68','disposition':'Different paired Host live ws backlog gate, not retested or cleared; relay stream write chunk/backpressure comment is no global slow-reader safety proof.'}],'boundedConclusion':'No new ordinary stream defect established in exact selected source contracts; no all-relay correctness claim.'})
save('diagnostics.json',{'atUTC':at,'productAttempts':0,'productFailures':0,'metadataFailures':[],'navigationFailures':[],'truncations':[],'note':'All prep139 observed tools exited 0 and outputs used for source scope were complete; no product retry or replacement run. Filename inventory repeated packages/server under packages yields duplicate path lines only, deduplicated for metadata.'})
save('validation.json',{'ownProductExecution':0,'ownHelperExecution':0,'imports':0,'fixturesRun':0,'testsRun':0,'nativeOrNetwork':0,'ownGitOperations':0,'sourceOnlyEvidence':True,'existingDeclarations':'Native launcher test title observed but not run. Selected acceptance fixture declares 5 delayed-reader lengths, abrupt disconnect, HTTP early/final/truncated response, cancellation, binary/size checks; declarations/PASS strings are not observed results.','sdkLimits':'ws/Node runtime semantics, event ordering, buffered final EOF, close settlement, OS sockets and actual external relay peer are not revalidated.','metadataOnlyFinalization':{'checks.files':[],'method':'Python standard-library source byte capture, JSON/range/count/link/receipt processing; no product import/evaluation.'}})
report=f'''# prep139：Relay 普通字节流与关闭合同静态复核

结论：**0 新正式问题、0 新候选、0 new-related**。仅针对真实连接器的控制消息→本地流→原始字节 Duplex 和收尾数据合同，没有证据将普通输入下的消息边界或关闭路径升级为缺陷；这不证明整套 Relay 或真实网络时序正确。

Root 提供的产品基线为 `f31a847f45e4805bce34aeb9e6db7efb503cfcb0`。本读者未读取 Git；CODESHELL/AGENTS 延续此前实际阅读并核同 SHA。仅在本 tmp 输出，未改产品。

## 实际链与反证

- `connector.ts:192–203` 将控制 WebSocket 当文本 JSON，拒绝 binary 后再调用 DTO parser；`:214–240` 发送 JSON ready/failed，打开正常 open 对应的 local stream，并在 `done` 后删去所属流。`protocol.ts:2–17/38–70` 提供大小、chunk、类型与字段投影。数据通道与控制消息处理分开。
- `local-stream.ts:97–102/111–122` 构造 data WebSocket 时保留 64 KiB payload cap、关闭压缩，open 后创建 Duplex，再 `socket.pipe(bytes).pipe(socket)`。`:13–87/103–125` 的普通状态字段区分附着、TCP/WS 关闭、排空与 disposed；`done` 仅在两边 close 都回报后结算。URL/header/凭据或完整握手机制没有被认证。
- `byte-stream.ts:14–20` 检查完整 WS message 的 binary/大小；`:34–44` 按回调顺序将出站 Buffer 切为最多32 KiB，未将每个 chunk 擅自转为文本。`:46–63` 将正常 EOF 与非正常 close 分开，正常 EOF 的缓冲读取保留分支明确存在。没有普通 producer 证据说明一定丢尾字节；也没有执行 ws/Node 事件顺序来证明该分支在所有时序下正确。
- 不能把 HTTP `request.end()` 自动当连接 EOF：`docs/device-relay.md:99–110` 明确一条流代表整条 TCP、无自定义 half-close；声明的 fixture `runner.mjs:73–104` 将请求 body 的 end 与响应完成后的 Agent 销毁区分。`local-stream.ts:55–85` 对已有响应的 EPIPE/reset 或异常 TCP close 有有界排空路径，销毁/取消则另行关闭。任意文本 data frame、伪造 token 或错误 DTO 不构成普通 producer 缺陷证明。
- `connector.ts:159–164/233–240/254–275` 的关闭与回收链会主动关闭 owned streams，并等 pending；本次没有观察真实 socket 回收或无限等待，也不对权限/authority 作完整结论。

## 旧范围与测试边界

原 `round14/evidence/bytes-source-manifest.json#/files/5` 与当前 byte-stream 同 SHA，且 `round14/bytes.md:18` 明确全文阅读。因此这65行是**旧 full 重叠的定向复核**，不计首次或新唯一覆盖。protocol 原文只说相关合同；local 原 preflight 也只是所述选段，不能凭哈希或 derived index 扩写成旧 full。旧 R68 的 paired Host live-output backlog 原因继续保留，不用 Relay 的分片回调推翻它；ChromeNative、旧 UTF8 和失败 NDJSON timer 方向未恢复。

现有 `relay.native.test.ts` launcher 全文只作导航，实际普通 fixture 仅选段阅读：`byte-stream.mjs:27–43/51–62` 声明5种长度的慢 EOF reader 与突然断开；`runner.mjs` 所选段声明 early response、truncated response、Range、大响应、取消、binary/size 等对照。**全部未执行**；源码中的 PASS、断言或旧结果不能当本轮通过。

[源范围](source-manifest.json) 共{counts['semanticFiles']}语义文件，{counts['full']}full（已知旧读重叠）/{counts['selected']}selected：{counts['semanticLines']}语义行 = {counts['productSemanticLines']}产品 + {counts['testDeclarationSemanticLines']}测试声明 + {counts['contractDocumentSemanticLines']}文档合同；另1个 native launcher 仅导航。实际显示联合{counts['uniqueDisplayedLines']}行，显示与普通语义范围分列；完整显示的协议/本地流并不等于完整机制审查。源证据截取在实际显示后保存，见[选段](source-excerpts.json)，未运行这些文本。

## 历史、诊断与冻结

Root 的共享 [历史投影](shared-history-projection.json) 保留5850份 MD/JSON、4251467个 JSON value scalar、0 parse errors，纳冻57排58及以后，含 archive、排 JSON keys。byte/local/protocol 分别54/38/60命中，cap100，均全部保存；机器访问不等于全史语义阅读。亲读原对象和 MD 的窗口见[历史范围](history-read-windows.json)及[gate](gate-decision.json)。自己的22份 path/SHA 原始命中文档仅作字节库存，不能替代具体 cause 全读。

本任务无首次产品尝试；[诊断](diagnostics.json)记录本次元数据/导航无失败或截断。[结束核对](ending-checks.json)记录10个产品/测试/文档/指令字节 pins、22份原命中加1份补充历史 MD和共享 batch 的结束 SHA，全部一致；共享 batch 同字节不表示本读者重验所有5850成员。该 dated snapshot 不认证未来文档或 Git 状态。

[分类](classification.json)、[验证边界](validation.json)、[原始pin](initial-pins.json)、[消费者pin](support-pins.json)、[测试pin](test-support-pin.json)、[字节测试pin](byte-test-support-pin.json)、[原历史pin](targeted-history-hits.json)、[历史补pin](history-support-pins.json)均保留。[最终清单](reviewer-receipt.json)自排除；[元数据检查](freeze-checks.json)的 `checks.files=[]` 不冒充另一份独立源码审查。
'''
(O/'report.md').write_text(report)
# This stage only validates metadata already produced, never imports/runs product.
links=[]
for target in re.findall(r'\]\(([^)]+)\)',report):
 p=(O/target).resolve();links.append({'target':target,'exists':p.exists(),'insideOwnedDir':p.is_relative_to(O.resolve())})
assert all(x['exists'] and x['insideOwnedDir'] for x in links if x['target'] not in ['reviewer-receipt.json','freeze-checks.json'])
save('freeze-checks.json',{'atUTC':at,'checks':{'files':[]},'role':'Author metadata finalization only; no additional source reading','sourceRangeChecks':{'semanticSubsetOfDisplayed':True,'allWithinPinnedLines':True,'rangeCounts':counts},'links':links,'futureSelfProducedLinks':['reviewer-receipt.json','freeze-checks.json'],'inputsUnchanged':all(x['sameBytesAndSha256'] for x in ends+hist),'sharedBatchUnchanged':sha(bb)==hp['sharedBatch']['sha256'],'productExecution':0,'gitOperations':0})
# Freeze all current artifacts, receipt excludes itself.
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes(); files.append({'path':p.name,'bytes':len(b),'sha256':sha(b)})
save('reviewer-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'role':'Independent source reviewer, receipt author metadata only','selfExcluded':True,'files':files})
for n in ['report.md','source-manifest.json','reviewer-receipt.json']:
 b=(O/n).read_bytes(); print(n,len(b),sha(b))
print('COUNTS',json.dumps(counts));print('ARTIFACTS',len(files)+1,'RECEIPTROWS',len(files),'LINKS',len(links))

"""Publish the current finite audit and dated coverage rebinding; no product execution."""
from pathlib import Path
from collections import Counter
import hashlib,json,re,subprocess,datetime
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round64';EV=OUT/'evidence';PRIMARY=Path('/Users/admin/Documents/个人学习/代码学习/codeshell')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());coverage=json.loads((OUT/'coverage.json').read_text());decision=json.loads((EV/'root-decision.json').read_text())
assert decision['allReadersFrozen'] and decision['rootSourceReviewComplete'] and len(decision['formal'])==1 and not decision['candidates']
checks=[]
for row in json.loads((EV/'worker-announced-freezes.json').read_text())['checks']:
 b=(EV/row['path']).read_bytes();assert len(b)==row['bytes'] and sha(b)==row['sha256'];checks.append(dict(path='evidence/'+row['path'],bytes=len(b),sha256=sha(b)))
assert len(checks)==15
write(EV/'freeze-checks.json',dict(expectedCount=15,checks=checks))
priorPath='docs/audit-2026-10-17-round63/evidence/root-coverage62/unified-current-index.json';priorRaw=(ROOT/priorPath).read_bytes();prior=json.loads(priorRaw);old=prior['files']
assert len(old)==len({r['path'] for r in old})==4643 and Counter(r['publishableCurrentCoverage'] for r in old)==dict(full=368,selected=377,unknown=3898)
def blobs(ref):
 requested=[ref+':'+r['path'] for r in old];p=subprocess.run(['git','cat-file','--batch'],input=('\n'.join(requested)+'\n').encode(),capture_output=True,cwd=ROOT);assert p.returncode==0 and not p.stderr
 cursor=0;rows=[]
 for row in old:
  end=p.stdout.index(b'\n',cursor);header=p.stdout[cursor:end].split();assert len(header)==3 and header[1]==b'blob',row['path'];size=int(header[2]);start=end+1;raw=p.stdout[start:start+size];cursor=start+size+1;assert p.stdout[cursor-1:cursor]==b'\n'
  rows.append(dict(path=row['path'],blob=header[0].decode(),bytes=len(raw),sha256=sha(raw)))
 assert cursor==len(p.stdout)
 return rows
baseline=blobs(plan['baseline']);current=blobs(plan['refreshedMain']);rows=[];changed=[]
for i,(priorRow,before,now) in enumerate(zip(old,baseline,current)):
 assert before['sha256']==priorRow['sha256'] and before['bytes']==priorRow['bytes'];raw=(ROOT/now['path']).read_bytes();assert sha(raw)==now['sha256'] and len(raw)==now['bytes']
 same=before['sha256']==now['sha256'];state=priorRow['publishableCurrentCoverage'] if same else 'unknown'
 row=dict(path=now['path'],bytes=now['bytes'],sha256=now['sha256'],publishableCurrentCoverage=state,priorIndexRow=i,priorCoverage=priorRow['publishableCurrentCoverage'],sameSourceAsPrior=same)
 rows.append(row)
 if not same:changed.append(dict(path=now['path'],priorCoverage=priorRow['publishableCurrentCoverage'],currentCoverage=state,priorSha256=before['sha256'],currentSha256=now['sha256'],reason='Current bytes changed; no current complete semantic scope imported from the previous SHA.'))
states=Counter(r['publishableCurrentCoverage'] for r in rows);assert states==dict(full=367,selected=377,unknown=3899)
assert {r['path'] for r in changed}=={'packages/core/src/capability-control/service.ts','packages/core/src/capability-control/service.test.ts','packages/desktop/src/renderer/i18n/ns/misc.ts','packages/desktop/src/renderer/updater/UpdaterBanner.tsx'}
write(EV/'coverage-current-index.json',dict(priorIndex=dict(path=priorPath,bytes=len(priorRaw),sha256=sha(priorRaw)),priorSemanticThroughRound=62,currentSourceHead=plan['refreshedMain'],files=rows,changed=changed,states=dict(states),notFull=4276,sourceSemanticReadsByRebinding=0,currentRound63And64NotUnioned=True,exactWholeRepositoryRemaining=None))
write(EV/'coverage-source-git-bindings.json',dict(baseline=plan['baseline'],current=plan['refreshedMain'],baselineFiles=baseline,currentFiles=current,sourceSemanticReads=0))
names=subprocess.check_output(['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**'],cwd=ROOT).decode().splitlines();added=sorted(set(names)-{r['path'] for r in old});removed=sorted({r['path'] for r in old}-set(names))
assert added==['docs/audit-2026-10-17-round57/evidence/static-path.test.ts','docs/audit-2026-10-17-round64/evidence/attachment-shared-path.test.ts','packages/core/src/capability-control/service.literal-override.test.ts'] and not removed
write(EV/'current-ts-inventory-delta.json',dict(originalPaths=4643,currentFilteredPaths=len(names),addedPaths=added,removedPaths=removed,addedPathsOutsideOriginalDenominator=True))
batch=json.loads((EV/'root-settings/history-batch.json').read_text());changedHistory=[];missing=[]
for row in batch['inventory']:
 p=ROOT/row['path']
 if not p.is_file():missing.append(row['path'])
 elif sha(p.read_bytes())!=row['sha256']:changedHistory.append(row['path'])
write(EV/'incoming-history-drift.json',dict(historyFiles=batch['historyFiles'],changed=changedHistory,missing=missing,scope='Original frozen63/exclude64+ machine inventory; original queries not rerun after concurrent main refresh.'))
diff=git('diff','--unified=5',plan['baseline'],plan['refreshedMain'],'--','packages/core/src/capability-control/service.ts');(EV/'concurrent-mcp-source.diff.txt').write_bytes(diff)
write(EV/'concurrent-source-status.json',dict(findingId='MCP-R61-01',readBaseline=plan['baseline'],currentMain=plan['refreshedMain'],status='Original dotted-path writer replaced by literal record-key mutation in current source.',readScope='Root actually read the bounded diff; this artifact is a later preservation of that diff, not invented first output or a full current-file audit.',sourcePath='packages/core/src/capability-control/service.ts',runtimeRevalidated=False,currentIssueClosedCertified=False,coverageDisposition='Old full scope loses current-SHA certification; current byte-rebound index conservatively unknown, no partial diff promoted to full.'))
oldCatalogPath='docs/audit-2026-10-17-round61/recorded-findings-catalog.json';oldRaw=(ROOT/oldCatalogPath).read_bytes();catalog=json.loads(oldRaw);original=list(catalog['findings']);finding=decision['formal'][0]
assert len(original)==119
catalog.update(createdUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Formal historical discoveries through64; not a current-open/current-fixed inventory.',baseline=plan['baseline'],predecessorCatalog=oldCatalogPath)
catalog['findings'].append(dict(id=finding['id'],priority='P2',title=finding['title'],sourceRound=64,canonicalFindings='docs/audit-2026-10-17-round64/findings.json',baseline=plan['baseline'],originalStatus='confirmed-at-frozen-source-and-first-guarded-reproduction',originalFixedFlag=False,originalMainSourceDisposition=None,statusInterpretation='One first guarded temporary-FS reproduction plus independent source review; no real UI/native/network or later-current unfixed certification.'))
assert catalog['findings'][:119]==original and len({r['id'] for r in catalog['findings']})==120
catalog['counts']=dict(formalRecordRows=120,uniqueIds=120,byPriority=dict(P2=47,P3=73),rounds=64)
b=(OUT/'findings.json').read_bytes();catalog['sourceDocuments'].append(dict(round=64,path='docs/audit-2026-10-17-round64/findings.json',bytes=len(b),sha256=sha(b),originalReportedCount=1,baselineBlobMatches=None,note='New task-owned audit evidence, not a baseline product blob.'))
catalog['subsequentSourceStageNotes']=[dict(source='docs/audit-2026-10-17-round64/evidence/concurrent-source-status.json',findingId='MCP-R61-01',runtimeRevalidated=False,currentIssueClosedCertified=False)]
write(OUT/'recorded-findings-catalog.json',catalog)
write(EV/'catalog-prefix-check.json',dict(priorPath=oldCatalogPath,priorBytes=len(oldRaw),priorSha256=sha(oldRaw),originalRows=119,originalObjectsPreserved=True,newId=finding['id'],formalRecordRows=120,byPriority=dict(P2=47,P3=73),currentOpenCountCertified=False))
write(OUT/'historical-records-reference.json',dict(path='docs/audit-2026-10-17-round64/recorded-findings-catalog.json',formalRecords=120,priorities=dict(P2=47,P3=73),historicalCandidates=42,candidatesSource='docs/audit-2026-10-17-round61/historical-candidates.json',currentOpenCountCertified=False))
lines=['# 全部120条正式历史问题','','累计120条：47条P2、73条P3。本轮新增ATTACH-R64-01。原119对象原样保留；这是历史记录数，当前未修复数尚未逐项重验。MCP-R61-01当前字面键写法已有源码处理说明，但未重跑运行验证。','','原4643个TS/TSX路径的旧through62台账经当前SHA重绑：367完整范围、377部分、3899覆盖证据不足，4276尚不能标完整。一个旧full文件已变更而降为unknown；63/64源阅读未统一回填。非TS/TSX及完整行为/平台验证不在分母。[覆盖说明](COVERAGE.md)。','','另有[42条历史候选](../audit-2026-10-17-round61/HISTORICAL-CANDIDATES.md)，包含未证实或SKIP方向，不并入正式数。','','| ID | 级别 | 历史问题 |','| --- | --- | --- |']
for row in catalog['findings']:
 title=re.sub(r'^\[P[0-3][^\]]*\]\s*','',row['title']).replace('|','\\|');target='findings.json' if row['sourceRound']==64 else str(PRIMARY/row['canonicalFindings']);lines.append(f"| [{row['id']}]({target}) | {row['priority']} | {title} |")
(OUT/'ALL-ISSUES.md').write_text('\n'.join(lines)+'\n')
(OUT/'COVERAGE.md').write_text('''# 当前覆盖与剩余边界

原4643个TS/TSX路径的through62旧账为368 full /377 selected /3898 unknown。并发主分支改变了4条原路径，其中service.ts原为full；未把旧SHA的全文记录套到新代码。当前字节重绑后为 **367 full /377 selected /3899 unknown，4276条尚不能标完整范围**。其余3条原本unknown，状态不变。[当前索引](evidence/coverage-current-index.json)、[Git绑定](evidence/coverage-source-git-bindings.json)。

本次只做同SHA承接/变更降级，未把Root读过的MCP diff、当前63/64源码片段或测试通过拼成full。full限原记录目的，unknown不表示从未读过。原61越EOF的旧deferred与原Root166范围澄清均不被本次数值解除。

同过滤库存现在4646，比原分母多旧57 fixture、本轮64 fixture、并发literal-override测试共3条，单列在[增量](evidence/current-ts-inventory-delta.json)，没有偷偷扩大或缩小原分母。非TS/TSX、跨模块/平台/运行行为尚无完整统一分母，无法精确给出全仓剩余量或剩余bug数。总目标active。
''')
(OUT/'README.md').write_text(f'''# 正式64：认证、Panel来源、附件与Hook来源

新增 **1条P2：ATTACH-R64-01**。同会话相同图片复用磁盘文件但使用不同附件ID，旧草稿24h清理会删掉仍在30d保留期内的已发送图片。[问题详情](attachment-retention.md)、[首次fixture](evidence/attachment-shared-path.test.ts)、[原始日志](evidence/attachment-shared-path.first.log)。

首次规定guarded shard：**1 pass /11 expect /0 fail /0 skip，exit0，Completed**。运行真实附件服务和自有临时FS，使用公开now参数；断言当前错误与独立路径正常对照。未修产品，未启真实UI/native/网络或账号，未重跑失败方向。

| 范围 | 有限结论 |
| --- | --- |
| [172认证](evidence/server-auth/report.md) | HTTP/store两文件完整静态及实际HTTP/WS/Web链，970产品语义行，0新问题；旧认证/锁因保留，作者0执行 |
| [173 Panel GitHub](evidence/panel-github/report.md) | 五目标算法全文及真实安装/update消费者，1009产品语义行，0新问题；不把导出的ref helper当实际安装调用，作者0执行 |
| [174附件](evidence/server-attachments/report.md) | 图像字节叶全文和staging/manifest/TTL/实际启动调用选段，1228产品语义行，提出同一P2；旧SOF3及限额问题不重报，作者0执行 |
| [Root175](evidence/root-settings/report.md) | Hook来源完整叶与真实readonly policy/merge/选择/Host消费者；935语义行含Root附件反例独立选段，不能与174叠成唯一新增覆盖 |
| [176独立反证](evidence/attachment-peer/report.md) | 实查UI移除只改state、同PNG再次添加/正常发送与启动TTL清理，支持同一P2只计一次；独立读Root首fixture/log，未重跑 |

累计 **120条正式历史记录（47P2、73P3）**，另42历史候选；当前未修复数未逐项认证。[全部问题](ALL-ISSUES.md)、[机器目录](recorded-findings-catalog.json)、[历史候选](../audit-2026-10-17-round61/HISTORICAL-CANDIDATES.md)。并发main已替换旧MCP点号写法，单列[源码状态](evidence/concurrent-source-status.json)，不冒称运行重验或旧数据修复。

共享机器历史导航纳冻63排64+，6801 MD/JSON、5060759 JSON value scalar访问、errors[]，archive/hidden/unignored含。各目标cap与真实旧canonical范围由原包记录，机器导航不是全史语义或根因唯一性证明。174另一次有限cause query6/6命中均不同因，未作全史穷尽声明。

{coverage['verbatimCopies']}份原件逐字节复制、{coverage['receiptChecks']}条收据检查、15冻结锚点；{coverage['uniqueSourcePins']}混合pins不是同数产品全文。原始metadata错误、显示截断与176首次混合evidence列表及其后拆分保留，未修饰冻件。Root新增fixture/raw/exit单独按task-owned evidence核对，不能绑定为源读取baseline Git产品文件。[源manifest](source-manifest.json)、[冻结](evidence/freeze-checks.json)、[验证](validation.json)、[字节索引](evidence-index.json)。

读取基线`{plan['baseline']}`，所有读者冻结后main`{plan['refreshedMain']}`，incoming15路径只做范围核对及MCP bounded diff说明；未认证并发更新的全部行为。本轮只集成审查材料，保留主目录既有改动，不push。当前原4643台账367/377/3899，4276未标完整，63/64源阅读未回填，[剩余边界](COVERAGE.md)。总目标active。
''')
frozen=json.loads((EV/'frozen-artifact-whitespace.json').read_text())['exactArtifacts'];write(EV/'root-whitespace-review.json',dict(exactTrailingWhitespaceLines={r['path']:r['trailingLineNumbers'] for r in frozen},scope='Exact frozen provenance bytes only; no product source exemptions.'))
(EV/'review-aggregate.md').write_text('''# Root64判断

174提出的共享文件/per-ID TTL反例经Root首次guarded临时FS复现与176独立源码反证支持，只登记ATTACH-R64-01/P2一次。普通UI移除chip没有淘汰manifest旧ID；下一次同图可正常发送。过期旧草稿删除仍有效sent引用的文件，独立路径sent控制保留。现有错误未修。

172认证、173Panel与Root175设置来源有限范围未建新反例，不能据局部0认证整个模块。测试/fixture仅Root新attempt1，既有测试声明和其他作者的0执行分账。旧失败方向未重跑。并发MCP源码处理只更新dated状态说明，旧历史记录保留，全仓目标active。
''')
print(json.dumps(dict(formal=1,formalRecords=120,priorities=dict(P2=47,P3=73),coverage=dict(states),notFull=4276,changedSourcePaths=len(changed),currentTsPaths=len(names),frozenAnchors=15,goalStillActive=True)))

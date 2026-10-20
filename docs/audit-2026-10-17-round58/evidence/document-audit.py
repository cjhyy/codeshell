from pathlib import Path
import json,hashlib,re,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=R/'docs/audit-2026-10-17-round58';E=O/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def wr(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
c=json.loads((O/'coverage.json').read_text());p=json.loads((E/'integration-plan.json').read_text())
assert c['formal']==1 and c['candidates']==0 and c['historicalFormalRecords']==118 and c['priorities']==dict(P2=45,P3=73)
old=json.loads((R/'docs/audit-2026-10-17-round57/recorded-findings-catalog.json').read_text());catalog=json.loads(json.dumps(old));f=json.loads((O/'findings.json').read_text())['findings'][0]
catalog.update(createdUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Formal historical discoveries through58, not current-open/current-fixed inventory.',baseline=p['baseline'],predecessorCatalog='docs/audit-2026-10-17-round57/recorded-findings-catalog.json')
catalog['findings'].append(dict(id=f['id'],priority=f['severity'],title=f['title'],sourceRound=58,canonicalFindings='docs/audit-2026-10-17-round58/findings.json',baseline=p['baseline'],originalStatus='static-confirmed; runtime not validated',originalFixedFlag=False,originalMainSourceDisposition=None,statusInterpretation='Dated discovery only; not current-unfixed/runtime certification'))
catalog['counts']=dict(formalRecordRows=118,uniqueIds=118,byPriority=dict(P2=45,P3=73),rounds=58)
b=(O/'findings.json').read_bytes();catalog['sourceDocuments'].append(dict(round=58,path='docs/audit-2026-10-17-round58/findings.json',bytes=len(b),sha256=sha(b),originalReportedCount=1,baselineBlobMatches=None,note='New task-owned evidence document, not baseline product Git blob.'))
assert catalog['findings'][:-1]==old['findings'];wr(O/'recorded-findings-catalog.json',catalog)
lines=['# 全部118项正式历史问题与未完成范围','','本批新增CHAT-R58-01/P2，累计118项：45P2、73P3。原117机器对象原样保留；118不是当前未修复数。部分旧项已有源码处理记录，未逐项重验当前状态。','','最新可靠语义台账仍为旧45同SHA迁移的4643路径：304完整范围、168部分、4171无法确认；4339不能标full不是精确未读或剩余量。46–53仍DEFERRED_UNPARSED、54–58未统一回填。当前同过滤库存4644，多出的1路径是旧57证据fixture，不是新增产品全文。非TS/TSX和完整运行机制不在分母。[覆盖报告](../audit-2026-10-17-round55/evidence/coverage-current/report.md)、[本轮hash绑定](evidence/coverage-snapshot-current-binding.json)。','','| ID | 级别 | 历史问题 |','| --- | --- | --- |']
for r in catalog['findings']:
 target='findings.json' if r['sourceRound']==58 else '/Users/admin/Documents/个人学习/代码学习/codeshell/'+r['canonicalFindings']
 title=re.sub(r'^\[[^]]*\]\s*','',r['title']).replace('|','&#124;');lines.append('| ['+r['id']+']('+target+') | '+r['priority']+' | '+title+' |')
lines.extend(['','原源码处理记录、日期与运行界限见[机器目录](recorded-findings-catalog.json)及各原报告，不由本列表认证当前全部未修或已修。'])
(O/'ALL-ISSUES.md').write_text('\n'.join(lines)+'\n')
(O/'README.md').write_text(f'''# 正式58：投递停机覆盖与传输、环境持久值复核

新增 **1项P2：CHAT-R58-01**，0活跃新候选、0新增关联。历史正式记录合计 **118项（45P2、73P3）**，不是当前未修复数。[完整列表](ALL-ISSUES.md)、[机器目录](recorded-findings-catalog.json)保留原117对象。

正常Node CLI在Mimi投递仍等待结果时收到SIGTERM/SIGINT，gateway仅等adapter/watch结束，queue.stop不等待已分离的consumer和它们后续写入，CLI便释放单实例锁。旧petChat/result请求没有接停机signal且保留自身timer，旧进程仍可继续。新CLI使用同配置获得租约并持久确认新消息后，旧consumer结算仍将它自己的pending/completed整快照rename到同inbox路径，撤回新进程已经写盘的新项。[正式条件、反证与范围](findings.json)。

影响必须限定：新进程内存里的消息仍在，之后的persist可修复；若在恢复写入前异常退出或崩溃，重启就不能从本地inbox恢复被移除项。外部平台是否重投未验证，不说每次交叠必丢，也不把at-least-once允许的重复投递单列bug。138与143同一候选CHAT-R138-C1由Root只晋升一次；144独立亲读旧因，未建立exact prior，不保证全史无同义记录。**仅静态确认，未运行进程、投递、模型或测试。**

Root141另一候选APPROVAL-R141-C1已撤回原“worker退出后无其它读取长期保留”的论证：142核实际Main正常初始化启动PetImDecisions，立即tick并每5000ms读alive/generation清cache。interval注册不是本轮观察到的严格5秒SLA；潜在短窗口/client旧卡未完成确定正常触发和立即一致性合同，不能强行改成新ID。141原候选冻结包保持原样，Root当前不计活跃候选。[Root决策](evidence/root-decision.json)。

| 有限包 | 实际范围与边界 |
| --- | --- |
| [138投递作者](evidence/delivery-queue/report.md) | reserve/persist/queued、正常sender、重试/stop及Gateway实际接线；作者保留候选，旧SWC/C8/CHAT-R11精确排除 |
| [143停机独立复核](evidence/delivery-shutdown-review/report.md) | 实际CLI lease、Node入口、Mimi请求、同路径新入队/ACK与快照persist，影响限定到磁盘窗口/修复前退出 |
| [144旧原因元数据](evidence/delivery-history/report.md) | 产品files为空；亲读C8/N22、SWC、CHAT-R11/archive旧因，不借词组检索证明全史无记录或产品正确 |
| [139 Relay](evidence/relay-stream/report.md) | 301产品/125声明/21文档行，byte65为旧R14全文重叠；control文本/data binary→Duplex/EOF，不认证完整握手/native网络 |
| [140环境持久值](evidence/web-storage/report.md) | 506产品/97声明，旧R5/R18full与W10 quota→secret旧因保留；80/128名称差异缺普通长名producer，不晋升 |
| [Root141配对/审批](evidence/root-pairing/report.md) | 540产品/149声明；默认TTL、同步commit/cache显式重置正常值链，候选经真实poll反证撤回，非全auth/custody认证 |
| [142独立审批](evidence/approval-replay-review/report.md) | 701产品语义，核Main→Pet周期read及必要snapshot/epoch/client消费；否定原前提，不认证全部时序/UI |

全部行数保留作者/独立/历史重叠，不累加为新增唯一覆盖。现有测试只是声明；本轮产品/helper/import/fixture/test/React/native/browser/worker/model/clock/business-network执行 **0**。57静态资源3pass不算本轮运行或投递问题验证。[验证](validation.json)、[Root复核](evidence/review-aggregate.md)。

[共享历史](evidence/root-pairing/history-batch.json)纳冻57排58+：5850 MD/JSON、4251467递归JSON value scalars、0parse错、archives参加、JSON keys不作值；10targets28–87均在100cap内保存。机器访问不是全史语义阅读。144另一次获准复合查询126contexts/24docs，cap300全保留，0parse/dated drift；有限词组/窗口漏检边界明确，0三词同窗不是新颖性证明。

七包{c['verbatimCopies']}原件逐字节复制、{c['receiptChecks']}receipt/copy核验、21个report/manifest/receipt锚点；{c['uniqueSourcePins']}唯一pins混合产品、测试、合同、历史元数据、指令及nav/hash，不是新增产品全文。[源清单](source-manifest.json)、[复制回执](evidence/prep-copy-receipt.json)、[索引](evidence-index.json)。Root初宽filename/hash和142/144宽导航截断不补未见内容；138口述CHAT-R11含义已按原件纠正为notification-progress首次load Promise，与永久Discord动态失败方向分开，首诊断原样保留。无产品失败重试。

全部源读者冻结后fetch/refresh；读取基线{p['baseline']}，集成前main {p['refreshedMain']}。[并发路径](evidence/incoming-main-paths.json)、[历史漂移](evidence/incoming-history-drift.json)保留实际变化。仅owned58文档集成，主目录原改动字节保留，no push。

[原覆盖集合hash绑定](evidence/coverage-snapshot-current-binding.json)针对旧4643路径；304full/168selected/4171unknown仍未合并46–53 DEFERRED_UNPARSED及54–58增量。当前4644含旧57证据TS，本轮无新增TS。4339不能标full不是精确剩余数量；非TS/TSX和完整运行机制不在分母，全仓目标active尚未完成。
''')
(E/'review-aggregate.md').write_text('''# Root正式58复核

Root实际读七份报告与范围清单。138/143的CHAT-R138-C1由Root单次晋升CHAT-R58-01 P2，144只做旧因元数据，不冒充第三次产品审。Root对queue/CLI/ChatGateway/gateway Mimi/client/instance-lock/config七源先pin后做所列actual body交叉核对，见delivery-root-before-pins.json；与作者/reviewer重叠，不计新唯一覆盖。

Node入口只main().catch置exitCode，不强制exit。普通Mimi petChat/result不接CLI signal、自身timer有活跃窗口；ChatGateway ingress只await enqueue，run finally同步stop不drain detached process。CLI release删锁文件，无内核fd继续持有，普通新CLI同配置same inbox可获锁。文本enqueue持久化后queued/ACK，旧process仍无stopped guard地persist实例旧pending/completed快照；atomic rename与实例Promise mutation都不提供跨owner reload/CAS/fence。B内存不变、后写可恢复；修复前退出才本地重启恢复丢失。不是重复A bug或每次B必丢，未运行任何进程/网络/模型来冒称观察。

144精确亲读C8 retry顺序、SWC身份/去重/spool失败ACK、CHAT-R11 notification rejected-load cache、archive retry/取消容量旧原因。没有建立完整stop→release→旧snapshot覆盖同因，但有限词组与语义窗口不证明全史无记录。138口述旧R11/Mimi缓存混淆已按原件纠正，永久Discord失败仍跳过，不重试旧产品实验。

141审批hypothesis原件冻结，142独立Main/Pet立即+5000ms read反证否定长期无人read前提。只撤原论证，不把短窗口硬凑问题；全部客户端/authority/worker行为仍有限。139真实relay数据/控制/EOF与140storage/environment普通消费者无新反例，旧byte full和W10等不重复。

本轮0产品/helper/test/React/clock/worker/native/browser/model/business-network；旧57三pass不计。七包receipt/anchors、旧source同SHA/语义显示nav区分与首诊断保留。历史118（45P2、73P3）原117对象原样，不是当前未修数量。旧4643覆盖+1旧fixture分开，未合并后续语义，不给精确剩余量。仅owned58 docs、dirty primary保留、no push，目标active。
''')
groups=['delivery-queue','relay-stream','web-storage','root-pairing','approval-replay-review','delivery-shutdown-review','delivery-history'];checks=[]
for stem in groups:
 d=E/stem;rr=[n for n in ['author-receipt.json','artifact-receipt.json','reviewer-receipt.json'] if (d/n).is_file()];assert len(rr)==1
 mp='source-manifest.json' if (d/'source-manifest.json').is_file() else 'metadata-manifest.json'
 for name in ['report.md',mp,rr[0]]:
  q=d/name;b=q.read_bytes();checks.append(dict(path=str(q.relative_to(O)),bytes=len(b),sha256=sha(b)))
wr(E/'freeze-checks.json',dict(expectedCount=21,checks=checks))
ex=json.loads((E/'frozen-artifact-whitespace.json').read_text())['exactArtifacts'];wr(E/'root-whitespace-review.json',dict(exactTrailingWhitespaceLines={r['path']:r['trailingLineNumbers'] for r in ex},frozenArtifacts=len(ex),scope='Only frozen provenance byte exceptions; all new Root-owned files require ordinary whitespace checks.'))
rows=[]
for q in sorted(O.rglob('*')):
 if q.is_file() and q.name!='evidence-index.json':
  b=q.read_bytes();rows.append(dict(path=str(q.relative_to(O)),bytes=len(b),sha256=sha(b)))
wr(O/'evidence-index.json',dict(files=rows,scope='Self excluded; metadata only, zero current product executions.'))
print(json.dumps(dict(indexed=len(rows),anchors=21,formal=1,historical=118)))

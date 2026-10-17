from pathlib import Path
import json,hashlib,datetime,re
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round144-delivery-history')
def h(b):return hashlib.sha256(b).hexdigest()
def load(n):return json.loads((O/n).read_text())
def save(n,d):(O/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
at=datetime.datetime.now(datetime.timezone.utc).isoformat();pins={}
for n in ['metadata-before-pins.json','round11-before-pins.json','chat-canonical-pins.json']:
 for x in load(n)['files']:pins[x['path']]=x
md={
 'docs/archive/bug-followups-2026-08-13.md':{'displayedLineRanges':[[75,105]],'selectedLineRanges':[[83,100]],'purpose':'Archive spool cleanup retry closure and slow attachment mutex, distinct from lease shutdown overwrite.'},
 'docs/audit-2026-10-16/server-web-chat.md':{'displayedLineRanges':[[1,42],[45,50]],'selectedLineRanges':[[7,35],[47,48]],'purpose':'SWC01 route ordinal, SWC02 dedupe identity, SWC03 I/O spooling ACK and explicitly known retry scope; no new source/read coverage attribution.'},
 'docs/review-remaining-2026-10-12/coding-tui-chat.md':{'displayedLineRanges':[[58,88],[137,150],[210,214],[225,233]],'selectedLineRanges':[[142,150],[213,213],[228,229],[233,233]],'purpose':'C8 serial retry ordering, broad historical source-directed scope and separately unconfirmed cancellation/spool risks. Earlier unrelated displayed C2/C3/LSP/TUI fragments are navigation only.'},
 'docs/audit-2026-10-17-round11/chat.md':{'displayedLineRanges':[[1,17]],'selectedLineRanges':[[3,15]],'purpose':'CHAT-R11-01 initial rejected-load Promise cache cause and retry/rebuild limitations; old tests/report claims metadata only, no rerun.'}
}
jp={'docs/audit-2026-10-16/findings.json':['/issues/20','/issues/21'],'docs/review-remaining-2026-10-12/findings.json':['/issues/21'],'docs/audit-2026-10-17-round11/findings.json':['/findings/0'],'docs/audit-2026-10-17-round11/evidence/chat-findings.json':['/findings/0']}
rows=[];snips=[];ending=[]
for p,x in pins.items():
 b=(R/p).read_bytes();z={**x,'endingBytes':len(b),'endingSha256':h(b),'endingSame':len(b)==x['bytes'] and h(b)==x['sha256']};ending.append(z)
 if p in md:
  rows.append({**x,'kind':'canonical-historical-markdown','coverage':'selected-metadata',**md[p]});ls=b.decode().splitlines();snips.append({'path':p,'sha256':h(b),'selected':[{'start':a,'end':e,'lines':ls[a-1:e]} for a,e in md[p]['selectedLineRanges']]})
 elif p in jp:
  d=json.loads(b);objs=[]
  for ptr in jp[p]:
   v=d
   for k in ptr.strip('/').split('/'):v=v[int(k)] if isinstance(v,list) else v[k]
   objs.append({'pointer':ptr,'value':v})
  rows.append({**x,'kind':'canonical-historical-findings-json','coverage':'selected-original-objects','jsonPointers':jp[p],'purpose':'Original IDs/trigger/evidence boundaries; not current product status recertification.'});snips.append({'path':p,'sha256':h(b),'objects':objs})
 else:
  rows.append({**x,'kind':'historical-review-metadata','coverage':'navigation-only','purpose':'Only rg contexts observed, first wide output truncated. Not used as an independent old-cause substantive source.'})
batch=load('shared-history-projection.json')['sharedBatch'];bb=Path(batch['path']).read_bytes();query=load('shutdown-lease-history.json')
save('metadata-manifest.json',{'atUTC':at,'role':'Independent old-cause metadata reviewer, not source reader or source-candidate verifier','files':[],'metadataFiles':rows,'metadataSemanticDocuments':8,'metadataNavigationOnlyDocuments':1,'sharedMachineNavigation':batch,'directedMachineQuery':{'method':'shutdown-lease-history.py','firstReceipt':'history-first-exit.json','snapshot':query['inventoryOriginalAtUTC'],'historyFiles':5850,'productFiles':[]},'notClaimed':'No product bytes opened or hashed; no new source semantic coverage, current product correctness, runtime behavior, candidate severity or formal promotion decision.','productExecution':0,'gitOperations':0})
save('canonical-excerpts.json',{'capturedUTC':at,'timing':'Selected historical metadata reproduction after actual bounded display, not product source excerpts','files':snips,'productFiles':[]})
comparisons=[
 {'oldId':'C8 (canonical N22/originalId C8)','canonical':'docs/review-remaining-2026-10-12/findings.json#/issues/21','report':'docs/review-remaining-2026-10-12/coding-tui-chat.md:142–150','actualOldCause':'maxPerTarget=1 permits a later same-target record while earlier record waits retry backoff; controls [a,b] vs [a,b,a].','difference':'No stop, lease release, concurrent owner snapshot or old writer continuation in this finding.'},
 {'oldId':'SWC-01','report':'docs/audit-2026-10-16/server-web-chat.md:7–15','actualOldCause':'Persisted adapter route uses account list ordinal; reorder assigns old pending to wrong account.','difference':'Reboot/recovery is shared symptom only; missing stable account routing is distinct from writer lease lifetime.'},
 {'oldId':'SWC-02','canonical':'docs/audit-2026-10-16/findings.json#/issues/20','report':'docs/audit-2026-10-16/server-web-chat.md:17–25','actualOldCause':'Dedupe/completed key omits adapter identity; legal second account input incorrectly accepted as duplicate.','difference':'No concurrent process writer/stop/drain or lease release.'},
 {'oldId':'SWC-03','canonical':'docs/audit-2026-10-16/findings.json#/issues/21','report':'docs/audit-2026-10-16/server-web-chat.md:27–35','actualOldCause':'Small valid attachment spool I/O error silently becomes memory-only queued acceptance, so restart cannot restore it.','difference':'Spool materialization/error/ACK policy, not old terminal consumer snapshot overwriting a new owner.'},
 {'oldId':'CHAT-R11-01','canonical':['docs/audit-2026-10-17-round11/findings.json#/findings/0','docs/audit-2026-10-17-round11/evidence/chat-findings.json#/findings/0'],'report':'docs/audit-2026-10-17-round11/chat.md:5–15','actualOldCause':'Initial store.load rejected Promise remains cached in long-lived notification progress handler; watcher retries never reload.','difference':'Same-handler initialization recovery, not durable queue stop/CLI lease/new process concurrent snapshot.'},
 {'oldId':'Archive spool retry cleanup note (no promoted ID inferred)','report':'docs/archive/bug-followups-2026-08-13.md:83–100','actualOldCause':'One global persist retry closure captures only record X cleanup, Y spool cleanup not retried; slow attachment load holds queue mutation mutex.','difference':'Neither note names stop without drain→lease release→old in-flight consumer terminal snapshot overwrite.'},
 {'oldId':'Previously unconfirmed cancellation capacity risk','report':'docs/review-remaining-2026-10-12/coding-tui-chat.md:228–229','actualOldCause':'Unbounded attachment.load signal/cancellation may retain preparation capacity; memory-only fallback restart risk separately stated.','difference':'Scope is preparation/spool behavior. Not an exact prior report of the proposed old in-flight writer/new owner snapshot chain.'}
]
save('cause-comparison.json',{'candidateHypothesisFromRootOnly':'queue.stop does not drain; CLI releases lease; old already-running consumer can continue persist and overwrite a new process snapshot','sourceMechanismReviewedHere':False,'comparisons':comparisons,'conclusion':'No exact prior cause established in read canonical windows; listed old findings are not adequate duplicate evidence for the proposed full chain.','limits':'Not proof no history record exists; not proof source hypothesis is valid/new/formal. Severity and normal trigger belong source reviewers 138/143 and Root.'})
save('diagnostics.json',{'firstNavigationTruncation':{'chunk':'719cab','nestedExitCode':0,'originalTokenCount':4092,'maxOutputTokens':2700,'outputLines':58,'disposition':'Original tool warning retained/transcribed. Missing middle rg snippets not claimed read. Later bounded chat.md and selected canonical objects were fully displayed; no product rerun.'},'firstCompoundMetadataQuery':{'receipt':'history-first-exit.json','exitCode':0,'stdout':'history-first.stdout','stderr':'history-first.stderr','method':'shutdown-lease-history.py','readOrder':'Method/stdout/stderr/exit persisted before results were opened.'},'productAttempts':0,'productFailures':0,'metadataErrors':[]})
save('ending-checks.json',{'atUTC':at,'metadataFiles':ending,'all9PinnedMetadataFilesSame':all(x['endingSame'] for x in ending),'sharedBatch':{**batch,'endingBytes':len(bb),'endingSha256':h(bb),'sameBytesAndSha256':len(bb)==batch['bytes'] and h(bb)==batch['sha256']},'compoundSnapshot':{'historyFiles':query['historyFiles'],'datedByteDrift':query['datedByteDrift'],'errors':query['errors'],'limits':'One machine compound scan against original5850 inventory found no byte drift at its read time. Ending only separately rehashes selected metadata and shared batch, not all5850 members.'},'productFiles':[],'gitOperations':0})
save('validation.json',{'role':'Metadata historical cause reviewer only','checks':{'files':[]},'productSourceReads':0,'productSourceHashing':0,'productHelperImportsExecution':0,'testOrFixtureReads':0,'testsRun':0,'networkNativeWorkerGit':0,'authorMutableInputsRead':[],'author143SourceMechanismVerification':False,'ownMetadataExecution':'One independent Python standard-library compound history query; metadata range/object/hash/link/receipt processing only. Author scan method not run.','oldDynamicClaims':'Only attributed historical metadata claims. No old tests/logs rerun or borrowed to validate current candidate.'})
report='''# prep144：Delivery 停机候选的旧原因独立元数据对照

**在亲读的原 canonical 和报告窗口中，未建立已有记录明确描述完整“queue.stop 未排空→CLI lease.release→旧执行 consumer 继续 persist 覆盖新进程 snapshot”同因。** C8、SWC 与 CHAT-R11 的具体原因不足以据此判重。这不是全史无记录保证，也不确认138/143源码假设成立、新颖或应晋升。

本角色只读历史元数据，不读产品正文或138/143 mutable包；产品 source `files=[]`，Git/产品/helper/import/fixture/test/native/network运行均0。提出假设来自Root；与138作者只交换既有 canonical 路径和旧范围，没有借此作为独立源验证。

## 原件逐项对照

| 原条目 | 原因及范围 | 与本候选的区别 |
|---|---|---|
| C8，canonical N22 / originalId C8 | remaining `findings.json#/issues/21`、`coding-tui-chat.md:142–150`：serial SDK 的 earlier retry 被 later message 越过 | backoff 期间调度顺序；没有 stop/drain、lease或旧/新进程 writer 链 |
| SWC-01 | `server-web-chat.md:7–15`：持久adapter列表ordinal重排后错账号 | 重启恢复是共同情景，路由身份缺失是不同根因 |
| SWC-02 | audit2026-10-16 `findings.json#/issues/20`、报告17–25：去重键缺adapterId | 正常第二账号被当重复，不是并发snapshot写入 |
| SWC-03 | 同JSON `/issues/21`、报告27–35：小附件spool I/O降级成memory-only但仍queued/ACK | materialization错误与接收确认策略；不是停机后旧consumer终态覆盖 |
| CHAT-R11-01 | round11两个原JSON均 `/findings/0`、`chat.md:5–15`：首次load rejected Promise被缓存，后续同handler重试不再load | 通知进度初始化恢复，与DeliveryQueue停机lease生命周期不同 |
| archive cleanup/slow-load notes | `bug-followups-2026-08-13.md:83–100`：单全局persist retry闭包漏其它spool清理；attachment.load持锁 | 未描述完整stop→release→旧writer覆盖链 |
| 旧未确认取消容量风险 | `coding-tui-chat.md:228–229`：无界attachment.load取消可能占preparing；spool内存fallback恢复未独立确证 | 不应自动扩写成已登记停机并发写入缺陷 |

同报告 `:213` 的source-directed列表与 audit报告`:47–48`既读/已知retry声明，不等于已登记所有停机故障，也不证明这些模块无bug。原动态PASS、fixture叙述只作为当时记录的边界，本读者没有打开或执行相应产品/测试。对照原值见[canonical选段](canonical-excerpts.json)和[原因矩阵](cause-comparison.json)。

## 有限补漏检索

Root共享[路径历史投影](shared-history-projection.json)为5850 MD/JSON、4251467个递归JSON value scalar、含archive、排JSON keys、纳冻57排58+。delivery79、bound68都低于cap100且全保存；这些是机器导航，不是亲读79/68全部上下文。

另按授权只执行一次[shutdown+lease复合元数据查询](shutdown-lease-history.py)，以共享原5850 inventory为集合。先按文件值文本同时出现queue、lease、shutdown/inflight类词作粗门槛，再取lease/queue.stop的JSON value或MD窗口；JSON只递归value不查keys。首[stdout](history-first.stdout)、[stderr](history-first.stderr)、[exit](history-first-exit.json)已在查看结果前保存，exit0。结果[快照](shutdown-lease-history.json)：126上下文/24文档，cap300，126全保留；0 parse/其它错误、0dated字节漂移、0单窗口/value同时具有三个词组。命中主要是其它lease设计文件在inventory/derived claims中的路径，以及旧coverage排除词组；没有把这些派生locator当作第二份语义证据。所读少量原locator与canonical未提供完整同因。

该检索依赖有限词组与窗口，不涵盖任意中文“锁”或同义转述，也不保证跨字段、跨文档或未显式写出lease的等价原因均能命中。0三词同窗不是语义去重证明；报告结论保持“exact prior未建立”，最终根因/合同/普通触发由实际源码读者和Root判断。

## 清单与边界

[metadata manifest](metadata-manifest.json)列9个原件pin：8份实际原窗口/对象，1份旧交叉review仅导航；产品 `files=[]`。第一次宽rg输出4092tokens超过2700预算，原warning记在[诊断](diagnostics.json)，中段未见内容不算读过；后续原CHAT窗口与对象均完整显示。未恢复其旧失败Promise/其它动态方向。

[结束核对](ending-checks.json)9个原件及共享batch均同字节。一次compound扫描在自身读时也核原5850 inventory的字节均无漂移，但不冒称结束时再次全量核对或认证未来Git。见[初始pin](metadata-before-pins.json)、[round11 pin](round11-before-pins.json)、[canonical JSON pin](chat-canonical-pins.json)、[验证范围](validation.json)、[冻结检查](freeze-checks.json)、[自排除receipt](reviewer-receipt.json)。
'''
(O/'report.md').write_text(report)
links=re.findall(r'\]\(([^)]+)\)',report);planned=['freeze-checks.json','reviewer-receipt.json'];assert all((O/x).exists() for x in links if x not in planned)
save('freeze-checks.json',{'role':'Author metadata finalization only','checks':{'files':[]},'metadataDocuments':len(rows),'productFiles':[],'links':[{'target':x,'insideOwnedDir':(O/x).resolve().is_relative_to(O.resolve()),'existsOrPlannedSelfGenerated':(O/x).exists() or x in planned} for x in links],'plannedSelfGenerated':planned,'allPinnedMetadataSame':all(x['endingSame'] for x in ending),'compoundFirstAttemptExit':0,'productExecution':0,'git':0})
files=[]
for p in sorted(O.iterdir()):
 if p.is_file() and p.name!='reviewer-receipt.json':
  b=p.read_bytes();files.append({'path':p.name,'bytes':len(b),'sha256':h(b)})
save('reviewer-receipt.json',{'frozenUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selfExcluded':True,'role':'Independent old-cause metadata reviewer, not product source reviewer','files':files})
assert all((O/x).is_file() and (O/x).resolve().is_relative_to(O.resolve()) for x in links)
for x in files:
 b=(O/x['path']).read_bytes();assert len(b)==x['bytes'] and h(b)==x['sha256']
print('ARTIFACTS',len(files)+1,'RECEIPTROWS',len(files),'LINKS',len(links))
for n in ['report.md','metadata-manifest.json','reviewer-receipt.json']:
 b=(O/n).read_bytes();print(n,len(b),h(b))

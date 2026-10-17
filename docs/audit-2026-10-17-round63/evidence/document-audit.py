"""Publish finite source reviews and through62 coverage metadata; product execution0."""
from pathlib import Path
from collections import Counter
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round63';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());decision=json.loads((EV/'root-decision.json').read_text());coverage=json.loads((OUT/'coverage.json').read_text())
assert decision['allReadersFrozen'] and decision['rootSourceReviewComplete'] and decision['formal']==decision['candidates']==[]
checks=[]
for row in json.loads((EV/'worker-announced-freezes.json').read_text())['checks']:
 raw=(EV/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'];checks.append(dict(path='evidence/'+row['path'],bytes=len(raw),sha256=sha(raw)))
assert len(checks)==12
write(EV/'freeze-checks.json',dict(checks=checks,expectedCount=12,productRuns=0))
batch=json.loads((EV/'root-coverage62/history-batch.json').read_text());changed=[];missing=[]
for row in batch['inventory']:
 p=ROOT/row['path']
 if not p.is_file():missing.append(row['path'])
 elif sha(p.read_bytes())!=row['sha256']:changed.append(row['path'])
write(EV/'incoming-history-drift.json',dict(historyFiles=batch['historyFiles'],changed=changed,missing=missing,scope='Original6669 shared inventory; no query rerun or semantic source reading.'))
ledger=json.loads((EV/'root-coverage62/unified-current-index.json').read_text());rows=ledger['files'];states=Counter(r['publishableCurrentCoverage'] for r in rows)
assert len(rows)==len({r['path'] for r in rows})==4643 and states==dict(full=368,selected=377,unknown=3898)
def bulk(ref):
 requested=[ref+':'+r['path'] for r in rows];assert all('\n' not in p for p in requested)
 p=subprocess.run(['git','cat-file','--batch'],input=('\n'.join(requested)+'\n').encode(),capture_output=True,cwd=ROOT);assert p.returncode==0 and not p.stderr
 data=p.stdout;cursor=0;out=[]
 for row in rows:
  end=data.index(b'\n',cursor);header=data[cursor:end].split();assert len(header)==3 and header[1]==b'blob',row['path'];size=int(header[2]);start=end+1;raw=data[start:start+size];cursor=start+size+1
  assert data[cursor-1:cursor]==b'\n' and size==row['bytes'] and sha(raw)==row['sha256'],row['path']
  out.append(dict(path=row['path'],blob=header[0].decode(),bytes=size,sha256=sha(raw)))
 assert cursor==len(data)
 return out
baseline=bulk(plan['baseline']);main=baseline if plan['baseline']==plan['refreshedMain'] else bulk(plan['refreshedMain'])
for row in rows:
 raw=(ROOT/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
write(EV/'coverage-source-git-bindings.json',dict(baseline=plan['baseline'],main=plan['refreshedMain'],baselineFiles=baseline,mainFiles=main,sourceSemanticReads=0,scope='Root bulk Git blob/raw-byte binding only;171 original gitCertified=false unchanged.'))
inventory=subprocess.check_output(['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**'],cwd=ROOT).decode().splitlines()
added=sorted(set(inventory)-{r['path'] for r in rows});removed=sorted({r['path'] for r in rows}-set(inventory))
assert added==['docs/audit-2026-10-17-round57/evidence/static-path.test.ts'] and removed==[]
write(EV/'coverage-snapshot-current-binding.json',dict(sourcePaths=4643,currentFilteredPaths=len(inventory),states=dict(states),notFull=4275,changedPaths=[],addedPaths=added,removedPaths=removed,incrementalSemanticRounds='Through62; current63 source reviews not unioned.',sourceSemanticReads=0,exactWholeRepositoryRemainingCount=None))
catalog=json.loads((ROOT/'docs/audit-2026-10-17-round61/recorded-findings-catalog.json').read_text());assert len(catalog['findings'])==119 and Counter(r['priority'] for r in catalog['findings'])==dict(P2=46,P3=73)
write(OUT/'historical-records-reference.json',dict(path='docs/audit-2026-10-17-round61/recorded-findings-catalog.json',formalRecords=119,priorities=dict(P2=46,P3=73),historicalCandidates=42,currentOpenCountCertified=False))
frozen=json.loads((EV/'frozen-artifact-whitespace.json').read_text())['exactArtifacts']
write(EV/'root-whitespace-review.json',dict(exactTrailingWhitespaceLines={r['path']:r['trailingLineNumbers'] for r in frozen},scope='Frozen provenance bytes only; new nonfrozen files use ordinary whitespace check.'))
(OUT/'COVERAGE.md').write_text('''# 覆盖台账：统计到正式62

原4643个TS/TSX路径，同9874源码SHA记录为 **368完整范围、377部分、3898覆盖证据不足**；4275路径尚不能标完整范围。full是原目的下完整静态语义文本，不证明所有行为/平台/运行时正确；unknown也不证明从未读过。

本次仅回填上一轮四份canonical作者/Root .files：36行中26条有效语义记录、10条hash/instruction排除、0本次新deferred。22个unknown升级（8full、14selected），另4路径仅补provenance。8个full里1个是既有测试声明，235行已读测试声明未运行；多份selected不合成full。[Root171报告](evidence/root-coverage62/report.md)、[逐路径索引](evidence/root-coverage62/unified-current-index.json)、[full原用途](evidence/root-coverage62/new-full-provenance.json)。

原61/files7展示越EOF仍在旧记录中暂缓，本次0新deferred不解除它。原Root166 realpath7行措辞澄清沿用正式62原scope记录，不伪造新的阅读或机制认证。方法首输出/输入pins时序及metadata文件名发现错误如实保留，未执行旧适配器或产品。

Root另核4643当前源码raw bytes及Git blob；同过滤库存4644，额外1个旧57审查fixture单列在原分母外。[当前绑定](evidence/coverage-snapshot-current-binding.json)。本轮63源阅读尚未并入此索引；非TS/TSX、完整跨模块/平台/运行验证不在分母，无法给出全仓精确剩余量和剩余bug数。总目标active。
''')
(OUT/'README.md').write_text(f'''# 正式63：模型追踪、后台通知与面板资源

本轮有限结论 **0新增正式问题、0候选、0新关联**。累计仍119条正式历史记录（46P2、73P3），另42条历史候选；未经逐项重验当前未修复数。[全部问题](../audit-2026-10-17-round61/ALL-ISSUES.md)、[历史候选](../audit-2026-10-17-round61/HISTORICAL-CANDIDATES.md)。

| 有限范围 | 实际检查 |
| --- | --- |
| [168模型追踪](evidence/model-traces/report.md) | native frames/sanitize/native-process三个静态全文和真实context/type消费者选段，552产品语义行、46既有普通测试声明；classification旧同SHA全文先排除。未运行真实FD/process/provider，不把局部0当所有秘密脱敏/保留策略正确 |
| [169后台通知](evidence/background-notification/report.md) | 正常任务result→enqueue/bus→Main→route→notifier/native闭包→session click接收链，检查实际sessionId/内容/状态；未发真实系统通知，不扩所有窗口authority，旧限流/点击历史边界保留 |
| [170面板资源](evidence/panel-resource-clone/report.md) | 真实Host-private materialize优化而非新建公开资源：capture/import digest→stable asset ID→staging/verify/close→materialize/tool消费。正常标识/路径和清理比较链未建反例；4MiB JSON加LF边界因当前小record未证明正常可达而单列notPromotedBoundary，无新ID |
| [Root171覆盖回填](evidence/root-coverage62/report.md) | 四份上一轮原canonical metadata回填，原4643路径368full/377selected/3898unknown；4275不能标full，当前63选段未合并。Root没有把4643 raw hash当新语义阅读 |

本轮产品/helper/import/fixture/test/native/进程/真实通知/模型/业务网络执行0，没有产品修复。既有测试只声明；测试导航片段、相邻非法输入声明显示、仅hash与产品语义分别记录，均不是pass。源范围/原用途/旧重复/未审机制在[manifest](source-manifest.json)及各原包保留，不能相加成新增唯一覆盖。有限0不证明整模块正确；可由静态代码检查的实际条件和清理分支照实检查，未把缺少动态执行当作跳过所有机制的理由。

共享首batch纳冻62排63+，6669 MD/JSON、4882650递归JSON value scalars、archive/hidden/unignored含、errors[]；9目标57/60/84、48/52/48、51/51/51均低cap100全保存。机器导航不是全历史语义阅读；真正旧scope依据为各包保存的原canonical。结束时点和Root刷新后的[历史漂移](evidence/incoming-history-drift.json)按实区分，首query不补跑。

{coverage['verbatimCopies']}份冻结原件逐字节复制、{coverage['receiptChecks']}条收据检查、12冻结锚点；{coverage['uniqueSourcePins']}个混合源/指令/metadata pins不等于同数新产品全文。Root检查当前声明selected/body/display/nav范围不越EOF，保留所有首metadata错误/边界，不修饰旧冻件。[复制回执](evidence/prep-copy-receipt.json)、[冻结](evidence/freeze-checks.json)、[执行](validation.json)、[字节索引](evidence-index.json)。

读取基线`{plan['baseline']}`，全部source读者冻结后main`{plan['refreshedMain']}`。只集成本轮文档，保留主目录已有改动、不push，全仓目标active。[覆盖边界](COVERAGE.md)。
''')
(EV/'review-aggregate.md').write_text('''# Root63有限复核

168–170按真实正常producer/consumer审查，未建立新可登记反例。trace实际channel的解码/clone/content-state、后台通知sessionId/结果状态及Host-private materialize的稳定ID/条件/比较/清理均有实际源码范围；未运行产品/native/真实通知。既有测试与测试导航不借作pass。

资源4MiB加LF边界原样保留为未晋升边界，缺正常producer到达证据，不用手造大DTO制造bug。Root171是已读62元数据回填，当前63源阅读不靠该包证明，旧deferred/范围限制不因新计数解除。保持119历史正式与42历史候选，全仓目标仍active。
''')

files=[]
for p in sorted(OUT.rglob('*')):
 if p.is_file() and p.name!='evidence-index.json':
  raw=p.read_bytes();files.append(dict(path=str(p.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
write(OUT/'evidence-index.json',dict(files=files,excludesSelf=True,productRuns=0))
print(json.dumps(dict(indexedFiles=len(files),formal=0,historicalRecords=119,frozenAnchors=12,sourcePins=coverage['uniqueSourcePins'],coverage=dict(states),notFull=4275,goalStillActive=True)))

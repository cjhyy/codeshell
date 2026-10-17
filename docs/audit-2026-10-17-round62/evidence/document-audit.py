"""Publish finite source reviews and through61 coverage metadata; product execution0."""
from pathlib import Path
from collections import Counter
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'docs/audit-2026-10-17-round62';EV=OUT/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
plan=json.loads((EV/'integration-plan.json').read_text());decision=json.loads((EV/'root-decision.json').read_text());coverage=json.loads((OUT/'coverage.json').read_text())
assert decision['allReadersFrozen'] and decision['rootSourceReviewComplete'] and decision['formal']==decision['candidates']==[]
checks=[]
for row in json.loads((EV/'worker-announced-freezes.json').read_text())['checks']:
 raw=(EV/row['path']).read_bytes();assert len(raw)==row['bytes'] and sha(raw)==row['sha256'];checks.append(dict(path='evidence/'+row['path'],bytes=len(raw),sha256=sha(raw)))
assert len(checks)==15
write(EV/'freeze-checks.json',dict(checks=checks,expectedCount=15,productRuns=0))
batch=json.loads((EV/'root-theme-window/history-batch.json').read_text());changed=[];missing=[]
for row in batch['inventory']:
 p=ROOT/row['path']
 if not p.is_file():missing.append(row['path'])
 elif sha(p.read_bytes())!=row['sha256']:changed.append(row['path'])
write(EV/'incoming-history-drift.json',dict(historyFiles=batch['historyFiles'],changed=changed,missing=missing,scope='Original6484 shared inventory; no query rerun or semantic source reading.'))
ledger=json.loads((EV/'coverage61/unified-current-index.json').read_text());rows=ledger['files'];states=Counter(r['publishableCurrentCoverage'] for r in rows)
assert len(rows)==len({r['path'] for r in rows})==4643 and states==dict(full=360,selected=363,unknown=3920)
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
write(EV/'coverage-source-git-bindings.json',dict(baseline=plan['baseline'],main=plan['refreshedMain'],baselineFiles=baseline,mainFiles=main,sourceSemanticReads=0,scope='Root bulk Git blob/raw-byte binding only;163 original GitVerified=false unchanged.'))
inventory=subprocess.check_output(['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**'],cwd=ROOT).decode().splitlines()
added=sorted(set(inventory)-{r['path'] for r in rows});removed=sorted({r['path'] for r in rows}-set(inventory))
assert added==['docs/audit-2026-10-17-round57/evidence/static-path.test.ts'] and removed==[]
write(EV/'coverage-snapshot-current-binding.json',dict(sourcePaths=4643,currentFilteredPaths=len(inventory),states=dict(states),notFull=4283,changedPaths=[],addedPaths=added,removedPaths=removed,incrementalSemanticRounds='Through61; current62 source reviews not unioned.',sourceSemanticReads=0,exactWholeRepositoryRemainingCount=None))
catalog=json.loads((ROOT/'docs/audit-2026-10-17-round61/recorded-findings-catalog.json').read_text());assert len(catalog['findings'])==119 and Counter(r['priority'] for r in catalog['findings'])==dict(P2=46,P3=73)
write(OUT/'historical-records-reference.json',dict(path='docs/audit-2026-10-17-round61/recorded-findings-catalog.json',formalRecords=119,priorities=dict(P2=46,P3=73),historicalCandidates=42,currentOpenCountCertified=False))
frozen=json.loads((EV/'frozen-artifact-whitespace.json').read_text())['exactArtifacts']
write(EV/'root-whitespace-review.json',dict(exactTrailingWhitespaceLines={r['path']:r['trailingLineNumbers'] for r in frozen},scope='Frozen provenance bytes only; new nonfrozen files use ordinary whitespace check.'))
(OUT/'COVERAGE.md').write_text('''# 覆盖台账更新：统计到正式61

原4643个TS/TSX路径，当前相同SHA的保守状态：**360完整范围、363部分、3920覆盖证据不足**。其中4283个尚不能标为完整范围。full仅代表原目的下完整静态语义文本；不证明所有行为/平台/运行机制正确。unknown也不证明从未读过。

相对[上轮台账](../audit-2026-10-17-round61/COVERAGE.md)，本次回填正式61原阅读证据，5个unknown→full、9个unknown→selected，另8个selected仅补provenance。不把多份selected拼成full，不把作者和复核者重叠相加。[163方法与原用途](evidence/coverage61/report.md)、[逐路径索引](evidence/coverage61/unified-current-index.json)、[变化](evidence/coverage61/transitions.json)。这些是既有证据归类，不是本次新读4643源码。

原161/files7展示范围40–124超过文件实际EOF120，该行整体暂缓迁移；有效selected51–80/114–120独立保留，其他155/159记录仍支撑同path。原冻件不改，不重新运行展示helper或声称替代实际显示总数；原MCP问题还有有效源证据。[勘误与范围澄清](evidence/scope-clarifications.json)。适配器首次只接受body字段、误拒实际navigation-display union支持的明确semantic17行，后来纠正；首方法/输出保留，未从纯nav创造语义。163的第二实现是作者自检，不是外部peer。

Root再核4643源码raw bytes及Git blob全同；当前同过滤库存4644，多出的旧57 static-path.test.ts审查fixture单列在分母外。[当前绑定](evidence/coverage-snapshot-current-binding.json)。本轮62的source选段未再并入统一索引。非TS/TSX、跨模块行为、完整运行/平台验证不在该分母，不能据此给出全仓精确剩余量或剩余bug数。全仓审查目标仍active。
''')
(OUT/'README.md').write_text(f'''# 正式62：模型目录、来源展示、主题与运行重放

本轮有限结论 **0新增正式问题、0候选、0新关联**。累计仍为119条正式历史记录（46P2、73P3），另42条历史候选；当前未修复数未经逐项重验。[全部问题](../audit-2026-10-17-round61/ALL-ISSUES.md)、[历史候选](../audit-2026-10-17-round61/HISTORICAL-CANDIDATES.md)、[本轮执行](validation.json)。

| 有限范围 | 实际进展与限制 |
| --- | --- |
| [164模型目录](evidence/model-catalog/report.md) | 三叶完整静态+真实image/video/save消费者选段，490产品语义行、126既有test声明；精确id更新与call/instance/kind模型优先级未建新普通反例，旧R10/R17重叠保留，失败cache-refresh方向未恢复 |
| [165 Sources展示](evidence/source-view/report.md) | collection DTO全文+linkview/capture/catalog/adapter选段，223语义行；credential/authority相邻方法仅显示停界，旧context-summary/resolve全文前排旧，旧S03不重报 |
| [Root166主题](evidence/root-theme-window/report.md) | conversion/URL/shared types三个小叶全文，其余选段共522语义/733显示；正常安装的canonical资产名→pack URL→协议字段相符，未执行安装/媒体/native，旧窗口问题body前排除；关于realpath7行的原报告措辞见范围澄清 |
| [167服务端重放](evidence/server-run-replay/report.md) | 普通baseline/request/游标/限额/clone/snapshot/finish/clear与真实worker消费者；persistence/OutputCoverage身份机制不认证，既有tests仅声明，旧R21原因与HTTP helper旧全文保留 |
| [163覆盖回填](evidence/coverage61/report.md) | 纯metadata接纳正式61有效记录，原4643路径更新360full/363selected/3920unknown；4283不能标full，62选段未统一合并，不把hash/索引当新读产品 |

本轮产品/helper/import/fixture/test/模型/native/业务网络执行0；既有测试声明不是pass，未借旧通过记录，旧失败动态方向继续跳过。普通producer→consumer/旧scope/显示/nav/hash分类分别在[源manifest](source-manifest.json)与各原包保留；行数含旧重叠，不能相加成新增唯一覆盖。有限0不证明整个模块正确。

共享历史batch纳冻61排62+、6484 MD/JSON、4639853 JSON value scalars、archive/hidden/unignored含，errors[]。模型三个target157/130/125、Sources四target110/593/102/132、window196均cap100只前100；theme三个38/37/39全保存。Root另补必要theme producer有限query，main/index1285只前100，其余87/73/67/37保存；机器导航不是全历史语义阅读或无旧因证明。167自行扫描的计数方法/窗口范围按原报告保留，不与这份JSON scalar数混算。

[范围勘误](evidence/scope-clarifications.json)不改任何旧冻件：161越EOF展示字段暂缓；Root166报告把realpath/open一概称仅显示过宽，protocol79–85实为普通guard字段语义选段，真实FS安全/竞态/native仍未认证，open86–89只显示。无需改变原selected522行或重跑产品。各首metadata错误/截断与自检/peer边界在原诊断留存。

{coverage['verbatimCopies']}份原件逐字节复制、{coverage['receiptChecks']}条收据检查、15冻结锚点；{coverage['uniqueSourcePins']}个混合源/指令/历史metadata pins不是同数产品全文。[复制](evidence/prep-copy-receipt.json)、[冻结](evidence/freeze-checks.json)、[Root决定](evidence/root-decision.json)、[字节索引](evidence-index.json)。各作者结束pins原样保留；Root刷新后的[共享库存漂移](evidence/incoming-history-drift.json)按实际记录，不重跑query。Root当前新scope同时检查selected/body/display/nav范围不得越EOF。

源读取基线`{plan['baseline']}`，所有source读者冻结后main`{plan['refreshedMain']}`。只集成本轮文档，保留主目录已有改动、不push；总审查未完成，goal保持active。[覆盖与剩余边界](COVERAGE.md)。
''')
(EV/'review-aggregate.md').write_text('''# Root62有限复核

已核163–167原报告/真实source与metadata范围，未建立新的普通输入反例；维持119历史正式、42历史候选。164精确模型字段、165显式schema/引用字段、Root166canonical主题数据链与167运行重放消费者均只作各自范围判断，不认证账号、权限、真实I/O或native。

163回填已有61记录并独立方法自检，Root额外重绑4643当前源码与Git。原161显示字段越EOF整行deferred，Root166少量措辞澄清不修饰原冻件；selected范围仍按原准确对象保留。所有产品执行0，测试只声明，失败动态方向保持SKIP。元数据诊断不是新产品bug或运行通过。

本轮0新增不代表全仓完成；保留原全仓目标active，不缩小为本轮有限包。
''')
files=[]
for p in sorted(OUT.rglob('*')):
 if p.is_file() and p.name!='evidence-index.json':
  raw=p.read_bytes();files.append(dict(path=str(p.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
write(OUT/'evidence-index.json',dict(files=files,excludesSelf=True,productRuns=0))
print(json.dumps(dict(indexedFiles=len(files),formal=0,historicalRecords=119,frozenAnchors=15,sourcePins=coverage['uniqueSourcePins'],coverage=dict(states),notFull=4283,goalStillActive=True)))

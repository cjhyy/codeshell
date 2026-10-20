"""Publish the complete historical list and conservative coverage ledger. Metadata only."""
from pathlib import Path
from collections import Counter
import hashlib, json, subprocess, datetime, re

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'docs/audit-2026-10-17-round61'; EV=OUT/'evidence'
PRIMARY=Path('/Users/admin/Documents/个人学习/代码学习/codeshell')
def sha(b): return hashlib.sha256(b).hexdigest()
def write(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT)

coverage=json.loads((OUT/'coverage.json').read_text()); plan=json.loads((EV/'integration-plan.json').read_text())
decision=json.loads((EV/'root-decision.json').read_text())
assert decision['allReadersFrozen'] and decision['rootSourceReviewComplete']
anchors=json.loads((EV/'worker-announced-freezes.json').read_text())['checks']; checks=[]
assert len(anchors)==27
for row in anchors:
    raw=(EV/row['path']).read_bytes(); assert len(raw)==row['bytes'] and sha(raw)==row['sha256']
    checks.append(dict(path='evidence/'+row['path'],bytes=len(raw),sha256=sha(raw)))
write(EV/'freeze-checks.json',dict(checks=checks,expectedCount=27,productRuns=0))

batch=json.loads((EV/'root-composition-lifetime/history-batch.json').read_text())
changed=[]; missing=[]
for row in batch['inventory']:
    p=ROOT/row['path']
    if not p.is_file(): missing.append(row['path'])
    elif sha(p.read_bytes())!=row['sha256']: changed.append(row['path'])
write(EV/'incoming-history-drift.json',dict(historyFiles=batch['historyFiles'],changed=changed,missing=missing,scope='Original6244 shared-query inventory only; no source semantic reread/query backfill.'))
assert changed==missing==[]

index=json.loads((EV/'coverage-migration/unified-current-index.json').read_text()); rows=index['files']
assert len(rows)==4643 and len({r['path'] for r in rows})==4643
states=Counter(r['publishableCurrentCoverage'] for r in rows)
assert states==dict(full=355,selected=354,unknown=3934)
def bulk_blobs(ref):
    requested=[ref+':'+r['path'] for r in rows]
    assert all('\n' not in p for p in requested)
    result=subprocess.run(['git','cat-file','--batch'],input=('\n'.join(requested)+'\n').encode(),capture_output=True,cwd=ROOT)
    assert result.returncode==0 and not result.stderr
    data=result.stdout; cursor=0; result_rows=[]
    for row in rows:
        eol=data.index(b'\n',cursor); head=data[cursor:eol].split(); assert len(head)==3 and head[1]==b'blob',row['path']
        size=int(head[2]); start=eol+1; raw=data[start:start+size]; cursor=start+size+1
        assert data[cursor-1:cursor]==b'\n' and len(raw)==size
        assert sha(raw)==row['sha256'] and size==row['bytes'],row['path']
        result_rows.append(dict(path=row['path'],blob=head[0].decode(),bytes=size,sha256=sha(raw)))
    assert cursor==len(data)
    return result_rows
baseline_rows=bulk_blobs(plan['baseline'])
main_rows=baseline_rows if plan['refreshedMain']==plan['baseline'] else bulk_blobs(plan['refreshedMain'])
for row in rows:
    raw=(ROOT/row['path']).read_bytes(); assert len(raw)==row['bytes'] and sha(raw)==row['sha256'],row['path']
inventory=git('ls-files','--cached').decode().splitlines() # Recorded separately; actual filter below preserves historical denominator rule.
filtered=subprocess.check_output(['rg','--files','--hidden','-g','*.ts','-g','*.tsx','-g','!**/node_modules/**','-g','!**/.git/**'],cwd=ROOT).decode().splitlines()
added=sorted(set(filtered)-{r['path'] for r in rows}); removed=sorted({r['path'] for r in rows}-set(filtered))
assert added==['docs/audit-2026-10-17-round57/evidence/static-path.test.ts'] and removed==[]
write(EV/'coverage-source-git-bindings.json',dict(baseline=plan['baseline'],main=plan['refreshedMain'],baselineFiles=baseline_rows,mainFiles=main_rows,sourceSemanticReads=0,scope='Root bulk Git blob/raw working byte checks only. Does not add source reading. Original154 gitCertified=false left intact.'))
binding=dict(sourcePaths=4643,currentFilteredPaths=len(filtered),changedPaths=[],addedPaths=added,removedPaths=removed,states=dict(states),notFull=4288,incrementalSemanticRounds='46–60 canonical standard manifests;61 reviews not unioned',sourceSemanticReads=0,remainingBugCount=None,exactWholeRepositoryRemainingCount=None)
write(EV/'coverage-snapshot-current-binding.json',binding)

old=json.loads((ROOT/'docs/audit-2026-10-17-round58/recorded-findings-catalog.json').read_text()); formal=decision['formal']
assert len(old['findings'])==118 and len(formal)==1 and formal[0]['id']=='MCP-R61-01'
catalog=dict(old)
catalog.update(createdUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Formal historical discoveries through61; not a current-open/current-fixed inventory.',baseline=plan['baseline'],predecessorCatalog='docs/audit-2026-10-17-round58/recorded-findings-catalog.json')
catalog['findings']=old['findings']+[dict(id=f['id'],priority=f['severity'],title=f['title'],sourceRound=61,canonicalFindings='docs/audit-2026-10-17-round61/findings.json',baseline=plan['baseline'],originalStatus=f['status'],originalFixedFlag=False,originalMainSourceDisposition=None,statusInterpretation='Dated static discovery; not runtime validated or certification of current state after later changes.') for f in formal]
catalog['sourceDocuments']=old['sourceDocuments']+[dict(round=61,path='docs/audit-2026-10-17-round61/findings.json',bytes=len((OUT/'findings.json').read_bytes()),sha256=sha((OUT/'findings.json').read_bytes()),originalReportedCount=1,baselineBlobMatches=None,note='New task-owned evidence, not baseline product blob.')]
catalog['counts']=dict(formalRecordRows=119,uniqueIds=119,byPriority=dict(P2=46,P3=73),rounds=61)
assert catalog['findings'][:118]==old['findings'] and len({r['id'] for r in catalog['findings']})==119
write(OUT/'recorded-findings-catalog.json',catalog)

# Finite metadata-only historical candidate index. All original rows retained; no new status inference.
candidate_rows=[]; candidate_sources=[]
for p in sorted((ROOT/'docs').glob('audit-2026-10-*/candidates.json')):
    if p.parent==OUT: continue
    match=re.fullmatch(r'audit-2026-10-17-round(\d+)',p.parent.name)
    if match and int(match.group(1))>=61: continue
    raw=p.read_bytes(); d=json.loads(raw); items=d.get('candidates',d.get('findings',[]))
    assert d.get('count',len(items))==len(items)
    candidate_sources.append(dict(path=str(p.relative_to(ROOT)),bytes=len(raw),sha256=sha(raw),count=len(items)))
    for i,item in enumerate(items):
        title=next((item[k] for k in ['title','summary','hypothesis','observation','issue','reason'] if isinstance(item.get(k),str)),None)
        candidate_rows.append(dict(id=item['id'],source=str(p.relative_to(ROOT)),pointer='/candidates/'+str(i),displayTitle=title or '原记录未设标题，见原对象',original=item))
assert len(candidate_rows)==len({r['id'] for r in candidate_rows})==42
write(OUT/'historical-candidates.json',dict(count=42,uniqueIds=42,sourceDocuments=candidate_sources,candidates=candidate_rows,currentUnresolvedCountCertified=False,scope='Historical candidates including unproven/skipped/source-addressed directions, not confirmed bugs and not current-unresolved certification. No cause re-review or product execution.'))
candidate_text=['# 42条历史候选记录\n','这些记录包含未证实、SKIP与后来可能已处理的方向；不是42条已确认bug，也不认证当前仍未解决。原对象完整保留在[机器目录](historical-candidates.json)。本次仅元数据汇总，不重新运行失败方向。\n','| ID | 历史候选 | 原状态 |\n| --- | --- | --- |\n']
def cell(s): return str(s).replace('|','\\|').replace('\n',' ')
for r in candidate_rows:
    status=r['original'].get('status') or r['original'].get('disposition') or '原对象未设status'
    candidate_text.append(f"| [{cell(r['id'])}]({PRIMARY/r['source']}) | {cell(r['displayTitle'])} | {cell(status)} |\n")
(OUT/'HISTORICAL-CANDIDATES.md').write_text('\n'.join(candidate_text[:3])+''.join(candidate_text[3:]))

all_text=['# 全部119条正式历史问题\n','累计 **119条：46条P2、73条P3**。本轮新增MCP-R61-01/P2；原118对象原样保留。此为正式历史记录数，**不是当前未修复数**。部分旧项已有源码处理记录，尚未逐项重验当前状态。\n','审查台账按原4643个TS/TSX路径统计：355完整范围、354部分、3934覆盖证据不足；4288尚不能标完整范围。该数不是精确未读数、剩余bug数或全仓剩余量；非TS文件与运行机制不在这个分母。迁移覆盖到正式60，61的选段尚未统一回填。当前同过滤库存4644，多出1个旧57审查fixture。[覆盖说明](COVERAGE.md)。\n','另有[42条历史候选](HISTORICAL-CANDIDATES.md)，未并入已确认数；原状态/跳过原因保留。\n','| ID | 级别 | 历史问题 |\n| --- | --- | --- |\n']
for r in catalog['findings']:
    title=re.sub(r'^\[P[0-3](?:[^\]]*)\]\s*','',r['title'])
    all_text.append(f"| [{r['id']}]({PRIMARY/r['canonicalFindings']}) | {r['priority']} | {cell(title)} |\n")
all_text.append('\n原日期、原状态、源码处理记录与运行界限见[机器目录](recorded-findings-catalog.json)及原报告。每行链接指向原证据；本列表不认证当前全部未修或已修。\n')
(OUT/'ALL-ISSUES.md').write_text('\n'.join(all_text[:5])+''.join(all_text[5:]))
(OUT/'COVERAGE.md').write_text('''# 审查覆盖与尚未完成范围

按原 **4643个TS/TSX路径**、相同源码SHA的保守台账：

| 记录状态 | 路径数 |
| --- | ---: |
| 有完整范围静态语义审查记录 | 355 |
| 只有部分范围审查记录 | 354 |
| 缺少可绑定的充分覆盖记录 | 3934 |
| 尚不能标完整范围（后两项之和） | **4288** |

这说明该口径下还有4288个路径未达到完整范围记录要求。unknown不等于从未读过，full也只代表原审查目的下的完整语义文本，不能代表所有行为、平台与运行机制都正确。355中也包含测试声明或测试基础设施文本；读过测试不等于运行通过。

[46–60迁移原报告](evidence/coverage-migration/report.md)将旧304/168/4171更新为355/354/3934：51个unknown升级full，186个unknown升级selected；不把多份selected拼成full，不相加作者/复核者重叠。77份规范非空manifest schema已适配，MD-only/其它旧格式仍保守保留原状态。旧55的hash键归一化失败原件仍保留，不再将旧0/511当成无进展结论。

[统一逐路径索引](evidence/coverage-migration/unified-current-index.json)、[逐路径变化](evidence/coverage-migration/transitions.json)与[Root当前字节/Git绑定](evidence/coverage-snapshot-current-binding.json)可查。迁移覆盖至正式60；本轮61的源选段未再并入统一索引，不能将这些数字说成全部审查工作的最终全集。

当前同一rg过滤库存4644，额外1路径是旧57的审查fixture `docs/audit-2026-10-17-round57/evidence/static-path.test.ts`，不是新增产品全文。原4643路径当前字节和Git基线全部对应，无缺失或改变。文件hash/索引读取不算产品语义审查。

整个仓库还有非TS/TSX源、脚本、配置、文档、跨模块行为以及各平台/运行验证，未纳入这4643分母。因此不能给出全仓精确剩余文件数、完成百分比、耗时或剩余bug数量。失败实验按用户要求继续跳过，未以反复重跑补成通过；总审查目标仍active。
''')
(OUT/'README.md').write_text(f'''# 正式61：完整问题列表、覆盖迁移与MCP项目覆盖

本轮 **1新增正式问题（MCP-R61-01/P2）、0残留本轮候选、0新关联计数**。累计 **119条历史正式记录：46P2、73P3**，另有42条历史候选；这些不是当前未修复/未解决计数。[全部119条](ALL-ISSUES.md)、[历史候选42条](HISTORICAL-CANDIDATES.md)、[机器目录](recorded-findings-catalog.json)、[覆盖与剩余范围](COVERAGE.md)。

新增问题：正常接受的`team.docs` MCP名称，在项目能力on/off路径被拼成点分配置键，落盘成嵌套对象；读回mcp record(enum)时拒绝该值。影响可扩至当前项目的validated settings读取失败。仅静态确认，未运行复现；成功写入、普通当前configVersion=2及无高层显式删除标记等条件在[正式证据](findings.json)、[Root159](evidence/root-dotted-mcp-decision/report.md)、[独立161读回复核](evidence/mcp-dot-readback-review/report.md)保留。

155曾据旧plugin/Skill同helper原因排除，158/160有限核对发现旧completed修复只覆盖该旧名称合同，不能自动保护当前仍合法的MCP入口。原意见全部保持冻件；Root只晋升同一线索一次，没有给158/161再加ID。[155](evidence/capability-control/report.md)、[158](evidence/dotted-capability-review/report.md)、[160历史归属](evidence/mcp-dot-history/report.md)。

并行有限审查还包括[156外部会话上下文表](evidence/session-context-store/report.md)和[Root157作用域/激活生命周期](evidence/root-composition-lifetime/report.md)，未建立新普通反例。上下文表为内存live ref映射，不把它当磁盘持久化承诺；生命周期只审普通所有权链，不认证任意factory/native关闭。旧覆盖、选段、完整显示、hash/导航与测试声明分开保留在[源manifest](source-manifest.json)，不能相加为新增唯一覆盖。

[154保守迁移](evidence/coverage-migration/report.md)更新原4643路径为355full/354selected/3934unknown；4288不能标full，不是全仓精确剩余量。只适配规范46–60，不把61选段自动并入；Root独立重绑4643当前源码与Git字节。旧失败方法/首输出/metadata修正留存。[162用户清单核对](evidence/user-status/report.md)独立核118旧记录、42历史候选和同过滤4644路径，未重新判断旧问题现状。

共享历史导航6244份MD/JSON、4350476递归JSON value scalars、含archive/排61+；overlay93/service177/project132/session25/lifetime78/activation65，cap100，service/project各只保存前100。机器访问不是读完所有历史；160另做有限新鲜去重导航/28窗口阅读，不声称新颖性穷尽。原输入结束无漂移，不补改首query。

本轮产品/helper/import/fixture/test/schema/真实配置/模型/native/业务网络执行均0；无产品修复。测试声明不当通过数，失败动态方向继续跳过。Root159元数据范围越界和路径显示错误、155/156各首导航/显示诊断如实保留；后续仅修metadata，不假造原始stdout/stderr。[执行口径](validation.json)、[Root元数据诊断](evidence/root-metadata-diagnostics.json)。

读取基线`{plan['baseline']}`，冻结后main`{plan['refreshedMain']}`；{coverage['verbatimCopies']}份原件逐字节复制、{coverage['receiptChecks']}条收据检查、27冻结锚点。{coverage['uniqueSourcePins']}个混合源/指令/历史metadata pins不是同数新增产品全文。[复制回执](evidence/prep-copy-receipt.json)、[冻结](evidence/freeze-checks.json)、[全部字节索引](evidence-index.json)。仅提交本轮文档，保留主目录已有改动、不push，总审查目标active。
''')
(EV/'review-aggregate.md').write_text('''# Root61有限决定

采纳MCP-R61-01/P2静态正式问题，只登记同一线索一次。当前普通合法名字/项目写路径及merge/schema读回都已选段核对；独立161反证和160有限旧史核对支持该入口仍需修复。未运行复现、未改产品；不扩成每个consumer/迁移/全局MCP操作均失败。

154覆盖迁移和162历史列表为metadata工作，不算本轮新读4643源码。原118对象原样保留，加1新记录为119；42旧候选不新判当前状态。155原排除、158/161候选意见保存，Root最终晋升一次，0残留本轮candidate。

156与157仅有限普通数据/所有权链阴性结论，完整显示、仅hash/nav、测试声明及旧同SHA重复均分账；0新增不证明全机制正确。全仓审查未完成，保持active。
''')
frozen=json.loads((EV/'frozen-artifact-whitespace.json').read_text())['exactArtifacts']
write(EV/'root-whitespace-review.json',dict(exactTrailingWhitespaceLines={r['path']:r['trailingLineNumbers'] for r in frozen},scope='Exact frozen copied provenance whitespace only; no new nonfrozen exemption.'))
files=[]
for p in sorted(OUT.rglob('*')):
    if p.is_file() and p.name!='evidence-index.json':
        raw=p.read_bytes(); files.append(dict(path=str(p.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
write(OUT/'evidence-index.json',dict(files=files,excludesSelf=True,productRuns=0))
print(json.dumps(dict(indexedFiles=len(files),formal=1,historicalRecords=119,historicalCandidates=42,sourcePins=coverage['uniqueSourcePins'],frozenAnchors=27,coverage=dict(states),notFull=4288,goalStillActive=True)))

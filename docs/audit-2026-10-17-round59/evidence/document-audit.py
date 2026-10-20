"""Build audit documentation and byte indexes; no product code execution."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round59"
EV = OUT / "evidence"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

coverage = json.loads((OUT / "coverage.json").read_text())
plan = json.loads((EV / "integration-plan.json").read_text())
decision = json.loads((EV / "root-decision.json").read_text())
assert decision["allReadersFrozen"] and decision["subagentIndependentReviewComplete"]
anchors = json.loads((EV / "worker-announced-freezes.json").read_text())["checks"]
checks = []
for row in anchors:
    raw = (EV / row["path"]).read_bytes()
    assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], row["path"]
    checks.append(dict(path="evidence/" + row["path"], bytes=len(raw), sha256=sha(raw)))
assert len(checks) == 15
write(EV / "freeze-checks.json", dict(checks=checks, expectedCount=15, productRuns=0))

batch = json.loads((EV / "root-subagent-continuation/history-batch.json").read_text())
changed, missing = [], []
for row in batch["inventory"]:
    path = ROOT / row["path"]
    if not path.is_file():
        missing.append(row["path"])
    elif sha(path.read_bytes()) != row["sha256"]:
        changed.append(row["path"])
write(EV / "incoming-history-drift.json", dict(historyFiles=batch["historyFiles"], changed=changed,
    missing=missing, scope="Original shared-query inventory only; drift is recorded without rerunning or backfilling the query."))

old = json.loads((ROOT / "docs/audit-2026-10-17-round55/evidence/coverage-current/unified-current-index.json").read_text())
rows = old["files"]
assert isinstance(rows, list) and len(rows) == 4643
changed_sources = [row["path"] for row in rows if sha((ROOT / row["path"]).read_bytes()) != row["sha256"]]
inventory = subprocess.check_output(["rg", "--files", "--hidden", "-g", "*.ts", "-g", "*.tsx",
    "-g", "!**/node_modules/**", "-g", "!**/.git/**"], cwd=ROOT).decode().splitlines()
added = sorted(set(inventory) - {row["path"] for row in rows})
removed = sorted({row["path"] for row in rows} - set(inventory))
assert changed_sources == [] and removed == []
assert added == ["docs/audit-2026-10-17-round57/evidence/static-path.test.ts"]
write(EV / "coverage-snapshot-current-binding.json", dict(sourcePaths=4643, currentFilteredPaths=len(inventory),
    changedPaths=changed_sources, addedPaths=added, removedPaths=removed,
    sourceSemanticReads=0, scope="Hash binding of old45 semantic coverage only; no46–59 semantic coverage union or exact remaining count."))
frozen = json.loads((EV / "frozen-artifact-whitespace.json").read_text())["exactArtifacts"]
write(EV / "root-whitespace-review.json", dict(exactTrailingWhitespaceLines={r["path"]:r["trailingLineNumbers"] for r in frozen},
    scope="Only exact frozen provenance copies retain original whitespace. All new nonfrozen files must pass ordinary checks."))

(OUT / "README.md").write_text(f'''# 正式59：LSP工作目录、会话分支、用量与子代理续办

有限结论 **0新增正式问题、0候选、0新关联**。历史正式记录仍为 **118项：45P2、73P3**，见[全部问题](../audit-2026-10-17-round58/ALL-ISSUES.md)与[机器目录](../audit-2026-10-17-round58/recorded-findings-catalog.json)。118不是当前未修复数，本批没有逐项重新认证旧项修复状态。

| 有限审查包 | 已核普通链与边界 |
| --- | --- |
| [145 LSP root](evidence/lsp-root/report.md) | 真实工具ctx.cwd/file→每root manager→同root initialize；6产品456语义行，2测试仅167声明行，725显示。旧URI/diagnostics、C4/C5及失败动态N12均排除 |
| [146会话分支](evidence/session-fork/report.md) | full/summary/completed-side真实协议→Engine→Manager→Transcript/portable serializer；5产品830选读行、121测试声明，1290显示。目标仅摘要是合同，未据此报原文丢失 |
| [147用量累计](evidence/session-usage/report.md) | provider response→foreground/external计量→本run未提交delta→latest state→成功后usage event；573产品行、63测试声明，975显示。usage旧同SHA全文重叠，timing正文不重读 |
| [Root148续办](evidence/root-subagent-continuation/report.md) | 原continuation字段创建→state snapshot→终态AgentSendInput恢复，7产品490语义行、1384显示，0测试阅读；parser为旧同SHA全文重读，authority/lease机制不由本批认证 |
| [149独立反证](evidence/subagent-continuation-review/report.md) | 对Root148有限结论独立核对；完整范围与反证见原包，不把父运行配置完全冻结当成未声明合同 |

所有行数含既有与必要消费者重叠，不能相加为新唯一覆盖。完整显示不等于完整机制验证，测试声明阅读不等于运行通过。[源清单](source-manifest.json)保留每包原范围/时序、仅导航、hash与旧范围边界。

共享[历史batch](evidence/root-subagent-continuation/history-batch.json)纳冻58、排59+，6010份MD/JSON、4291442递归JSON值scalar，含archive、0parse错。八目标命中37/37/56/609/548/87/59/56，cap100；manager/transcript仅保存前100，不能据无命中宣称未读或新颖。机器访问不等于全历史语义复审。各作者仅按原canonical选段认定旧范围。

本批[产品运行](validation.json)为0：未执行产品/helper/import/fixture/test/React/worker/native/模型/时钟/业务网络实验，也不借旧57通过数。145窄regex正常无命中exit1、147元数据文字修正保留首版、Root导航SyntaxWarning及未单独保存原stderr的界限均在原诊断如实保留。既有失败方向继续跳过。

共{coverage['verbatimCopies']}份prep原件逐字节复制、{coverage['receiptChecks']}条收据核验、15个report/manifest/receipt锚点；{coverage['uniqueSourcePins']}个混合source/instruction/metadata pins不能称为同数新增产品全文。[复制回执](evidence/prep-copy-receipt.json)、[冻结核对](evidence/freeze-checks.json)、[Root复核](evidence/review-aggregate.md)与[证据索引](evidence-index.json)可复核。

读基线`{plan['baseline']}`，作者冻结后refresh main至`{plan['refreshedMain']}`。[并发路径](evidence/incoming-main-paths.json)及[旧历史漂移](evidence/incoming-history-drift.json)按实际保存，不倒填原query。仅集成本批审查文档，保留主目录已有改动，不push。

剩余范围仍无法精确计数：[可靠旧覆盖台账](../audit-2026-10-17-round55/evidence/coverage-current/report.md)是4643路径的旧45同SHA迁移，304完整范围/168部分/4171无法确认；4339不能标full不是精确未读或剩余量。46–53仍DEFERRED_UNPARSED、54–59未统一回填，非TS/TSX与完整运行机制不在分母。[当前hash绑定](evidence/coverage-snapshot-current-binding.json)仍4643全同；当前库存4644，多出的1路径是旧57证据fixture。全仓目标保持active，未完成。
''')

(EV / "review-aggregate.md").write_text('''# Root59有限复核

亲读145/146/147报告及manifest分类、Root148原普通链，并以149独立报告检查结论界限。没有可升级的新正常输入反例，不制造正式项凑数；原件均冻结后才refresh。候选为零不证明全子系统无bug。

本批0产品运行，源SHA/语义范围/显示/导航/测试声明分别保存。旧118记录仅引用正式58，不改变原对象，不由本包认证全部当前未修。复用旧全文并未计作新唯一覆盖。字段层反证不升级成进程、权限、原子写入、跨进程或真实LSP机制认证。

[Root决定](root-decision.json)、[独立反证](subagent-continuation-review/report.md)、[范围](../source-manifest.json)、[验证](../validation.json)保存有限结论。完整目标继续active。
''')
write(OUT / "historical-records-reference.json", dict(path="docs/audit-2026-10-17-round58/recorded-findings-catalog.json",
    formalRecords=118, priorities=dict(P2=45,P3=73), currentOpenCountCertified=False))

files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        raw = path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
write(OUT / "evidence-index.json", dict(files=files, excludesSelf=True, productRuns=0))
print(json.dumps(dict(indexedFiles=len(files), sourcePins=coverage["uniqueSourcePins"], historicalRecords=118,
    frozenAnchors=len(checks), changedHistory=changed, goalStillActive=True)))

"""Build audit documentation and byte indexes; no product code execution."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round60"
EV = OUT / "evidence"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

coverage = json.loads((OUT / "coverage.json").read_text())
plan = json.loads((EV / "integration-plan.json").read_text())
decision = json.loads((EV / "root-decision.json").read_text())
assert decision["allReadersFrozen"] and decision["rootSourceReviewComplete"]
anchors = json.loads((EV / "worker-announced-freezes.json").read_text())["checks"]
checks = []
for row in anchors:
    raw = (EV / row["path"]).read_bytes()
    assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], row["path"]
    checks.append(dict(path="evidence/" + row["path"], bytes=len(raw), sha256=sha(raw)))
assert len(checks) == 12
write(EV / "freeze-checks.json", dict(checks=checks, expectedCount=12, productRuns=0))

batch = json.loads((EV / "root-release-audit-config/history-batch.json").read_text())
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
    sourceSemanticReads=0, scope="Hash binding of old45 semantic coverage only; no46–60 semantic coverage union or exact remaining count."))
frozen = json.loads((EV / "frozen-artifact-whitespace.json").read_text())["exactArtifacts"]
write(EV / "root-whitespace-review.json", dict(exactTrailingWhitespaceLines={r["path"]:r["trailingLineNumbers"] for r in frozen},
    scope="Only exact frozen provenance copies retain original whitespace. All new nonfrozen files must pass ordinary checks."))

(OUT / "README.md").write_text(f"# 正式60：构建入口、资源复制与发布元数据\n\n有限结论 **0新增正式问题、0候选、0新关联**。历史仍为 **118项：45P2、73P3**，见[全部问题](../audit-2026-10-17-round58/ALL-ISSUES.md)与[机器目录](../audit-2026-10-17-round58/recorded-findings-catalog.json)。这是历史记录数，不是当前未修复数。\n\n| 有限包 | 实际检查 |\n| --- | --- |\n| [150 build meta](evidence/build-meta/report.md) | 当前root exports/bin与shim生成目标、core/tui声明入口、root build顺序；旧R24/R31同SHA全文重叠保留，未运行build/CLI |\n| [151资源复制](evidence/copy-assets/report.md) | 三包真实copy参数、来源资产及runtime读取路径；旧zero-match已处理原因不重报，实际复制/删除/构建均0 |\n| [152版本检查](evidence/release-versions/report.md) | 当前15声明包与目录、版本/依赖/lock输入及普通bump→verify→发布前置调用；旧A11标签推送排除，未运行发布或改lock |\n| [Root153清单分类](evidence/root-release-audit-config/report.md) | config297全文静态+两consumer选段共448语义代码行，494显示；root/core/web三个manifest属性投影。non-code、types-only与runtime分别消费，不扩成全发布正确性 |\n\n旧范围、完整显示、语义选段、JSON pointers、仅文件名/行号导航、hash与测试声明均在[原manifest分类](source-manifest.json)保留；行数含旧范围与consumer重叠，不能相加成新增唯一覆盖。测试声明不是运行通过。\n\n[共享历史batch](evidence/root-release-audit-config/history-batch.json)纳冻59排60+、含archive：6126 MD/JSON、4322397递归JSON值scalar、0parse错。四目标109/34/33/57，cap100，build-meta仅前100；机器访问不等于全历史语义阅读，不能据没有命中认定未读或新颖。\n\n本批[产品执行](validation.json)为0，不导入/运行产品/helper/build/test/install/publish/native/模型/业务网络；也不借R6的旧17pass。151/152导航输出截断与151首次将JSONC当JSON解析失败按原诊断保留，未捕获输出不伪造，后续只读有限原件；既有失败产品实验继续跳过。\n\n{coverage['verbatimCopies']}份prep原件逐字节复制，{coverage['receiptChecks']}条收据核验，12个冻结锚点；{coverage['uniqueSourcePins']}个混合源/配置/指令/元数据pins不是同数新增产品全文。[复制回执](evidence/prep-copy-receipt.json)、[冻结检查](evidence/freeze-checks.json)、[Root复核](evidence/review-aggregate.md)、[证据索引](evidence-index.json)。首次整理输出和冻结空白例外均保留。首次集成因主分支并发推进而在暂存前保护性退出1；[首stderr](evidence/finalize-first.stderr)、[首exit](evidence/finalize-first-exit.json)和[并发核对](evidence/concurrent-main-review.json)保留。原未提交字节未变，随后只更新合并基线与证据绑定，不重跑产品。\n\n读取基线`{plan['baseline']}`，所有作者冻结后refresh main至`{plan['refreshedMain']}`；[并发路径](evidence/incoming-main-paths.json)、[历史字节漂移](evidence/incoming-history-drift.json)按实记录，不倒填原query。只集成本批文档，保留主目录已有改动，不push。\n\n[可靠覆盖台账](../audit-2026-10-17-round55/evidence/coverage-current/report.md)仍是旧45相同SHA迁移：4643路径、304完整范围/168部分/4171无法确认；4339不能标full不是精确剩余量。46–53仍DEFERRED_UNPARSED、54–60未统一回填，非TS/TSX和完整运行机制不在分母。[当前hash绑定](evidence/coverage-snapshot-current-binding.json)4643全同，库存4644，多出的1路径是旧57证据fixture。全仓目标active，未完成。\n")

(EV / "review-aggregate.md").write_text('# Root60有限复核\n\n亲读150–152原报告/准确manifest及Root153普通配置/consumer数据链，未建立可登记新普通反例。旧A11、旧copy zero-match及R6/R24/R31已读范围保留，不凑formal；零候选也不证明整条构建/发布链正确。\n\n本批只做静态源码与有限metadata阅读，没有真实构建、复制、安装、发布、运行测试或修改产品。完整显示、旧重复范围与仅导航不升级为新增语义覆盖。元数据首错/截断保留，不借旧pass。产品失败方向仍跳过。\n\n[Root决定](root-decision.json)、[Root原审查](root-release-audit-config/report.md)、[源范围](../source-manifest.json)、[执行口径](../validation.json)可复核。118仍为历史正式数，不逐项认证当前修复状态；全仓目标继续active。\n')

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

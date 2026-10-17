"""Rebuild this audit checkpoint's indexes from saved first-run evidence only."""
from pathlib import Path
import collections
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round4"
BASE = "4ee32f28f78b8315112cca77cfc22b2f2f80ced6"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

rows = [
    ("CTX-1", "P2", "Fallback snip切掉已保留tool call的结果", "context.md", "packages/core/src/context/compaction.ts", 324, ["context-snip-pairs.first.log"], "真实manager/TurnLoop+fake model", "summary失败后fallback；没有真实provider请求"),
    ("CTX-2", "P2", "摘要转换丢失结构化tool_result中的文字", "context.md", "packages/core/src/context/compaction.ts", 843, ["context-structured-summary.first.log"], "真实manager/toolResultToBlock+fake summarizer", "自动压缩/range archival；原始transcript保留；真实MCP/Engine持久化未执行"),
    ("SET-01", "P2", "user单字段保存遮蔽YAML中的其他配置", "settings.md", "packages/core/src/settings/manager.ts", 550, ["settings-yaml-write.first.log"], "真实manager/自有YAML JSON目录", "YAML字节保留；fresh manager加载已验证，实际TUI/app重启未执行"),
    ("SET-02", "P3", "Config接受错误类型并落盘，后续settings读取失败", "settings.md", "packages/core/src/settings/manager.ts", 581, ["settings-invalid-write.first.log"], "真实Config/manager/schema/自有文件", "需无效类型输入；写回合法值可恢复；没有真实app crash"),
    ("CODING-R4-01", "P2", "LSP Definition/References把编码URI当文件路径", "coding.md", "packages/coding/src/tools/lsp.ts", 208, ["coding-lsp-data.first.log"], "真实tool/manager+内存client/自有文件", "含空格/中文等路径；无真实server/Windows/GUI"),
    ("CODING-R4-02", "P2", "LSP重复diagnostics未同步已打开文件的编辑", "coding.md", "packages/coding/src/tools/lsp.ts", 156, ["coding-lsp-data.first.log"], "真实tool/manager+严格fake client", "重复didOpen/version1违反官方3.17合同；陈旧结果仅fake观察，真实server未执行"),
    ("LOG-R4-01", "P3", "日志轮转按bucket前缀删除最近engine历史", "root.md", "packages/core/src/logging/logger.ts", 439, ["root-log-retention.first.log"], "真实rotation/getRecentLogs/自有tmp", "TUI启动接线静态；仅诊断文件，无真实应用启动/transcript损失"),
]
findings = []
for ident, priority, title, report, source, line, logs, level, limits in rows:
    report_lines = (OUT / report).read_text().splitlines()
    report_line = next(i for i, text in enumerate(report_lines, 1) if text.startswith("#") and re.search(r"\b" + re.escape(ident) + r"\b", text))
    frozen_source = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
    assert 0 < line <= len(frozen_source.decode().splitlines())
    assert all((OUT / "evidence" / log).is_file() for log in logs)
    findings.append(dict(id=ident, priority=priority, title=title, report=report, reportLine=report_line,
        source=source, line=line, logs=["evidence/" + log for log in logs], evidenceLevel=level,
        limitations=limits, status="confirmed-at-frozen-source-baseline"))
priorities = dict(collections.Counter(row["priority"] for row in findings))
save("findings.json", dict(baseline=BASE, count=len(findings), priorities=priorities, findings=findings))

runs = []
for path in sorted((OUT / "evidence").glob("*.first.log")):
    text = path.read_text(errors="replace")
    if "bun test v" not in text:
        continue
    def count(pattern):
        m = re.search(pattern, text, re.M)
        return int(m.group(1)) if m else None
    completed = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    stem = path.name.removesuffix(".first.log")
    possible_exits = [path.with_name(stem + suffix) for suffix in [".first.exit.txt", ".exit.txt"]]
    exit_path = next(p for p in possible_exits if p.is_file())
    row = dict(log=str(path.relative_to(OUT)), exitFile=str(exit_path.relative_to(OUT)),
        exitCode=int(exit_path.read_text().strip()), firstRun=True, completed=bool(completed),
        passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
        errors=count(r"^\s*(\d+) error\s*$"), expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        selectedTests=int(completed.group(1)) if completed else None,
        skipped=int(completed.group(2)) if completed else None,
        sha256=sha(path.read_bytes()))
    if not completed:
        assert stem in {"root-cli-data", "root-recorder-day"}
        row["phase"] = "failed-fixture-skipped-no-retry"
        row["note"] = "Before product dynamic imports; ESM readonly namespace assignment" if stem == "root-cli-data" else "Before event writes; /var versus /private/var temporary path string control"
    else:
        row["phase"] = "focused-observation-and-controls"
    runs.append(row)
clean = [row for row in runs if row["completed"] and row["exitCode"] == 0 and row["failed"] == 0]
totals = dict(completedShards=len(clean), passedTests=sum(row["passed"] for row in clean),
    expectations=sum(row["expectations"] for row in clean), skippedOrFilteredTests=sum(row["skipped"] for row in clean),
    failedShardsSeparatelyRetained=len(runs)-len(clean))
assert totals == dict(completedShards=6, passedTests=23, expectations=114, skippedOrFilteredTests=0, failedShardsSeparatelyRetained=2), totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Shared Coding log supports two findings but counted once.",
    "Passing wrong-behavior assertions reproduces bugs, not fixed behavior.",
    "Two failed first fixtures retained with no repair, retry, alternate method, or confirmed product finding.",
    "CLI first failure printed no expectation count; keep null rather than invent zero. Recorder failed control prints 2 expectations, excluded from clean totals.",
    "No broad baseline/full build/typecheck/lint/real provider/server/app/OS test was run.",
    "Three read-only crossreviews add zero product tests; aggregate evidence index is final artifact hash authority.",
    "node_modules symlinks and existing dependencies reused; direct source fixtures are not a clean package/dist build gate.",
    "Raw logs intentionally included verbatim despite repository ignore rules.",
]))

sources = {row[4] for row in rows}
for p in list(OUT.glob("*.md")) + list((OUT / "evidence").glob("*.json")):
    if p.name.endswith("dedup.json"):
        continue
    sources.update(re.findall(r"(?:packages|scripts)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|md)\b", p.read_text()))
sources.update(["CODESHELL.md", "AGENTS.md", "bun.lock", "package.json", "tsconfig.json"])
for package in ["core", "coding", "tui"]:
    sources.add("packages/" + package + "/package.json")
manifest, unresolved = [], []
for name in sorted(sources):
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    path = ROOT / name
    if not path.is_file() or blob.returncode:
        unresolved.append(name)
        continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True,
        currentWorkingTreeMatchesFrozenBlob=path.read_bytes() == blob.stdout))
save("source-manifest.json", dict(baseline=BASE, files=manifest, unresolvedReferences=unresolved,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    note="Hashes refer to frozen Git blobs. Concurrent main changes are identified separately; per-file current comparison does not change first-run baseline or imply rerun. Full versus partial reading depth is in reports."))
inventory = collections.Counter()
for name in subprocess.check_output(["git", "ls-files", "packages"], cwd=ROOT).decode().splitlines():
    if re.search(r"\.(ts|tsx|mjs|js)$", name) and not re.search(r"(?:\.test\.|\.spec\.|/__tests__/|/dist/)", name):
        inventory[name.split("/")[1]] += 1
save("inventory.json", dict(baseline=BASE, trackedProductionLikeFilesByPackage=dict(sorted(inventory.items())),
    note="Filename inventory, not executed or deep-reviewed file count; excludes test/spec/dist patterns, includes support files."))
table = "\n".join(f"| {row['id']} | {row['priority']} | {row['title']} | [{row['report']}]({row['report']}) |" for row in findings)
(OUT / "README.md").write_text(f"""# CodeShell 从源码重新审查（2026-10-17，第四批 checkpoint）

本批确认并记录 **7 项：5 P2、2 P3**。仅新增审查报告、复现与原始收据，未修产品源码。完整条件、源码位置、预期/实际、影响、建议与验证边界见分报告；结构化入口 [findings.json](findings.json)。

冻结基线：`{BASE}`。任务分支：`codex/audit/context-round4-20261017`。刷新 origin 后，从当时已包含最新 origin/main 的本地 main 创建；沿用本聊天独立 worktree，主目录既有改动保留。整合前另一任务已更新本地 main，源码基线和首次测试仍保持原值；[整合范围记录](integration-context.md) 单列并发变化及静态核对，未冒称对新 main 重跑。本批重新读当时当前源码，旧报告仅用于去重，不能直接将 [10-16](../audit-2026-10-16/README.md)、[10-17](../audit-2026-10-17/README.md)、[第三批](../audit-2026-10-17-round3/README.md) 的历史数量相加为当前剩余问题数。

| 编号 | 优先级 | 问题 | 详情 |
| --- | --- | --- | --- |
{table}

[验证汇总](validation.json)：**6 个首次完整成功 guarded shard，23 pass / 114 expect / 0 fail、skip**。共享日志只计一次。另 **2 组首次 fixture 失败独立保留并跳过**，没有修支架、重试或换方式：CLI 在产品导入前因 readonly namespace 赋值失败；dev recorder 在事件写入前因临时路径字符串控制失败。这两组不支持确认 bug、不计入成功数量。

当前错误行为断言通过只表示可复现，**所有确认项均未修复**。Context 为真实 manager/TurnLoop 与 fake model/summarizer；Settings 为真实 Config/manager 与自有 YAML/JSON；LSP 为真实 tool/manager 与内存 client，官方3.17 didOpen合同经主审在线核对；日志维护只操作自有 tmp。没有真实模型、语言服务器、MCP、账户、平台发送、Ink/PTY/Electron/Host启动或跨平台验证。

三份只读交叉复核：[Settings审Context/Coding](quality-settings.md)、[Coding审Settings/Root](quality-coding.md)、[Context审Coding/Root](quality-context.md)。它们未新增测试。最终 [证据哈希](evidence-index.json)、[源码哈希](source-manifest.json)、[材料质量记录](quality-root.md)、[候选与跳过](candidates-and-skips.md)、[覆盖范围](coverage.md)、[包文件清单](inventory.json) 单独保留。没有全仓 build/typecheck/lint/测试通过声明。

**本批只是持续审查的一个 checkpoint，全仓目标仍在进行。** 当前报告记录已证实的问题和未完成方向，独立 Panel Apps 仓库未做全仓审查。
""")
files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        data = path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)), bytes=len(data), sha256=sha(data)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded; first raw logs and failed fixtures retained verbatim. SHA verification is not a product test."))
print(json.dumps(dict(findings=len(findings), priorities=priorities, totals=totals, sources=len(manifest), unresolved=unresolved, evidenceFiles=len(files)), ensure_ascii=False))

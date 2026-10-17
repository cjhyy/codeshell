"""Rebuild third-batch audit indexes from saved first-run receipts, without tests."""
from pathlib import Path
import collections
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round3"
BASE = "0f83bbfdfb8f2c6f31148250bd6544f5325c16e7"
def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
def sha(data):
    return hashlib.sha256(data).hexdigest()

rows = [
    ("R3-01", "P3", "Codex file_change完成事件丢失修改文件投影", "root.md", "packages/server/src/mobile-remote/codex-parse.ts", 99, ["root-codex-event-data.log", "root-codex-room-projection.log"], "生产parser及真实本地RoomManager/fake agent", "官方Codex0.142.4数组形状；没有真实CLI/文件改动实验"),
    ("R3-02", "P3", "Codex MCP结果与失败原因变成不可读摘要", "root.md", "packages/server/src/mobile-remote/codex-parse.ts", 79, ["root-codex-event-data.log", "root-codex-room-projection.log"], "生产parser及真实本地RoomManager/fake agent", "结构化result和error.message；成功/失败同一投影缺陷"),
    ("R3-03", "P3", "Codex JSONL null记录未隔离", "root.md", "packages/server/src/mobile-remote/codex-parse.ts", 37, ["root-codex-event-data.log"], "生产parser纯函数", "损坏/非schema记录；与R2-04相关家族但独立Codex live入口"),
    ("R3-04", "P3", "Windows格式默认room名使用整段cwd并可生成不可读metadata", "root.md", "packages/server/src/mobile-remote/room-manager.ts", 617, ["root-room-default-name.log"], "真实本地RoomManager metadata读写", "Windows格式输入条件；未运行Windows/创建真实长路径"),
    ("HL-01", "P3", "精确GitHub文件路径被trim并合并引用", "host-link.md", "packages/link/src/file-selection.ts", 15, ["host-link-selection.raw.log"], "生产resolver纯函数/自有Map", "真实仓库含首尾空白文件名条件；identity/reader为静态接线"),
    ("HL-02", "P3", "长路径默认标签截断Unicode代理对", "host-link.md", "packages/link/src/file-selection.ts", 90, ["host-link-selection.raw.log"], "生产resolver纯函数", "合法多段长路径；path仍正确，仅label损坏"),
    ("CDP-R3-01", "P3", "旋转quad点击/hover取到元素外的点", "cdp-browser.md", "packages/cdp/src/driver.ts", 157, ["cdp-geometry-keymap.first.stdout.log", "cdp-geometry-keymap.first.stderr.log"], "legacy SDK/fake sender/独立几何判定", "私有兼容SDK；无真实浏览器/命中/scroll布局验证"),
    ("CDP-R3-02", "P3", "Shift组合的logical key与text矛盾", "cdp-browser.md", "packages/cdp/src/keymap.ts", 316, ["cdp-geometry-keymap.first.stdout.log", "cdp-geometry-keymap.first.stderr.log"], "legacy SDK生产planKeySequence/fake sender", "私有兼容SDK；没有真实OS键盘/Chromium事件验证"),
    ("CDP-R3-03", "P2", "DOM hidden祖先剪枝漏掉显式visible子节点", "cdp-browser.md", "packages/browser-devtools/src/inspector.ts", 138, ["cdp-diagnostics-projection.first.stdout.log", "cdp-diagnostics-projection.first.stderr.log"], "实际inspector callback/Node VM/纯对象DOM", "有生产适配器静态消费者；没有CSS排版引擎E2E"),
    ("LAB-R3-01", "P3", "Lab反思输入仍选取已更正的旧评分", "arena-lab.md", "packages/optimization-lab/src/strategy.ts", 41, ["lab-offline-round1.raw.log"], "真实grading/correction/reflection纯转换", "实验flag默认off；Controller冻结链路静态/无真实模型"),
    ("ARENA-R3-01", "P3", "缺失或非法peer verdict默认agree并verified", "arena-lab.md", "packages/arena/src/strategies/utils.ts", 361, ["lab-offline-round1.raw.log"], "真实parser/claim状态纯函数", "私有保留Arena；非默认Host流程/无评审模型"),
    ("ARENA-R3-02", "P3", "Arena裁决早退跳过unresolved收尾", "arena-lab.md", "packages/arena/src/phases/adjudication.ts", 55, ["lab-offline-round1.raw.log"], "真实ledger/model-free裁决早退", "私有Arena；四桶summary遗漏静态/原始claims仍保留"),
]
findings = []
for id_, priority, title, report, source, line, logs, level, conditions in rows:
    lines = (OUT / report).read_text().splitlines()
    report_line = next(i for i, value in enumerate(lines, 1) if value.startswith("#") and re.search(r"\b" + re.escape(id_) + r"\b", value))
    assert 0 < line <= len((ROOT / source).read_text().splitlines())
    for log in logs:
        assert (OUT / "evidence" / log).is_file(), log
    findings.append(dict(id=id_, priority=priority, title=title, report=report, reportLine=report_line,
        source=source, line=line, logs=["evidence/" + log for log in logs], evidenceLevel=level,
        conditions=conditions, status="confirmed-at-frozen-source-baseline",
        deduplication="limited historical review; related families explicitly cross-referenced"))
counts = collections.Counter(item["priority"] for item in findings)
save("findings.json", dict(baseline=BASE, count=len(findings), priorities=dict(counts), findings=findings))

runs = []
# CDP keeps stdout/stderr separate; each pair is one execution, not two shards.
groups = [[p] for p in sorted((OUT / "evidence").glob("*.log")) if ".first." not in p.name]
for p in sorted((OUT / "evidence").glob("*.first.stdout.log")):
    groups.append([p, p.with_name(p.name.replace(".stdout.log", ".stderr.log"))])
for paths in groups:
    text = "\n".join(path.read_text(errors="replace") for path in paths)
    if "bun test v" not in text:
        continue
    def number(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None
    completed = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    row = dict(logs=[str(path.relative_to(OUT)) for path in paths], completed=bool(completed),
        phase="baseline" if any("baseline" in path.name for path in paths) else "focused-observation",
        passed=number(r"^\s*(\d+) pass\s*$"), failed=number(r"^\s*(\d+) fail\s*$"),
        expectations=number(r"^\s*(\d+) expect\(\) calls\s*$"),
        selectedTests=int(completed.group(1)) if completed else None,
        skipped=int(completed.group(2)) if completed else None,
        receipt="first-run-redirected-guarded-runner-output",
        hashes={str(path.relative_to(OUT)):sha(path.read_bytes()) for path in paths})
    if not completed:
        assert paths[0].name == "lab-offline-round2.raw.log", paths
        row["phase"] = "failed-fixture-skipped"
        row["note"] = "Provider registry identity mismatch before fakeLLM/expect; raw log does not print expectation count. No repair/retry."
    runs.append(row)
clean = [run for run in runs if run["completed"] and run["failed"] == 0]
totals = dict(completedShards=len(clean), passedTests=sum(run["passed"] for run in clean),
    expectations=sum(run["expectations"] for run in clean), filteredOrSkippedTests=sum(run["skipped"] for run in clean),
    failedShardsSeparatelyRetained=len(runs)-len(clean))
assert totals == dict(completedShards=12, passedTests=87, expectations=507, filteredOrSkippedTests=32, failedShardsSeparatelyRetained=1), totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Shared logs counted once. CDP stdout/stderr paired as one first-run shard.",
    "Selected test counts include filtered cases; passedTests is actual executed pass only.",
    "Passing wrong-behavior assertions reproduces bugs; it does not mean fixed product behavior.",
    "Lab failure is separately retained; no repair/retry or successful fakeLLM business result.",
    "Two independent quality agent turns later failed at model capacity; not product/test failures and not full independent reviews.",
    "Existing room history fixture has an explicit 120s case timeout and 10010 fsync writes; 40.7s first-run completion is not independent performance-bug evidence.",
    "No clean build/full typecheck/lint/full suite/real platforms claimed. Existing node_modules/dist reused where imports require it.",
    "Raw failed Lab log line11 ends with the provider diagnostic's literal trailing space. Full diff --check reports this one preserved raw-receipt exception; non-log material passes.",
    "16 raw .log files are intentionally force-added only within this task directory because repository ignore rules exclude logs.",
]))

sources = {row[4] for row in rows}
for p in list(OUT.glob("*.md")) + list((OUT / "evidence").glob("*manifest.json")) + [OUT / "evidence/cdp-receipt.json"]:
    sources.update(re.findall(r"packages/[A-Za-z0-9_.\-/]+\.(?:tsx?|md)\b", p.read_text()))
sources.update(["CODESHELL.md", "AGENTS.md", "bun.lock", "package.json"])
for package in ["host", "link", "cdp", "browser-devtools", "arena", "optimization-lab", "server", "core"]:
    sources.add("packages/" + package + "/package.json")
manifest, unresolved = [], []
for name in sorted(sources):
    p = ROOT / name
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    if not p.is_file() or blob.returncode:
        unresolved.append(name)
        continue
    assert p.read_bytes() == blob.stdout, "source differs from frozen baseline: " + name
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), matchesFrozenGitBlob=True))
save("source-manifest.json", dict(baseline=BASE, files=manifest, unresolvedReferences=unresolved,
    note="Selected source/contract files match frozen blobs; hashes do not prove full-file review depth."))

table = "\n".join(f"| {item['id']} | {item['priority']} | {item['title']} | [{item['report']}]({item['report']}) |" for item in findings)
readme = f"""# CodeShell 广度续审（2026-10-17，第三批 checkpoint）

本批确认并记录 **{len(findings)} 项：{counts['P2']} P2、{counts['P3']} P3**，仅写审查材料，未修产品代码。全部问题的源码位置、条件、预期/实际、影响和证据边界见分报告；结构化入口为 [findings.json](findings.json)。

冻结源码基线：{BASE}。任务分支：codex/audit/broad-round3-20261017。使用本聊天已有独立worktree；原主目录既有改动保留。刷新origin后，当前较新的本地main作为审查基线，其相对上一源码基线仅增加审查文档。旧 [10-16](../audit-2026-10-16/README.md) 和 [10-17上一批](../audit-2026-10-17/README.md) 均保持冻结，不能直接把各批数量相加为当前剩余问题数。

| 编号 | 优先级 | 问题 | 详细记录 |
| --- | --- | --- | --- |
{table}

验证见 [validation.json](validation.json)：**{totals['completedShards']} 个完整成功首次guarded shard，{totals['passedTests']} pass /{totals['expectations']} expect**，另有{totals['filteredOrSkippedTests']}个按名称过滤测试。共享收据只计一次；CDP stdout/stderr每对是一组执行。**1组首次Lab fixture失败独立保留并跳过**，没有修支架或换方式重跑，reviewer cap只列候选。

两项CDP输入缺陷保守按私有legacy SDK范围P3；Arena不被Host加载，Lab默认flag-off，均明确限定为P3。Browser diagnostics的DOM漏报有生产适配器静态消费者，保留P2。Codex协议形状对照源码声明的官方0.142.4版本；null仅损坏记录边界，未证明正常writer会产生。

[主审质量记录](quality-root.md)、[候选/重复/跳过](candidates-and-skips.md)、[覆盖范围](coverage.md)、[源码哈希](source-manifest.json)、[证据哈希](evidence-index.json)。两路完整独立质量turn因模型容量中断，已有片段意见保留；本批不冒称完整独立复核通过，最终源码/收据核对由主审继续完成。CDP分审receipt内旧报告SHA是历史版本，最终报告SHA以总证据索引为准。

材料检查包含源码/证据SHA、编号/行号、收据计数与本地链接。16份被ignore的原始日志显式纳入本审查目录；Lab失败诊断第11行自带一个尾空格，完整diff空白检查因此有一条原始收据例外并原样保留，排除日志后的材料空白检查通过。

所有动态限定本地纯函数、自有tmp/fake adapter或VM实际callback。未启动真实CLI/浏览器/付费模型/平台发送/实验feature，没有全仓build/typecheck/lint或真实OS验收声明。**本批只是持续审查的checkpoint，完整全仓目标仍在进行**；未覆盖范围继续保留，遇到失败方向按用户要求跳过。
"""
(OUT / "README.md").write_text(readme)
files = []
for p in sorted(OUT.rglob("*")):
    if p.is_file() and p.name != "evidence-index.json":
        data = p.read_bytes()
        files.append(dict(path=str(p.relative_to(OUT)), bytes=len(data), sha256=sha(data)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded; raw first stdout/stderr and failed fixture retained verbatim. Hash checks are not additional product tests."))
print(json.dumps(dict(findings=len(findings), priorities=dict(counts), totals=totals, sourceFiles=len(manifest), unresolved=unresolved, indexedFiles=len(files)), ensure_ascii=False))

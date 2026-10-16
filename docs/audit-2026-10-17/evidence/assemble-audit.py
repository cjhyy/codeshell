"""Assemble this audit checkpoint from saved receipts; never runs product tests."""
from pathlib import Path
import collections
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17"
BASE = "ab8b03f86ad38835939d4125b56bf4513cae7f15"

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

def digest(data):
    return hashlib.sha256(data).hexdigest()

# Each row is one distinct confirmed defect, not one test assertion.
ROWS = [
    ("R2-01", "P2", "Claude 项目编码碰撞导致会话归属错误", "root.md", "packages/coding/src/cc-orchestrator/session-discovery.ts", 244, ["root-session-discovery"], "真实 reader / 自有 JSONL", "自然路径编码碰撞；全局 Pet 发现不受同一入口影响"),
    ("R2-02", "P2", "Codex 列表选新 rollout，历史定位选旧文件", "root.md", "packages/coding/src/cc-orchestrator/codex-session-history.ts", 209, ["root-rollout-selection"], "真实列表和 history reader", "同线程多个 resumed rollout；tail 仅静态接线"),
    ("R2-03", "P3", "Markdown 导出围栏被工具正文提前闭合", "root.md", "packages/tui/src/cli/commands/builtin/export-md.ts", 134, ["root-export-fence"], "真实导出函数与 marked lexer", "只验证短 tool_result；原始文本仍存在"),
    ("R2-04", "P3", "Claude null 记录中止该会话健康历史", "root.md", "packages/coding/src/cc-orchestrator/session-history.ts", 87, ["root-history-corruption"], "真实 snapshot/tail parser", "损坏或非对象 schema；未证明正常 writer 会生成 null"),
    ("R2-05", "P3", "复制为纯文本会修改 fenced code 正文", "root.md", "packages/desktop/src/renderer/markdown/stripMarkdown.ts", 14, ["root-copy-code"], "生产纯函数", "仅回复整段纯文本复制；未操作剪贴板"),
    ("R2-06", "P3", "TUI 将 fenced 表格示例当成真实表格", "root.md", "packages/tui/src/ui/components/MessageContent.tsx", 166, ["root-tui-tables"], "真实组件及 renderer / PassThrough", "显示投影错误；原消息不变"),
    ("R2-07", "P3", "TUI 转义管道符导致表格错列并隐藏后列", "root.md", "packages/tui/src/ui/components/MessageContent.tsx", 179, ["root-tui-tables"], "真实组件及 renderer / PassThrough", "显示投影错误；与 R2-06 共享一个收据"),
    ("R2-08", "P3", "Codex patch rename 变更归属遗漏新路径", "root.md", "packages/coding/src/cc-orchestrator/external-agent-changes.ts", 121, ["root-changed-file-paths"], "生产 extractor 纯函数", "只审归属元数据；JSON arguments 形状仍为候选"),
    ("R2-09", "P2", "Review 将 hunk 正文误判为文件头并丢失改动", "root.md", "packages/desktop/src/renderer/diff/parseUnifiedDiff.ts", 62, ["root-unified-diff"], "自有 Git repo 真实 diff / 生产 parser", "Electron 打开/评论动作仅静态接线"),
    ("R2-10", "P3", "Review 纯重命名丢失两个文件路径", "root.md", "packages/desktop/src/renderer/diff/parseUnifiedDiff.ts", 74, ["root-unified-diff"], "自有 Git repo 真实 diff / 生产 parser", "仅纯 rename；与 R2-09/11 共享收据"),
    ("R2-11", "P2", "Review 未解码 Git quoted 中文路径", "root.md", "packages/desktop/src/renderer/diff/parseUnifiedDiff.ts", 143, ["root-unified-diff"], "自有 Git repo 真实 diff / 生产 parser", "默认 quotePath=true；文件打开/过滤影响静态接线"),
    ("S01", "P2", "Office 关系路径拼接静默遗漏 sheet/slide", "sources.md", "packages/core/src/sources/documents/parse.ts", 291, ["sources-parse"], "内存 ZIP / 真实 parseDocument", "混合相对、./、包根关系；未作完整 OOXML schema 验证"),
    ("S02", "P3", "Office 写死 r:id 前缀导致标签和顺序错误", "sources.md", "packages/core/src/sources/documents/parse.ts", 301, ["sources-parse"], "内存 ZIP / 真实 parseDocument", "动态 XLSX；PPTX 共用实现仅静态推论"),
    ("S03", "P2", "ReadSource 单文件查询脱敏破坏已序列化 JSON", "sources.md", "packages/core/src/tool-system/builtin/sources.ts", 686, ["sources-redaction", "sources-handler"], "生产函数组合及真实 handler / 本地 worker", "普通占位文字；未运行完整 executor/UI"),
    ("OM1", "P2", "全局记忆 ADD 按名称覆盖项目另一条 dream", "operations-memory.md", "packages/core/src/services/global-dream-promotion.ts", 99, ["ops-memory-promotion-round2"], "真实 orchestrator/gate/manager / fake LLM", "只限 auto/dream；manual 和真实模型未验证"),
    ("OM3", "P3", "Session summary 对有效时区时间按字符串排序", "operations-memory.md", "packages/core/src/services/session-memory-sort.ts", 12, ["ops-memory-data-round1"], "局部通过观察及明确源码契约", "失败 shard 中第一项通过；整组 1 pass/3 fail 无 Completed"),
    ("OM4", "P3", "并行工具进度复制另一工具的开始时间", "operations-memory.md", "packages/core/src/tool-system/builtin/agent-progress.ts", 53, ["ops-progress-recovery-round3"], "生产 reducer 纯函数", "仅进度元数据；未发现 UI 时长消费者"),
    ("OM5", "P2", "不同自然项目路径共用持久 memory 根", "operations-memory.md", "packages/core/src/session/memory.ts", 189, ["ops-memory-project-key-round4"], "真实本地 manager / 冷重建 / injection index", "自有自然路径；没有覆盖/删除/模型错误操作实验"),
    ("UI-01", "P3", "多行本地评论显示截断并误分类续行", "desktop-data.md", "packages/desktop/src/renderer/chat/anchors.ts", 146, ["ui-annotation-roundtrip"], "生产 wire 编解码纯函数", "wire 保留全文；Textarea/消息卡为静态接线"),
    ("UI-02", "P2", "Web/Mobile 对 cwd 转小写合并不同项目", "desktop-data.md", "packages/web/src/lib/format.ts", 18, ["ui-web-project-case"], "生产归属/分组纯函数", "条件：大小写敏感 Host 的两个合法仅大小写不同根"),
    ("UI-03", "P2", "历史尾窗口选择新任务却匹配旧 raw turn", "desktop-data.md", "packages/desktop/src/renderer/MessageStream.tsx", 710, ["ui-context-tail-selection"], "真实 tmp transcript reader/折叠/选择逻辑", "合法 legacy 无 journal、512 KiB tail 不完整；未执行 fork"),
    ("PET-01", "P3", "Pet JSON 原文预筛漏掉引号代码和反斜杠路径", "pet-data.md", "packages/pet/src/disclosure/search.ts", 123, ["pet-search-json-text"], "真实本地 reader / 自有 tmp", "全文 substring 搜索；Sessions/IPC 仅静态接线"),
    ("TIME1", "P3", "Cron 多余分隔符被截断且 update 接受错误计划", "scheduling-data.md", "packages/core/src/automation/cron-expr.ts", 60, ["time-cron-data-round1"], "生产 parser/内存 scheduler / fake clock", "executionDisabled；未触发实际任务"),
    ("TIME2", "P3", "CronCreate 的 Host 钟面时间贴上 job 时区", "scheduling-data.md", "packages/core/src/tool-system/builtin/cron.ts", 205, ["time-cron-data-round1", "time-cron-once-display"], "真实确认字符串 / fake clock / 内存 scheduler", "Host 与 job 时区不同；nextRun 绝对时刻正确"),
    ("CHD01", "P2", "Slack thread 身份丢失使回复落到频道顶层", "chat-data.md", "packages/chat/src/slack.ts", 69, ["chat-slack-thread"], "真实 Adapter/Gateway 数据链 / fake SDK 回调", "无真实连接或发送；平台参数语义来自官方文档"),
    ("CHD02", "P3", "长附件标签截断拆开 Unicode 代理对", "chat-data.md", "packages/chat/src/media.ts", 232, ["chat-text-metadata"], "生产共享名称函数及 bridge metadata", "条件：长 remote/SDK 标签；未证明真实平台返回该长度"),
]

findings = []
for id_, priority, title, report, source, line, logs, level, condition in ROWS:
    report_lines = (OUT / report).read_text().splitlines()
    heading = next(i for i, s in enumerate(report_lines, 1) if s.startswith("#") and re.search(r"\b" + re.escape(id_) + r"\b", s))
    assert 0 < line <= len((ROOT / source).read_text().splitlines()), (id_, source, line)
    for log in logs:
        assert (OUT / "evidence" / (log + ".log")).is_file(), log
    findings.append(dict(id=id_, priority=priority, title=title, report=report, reportLine=heading,
        source=source, line=line, logs=["evidence/" + v + ".log" for v in logs],
        evidenceLevel=level, conditions=condition,
        history="limited-deduplication-no-same-root-cause-found", status="confirmed-at-frozen-source-baseline"))
save("findings.json", {"baseline": BASE, "count": len(findings), "findings": findings})

FAILED = {
    "ops-memory-data-round1.log": "fixture/order failures; only OM3 first-test observation retained; no Completed; no retry",
    "root-summary-json.log": "wrong listSessionMemories arguments; normal control fails; both temporary R2-12/13 labels remain candidates; no retry",
    "chat-discord-chunks.log": "discord.js top-level import unavailable; no production assertion reached; skipped without repair/retry",
}
BASELINES = {"root-parser-baseline.log", "root-adjacent-baseline.log", "sources-pure-baseline.log", "ops-operations-baseline-round1.log", "ops-state-baseline-round3.log", "time-scheduling-baseline.log", "chat-channel-baseline.log"}
runs = []
for p in sorted((OUT / "evidence").glob("*.log")):
    text = p.read_text(errors="replace")
    if "bun test v" not in text:
        continue
    def number(pattern):
        m = re.search(pattern, text, re.M)
        return int(m.group(1)) if m else None
    completed = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    pass_ = number(r"^\s*(\d+) pass\s*$")
    fail = number(r"^\s*(\d+) fail\s*$")
    run = dict(log="evidence/" + p.name, phase="baseline" if p.name in BASELINES else "focused-observation",
        receipt="first-run-redirected-guarded-runner-output", completed=bool(completed),
        passed=pass_, failed=fail, errors=number(r"^\s*(\d+) error(?:s)?\s*$") or 0,
        expectations=number(r"^\s*(\d+) expect\(\) calls\s*$"),
        selectedTests=int(completed.group(1)) if completed else None,
        skipped=int(completed.group(2)) if completed else None,
        sha256=digest(p.read_bytes()), note=FAILED.get(p.name, ""))
    if not completed:
        assert p.name in FAILED, "Unclassified incomplete shard: " + p.name
        run["phase"] = "failed-fixture-or-partial-observation"
    elif p.name == "root-adjacent-baseline.log":
        run["note"] = "Only actual external-agent-changes 8 tests selected; nonexistent MessageContent.test.tsx was not run."
    runs.append(run)
clean = [r for r in runs if r["completed"] and r["failed"] == 0 and r["errors"] == 0]
totals = {"completedShards": len(clean), "passedTests": sum(r["passed"] for r in clean),
    "expectations": sum(r["expectations"] or 0 for r in clean), "filteredOrSkippedTests": sum(r["skipped"] for r in clean),
    "failedShardsSeparatelyRetained": len(runs) - len(clean)}
save("validation.json", {"baseline": BASE, "totals": totals,
    "notes": ["Completed counts selected tests, including filtered cases; passedTests counts actual pass only.",
        "Bug reproduction assertions passing means observed wrong behavior reproduced, not fixed product behavior.",
        "Shared logs are counted once; candidate/normal-control tests do not each count as bugs.",
        "No failed fixture was repaired/retried. Failed groups are not added to clean totals.",
        "Unit guard isolates HOME/config/credentials. Fixtures separately avoid real external services and models.",
        "Source imports can resolve package-level dependencies through existing node_modules and dist; no full clean build/typecheck claimed.",
        "All staged diff --check reports one raw Bun diagnostic trailing space at root-summary-json.log:22 (47 | ). Preserved verbatim; excluding raw logs the whitespace check passes.",
        "42 raw .log receipts are intentionally force-added within this task directory because the repository ignores *.log."], "runs": runs})

sources = set(v[4] for v in ROWS)
for report in sorted(OUT.glob("*.md")):
    sources.update(re.findall(r"packages/[A-Za-z0-9_.\-/]+\.(?:tsx|ts)\b", report.read_text()))
sources.update(["CODESHELL.md", "AGENTS.md", "bun.lock", "package.json", "docs/todo/workspace-upload-document-index-delivery.md"])
manifest, unresolved = [], []
for name in sorted(sources):
    p = ROOT / name
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    if not p.is_file() or blob.returncode != 0:
        unresolved.append(name)
        continue
    data = p.read_bytes()
    assert data == blob.stdout, "Production source changed from frozen baseline: " + name
    manifest.append({"path": name, "sha256": digest(data), "bytes": len(data), "matchesFrozenGitBlob": True})
save("source-manifest.json", {"baseline": BASE, "files": manifest, "unresolvedReferences": unresolved,
    "note": "Hash list proves cited/selected files match frozen blobs; it is not a list of fully reviewed files."})

tracked = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", BASE], cwd=ROOT, text=True).splitlines()
packages = collections.Counter(p.split("/")[1] for p in tracked if p.startswith("packages/"))
save("inventory.json", {"baseline": BASE, "trackedFiles": len(tracked), "packageFileCounts": dict(sorted(packages.items())),
    "note": "Repository inventory only; read depth/coverage is in coverage.md and individual reports."})

counts = collections.Counter(v["priority"] for v in findings)
table = "\n".join(f"| {v['id']} | {v['priority']} | {v['title']} | [{v['report']}]({v['report']}) |" for v in findings)
readme = f"""# CodeShell 审查记录（2026-10-17 checkpoint）

本轮从当前冻结源码重新建立证据，确认 **{len(findings)} 项：{counts['P2']} P2、{counts['P3']} P3**。只记录问题，未修改产品代码。完整问题索引见 [findings.json](findings.json)，逐项触发、预期/实际、影响和证据边界见下表分报告。

冻结基线：`{BASE}`。任务分支：`codex/audit/remaining-20261017`。独立 worktree 中审查，主目录既有改动不参与本任务；没有推送或发布。旧 [2026-10-16 审查](../audit-2026-10-16/README.md) 保持冻结，新旧问题不能直接相加为当前仍存在数。本轮有限查重未发现与旧确认项相同实现/根因的条目，不能宣称穷尽历史记录。

| 编号 | 优先级 | 问题 | 详细报告 |
| --- | --- | --- | --- |
{table}

验证收据：[validation.json](validation.json)。{totals['completedShards']} 个完整成功 guarded shard，实际 **{totals['passedTests']} pass / {totals['expectations']} expect**；另有 {totals['filteredOrSkippedTests']} 个过滤测试。共享收据只计一次，候选和正常对照不是额外 bug；断言错误现象的测试通过也不代表产品已修复。

**{totals['failedShardsSeparatelyRetained']} 组首次失败实验独立保留，均未修支架重跑。** OM3 的排序观察来自其中一组的首项通过与明确源码契约，整组仍失败、无 Completed；摘要 JSON 两个临时编号和 Discord 长回复线索不计确认。其余候选、只读检索缺口和已知边界见 [候选与跳过账本](candidates-and-skips.md)。

独立只读交叉复核：[Root/OM/UI/Pet](evidence/quality-ui-review.md)、[Sources/UI/失败收据](evidence/quality-ops-review.md)、[最终时区/Chat/汇总](evidence/quality-final-review.md)。这些复核没有新增动态测试，不可计作第二次独立复现。

[覆盖范围](coverage.md)、[源码哈希](source-manifest.json)、[证据哈希](evidence-index.json)、[仓库清单](inventory.json)。所有关键发现区分纯函数、真实 reader/renderer/handler 和静态调用链；未执行真实平台发送、付费模型、用户真实数据操作或完整 Electron/跨平台验收。

材料检查：源码/证据 SHA、问题行号、唯一编号与本地 Markdown 链接核对通过。原始 Bun 失败日志中一行诊断自带尾空格，完整 diff --check 因此有一条例外，保留原始字节；排除原始日志后的材料空白检查通过。被 .gitignore 忽略的42份日志已在本审查目录显式纳入版本控制。

这是持续审查的一个可复核 checkpoint，**并非全仓逐行审查或全部行为覆盖完成**。原目标仍在进行；本轮未重验旧 25 项是否已修复，也未覆盖独立 `codeshell-panel-apps` 仓库全部业务。
"""
(OUT / "README.md").write_text(readme)
print(json.dumps({"findings": len(findings), "priorities": dict(counts), "totals": totals,
    "sourceFiles": len(manifest), "unresolvedSourceReferences": unresolved}, ensure_ascii=False))

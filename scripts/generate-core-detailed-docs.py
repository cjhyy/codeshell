#!/usr/bin/env python3
from __future__ import annotations

import ast
import re
import textwrap
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path("packages/core/src")
OUT = Path("docs/core-modules-detailed")
IMG = OUT / "images"

ROLE = {
    "engine": "核心 Agent 编排层：负责把 settings、prompt、session、context、LLM、tools、hooks、MCP、sandbox 组装成一次可执行的 turn-loop。",
    "tool-system": "工具系统：负责工具注册、schema 校验、权限分类、审批、hook、执行、MCP 代理、内建工具与 guard。",
    "protocol": "Host/UI 与 Engine 的 JSON-RPC 风格边界：负责 run/query/configure/approve/cancel 以及 stream event 分发。",
    "run": "托管长任务生命周期层：负责 RunSnapshot、队列、锁、checkpoint、approval/input suspend、artifact、heartbeat 和 EngineRunner。",
    "llm": "模型抽象层：负责 provider client、model pool、capability rules、streaming、retry、watchdog、token/cost 相关工具。",
    "context": "上下文窗口管理：负责 token 估算、compaction、summary、tool-result 截断/持久化和 usage 记录。",
    "prompt": "System prompt 组装层：负责 section loader/cache、instruction scanner、skills/tools/preset/custom prompt 拼装。",
    "session": "会话持久化层：负责 session metadata、transcript、file-history、session memory。",
    "settings": "配置层：负责 Zod schema、多来源 settings 合并、scope 隔离和 user/project setting 写入。",
    "plugins": "插件兼容层：负责 marketplace 安装、installed_plugins、hooks/commands/skills 扫描、变量重写和插件命令执行。",
    "hooks": "扩展事件总线：负责 hook event 类型、优先级 registry、shell hook runner、hook message 注入和 goal-stop hook。",
    "skills": "Skill 发现层：负责 project/user/plugin skills 扫描、frontmatter 解析、禁用过滤和缓存。",
    "agent": "Sub-agent 定义与运行期协调层：负责 Markdown agent definitions、registry、singleton coordinator 和 inbox。",
    "arena": "多模型协作分析引擎：负责 planner、evidence providers、participant research、ledger、debate/adjudication/consensus。",
    "automation": "无人值守自动化层：负责 cron/interval job store、scheduler、runner binding、runNow 和 write policy 出口。",
    "cron": "历史兼容 shim：把旧 cron import path 转发到 automation 实现。",
    "capability-control": "能力控制层：把 builtin tools、MCP、skills、plugins 投影为统一 capability descriptor，并写 settings/overrides。",
    "product": "产品适配层：用 defineProduct 汇总 preset、tools、permissions、MCP、hooks、RunManager 和 evaluator。",
    "services": "横切服务集合：memory extraction、auto-dream、dream consolidation、analytics、diagnostics、notifier、OAuth、browser open。",
    "logging": "日志和录制层：负责结构化日志、session recorder、message/tool 脱敏和 AsyncLocalStorage session id。",
    "lsp": "语言服务器支持层：负责 LSP process/client/manager、root path 和 server 配置。",
    "git": "Git helper 层：负责 repo detection、worktree、parse log、argv git/gh helper。",
    "runtime": "安全进程运行层：封装 spawn lifecycle、timeout、abort、output cap 和 cleanup。",
    "remote": "远程桥接层：通过 ssh/NDJSON 触发 remote agent/workflow。",
    "data": "模型数据层：静态 provider catalogs、OpenRouter 同步和 JSON model snapshots。",
    "utils": "通用工具层：env、format、theme、ANSI slicing、lockfile、semver、exec helper、tool display 等。",
    "cli": "core 内的 agent-server 启动入口：stdio/tcp worker bootstrap 和 graceful shutdown。",
    "preset": "Agent preset registry：内建 preset、注册 preset、默认工具/提示策略。",
    "entrypoints-runtime": "根入口和运行时支撑：index/types/state/onboarding/updater/migrate/cost/errors/colorizer。",
}

FLOW = {
    "engine": ["Host 调用 Engine.run/query。", "Engine 解析 task/图片、settings、session、prompt、tool context。", "创建 ContextManager、ToolExecutor、ModelFacade 与 TurnLoop。", "TurnLoop 在 model_call/tool_exec/context_mgmt/hook_notify 间循环。", "完成后保存 transcript、session state、cost/usage，并返回 RunResult/stream events。"],
    "tool-system": ["TurnLoop 收到 model tool_use。", "ToolExecutor 执行 plan-mode allowlist、schema validation、pre_tool_use hook。", "Investigation/task/path/permission guard 分类，必要时走 approval backend。", "ToolRegistry 查找内建/MCP/custom executor 并带 timeout/abort 执行。", "post_tool_use/file_changed hooks 后将 ToolResult 转回 LLM tool_result message。"],
    "protocol": ["AgentClient 通过 Transport 发送 Run/Query/Configure/Approve 请求。", "AgentServer handleRequest 分发到 session/engine/run path。", "ChatSessionManager 按 sessionId 管理 Engine turn。", "server 把 StreamEvent 包装成 notification 发回 client。", "approval/cancel/inject/close 走同一 RPC envelope。"],
    "run": ["RunManager.submit 创建 queued RunSnapshot 并写 event log。", "RunQueue 调 executeRun，RunLock/Heartbeat/Checkpoint 开始工作。", "EngineRunner 构造 EngineConfig、RunApprovalBackend 和 askUser adapter。", "通过 in-process protocol 调用 Engine。", "完成/失败/取消后持久化 checkpoint、artifact、evaluator 和最终状态。"],
    "llm": ["ModelPool/settings 解析 active model/provider/key/capability。", "client-factory 选择 Anthropic/OpenAI-compatible client。", "provider client 构造 message/tools/stream request。", "stream chunks 归一化为 text/tool/reasoning/usage/stop reason。", "retry/watchdog/strip-vision/clamp-max-tokens 处理 provider 差异。"],
    "context": ["TurnLoop 每轮 model call 前调用 ContextManager.manage/manageAsync。", "先估算 token，再处理 tool-result budget/persistence。", "按阈值选择 micro/window/snip/summary/emergency compaction。", "summary compact 可调用注入的 summarizer LLM。", "记录 actual usage，并保持 tool_use/tool_result API round 不被拆坏。"],
    "plugins": ["installPlugin 从 marketplace 找 entry 并 materialize 到 cache。", "安装后 rewritePluginVars 并写 installed_plugins.json。", "loadPluginHooks 扫 hooks/hooks.json 并注册到 HookRegistry。", "pluginCommandsLoader 扫 commands/*.md。", "skills scanner 读取 installed plugins 并暴露 plugin skills。"],
    "automation": ["startAutomation 创建 CronScheduler 并绑定 runner/RunManager。", "create/update/delete/pause/resume 修改 store 并 reconcile timers。", "arm 对 interval 用 setInterval，对 cron expr 用 setTimeout 计算 next run。", "fire 用 running set 防重入，更新 run stats。", "runner 以 read-only/headless 或 RunManager submit 方式执行 prompt。"],
    "capability-control": ["CapabilityService.list 读取 settings 与 registry。", "project.ts 将 builtin/MCP/skills/plugins 投影为 descriptors。", "overlay.ts 应用 project tri-state overrides。", "setEnabled/setOverride 按 descriptor.control 写 user/project settings。"],
    "arena": ["Arena.run 先调用 planner 生成 mode/lenses/sources/outputShape。", "collectEvidence 并行收集 repo/git/docs 等证据。", "participant-research 并行调用多模型并可使用 context tools。", "ledger 注册 claims/dossiers。", "按 planning 或 review/discussion 路径进入 verification/debate/adjudication/consensus。"],
}

RISK = {
    "engine": ["Engine.run 装配职责很重，settings/session/context/tools/hooks/LLM/MCP/sandbox 都在同一入口交织。", "多 session、子 agent、settingsScope、permissionMode 组合复杂，容易出现状态或权限串台。"],
    "tool-system": ["权限路径包含 classifier、hooks、approval backend、plan mode、headless mode，多层叠加容易 drift。", "内建工具中心数组增长后，可维护性和 per-tool 安全策略成本上升。"],
    "protocol": ["legacy single-engine 与 multi-session 路径并存，行为分叉风险较高。", "stream notification schema 主要靠 TypeScript，运行时校验不足。"],
    "run": ["approval/input suspend 与 crash recovery 边界复杂。", "文件型 RunStore 依赖锁和 atomic rename，跨进程一致性需要持续测试。"],
    "llm": ["OpenAI-compatible provider 差异由 capability rules 维护，容易随 provider API 演化漂移。", "streaming tool-call JSON delta 拼接对截断和格式变化敏感。"],
    "context": ["compaction 必须保持 tool_use/tool_result 成对，否则 provider 会拒绝请求。", "summary compact 可能引入信息丢失或额外 LLM 失败。"],
    "plugins": ["插件 hook/command 使用 shell 执行，插件安装源是强信任边界。", "hook 失败常被吞掉，健壮但可能隐藏关键扩展失效。"],
    "hooks": ["updatedInput/updatedPrompt last-write-wins，低优先级 hook 仍可能覆盖结果。", "shell hook 失败 fail-open 返回空结果，策略 hook 失效可能不明显。"],
    "automation": ["job schema 有 permissionLevel，但不同 runner binding 的实际权限执行语义要保持一致。", "executor 失败若只吞错，会造成 unattended job 静默失败。"],
    "capability-control": ["descriptor projection 与 settings 写入强相关，kind/control drift 会导致 UI 显示与实际能力不一致。", "MCP 当前偏 server 级控制，不是单 tool 粒度。"],
}

@dataclass
class Evidence:
    title: str
    file: str
    start: int
    end: int
    code: str


def read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []


def module_files(module: str) -> list[Path]:
    if module == "entrypoints-runtime":
        names = ["index.ts", "types.ts", "state.ts", "onboarding.ts", "updater.ts", "migrate-models.ts", "cost-tracker.ts", "exceptions.ts", "colorizer.ts"]
        return [ROOT / n for n in names if (ROOT / n).exists()]
    return sorted([p for p in (ROOT / module).glob("**/*") if p.is_file() and p.suffix in {".ts", ".tsx", ".json", ".md"} and ".test." not in p.name])


def top_modules() -> list[str]:
    dirs = sorted([p.name for p in ROOT.iterdir() if p.is_dir()])
    return dirs + ["entrypoints-runtime"]


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def find_deps(files: list[Path], module_names: set[str]) -> set[str]:
    deps = set()
    for p in files:
        if p.suffix not in {".ts", ".tsx"}:
            continue
        text = "\n".join(read_lines(p))
        for m in re.finditer(r"from\s+['\"](\.\.?/[^'\"]+)['\"]|import\(['\"](\.\.?/[^'\"]+)['\"]\)", text):
            imp = m.group(1) or m.group(2)
            try:
                target = (p.parent / imp).resolve().relative_to(ROOT.resolve())
            except Exception:
                continue
            first = target.parts[0] if target.parts else ""
            dep = first if first in module_names else "entrypoints-runtime"
            deps.add(dep)
    return deps


def exported_symbols(p: Path) -> list[tuple[str, int, str]]:
    lines = read_lines(p)
    out = []
    pats = [
        ("class", r"export\s+(?:abstract\s+)?class\s+(\w+)"),
        ("function", r"export\s+(?:async\s+)?function\s+(\w+)"),
        ("interface", r"export\s+interface\s+(\w+)"),
        ("type", r"export\s+type\s+(\w+)"),
        ("const", r"export\s+const\s+(\w+)"),
        ("enum", r"export\s+enum\s+(\w+)"),
    ]
    for i, line in enumerate(lines, 1):
        for kind, pat in pats:
            mm = re.search(pat, line)
            if mm:
                out.append((mm.group(1), i, kind))
    return out


def snippet(path: Path, line: int, before: int = 2, after: int = 8, title: str | None = None) -> Evidence:
    lines = read_lines(path)
    s = max(1, line - before)
    e = min(len(lines), line + after)
    numbered = []
    for no in range(s, e + 1):
        numbered.append(f"{no:>4} | {lines[no-1]}")
    return Evidence(title or f"`{rel(path)}`:{line}", rel(path), s, e, "\n".join(numbered))


def key_files(files: list[Path]) -> list[Path]:
    score_words = ["index", "types", "schema", "engine", "manager", "registry", "executor", "server", "client", "runner", "scheduler", "store", "factory", "permission", "context", "composer", "scanner", "installer", "runtime"]
    def score(p: Path) -> tuple[int, str]:
        name = p.name.lower()
        if p.suffix == ".json":
            return (50, rel(p))
        s = 20
        for i, w in enumerate(score_words):
            if w in name:
                s = min(s, i)
        return (s, rel(p))
    return sorted([p for p in files if p.suffix in {".ts", ".tsx"}], key=score)[:12]


def collect_evidence(module: str, files: list[Path]) -> list[Evidence]:
    ev: list[Evidence] = []
    for p in key_files(files):
        syms = exported_symbols(p)
        if syms:
            for name, line, kind in syms[:2]:
                ev.append(snippet(p, line, title=f"导出 {kind} `{name}`"))
        else:
            lines = read_lines(p)
            added = False
            for i, line in enumerate(lines, 1):
                if re.search(r"class\s+\w+|function\s+\w+|const\s+\w+\s*=|export\s+\*\s+from", line):
                    ev.append(snippet(p, i, title=f"关键实现 `{rel(p)}`"))
                    added = True
                    break
            if not added and lines:
                ev.append(snippet(p, 1, before=0, after=min(8, len(lines) - 1), title=f"模块入口 `{rel(p)}`"))
        if len(ev) >= 10:
            break
    return ev[:10]


def file_table(files: list[Path]) -> str:
    rows = ["| 文件 | 规模 | 作用判断 |", "| --- | ---: | --- |"]
    for p in files[:35]:
        lines = len(read_lines(p))
        name = p.name.lower()
        if p.suffix == ".json": role = "模型/静态数据。"
        elif "test" in name: role = "测试文件。"
        elif name in {"index.ts", "types.ts"}: role = "导出/类型入口。"
        elif any(w in name for w in ["manager", "registry", "runner", "server", "client", "scheduler", "store"]): role = "生命周期、注册、调度或状态管理。"
        elif any(w in name for w in ["permission", "policy", "guard", "sanitize", "redact", "validation"]): role = "安全、权限、策略或校验。"
        else: role = "模块实现/辅助逻辑。"
        rows.append(f"| `{rel(p)}` | {lines} | {role} |")
    if len(files) > 35:
        rows.append(f"| … | … | 其余 {len(files)-35} 个文件见源码目录。 |")
    return "\n".join(rows)


def draw_png(module: str, deps: list[str], callers: list[str], files: list[Path]) -> None:
    IMG.mkdir(parents=True, exist_ok=True)
    W, H = 1600, 1000
    im = Image.new("RGB", (W, H), "#f7f9fc")
    d = ImageDraw.Draw(im)
    try:
        font_title = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 42)
        font_h = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 26)
        font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 22)
        font_s = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 18)
    except Exception:
        font_title = font_h = font = font_s = ImageFont.load_default()

    def box(x, y, w, h, fill, outline, title, body=""):
        d.rounded_rectangle([x, y, x+w, y+h], radius=24, fill=fill, outline=outline, width=3)
        d.text((x+w/2, y+20), title, fill="#172033", font=font_h, anchor="ma")
        if body:
            lines = textwrap.wrap(body, width=34)[:5]
            yy = y + 70
            for line in lines:
                d.text((x+w/2, yy), line, fill="#4b5873", font=font_s, anchor="ma")
                yy += 26

    def arrow(x1, y1, x2, y2):
        d.line([x1, y1, x2, y2], fill="#5d6d8a", width=4)
        # simple arrow head
        import math
        ang = math.atan2(y2-y1, x2-x1)
        for da in [2.7, -2.7]:
            x = x2 - 18 * math.cos(ang + da)
            y = y2 - 18 * math.sin(ang + da)
            d.line([x2, y2, x, y], fill="#5d6d8a", width=4)

    d.text((W/2, 45), f"packages/core/src/{module} 模块架构图", fill="#121826", font=font_title, anchor="ma")
    d.text((W/2, 92), "调用方 → 模块内部职责 → 下游依赖 / 状态边界", fill="#56657f", font=font, anchor="ma")
    d.text((230, 145), "主要调用方", fill="#33415f", font=font_h, anchor="ma")
    d.text((1370, 145), "主要依赖", fill="#33415f", font=font_h, anchor="ma")
    left = callers[:7] or ["外部 host / package entry"]
    right = deps[:7] or ["本模块内部 / 外部包"]
    for i, name in enumerate(left):
        y = 190 + i * 95
        box(60, y, 340, 62, "#e8f1ff", "#7aa7e8", name)
        arrow(400, y+31, 590, 500)
    for i, name in enumerate(right):
        y = 190 + i * 95
        box(1200, y, 340, 62, "#fff2e6", "#e5a15f", name)
        arrow(1010, 500, 1200, y+31)
    box(560, 250, 480, 430, "#ffffff", "#244a86", module, ROLE.get(module, "Core module"))
    d.text((800, 405), "关键文件", fill="#244a86", font=font_h, anchor="ma")
    y = 448
    for p in key_files(files)[:7]:
        d.rounded_rectangle([615, y, 985, y+38], radius=18, fill="#eef4ff", outline="#abc4ed", width=2)
        d.text((800, y+9), rel(p), fill="#21314d", font=font_s, anchor="ma")
        y += 48
    im.save(IMG / f"{module}.png")


def write_doc(module: str, modules: list[str], dependents: dict[str, set[str]]) -> None:
    files = module_files(module)
    deps = sorted(find_deps(files, set(modules)) - {module})
    callers = sorted(dependents[module])
    evidence = collect_evidence(module, files)
    draw_png(module, deps, callers, files)

    md = []
    md.append(f"# `packages/core/src/{module}` 详细技术文档\n\n")
    md.append(f"![{module} architecture](./images/{module}.png)\n\n")
    md.append("## 1. 模块定位\n\n")
    md.append(ROLE.get(module, "CodeShell core 顶层模块。") + "\n\n")
    md.append(f"本模块当前统计：源码/数据文件 **{len(files)}** 个；静态跨模块依赖 **{len(deps)}** 个；被其他 core 模块静态 import **{len(callers)}** 个。\n\n")
    md.append("## 2. 关键源码组成\n\n")
    md.append(file_table(files) + "\n\n")
    md.append("## 3. 真实运行主线\n\n")
    for i, step in enumerate(FLOW.get(module, ["通过模块导出或内部 import 进入。", "核心文件执行本模块职责并调用下游依赖。", "结果返回给 engine/protocol/run 或写入对应 store/log/session。"]), 1):
        md.append(f"{i}. {step}\n")
    md.append("\n## 4. 代码佐证\n\n")
    md.append("下面片段直接从当前源码抽取，行号为生成时的真实文件行号。\n\n")
    for ev in evidence:
        md.append(f"### 4.{evidence.index(ev)+1} {ev.title}\n\n")
        md.append(f"证据位置：`packages/core/src/{ev.file}:{ev.start}-{ev.end}`。\n\n")
        md.append("```ts\n" + ev.code + "\n```\n\n")
    md.append("## 5. 依赖与边界\n\n")
    md.append("### 5.1 依赖的 core 模块\n\n")
    md.extend([f"- `{x}`\n" for x in deps] or ["- 未发现静态相对 import 指向其他 core 顶层模块；可能主要依赖外部包、数据文件或被动态加载。\n"])
    md.append("\n### 5.2 被这些 core 模块调用\n\n")
    md.extend([f"- `{x}`\n" for x in callers] or ["- 未发现其他 core 顶层模块静态 import；可能作为外部 API、兼容 shim 或动态入口使用。\n"])
    md.append("\n## 6. 导出符号速查\n\n")
    syms = []
    for p in key_files(files):
        for name, line, kind in exported_symbols(p):
            syms.append((name, kind, rel(p), line))
    if syms:
        md.append("| 符号 | 类型 | 文件 | 行号 |\n| --- | --- | --- | ---: |\n")
        for name, kind, file, line in syms[:40]:
            md.append(f"| `{name}` | {kind} | `{file}` | {line} |\n")
        if len(syms) > 40:
            md.append(f"| … | … | … | 其余 {len(syms)-40} 个导出略。 |\n")
    else:
        md.append("该模块显式导出较少，主要通过入口文件 re-export、数据文件或动态加载使用。\n")
    md.append("\n## 7. 维护风险与审查重点\n\n")
    for risk in RISK.get(module, ["保持模块职责边界清晰，避免把 UI/TUI/desktop 假设写入 core。", "涉及持久化、网络、进程、权限或自动化的改动，需要补充端到端测试和失败路径测试。"]):
        md.append(f"- {risk}\n")
    md.append("\n## 8. 建议测试切入点\n\n")
    md.append("- 修改导出类型或 public API：优先运行相关 `bun test`，再视情况运行 `bun run typecheck`。\n")
    md.append("- 修改 engine/tool/protocol/run/llm/context：补一条从请求到 stream/result 的集成路径。\n")
    md.append("- 修改权限、自动化、插件、hooks、runtime：必须覆盖 deny/ask/allow、headless/unattended、timeout/abort 失败路径。\n")
    (OUT / f"{module}.md").write_text("".join(md), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    IMG.mkdir(parents=True, exist_ok=True)
    modules = top_modules()
    deps_by_module = {m: find_deps(module_files(m), set(modules)) - {m} for m in modules}
    dependents = defaultdict(set)
    for m, deps in deps_by_module.items():
        for d0 in deps:
            dependents[d0].add(m)
    for m in modules:
        write_doc(m, modules, dependents)
    idx = ["# `packages/core/src` 详细模块技术文档\n\n", "本目录是详细版 core 模块文档：每个模块一篇 Markdown，并配一张 PNG 架构图。文档包含真实源码行号、代码片段、依赖关系、运行主线和维护风险。\n\n", "| 模块 | 文档 | PNG 架构图 | 定位 |\n", "| --- | --- | --- | --- |\n"]
    for m in modules:
        idx.append(f"| `{m}` | [{m}.md](./{m}.md) | [images/{m}.png](./images/{m}.png) | {ROLE.get(m, '')} |\n")
    idx.append("\n## 生成口径\n\n- 模块边界来自 `packages/core/src` 顶层目录；根文件合并为 `entrypoints-runtime`。\n- 代码佐证从当前源码自动抽取，行号随源码变化可能漂移。\n- PNG 架构图由本仓库脚本确定性生成，不使用 SVG。\n- 依赖关系来自 TypeScript 相对 import 静态扫描，动态加载仍需结合运行路径人工确认。\n")
    (OUT / "README.md").write_text("".join(idx), encoding="utf-8")
    print(f"generated {len(modules)} docs and {len(modules)} png diagrams in {OUT}")

if __name__ == "__main__":
    main()

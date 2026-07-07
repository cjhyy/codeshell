<p align="center">
  <img src="assets/codeshell-dog-icon.png" alt="CodeShell mascot" width="120" />
</p>

# CodeShell

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>一个通用 AI agent 编排框架：覆盖终端、headless 运行和完整桌面应用。</strong>
</p>

<p align="center">
  <img src="assets/codeshell-promo.png" alt="CodeShell 桌面端 AI agent 编排宣传图" width="860" />
</p>

CodeShell 是同一个编排引擎的三种形态：

- **终端 CLI** (`code-shell`)：用于交互式和 headless agent 运行；
- **Electron 桌面应用**：提供聊天、文件/浏览器/终端/diff 面板、模型与凭证管理、扩展市场、自动化和手机远程控制；
- **程序化 SDK** (`import { Engine } from "@cjhyy/code-shell"`)：可把引擎嵌入你自己的产品。

核心引擎保持**领域无关**。turn loop、上下文管理、权限、MCP 集成、hooks、tasks、cron、sub-agents、sessions 和 memory 都是通用机制；“写代码助手”只是叠在引擎上的一个 preset，而不是写死在核心里。

> 状态：**0.6.0-rc.12**，正在准备 beta。桌面应用是当前主产品；CLI 和 SDK 共享同一个核心引擎。

---

## 为什么是 CodeShell

- **一个引擎，多种产品**：同一套 runtime 可以驱动编码、研究、自动化、浏览器任务和长期工作流。
- **终端优先，也适合 headless 和桌面**：可在终端交互运行，也可执行一次性 headless 任务，或者使用完整可视化桌面端。
- **默认具备权限意识**：写文件、shell、git 等高影响操作通过显式审批流程控制，并支持按 session/project 缓存规则。
- **端到端可扩展**：presets、内置工具、MCP servers、hooks、skills、plugins、sub-agents 和 cron jobs 都是一等能力。
- **本地优先与隐私友好**：sessions、transcripts、credentials 和 memory 存在 `~/.code-shell/`；凭证文件以 owner-only (`0o600`) 权限写入。

---

## 快速开始

### CLI

```bash
# 默认 CLI preset：终端编码助手（交互式 REPL）
npx @cjhyy/code-shell

# 作为通用编排器运行
npx @cjhyy/code-shell --preset general

# 一次性 / headless 执行
npx @cjhyy/code-shell run --preset general \
  "Create a long-running research plan and track it with tasks"
```

需要 **Node.js >= 20.10**。

### 桌面应用

桌面应用位于 `packages/desktop`。从源码启动：

```bash
bun install
bun run dev          # 以开发模式启动桌面应用
```

桌面端提供流式聊天、并排文件/浏览器/终端/diff 面板、模型与凭证管理、扩展市场、自动化/cron 调度、持久目标、memory 和手机远程控制。所有能力都通过每个 session 的 agent worker 进程驱动同一个核心引擎。

### 桌面预览

<p align="center">
  <img src="assets/codeshell-desktop-screenshot-en.png" alt="使用 Playwright 捕获的 CodeShell 桌面应用真实截图" width="860" />
</p>

---

## 功能

### 核心引擎 (`@cjhyy/code-shell-core`)

- turn-based agent loop，支持流式输出和逐步生命周期事件；
- 上下文压缩与持久 session 存储；
- 带权限门禁的工具执行，支持 session/project 规则缓存和链式命令防护；
- hook pipeline 与完整 MCP client 集成；
- 一等支持 **tasks、sub-agents、cron 和 sleep**，适合长期、自我节奏化工作流；
- **Persistent goals**：通过 stop-hook judge 和显式 `complete_goal` 声明推进目标；
- **Memory + Dream**：每轮注入 memory，并通过 LLM consolidation 进行整理；
- **统一模型目录**：text / image / video providers 使用同一套 tag-based config；
- 后台 shell jobs、成本追踪和 turn-level 文件 undo/redo。

### Presets

| Preset | 用途 | 额外工具 |
|--------|------|----------|
| `general` | 通用编排、研究、自动化、长期任务 | 仅核心编排工具 |
| `terminal-coding` | 终端原生编码助手 | `EnterWorktree`, `ExitWorktree`, `NotebookEdit`, `LSP`, `Brief`, `Arena` |

Preset 决定 system prompt、内置工具集和权限默认值。可通过 SDK、CLI `--preset` 参数或 settings 配置。

### 终端体验 (`@cjhyy/code-shell-tui`)

- 基于 Ink 的交互式 REPL，支持 fullscreen/flow 模式、vim-mode 输入和输入历史；
- headless `run` 模式，以及 `repl`、`sessions`、`runs` 子命令；
- slash commands、`@` 文件/skill 搜索、命令补全和 REPL 内 cron 调度；
- `Shift+Tab` 切换权限模式、transcript 浏览、session resume 和成本/用量报告。

### 桌面应用 (`@cjhyy/code-shell-desktop`)

- **Chat**：流式输出、图片附件（上传/拖拽/粘贴）、运行时 steering/queue 模型；
- **Panel dock**：对话旁的 Files、Browser、Terminal、Diff/Review 面板；
- **Model catalog & connections**：providers/models 的完整 CRUD、按公司复用凭证、参数文档联动 UI；
- **Credentials**：API keys、浏览器 cookie 登录、多账号 cookie 凭证和权限 token/link gates；
- **Extensions**：plugin/skill/MCP 管理、marketplace、capability overview 和 sub-agent role 管理；
- **Automation**：cron/scheduled tasks、每个任务的 transcript/memory，以及长任务 runs 视图；
- **Persistent goals**、memory 管理、hooks 配置和中英文 i18n；
- **Phone remote**：通过本地 WebSocket 从手机控制桌面 session；
- onboarding、trust gate、app updater、command palette (`⌘K`)、跨项目 session 搜索 (`⌘P`) 和 transcript 搜索 (`⌘F`)。

### 内置工具

默认 `general` preset 白名单包含 47 个内置工具。CLI 默认使用
`terminal-coding` preset，并额外加入编码相关工具。运行时 guard 可能隐藏当前不可用的
provider、凭证、cookie 或 goal 相关工具。

- **File / workspace**：`Read`, `Write`, `Edit`, `ApplyPatch`, `Glob`, `Grep`
- **Shell / execution**：`Bash`, `BashOutput`, `KillShell`, `ListShells`, `PowerShell`, `REPL`, `Sleep`
- **Web / media / browser**：`browser_observe`, `browser_act`, `browser_navigate`, `WebSearch`, `WebFetch`, `GenerateImage`, `GenerateVideo`
- **Planning / orchestration**：`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `ToolSearch`, `TodoWrite`, `Agent`, `AgentCancel`, `DriveAgent`, `DriveClaudeCode`, `CheckQuota`
- **Automation / integration**：`CronCreate`, `CronDelete`, `CronList`, `Config`, `Skill`, `MCPTool`, `ListMcpResources`, `ReadMcpResource`, `EditModelCatalog`
- **Memory / credentials / goals**：`MemoryList`, `MemoryRead`, `MemorySave`, `MemoryDelete`, `UseCredential`, `InjectCredential`, `complete_goal`, `cancel_goal`
- **Terminal-coding preset extras**：`EnterWorktree`, `ExitWorktree`, `NotebookEdit`, `LSP`, `Brief`, `Arena`

---

## 程序化 API

meta package 会重新导出核心引擎，所以旧的 SDK import 仍然可用：

```ts
import { Engine } from "@cjhyy/code-shell";

const generalEngine = new Engine({
  llm: {
    provider: "openai",
    model: "gpt-4.1",
    apiKey: process.env.OPENAI_API_KEY,
  },
  preset: "general",
});

const codingEngine = new Engine({
  llm: {
    provider: "openai",
    model: "gpt-4.1",
    apiKey: process.env.OPENAI_API_KEY,
  },
  preset: "terminal-coding",
});
```

所有内容都从 package root 导出：`import { ... } from "@cjhyy/code-shell"`，也可以直接从 `@cjhyy/code-shell-core` 导入。当前没有 `/run`、`/arena` 或 `/product` 这样的 subpath entry points。

---

## 配置

CLI preset 选择：

```bash
npx @cjhyy/code-shell --preset general
npx @cjhyy/code-shell --preset terminal-coding
```

settings 配置（`~/.code-shell/settings.json`，支持项目级覆盖）：

```json
{
  "agent": {
    "preset": "general",
    "enabledBuiltinTools": ["LSP"],
    "disabledBuiltinTools": ["WebSearch"],
    "appendSystemPrompt": "Prefer long-horizon planning and keep task state updated."
  }
}
```

支持的 `agent` settings：`preset`、`enabledBuiltinTools`、`disabledBuiltinTools`、`customSystemPrompt`、`appendSystemPrompt`。

### Fullscreen mode (TUI)

CodeShell 的终端 UI 默认使用 **fullscreen**（alt-screen + ScrollBox）。可以用 `CODESHELL_FULLSCREEN=0|false|off` 在启动时关闭，或在运行时使用 `/fullscreen off` 切换。

### Stream idle watchdog（默认开启）

OpenAI-compatible provider 会中止在 `CODESHELL_STREAM_IDLE_TIMEOUT_MS` 毫秒内没有 chunk 的 LLM stream（默认 `90000`），然后交给现有 retry 策略重试，最多 `CODESHELL_STREAM_WATCHDOG_RETRIES` 次（默认 `2`）。设置 `CODESHELL_ENABLE_STREAM_WATCHDOG=0` 可关闭。用户主动中止（Esc / Ctrl+C）不会被重试。

---

## 架构

<p align="center">
  <img src="docs/architecture/images/overview-runtime-layers.png" alt="CodeShell runtime layering and protocol flow architecture diagram" width="860" />
</p>

高层来看，CodeShell 让 CLI、headless、SDK 和桌面客户端都走同一个 engine runtime：

- **Preset resolution** 选择 system prompt、内置工具和权限默认值；
- **TurnLoop** 协调模型流式输出、上下文组装、工具执行和生命周期事件；
- **Tool system** 承载内置工具、MCP tools、permissions、hooks 和 cancellation；
- **Session / run layers** 持久化 transcripts、state、tasks、automation runs 和 memories。

桌面应用中，Electron main process 作为 IPC service layer：它本身不运行 Engine，而是为每个 session 启动核心 agent worker，把 stdout 流式传给 renderer，并提供文件、终端、凭证、插件、浏览器自动化 host 和 memory 等系统能力。Renderer 是只通过 `window.codeshell.*` 与 main 通信的 thin client。

设计原则：

- **Core first**：编排引擎保持领域无关；
- **Presets over hardcoding**：编码行为存在配置里；
- **Secure by default**：高影响动作默认经过权限门禁；
- **Long-running ready**：tasks、cron、sleep、sub-agents 和 persistent goals 都是一等能力。

---

## 项目结构

```text
packages/
├── core/      # Engine, context, tools, MCP, hooks, sessions, runs, presets, memory
├── tui/       # Terminal CLI, Ink-based UI, renderer, commands, approvals
├── desktop/   # Electron desktop client + agent worker bridge + mobile remote app
└── cdp/       # Environment-agnostic CDP browser-action layer (no Playwright)

assets/       # README / product images (mascot, promo hero, Playwright desktop screenshots)

docs/
├── architecture/        # System architecture chapters + feature inventory
├── todo/                # Roadmap + forward-looking design docs
└── archive/             # Superseded design docs, audits, and prior architecture set

scripts/      # Build, release, and repo maintenance scripts
```

---

## 开发

```bash
bun install
bun run build          # build core + tui + meta package
bun run typecheck      # root core + tui check; currently not a clean gate
bun test               # core / tui test suites

# Desktop has its OWN typecheck and build (root checks do NOT cover it):
cd packages/desktop
bun run typecheck
bun run build
```

> 当前注意：repo root 的 `bun run typecheck` 会因 `packages/core/src/tool-system/builtin/drive-claude-code.test.ts:158` 的既有测试类型错误失败。它仍可提供信号，但在该错误修复前不要把它当成干净 gate。

`bun run dev` 会启动桌面应用。TUI 开发模式：`bun run dev:tui`。

> 桌面 renderer 使用 **shadcn/ui + Tailwind v4**（zinc theme），且不导入 core 代码；它是 `window.codeshell.*` 上的 thin client。Renderer 约定见 `packages/desktop/CLAUDE.md`。

---

## 延伸阅读

- [Architecture & feature inventory](docs/architecture/README.md)
- [Roadmap & TODO](docs/todo/README.md)
- [Prior architecture documentation set (archived, pending rewrite)](docs/archive/architecture/README.md)

---

## 致谢

`ApplyPatch` tool（`packages/core/src/tool-system/builtin/apply-patch/`）改编自 [OpenAI Codex `codex-rs/apply-patch`](https://github.com/openai/codex/tree/main/codex-rs/apply-patch)，使用 Apache License 2.0。详见该目录下的 `NOTICE.md` 和 `LICENSE-codex`。

## License

MIT — see [LICENSE](LICENSE).

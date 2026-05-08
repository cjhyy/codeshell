# Code Shell — 完整架构文档

> 生成日期: 2026-05-08 | 基于当前 `main` 分支 + uncommitted 改动

---

## 目录

1. [总体架构概览](#1-总体架构概览)
2. [模块详解](#2-模块详解)
   - [2.1 Engine — 对话轮询引擎](#21-engine--对话轮询引擎)
   - [2.2 Tool System — 工具系统](#22-tool-system--工具系统)
   - [2.3 Arena — 多模型协作分析](#23-arena--多模型协作分析)
   - [2.4 Product — 产品定义系统](#24-product--产品定义系统)
   - [2.5 CLI — 命令行入口](#25-cli--命令行入口)
   - [2.6 UI — Ink/React 终端组件](#26-ui--inkreact-终端组件)
   - [2.7 LLM — 大语言模型适配层](#27-llm--大语言模型适配层)
   - [2.8 Preset — Agent 预设系统](#28-preset--agent-预设系统)
   - [2.9 Session — 会话与记忆](#29-session--会话与记忆)
   - [2.10 Protocol — 远程通信协议](#210-protocol--远程通信协议)
   - [2.11 Context — 上下文管理](#211-context--上下文管理)
   - [2.12 Prompt — 提示词组装](#212-prompt--提示词组装)
   - [2.13 Run — 运行编排](#213-run--运行编排)
   - [2.14 Services — 辅助服务](#214-services--辅助服务)
   - [2.15 Agent — 多代理协调](#215-agent--多代理协调)
   - [2.16 Bootstrap — 启动引导](#216-bootstrap--启动引导)
   - [2.17 Hooks — 生命周期钩子](#217-hooks--生命周期钩子)
   - [2.18 其他辅助模块](#218-其他辅助模块)
3. [完整模块互连图](#3-完整模块互连图)
4. [设计决策与模式](#4-设计决策与模式)
5. [当前待改进点](#5-当前待改进点)

---

## 1. 总体架构概览

Code Shell 是一个**通用 Agent 编排框架**，内置 `terminal-coding` preset 提供编程场景。核心思想：

- **Engine** 是独立于领域的对话引擎（轮询 → LLM → 工具执行 → 上下文压缩）
- **Preset** 决定 Agent 的"人格"（系统提示词 + 工具白名单 + 权限策略）
- **Arena** 是多模型协作分析层（可选的、更高级的能力）
- **工具系统** 是核心扩展点，所有能力通过工具暴露给 LLM
- **Ink/React** 提供终端 UI，但引擎可通过 Protocol 或 Query API 脱离 UI 独立运行

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI (main.ts)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   run    │  │   repl   │  │  arena   │  │ sessions │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │             │              │          │
│       ▼              ▼             ▼              ▼          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   RunManager                          │   │
│  │  ┌──────────────────────────────────────────────┐    │   │
│  │  │              EngineRunner                     │    │   │
│  │  │  ┌─────────────────────────────────────┐     │    │   │
│  │  │  │          TurnLoop (Engine)           │     │    │   │
│  │  │  │  pre_check → model_call → exec → …  │     │    │   │
│  │  │  │  ┌────────┐  ┌───────────────┐      │     │    │   │
│  │  │  │  │ModelFcd│  │ ToolExecutor  │      │     │    │   │
│  │  │  │  └────────┘  └───────┬───────┘      │     │    │   │
│  │  │  │                      │               │     │    │   │
│  │  │  │  ┌───────────────────┼───────────┐   │     │    │   │
│  │  │  │  │     Tool Registry │ Permission│   │     │    │   │
│  │  │  │  │  ┌──────┐ ┌──────┐│ Validation│   │     │    │   │
│  │  │  │  │  │ Read │ │Write ││  MCP Mgr  │   │     │    │   │
│  │  │  │  │  │ Bash │ │ Edit ││  ...      │   │     │    │   │
│  │  │  │  │  └──────┘ └──────┘│           │   │     │    │   │
│  │  │  │  └───────────────────┴───────────┘   │     │    │   │
│  │  │  └─────────────────────────────────────┘     │    │   │
│  │  └──────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 模块详解

### 2.1 Engine — 对话轮询引擎

**位置**: `src/engine/` (9 文件, ~1,500 行)

Engine 是整个 agent 运行时的核心状态机。从"用户消息"到"完成输出"的全流程编排。

#### 文件清单

| 文件 | 行数 | 核心职责 | 导出 |
|------|------|----------|------|
| `engine.ts` | ~590 | Engine 入口：组装所有组件, 会话生命周期, 权限配置, 并行初始化 | `Engine` 类 |
| `turn-loop.ts` | ~515 | Agent 状态机：pre_check → model_call → tool_exec 循环 | `TurnLoop` 类 |
| `model-facade.ts` | ~164 | LLM 客户端封装：transcript 记录 + usage 跟踪 + reasoning_content | `ModelFacade` 类 |
| `streaming-tool-queue.ts` | ~71 | 流式工具执行队列：安全工具并发, 不安全工具串行 | `StreamingToolQueue` 类 |
| `token-budget.ts` | ~60 | 递减回报感知的 token 预算控制 | `TokenBudget` 类 |
| `tool-summary.ts` | ~46 | 工具执行后的一行摘要生成 | `toolSummary()` |
| `query.ts` | ~159 | AsyncGenerator API 包装 TurnLoop | `query()` 函数 |
| `turn-state.ts` | ~22 | 单轮状态快照 | `TurnState` 类型 |
| `cost-store.ts` | ~24 | 成本持久化策略接口 | `CostStore` 接口 |

#### engine.ts — Engine 类

**生命周期: 构造 → registerCustomTool() → run() → forceCompact()**

```typescript
const engine = new Engine({
  llm: { provider: "openai", model: "deepseek-v4-pro" },
  cwd: "/project",
  maxTurns: 30,
  permissionMode: "acceptEdits",
  preset: "terminal-coding",
  customSystemPrompt: "...",
  mcpServers: { ... },
});

engine.registerCustomTool(myToolDef, myExecutor);

const result = await engine.run("帮我修复登录页面的 bug");
```

**`run()` 方法执行的 7 个阶段**:

1. **注入全局依赖** — `setAskUserFn()`, `setArenaLLMConfig()`, `setSubAgentConfig()`, `setToolSearchRegistry()`
2. **会话管理** — 恢复历史 or 创建新会话, 追加 user 消息
3. **初始化 LLM 客户端** (提前启动网络握手) — `createLLMClient()`
4. **权限配置 `buildPermissionConfig()`** — preset 默认规则 + permissionMode 追加 + ApprovalBackend 选择
5. **并行初始化** — LLM 客户端就绪 + 系统提示词 + 环境上下文 (CLAUDE.md 等) 三路 Promise.all
6. **注入 CLAUDE.md** — prepend 到消息列表
7. **创建核心组件** — `ModelFacade`, `ContextManager`, `TurnLoop`, `FileHistory` (Hook 注入)

**依赖注入方式 (当前)**:

```typescript
// 通过模块级 setter 注入, 非构造函数注入:
setAskUserFn(callback);           // AskUserQuestion 工具回调
setArenaLLMConfig(config);        // Arena 多模型配置
setSubAgentConfig(config);        // Agent 子代理配置
setToolSearchRegistry(registry);  // 工具搜索注册表
```

**`forceCompact()`** — 手动触发上下文压缩, 分两步:
1. 删除 assistant-text-only 轮次 (非工具调用轮)
2. LLM 驱动摘要生成

#### turn-loop.ts — TurnLoop 状态机

**单轮循环 7 阶段**:

```
[pre_check] → [model_call] → [post_check] → [tool_exec] → [context_mgmt]
     ▲                                                          │
     └────────── [hook_notify: on_turn_end] ◄───────────────────┘
```

**关键保护机制**:

| 机制 | 位置 | 说明 |
|------|------|------|
| 渐进式 nudge | L75-88 | 剩 2 轮 → "请开始总结"; 最后一轮 → 强制只输出文本 |
| 反循环保护 | L92-102 | 连续 8 轮只调工具不输出文本 → 注入停止指令 |
| Streaming fallback | L362-412 | streaming 失败 → 发 tombstone → 降为非流式 |
| max_tokens 续写 | L157-184 | 响应截断 → 自动 continuation 请求 (最多 3 次) |
| Context 溢出恢复 | L116-143 | ContextLimitError → 丢弃旧轮次 → 重试 3 次 |
| 孤儿 tool_use 修补 | L477-513 | API 调用失败 → 为没得到结果的 tool_use 注入合成错误 |
| Tool 并发优化 | streaming-tool-queue.ts | 读工具并发并行, 写工具排队串行 |
| 流式 tool_use_start | L363-369 | streaming 阶段就 emit 工具开始事件 |

#### model-facade.ts — ModelFacade

封装 LLM 客户端, **自动记录**每次调用的:
- `usage` (promptTokens, completionTokens, cache 信息)
- `latency` (API 调用耗时)
- `response` (完整响应内容, 含 DeepSeek V4 的 `reasoning_content`)

DeepSeek V4 思考模式特殊处理: API 要求下一轮 call 必须携带之前的 `reasoning_content`, ModelFacade 自动处理此要求。

#### streaming-tool-queue.ts — StreamingToolQueue

**流式工具执行策略**:

| 工具分类 | 并发策略 | 示例 |
|----------|----------|------|
| Concurrency-safe | streaming 阶段就执行, 多路并发 | Read, Glob, Grep, WebSearch, WebFetch, LSP |
| Unsafe | 排队串行, 但可与 safe 组同时启动 | Write, Edit, Bash, ApplyPatch, Task, NotebookEdit |

#### token-budget.ts — TokenBudget

递减回报检测:

```
continue → nudge ("请总结") → stop
            ↑
     连续 3+ 次续写 + 增量 < 500 tokens → 自动停止
```

#### query.ts — Query (AsyncGenerator API)

```typescript
for await (const event of query({
  task: "写一个排序函数",
  llm: config,
  tools: registry,
})) {
  // event.text, event.toolStart, event.toolResult, event.error ...
}
```

独立的 AsyncGenerator 高层 API, 外部可直接消费流式事件。**注意**: Engine 当前未使用此入口, 存在两套并行 API (Engine.run → TurnLoop vs query)。

---

### 2.2 Tool System — 工具系统

**位置**: `src/tool-system/` (32 文件, ~3,000+ 行)

#### 核心模块 (5 文件)

| 文件 | 职责 |
|------|------|
| `registry.ts` | 中央工具注册表, 按名称 key 存储 `ToolDefinition` |
| `executor.ts` | 薄中介层: 查找 → 权限检查 → 验证 → 派发 |
| `permission.ts` | 粗粒度 allow/deny/ask 决策树, 支持 preset 快捷方式 |
| `validation.ts` | 浅层 JSON Schema 验证 (required fields + type/enum) |
| `mcp-manager.ts` | MCP 服务器生命周期管理, 懒加载工具 schema |

**工具执行链路**:

```
ToolExecutor.execute(toolName, args)
  ├─ ToolRegistry.get(toolName)       ← 查找工具定义
  ├─ Permission.shouldAllow(...)      ← 权限检查
  │   ├─ deny    → PermissionDeniedError
  │   └─ ask     → prompt user → allow/deny
  ├─ Validator.validate(args, schema) ← 参数校验
  └─ executor(toolCall)               ← 实际执行
```

**权限决策树** (permission.ts):

```
permissionMode: "acceptEdits" → Write + Edit 自动允许
permissionMode: "bypassPermissions" → Bash 也自动允许
default: 安全工具自动允许, 写操作需要确认
```

#### 内置工具清单 (28 个)

**文件 I/O**:
- `read.ts` — 按行号/偏移量读取文件, 默认 2000 行
- `write.ts` — 写入文件, 自动创建父目录
- `edit.ts` — 精确字符串替换 (需 old_string 唯一匹配)
- `apply-patch/` — 原子化多文件 V4A patch (新增 feat, 含 parser + applier + types)

**Shell**:
- `bash.ts` — 执行 shell 命令, 含超时控制
- `powershell.ts` — PowerShell 命令执行

**搜索与发现**:
- `glob.ts` — 文件模式匹配 (支持 `**/*.ts`)
- `grep.ts` — 正则搜索, 支持 context/max_results/glob 过滤
- `tool-search.ts` — 搜索可用工具 (含 MCP 远程工具)

**Web**:
- `web-search.ts` — 网页搜索, 返回 title/url/snippet
- `web-fetch.ts` — 获取网页文本, 剥离 HTML

**Agent 协调**:
- `agent.ts` — 启动子代理 (支持后台运行)
- `agent-registry.ts` — 子代理状态查询
- `send-message.ts` — 代理间消息传递
- `remote-trigger.ts` — 触发远程代理执行

**任务与计划跟踪**:
- `task.ts` — 多步骤任务创建/更新/停止
- `plan.ts` — 计划模式进入/退出

**用户交互**:
- `ask-user.ts` — 向用户提问并等待回答
- `brief.ts` — 向用户发送结构化状态摘要

**开发工具**:
- `lsp.ts` — LSP 智能操作 (goToDefinition, findReferences, hover, getDiagnostics, getSymbols)
- `notebook-edit.ts` — Jupyter Notebook 编辑 (read/insert/replace/delete cells)
- `repl.ts` — 在线 REPL 执行 (JS/TS/Python/Ruby)

**系统与配置**:
- `config.ts` — 读取/修改 settings.json
- `cron.ts` — 创建/删除/列出定时任务
- `sleep.ts` — 休眠指定秒数 (最多 300s)
- `worktree.ts` — Git worktree 隔离操作
- `skill.ts` — 调用内置技能
- `mcp-tools.ts` — 通用 MCP 工具调用器
- `file-cache.ts` — 文件缓存管理

#### 关键约定

**`__args` 上下文注入**: 每个工具定义的 `execute` 函数签名外挂 `__args` 参数, 包含:
- `context` — 当前 session 上下文
- `hooks` — 生命周期钩子注册表
- `settings` — 用户设置
- 其他运行时元数据

**错误处理约定**: 所有工具执行错误统一包装为 `ToolExecutionError`, 携带 `toolName` 和原始错误信息, 不会中断整个 turn loop。

---

### 2.3 Arena — 多模型协作分析

**位置**: `src/arena/` (~50 文件, ~4,000+ 行)

Arena 是 evidence-driven 的多模型协作引擎。支持 3 种模式: review, discussion, planning。

#### 核心架构

```
用户 Topic (自然语言)
        │
        ▼
  detect-mode.ts        ← 自动检测模式 (review/discussion/planning)
        │
        ▼
  planner.ts            ← 单一 LLM 调用, 规划参与者 + 证据 + 策略
        │
  ┌─────┼─────┐
  │     │     │
  ▼     ▼     ▼
Strategy × Lens × Evidence Providers
  │
  ▼
  phases/participant-research.ts   ← 并行启动多模型研究
  │
  ▼
  phases/cross-review.ts           ← 参与者互相审查
  │
  ▼
  claim-registry.ts                ← 注册 + 追踪声明生命周期
  │
  ▼
  ┌──────────┼──────────┐
  ▼          ▼          ▼
review     discussion   planning
  │          │           │
  ▼          ▼           ▼
  └──────────┼──────────┘
             ▼
  phases/adjudication.ts           ← 裁判裁决
             ▼
  phases/build-consensus.ts        ← 构建共识 (由 concluder 模型)
             ▼
  render/session.ts                ← session 格式输出
  render/terminal.ts               ← 终端 ANSI 输出
```

#### 声明的生命周期

```
FINDING → PROPOSED → UNDER_REVIEW → CONTESTED → VERIFIED
                           │
                           ▼
                       DEBATE → ADJUDICATED (upheld/overturned)
                           │
                           ▼
                       DISMISSED (not relevant)
```

#### 策略 (Strategies, `src/arena/strategies/`)

| 策略 | 用于 | 关键不同 |
|------|------|----------|
| `review.ts` | 代码/文档审查 | 结构化的 finding → claim → verdict 流程, 交叉审查 |
| `discussion.ts` | 开放式讨论 | 自由辩论, 多轮反驳, 共同发现 |
| `planning.ts` | 路线图规划 | 分层展开: 愿景 → 目标 → 里程碑 → 任务, 依赖分析 |

**策略接口层次**:

```
ArenaStrategy (基础)
  └─ ArenaStrategyV2 (增强: 证据收集 + 声明注册)
      └─ ArenaStrategyPlanning (特化: 分层规划)
```

#### 分析视角 (Lenses, `src/arena/lenses/`)

| Lens | focus_prompt 关键点 |
|------|---------------------|
| `general.ts` | 通用视角, 无特定偏见 |
| `architecture.ts` | 模块耦合, 接口设计, 扩展性, 技术债务 |
| `engineering.ts` | 代码质量, 测试, 性能, 安全性 |
| `product.ts` | 用户体验, 功能完整性, 业务价值 |

Lens 通过 `lens-wrapper.ts` 与 Strategy 组合, 注入特定的分析视角。

#### 证据提供者 (Providers, `src/arena/providers/`)

| Provider | 收集什么 |
|----------|----------|
| `repo.ts` | 文件列表, package.json, tsconfig, workspace 信息 |
| `git.ts` | git log, git diff, git status, commit 元数据 |
| `docs.ts` | CODESHELL.md, CLAUDE.md, README, 其他文档 |
| `none.ts` | 空提供者 (纯讨论场景无需代码证据) |

#### 渲染层 (render/)

| 文件 | 输出格式 |
|------|----------|
| `terminal.ts` | ANSI 格式化输出 (Box 框, 彩色标注, 折叠) |
| `session.ts` | 结构化 JSON/文本, 适合写入 transcript |

#### 关键设计决策

1. **证据优先** — 模型先被要求"读代码/查 git"再发表意见 (防幻觉)
2. **Append-only ledger** — 所有声明不可修改, 新声明追加, 旧声明 refute/support
3. **Digest 控制 token** — 不传完整代码内容, 传递 digest 摘要供模型参考
4. **并行研究, 串行辩论** — 参与者在研究阶段并行, 在 debate 阶段串行 (读对方意见后再反驳)
5. **单一 LLM 调用的 Planner** — 一次 API 调用决定整个 Arena 会话的参与者、证据、策略
6. **优雅降级** — 部分模型不可用 → 跳过, 证据收集失败 → 标记 missing, 超时 → 截断

---

### 2.4 Product — 产品定义系统

**位置**: `src/product/` (3 文件)

| 文件 | 职责 |
|------|------|
| `define.ts` | `defineProduct()` 主函数, 组装 Preset + Adapter + Contract |
| `types.ts` | `ProductDefinition`, `ProductPreset`, `ProductAdapter`, `QualityContract` |
| `index.ts` | 桶文件, re-export |

**概念**: Product 是将通用 Agent 框架适配到具体业务场景的"产品化"入口。

```
defineProduct({
  name: "prismo-coding-agent",
  preset: "terminal-coding",        // 大脑 (系统提示词 + 工具集)
  adapter: {                         // 手 (自定义工具 + 行为)
    customTools: [...],
    customHooks: [...],
    promptPrefix: "You are Prismo, an expert TypeScript developer...",
  },
  contract: {                        // 质量契约 (约束 + 评估)
    constraints: ["No destructive git operations without confirmation"],
    evaluator: async (run) => { ... },
  },
})

// → 返回配置好的 RunManager, 直接可用
```

**Prismo 示例** (`examples/prismo-agent/`): 通过 Product 系统将一个通用 coding agent 包装为 Prismo 风格的专用 agent。

---

### 2.5 CLI — 命令行入口

**位置**: `src/cli/` (20+ 文件)

#### 主要入口

| 文件 | 职责 |
|------|------|
| `main.ts` | CLI 根入口 (用 Commander), 注册 subcommands: `run`, `repl`, `arena` |
| `onboarding.ts` | 首次运行配置向导 (箭头键选择, 7 个 provider, 环境变量检测) |
| `cost-tracker.ts` | 单例 `costTracker`, 记录每次 API 调用的 token + cost |
| `input-compiler.ts` | 输入预处理: slash command / @file / model override 解析 |
| `exit.ts` | SIGINT/SIGTERM 优雅退出 |
| `updater.ts` | npm 版本更新检查 |

#### 命令系统

| 文件 | 职责 |
|------|------|
| `commands/registry.ts` | `CommandRegistry` 类: 注册/解析/分发 slash 命令 |
| `commands/run.ts` | `runCommand()`: 无头单次执行, --output text/json/jsonl/stream-json |
| `commands/repl.ts` | `replCommand()`: 启动 Ink 交互 UI (`render(<App>)`) |
| `commands/arena.ts` | `runArenaReview()`: Arena 多模型审查入口 |

**Slash 命令 (19 个)**: `/exit`, `/clear`, `/cost`, `/tasks`, `/model`, `/session`, `/sessions`, `/tools`, `/memory`, `/fork`, `/compact`, `/arena`, `/resume`, `/diff`, `/status`, `/version`, `/export`, `/config`, `/init`, `/doctor`, `/help`

#### 输出渲染

| 文件 | 职责 |
|------|------|
| `output/renderer.ts` | `TextRenderer`, `JsonRenderer`, `JsonlRenderer`, `StreamJsonRenderer`; `createRenderer(format)` 工厂 |
| `output/terminal-ui.ts` | Markdown → ANSI 渲染 (marked + marked-terminal); 代码高亮; Spinner |

---

### 2.6 UI — Ink/React 终端组件

**位置**: `src/ui/` (30+ 文件)

**核心技术**: Ink (React for CLI)。组件使用 `.tsx`, React 渲染到终端。

#### 主要组件

| 组件 | 文件 | 职责 |
|------|------|------|
| App | `App.tsx` | 根组件: 20+ state 管理, 事件流订阅, 命令分发, 布局编排 |
| MessageContent | `components/MessageContent.tsx` | Markdown/Table 混合渲染, LRU token cache, streaming 显示 |
| ToolCall | `components/ToolCall.tsx` | 工具调用可视块: ● 开始 → ⠹ 运行 → ✓ 结果 + 输出折叠 |
| PermissionPrompt | `components/PermissionPrompt.tsx` | [y]Allow [n]Deny [a]Always [d]Always deny 内联对话框 |
| TaskList | `components/TaskList.tsx` | ✓ completed / ⠹ in_progress / ✗ stopped / ○ pending |
| StatusLine | `components/StatusLine.tsx` | 底部状态栏: 运行时间/令牌数/模型/上下文/费用/分支 |
| CommandInput | `components/CommandInput.tsx` | 文本输入 + `/` 触发自动补全 + ↑↓ 历史导航 |
| AskUserPrompt (new) | `components/AskUserPrompt.tsx` | AskUserQuestion 工具的交互界面 |
| ModelSelector (new) | `components/ModelSelector.tsx` | `/model` 命令的模型选择器 |
| OnboardingPrompt (new) | `components/OnboardingPrompt.tsx` | 首次运行的配置向导组件 |

#### 状态管理

| 文件 | 职责 |
|------|------|
| `store.ts` | `chatStore` 单例 — 外部可变状态存储, 避免 React re-render; 支持 `subscribe()` → `useSyncExternalStore` |
| `input-history.ts` | JSONL 持久化命令历史, ↑↓ 导航, 去重 |
| `vim-mode.ts` | Vim 键绑定层: normal/insert/visual/command 四模式 |

#### 终端渲染

| 文件 | 职责 |
|------|------|
| `terminal-renderer.ts` | 双缓冲逐行 diff 渲染器 (CSI escape sequences), DEC 2026 sync, 终端检测 |
| `theme.ts` | 集中式颜色调色板 |

---

### 2.7 LLM — 大语言模型适配层

**位置**: `src/llm/` (7 文件)

#### 架构

```
createLLMClient(config)  ← 工厂函数
  │
  ├─ PROVIDER_REGISTRY.openai   → OpenAIClient
  │     └─ OpenAI Python SDK (chat.completions.create)
  └─ PROVIDER_REGISTRY.anthropic → AnthropicClient
        └─ Anthropic TypeScript SDK (messages.stream/create)
```

#### 文件清单

| 文件 | 职责 |
|------|------|
| `client-base.ts` | `LLMClientBase` 抽象类: 重试 (指数退避), usage 追踪, 错误分类 |
| `client-factory.ts` | `registerProvider()` + `createLLMClient()` → 懒导入 & 动态注册 |
| `model-pool.ts` | `ModelPool` 类: 运行时模型列表, hot-swap, LLMConfig 解析 |
| `types.ts` | `CreateMessageOptions`, `LLMUsageTracker` |
| `providers/openai.ts` | `OpenAIClient`: Streaming SSE → text/tool_calls/reasoning; DeepSeek V4 思考模式 |

**重试策略** (client-base.ts):
- 指数退避 (base × 2^n)
- ContextLimitError: 特殊处理 (丢弃旧轮次后重试, 最多 3 次)
- LLMRateLimitError: 等待 Retry-After header
- 其他错误: 标准退避, 最多 `retryMaxAttempts` 次

**DeepSeek V4 思考模式**:
- `reasoning_content` 需要在模型内部传递, 不能发送给用户
- ModelFacade 在下一轮 API 调用时必须包含之前的 reasoning_content
- 流式和非流式模式都需处理

---

### 2.8 Preset — Agent 预设系统

**位置**: `src/preset/index.ts` (~150 行)

**当前预设**:

| Preset | 工具数 | 追加工具 | 特点 |
|--------|--------|----------|------|
| `general` | 35 | — | 领域无关编排, 安全工具 allow-list |
| `terminal-coding` | 41 | EnterWorktree, ExitWorktree, NotebookEdit, LSP, Brief, Arena | git 状态注入, coding prompt sections |

**函数**:
- `resolveAgentPreset(name)` → `AgentPreset`
- `buildPresetSystemPrompt(preset)` → 组装系统提示词 (加载 sections)
- `resolveBuiltinToolNames(preset)` → 内置工具名列表
- `registerPreset(name, preset)` → 注册自定义预设
- `listPresetNames()` → 列出所有可用预设名

**扩展方式**: 外部 repo 可通过 `registerPreset()` 注册自定义预设, 组合内置工具 + 自定义工具 + 自定义提示词。

---

### 2.9 Session — 会话与记忆

**位置**: `src/session/` (4 文件)

| 文件 | 职责 |
|------|------|
| `session-manager.ts` | `SessionManager`: CRUD 管理具名会话, 协调 transcript/memory/file-history |
| `memory.ts` | 持久记忆 CRUD (`saveMemory/loadMemories/deleteMemory`), 4 种类型: user/feedback/project/reference |
| `file-history.ts` | `FileHistoryTracker`: 追踪工具操作的文件变更 (path, action, timestamp, lines) |
| `transcript.ts` | `SessionTranscript`: Append-only 结构化对话日志 (JSON 格式) |

**记忆类型**:
- `user` — 用户偏好、习惯
- `feedback` — 用户反馈
- `project` — 项目笔记
- `reference` — 参考信息

**存储路径**: `~/.code-shell/` 下
- `sessions/<id>/transcript.json`
- `memories.json`

---

### 2.10 Protocol — 远程通信协议

**位置**: `src/protocol/` (5 文件, ~500 行)

JSON-RPC 风格 NDJSON 协议, 支持 agent-to-agent 通信和 client/serve 模式。

| 文件 | 职责 |
|------|------|
| `types.ts` | `ProtocolMessage`, `RequestMessage`, `ResponseMessage`, `StreamEvent`, `ProtocolCapabilities` |
| `client.ts` | `ProtocolClient`: 客户端 NDJSON 通信, pending-request map, stream 订阅 |
| `server.ts` | `ProtocolServer`: 服务端, 路由请求到处理函数, 事件订阅管理 |
| `transport.ts` | `createStdioTransport()`, `createSSHTransport()`: 传输层抽象 |
| `index.ts` | Re-export 桶 |

**消息流向**:

```
Agent A (client) ←─ NDJSON ─→ ProtocolServer ─→ Agent B (server)
     │                              │
     ├─ request →                    → handler
     ├─ response ←                   ← result
     └─ subscribe →                  → notify
```

**用途**: 
- `SendMessage` 工具 → client 发送消息
- `Agent` 子代理 → 通过 protocol client 通信
- `remote/bridge.ts` → SSH 远程连接

---

### 2.11 Context — 上下文管理

**位置**: `src/context/` (3 文件, ~850 行)

| 文件 | 职责 |
|------|------|
| `manager.ts` (311 行) | `ContextManager` 类: 三层压缩 (microcompact → LLM summary → window snip), hybrid token 估算, 工具去重 |
| `compaction.ts` (420 行) | 所有压缩策略实现: `adjustIndexToPreserveAPIInvariants` (关键的工具配对保护), snip, window, microcompact, LLM summary, `dropOldestRounds` |
| `token-counter.ts` (117 行) | 内容感知启发式 token 估算 (英文/代码/JSON/CJK 不同 ratio) |

**三层压缩策略**:

```
正常 → microcompact (删除冗余工具结果)
     → LLM summary (用便宜模型生成摘要)
     → window/snip compact (硬截断, 保留系统提示词 + 最近 N 轮)
```

**关键安全机制** (`adjustIndexToPreserveAPIInvariants`):
- 某些 LLM API 要求 tool_use 和 tool_result 成对出现
- 压缩时不能单独删除其中一个
- 此函数确保删除边界不会破坏这个不变量

**Token 估算 heuristic**:
- 英文: ~4 chars/token
- 代码: ~3 chars/token
- JSON: ~2.5 chars/token
- CJK: ~1.5 chars/token
- 用实际 API 返回的 `usage.promptTokens` 校准

---

### 2.12 Prompt — 提示词组装

**位置**: `src/prompt/` (3 文件)

| 文件 | 职责 |
|------|------|
| `composer.ts` | `composeSystemPrompt()`: 组装最终系统提示词 (preset + 发现文件 + 技能 + 记忆) |
| `instruction-scanner.ts` | `scanInstructions()`: 从工作目录向上扫描 `CODESHELL.md`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules` 等 |
| `section-loader.ts` | `loadSections()`: 读取指令文件, 解析 ## section, 缓存感知重载 |

**指令文件扫描层级**:

```
/project/
  ├── CODESHELL.md        ← project root (加载)
  ├── src/
  │   └── CODESHELL.md    ← nested (可选加载)
  └── CLAUDE.md           ← legacy (兼容加载)
```

**Prompt 组装顺序**:
1. Preset 基础 system prompt
2. 发现的指令文件 (CODESHELL.md 等)
3. 记忆文件
4. 技能定义
5. 工具列表 (LLM-compat 格式)
6. Git 上下文注入

---

### 2.13 Run — 运行编排

**位置**: `src/run/` (11 文件)

这是比 Engine 更高一层的编排层，管理多 run 生命周期。

| 文件 | 职责 |
|------|------|
| `RunManager.ts` | 管理多个并发 run, 状态跟踪: idle/running/waiting_for_approval/compacting/interrupted |
| `EngineRunner.ts` | 顶层编排器: user input → LLM call → tool exec → response, 协调所有子系统 |
| `RunApprovalBackend.ts` | 权限审批 UI 流程, 超时默认拒绝 |
| `ArtifactTracker.ts` | 追踪 run 中产生的产出物 (文件/补丁/输出) |
| `CheckpointWriter.ts` | 崩溃恢复检查点 (原子写: write-temp-then-rename) |
| `RunLock.ts` | Run 互斥锁 (防止并发修改) |
| `RunQueue.ts` | Run 任务队列 (顺序执行) |
| `RunStore.ts` / `FileRunStore.ts` | Run 持久化接口 + 文件实现 |
| `factory.ts` | `createRunManager()`: 依赖注入工厂 |
| `types.ts` | 类型定义 |
| `Evaluator.ts` | 质量评估器接口 |
| `Heartbeat.ts` | 心跳检测 |

**Run 状态机**:

```
idle → running → waiting_for_approval → running
                  → compacting → running
                  → interrupted → idle / running (resume)
                  → completed → idle
                  → failed → idle
```

---

### 2.14 Services — 辅助服务

**位置**: `src/services/` (8 文件)

| 文件 | 职责 |
|------|------|
| `session-memory.ts` | 会话内存 CRUD, session 列表/删除 |
| `diagnostics.ts` | 系统健康检查: Node 版本, 磁盘, 网络, API key 有效性, Git 脏状态 |
| `compact.ts` | LLM 驱动的对话压缩 (用便宜模型生成结构化摘要) |
| `extract-memories.ts` | LLM 驱动的内存提取: 从 transcript 提取持久偏好/反馈/项目笔记 |
| `analytics.ts` | 分析事件发送 |
| `auto-dream.ts` | 自动 "梦" (离线推理) |
| `notifier.ts` | 通知服务 |
| `oauth.ts` | OAuth 认证 |
| `index.ts` | 桶文件 |

---

### 2.15 Agent — 多代理协调

**位置**: `src/agent/` (1 文件)

| 文件 | 职责 |
|------|------|
| `coordinator.ts` | `AgentCoordinator` 单例: 代理注册/销毁, 消息 inbox/outbox, 生命周期跟踪 |

**API**:
```typescript
agentCoordinator.register(name, metadata)  // 注册子代理
agentCoordinator.send(to, msg)             // 发送消息 → outbox
agentCoordinator.receive(name)             // 读取 inbox (drain)
agentCoordinator.peek(name)                // 读取 inbox (不 drain)
agentCoordinator.complete(name)            // 标记完成
agentCoordinator.fail(name, error)         // 标记失败
agentCoordinator.getStatus(name)           // 查询状态
```

**用途**: `Agent` 工具 + `SendMessage` 工具 + Arena 工具 都通过此协调器管理子代理通信。

---

### 2.16 Bootstrap — 启动引导

**位置**: `src/bootstrap/` (2 文件)

| 文件 | 职责 |
|------|------|
| `setup.ts` | `setup()`: 飞行前检查 (Node ≥ 18, cwd 存在, no root-with-bypass), chdir, git 检测, 后台初始化 |
| `state.ts` | ~90 个 getter/setter: 全局状态管理 (session/model/token/line/duration/feature-flags/plan/skills/hooks/auth) |

**`state.ts` 是全局状态中枢**, 被几乎所有模块引用。分类:
- **Session**: `getSessionId()`, `switchSession()`, `getOriginalCwd()`, `getProjectRoot()`
- **Model**: `getMainLoopModelOverride()`, `setInitialMainLoopModel()`, `getModelStrings()`
- **Token/Cost**: `getTotalInputTokens()`, `addOutputTokens()`, `getModelUsage()`, `addAPIDuration()`
- **Line Changes**: `addLinesChanged()`, `getLinesAdded()`, `getLinesRemoved()`
- **Turn Duration**: `addTurnHookDuration()`, `addTurnToolDuration()`
- **Feature Flags**: `getIsRemoteMode()`, `getScheduledTasksEnabled()`, `getSdkBetas()`
- **Plan Mode**: `getHasExitedPlanMode()`, `setNeedsPlanModeExitAttachment()`
- **System Prompt**: `getSystemPromptSectionCache()`, `setSystemPromptSectionCacheEntry()`

---

### 2.17 Hooks — 生命周期钩子

**位置**: `src/hooks/` (2 文件)

| 文件 | 职责 |
|------|------|
| `events.ts` | 16 个钩子事件名定义, `HookResult` 类型 (支持 stop/mutation/injection/decision) |
| `registry.ts` | `HookRegistry` 类: priority-ordered handler chain, chain-of-responsibility 执行 |

**当前已触发的 16 个事件**:

```
on_agent_start       → Engine 启动
on_agent_end         → Engine 结束
on_turn_start        → 每轮开始
on_turn_end          → 每轮结束 (含统计信息)
pre_tool_use         → 工具执行前 (可阻止)
post_tool_use        → 工具执行后 (可修改结果)
on_tool_start        → 工具开始
on_tool_end          → 工具结束
file_changed         → 文件被修改
on_permission_check  → 权限检查时
on_session_start     → 会话开始
on_session_end       → 会话结束
user_prompt_submit   → 用户提交消息
pre_compact          → 压缩前
post_compact         → 压缩后
notification         → 通知事件
```

**HookResult 可以做的 4 件事**:
1. `stop` — 中断链
2. `decision` — 返回 allow/deny/ask 权限决定
3. `messages` — 注入消息到 dialog
4. `data` — 修改当前数据

**错误隔离**: 每个 handler 在独立 try/catch 中执行, 一个 handler 失败不影响其他。

---

### 2.18 其他辅助模块

| 模块 | 位置 | 职责 |
|------|------|------|
| **LSP** | `src/lsp/` | LSP 客户端 + 服务器管理器 |
| **Plugins** | `src/plugins/` | 插件加载器 + 类型定义 |
| **Skills** | `src/skills/` | 技能系统 (matcher + scanner + index) |
| **Git** | `src/git/` | `utils.ts` (git 操作), `worktree.ts` (隔离 worktree) |
| **Voice** | `src/voice/` | 语音输入 (仅 index.ts 存在) |
| **Cron** | `src/cron/` | 定时任务调度器 |
| **Remote** | `src/remote/` | SSH 远程桥接 |
| **Settings** | `src/settings/` | 配置管理 (manager + schema) |
| **Logging** | `src/logging/` | 日志基础设施 |
| **Ink** | `src/ink/` | Ink React 渲染器 (60+ 文件, 内部 fork) |
| **Native** | `src/native-ts/` | Yoga Layout 引擎 (Layout 计算) |
| **Utils** | `src/utils/` | 工具函数 (debug, format, truncate, env, lockfile 等) |

---

## 3. 完整模块互连图

```
CLI (cli/main.ts)
  │
  ├── bootstrap/setup.ts ← 环境验证 + chdir + git 检测
  │     └── bootstrap/state.ts ← 全局状态初始化
  │
  ├── onboarding.ts ← 首次配置 ← ~/.code-shell/settings.json
  │
  ├── run/factory.ts ← createRunManager()
  │     │
  │     ├── run/RunManager.ts ← 多 run 管理
  │     │     ├── run/RunApprovalBackend.ts ← 审批 UI
  │     │     ├── run/ArtifactTracker.ts ← 产出追踪
  │     │     ├── run/CheckpointWriter.ts ← 崩溃恢复
  │     │     ├── run/RunLock.ts ← 互斥锁
  │     │     └── run/RunQueue.ts ← 队列
  │     │
  │     └── run/EngineRunner.ts ← 每 run 的编排器
  │           │
  │           ├── prompt/composer.ts ← 系统提示词组装
  │           │     ├── prompt/instruction-scanner.ts ← 指令文件发现
  │           │     ├── prompt/section-loader.ts ← 加载 ## sections
  │           │     └── skills/index.ts ← 技能注入
  │           │
  │           ├── context/manager.ts ← 上下文窗口管理
  │           │     ├── context/compaction.ts ← 压缩策略
  │           │     │     └── services/compact.ts ← LLM 压缩
  │           │     └── context/token-counter.ts ← Token 估算
  │           │
  │           ├── engine/engine.ts ← Engine.run()
  │           │     ├── engine/turn-loop.ts ← 状态机
  │           │     │     ├── engine/model-facade.ts ← LLM 封装
  │           │     │     ├── engine/streaming-tool-queue.ts ← 工具并发
  │           │     │     └── engine/token-budget.ts ← 预算控制
  │           │     └── engine/cost-store.ts ← Cost 策略接口
  │           │
  │           ├── tool-system/executor.ts ← 工具执行
  │           │     ├── tool-system/registry.ts ← 工具注册
  │           │     ├── tool-system/permission.ts ← 权限决策
  │           │     ├── tool-system/validation.ts ← 参数校验
  │           │     └── tool-system/mcp-manager.ts ← MCP 管理
  │           │           └── tool-system/builtin/ (28 工具)
  │           │
  │           ├── hooks/registry.ts ← 生命周期钩子
  │           │     └── hooks/events.ts ← 事件类型
  │           │
  │           ├── session/transcript.ts ← 对话日志
  │           ├── session/file-history.ts ← 文件变更追踪
  │           ├── session/memory.ts ← 持久记忆
  │           │     └── services/extract-memories.ts ← 记忆提取
  │           │
  │           ├── agent/coordinator.ts ← 多代理消息总线
  │           │
  │           ├── protocol/client.ts ← NDJSON 客户端
  │           └── protocol/server.ts ← NDJSON 服务端
  │
  ├── commands/run.ts ← headless mode
  │     └── output/renderer.ts ← Text/Json/StreamJson 渲染
  │
  ├── commands/repl.ts ← Ink交互模式
  │     └── ui/App.tsx ← 根组件
  │           ├── ui/store.ts ← chatStore
  │           ├── ui/input-history.ts ← 命令历史
  │           ├── component/MessageContent.tsx
  │           ├── component/ToolCall.tsx
  │           ├── component/StatusLine.tsx
  │           ├── component/CommandInput.tsx
  │           ├── component/PermissionPrompt.tsx
  │           ├── component/TaskList.tsx
  │           ├── component/AskUserPrompt.tsx (new)
  │           ├── component/ModelSelector.tsx (new)
  │           └── component/OnboardingPrompt.tsx (new)
  │
  ├── commands/arena.ts ← runArenaReview()
  │     └── arena/arena.ts ← Arena 引擎
  │           ├── arena/strategies/
  │           ├── arena/lenses/
  │           ├── arena/providers/
  │           ├── arena/phases/
  │           └── arena/render/
  │
  └── cost-tracker.ts ← token/cost 单例

LLM Layer
  ├── llm/client-factory.ts → createLLMClient()
  ├── llm/client-base.ts → LLMClientBase (抽象类)
  ├── llm/model-pool.ts → ModelPool
  └── llm/providers/
        ├── openai.ts → OpenAIClient
        └── anthropic.ts → AnthropicClient

Public API: src/index.ts (桶文件, re-export 所有模块)
```

---

## 4. 设计决策与模式

### 4.1 全局状态 (`bootstrap/state.ts`)

采用模块级 getter/setter 模式而非 Context/Dependency Injection。约 90 个函数, 被几乎所有模块引用。

**优点**: 零依赖注入样板, 任何模块随时读/写状态
**缺点**: 隐式依赖, 难以测试 (需 mock), 难以并行使用 (单例假设)

### 4.2 两套入口并行 (Engine vs Query)

- `Engine.run()` → TurnLoop 直接运行 → 内部消费流式事件
- `query()` → AsyncGenerator 包装 TurnLoop → 外部消费流式事件

当前 Engine 未使用 `query()`, 两套 API 并存但 `query()` 使用较少。

### 4.3 证据优先 (Arena)

Arena 的核心设计原则: 模型在发表意见前必须先"读代码/查 git"。证据通过 Providers 收集, 不依赖模型训练时的记忆。

### 4.4 安全工具优先并发 (StreamingToolQueue)

工具分为 concurrency-safe (可并行) 和 unsafe (需串行)。safe 工具在 API streaming 阶段就开始执行, 不等完整响应返回。

### 4.5 多层错误恢复 (TurnLoop)

| 错误类型 | 恢复策略 |
|----------|----------|
| LLMRateLimitError | 等待 Retry-After → 重试 |
| ContextLimitError | 丢弃旧轮次 → 重试 (最多 3 次) |
| Streaming 失败 | 发 tombstone → 降为非流式 |
| max_tokens 截断 | Auto-continuation (最多 3 次, 递减回报检测) |
| 孤儿 tool_use | 注入合成错误 → 继续 |
| 反循环 | 连续 8 轮无文本 → 强制停止 |

### 4.6 Product 系统

外部消费者通过 `defineProduct()` 将通用框架包装为专用 Agent:
- Preset = "大脑" (系统提示词 + 工具集)
- Adapter = "手" (自定义工具 + 行为)
- Contract = "质量契约" (约束 + 评估)

### 4.7 Preset 系统

支持注册自定义预设, 可在运行时切换。每个 preset 定义:
- 系统提示词 sections
- 内置工具白名单
- 权限快捷方式 (哪些工具自动允许)
- 额外上下文 (如 git status)

---

## 5. 当前待改进点

### 5.1 Engine 隐式依赖注入

`setAskUserFn()`, `setArenaLLMConfig()`, `setSubAgentConfig()` 通过模块级全局变量注入, 不是通过构造函数。重构建议:
- 统一为 `EngineOptions` 构造函数参数
- 或引入 `ServiceContainer` 依赖注入容器

### 5.2 `query.ts` 与 Engine 的二义性

两套入口并存, 设计意图不清晰。建议:
- 明确 `query()` 是低级 API (给框架内部 consumer)
- `Engine.run()` 是高级 API (给 CLI/UI consumer)
- 或统一为单一入口

### 5.3 `TurnState` 利用不充分

`turn-state.ts` 定义了 `TurnState` 类型, 但在 turn loop 中 state 对象创建后被丢弃, phase 状态追踪形同虚设。建议:
- 将 state 传递到各阶段, 用于错误处理决策
- 记录 state 历史用于调试 (类似 transcript)

### 5.4 全局状态难以测试

`bootstrap/state.ts` 的 ~90 个 getter/setter 是模块级全局单例, 单元测试难以隔离。建议:
- 引入 `createState()` 工厂函数
- 或使用 `context` 对象传递代替全局

### 5.5 `registerCustomTool` 缺少生命周期保护

如果在 `run()` 之后调用 `registerCustomTool()`, 工具不会生效且静默失败。建议:
- 在 `run()` 后冻结注册表
- 或抛出明确的错误

### 5.6 测试覆盖率低

`tests/` 下仅有少量测试文件。核心路径缺乏回归覆盖:
- Engine turn loop (状态机 + 错误恢复)
- Permission 分类逻辑
- Arena 完整生命周期
- Protocol 消息序列化/反序列化
- Context compaction 正确性 (工具配对保护)

### 5.7 Arena 与 Engine 的边界

Arena 是可选的多模型协作层, 但与 Engine 的集成方式是通过 `setArenaLLMConfig()` 全局注入, 导致 Arena 与 Engine 循环依赖。建议:
- Arena 完全独立于 Engine (只需 LLM 客户端)
- 通过事件/回调与 Engine 通信
- 或作为工具的一部分 (当前 `builtin/arena.ts` 已经存在)

### 5.8 Product 系统未完成

`src/product/` 定义了框架, 但 `examples/prismo-agent/` 尚未完整实现。建议:
- 完成 Prismo Agent 示例作为 end-to-end 验证
- 明确 Product 系统与 RunManager 的集成边界

---

*文档结束 — 基于 2026-05-08 分支状态, 200+ 源文件分析*

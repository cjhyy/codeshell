# Claude Code CLI 架构深度解析

---

## 目录

1. [产品本质](#1-产品本质)
2. [顶层入口与运行模式](#2-顶层入口与运行模式)
3. [架构分层总览](#3-架构分层总览)
4. [Settings 配置系统](#4-settings-配置系统)
5. [Session 与 Transcript 持久化](#5-session-与-transcript-持久化)
6. [输入编译链](#6-输入编译链)
7. [主循环状态机 (Agent Loop)](#7-主循环状态机-agent-loop)
8. [Prompt 装配与 Context Layering](#8-prompt-装配与-context-layering)
9. [工具执行系统](#9-工具执行系统)
10. [权限系统](#10-权限系统)
11. [Hook 系统](#11-hook-系统)
12. [上下文压缩 (Compaction)](#12-上下文压缩-compaction)
13. [MCP 系统](#13-mcp-系统)
14. [Skills 系统](#14-skills-系统)
15. [Plugin 系统](#15-plugin-系统)
16. [Resume / Fork / Sidechain / Subagent](#16-resume--fork--sidechain--subagent)
17. [Plan 系统](#17-plan-系统)
18. [TUI 系统](#18-tui-系统)
19. [重写架构建议](#19-重写架构建议)

---

## 1. 产品本质

Claude Code CLI **不是一个问答聊天工具**，而是一个完整的 **Agentic Coding Shell**。

其核心能力包括：

- Commander 风格 CLI 程序 + React/Ink TUI
- Headless/SDK/JSON 流模式
- 会话持久化与还原（Resume / Fork / Sidechain）
- 工具执行与权限系统（内建工具 + MCP 外部工具）
- MCP server/client 管理
- 插件管理与 Marketplace
- Hook 生命周期系统
- Rules / Skills / Memory / Plan / File History
- 远端 transcript 同步与 bridge

### 与普通聊天 CLI 的根本区别

| 维度 | 普通聊天 CLI | Claude Code CLI |
|------|-------------|-----------------|
| 会话 | 单一消息数组 | 带 file-history、content-replacement、plan、attribution、queued commands 的"工作现场" |
| 工具 | 插件式附加物 | 主循环的一等公民 |
| Prompt | 固定字符串 | 多源、多层、带缓存的 system sections |
| 还原 | 还原聊天记录 | 还原"工作状态"（文件快照 + plan + 中断点） |
| 模式 | TUI 一种 | Headless 与 TUI 共享核心循环，只在 I/O 和审批交互上分叉 |

### 产品架构概览

```
CLI/TUI 外壳
  → 输入编译器
    → 多轮 Agent Loop（状态机）
      → 模型调用适配层
      → 工具执行器
      → Hook / Permission
      → Session / Transcript / Plan / FileHistory
```

---

## 2. 顶层入口与运行模式

### 启动分流

最外层入口 `jBz()` 不是直接进主 CLI，而是先做 fast-path 分流：

1. `--version`：直接输出版本并退出
2. `--claude-in-chrome-mcp`：启动 Chrome MCP server
3. `--chrome-native-host`：启动 Chrome native host
4. `--computer-use-mcp`：启动 computer-use MCP server
5. `remote-control | rc | remote | sync | bridge`：进入 remote bridge 路径
6. 否则：懒加载主 CLI 入口 `_Bz()`

### 主入口 `_Bz()`

负责：

- 信号处理（SIGINT、SIGTERM）
- deep-link 处理
- 非交互模式判定
- settings 预加载
- 进入 Commander 程序 `YBz()`

### 运行模式

| 模式 | 触发方式 | 特征 |
|------|---------|------|
| **TUI/REPL** | 默认交互模式 | React/Ink 渲染、readline 输入、审批对话框 |
| **Headless** | `--print`、`--output-format json/stream-json` | JSON/JSONL/stream-json 输出，无 TUI |
| **SDK** | `--sdk-url` | 通过 URL 对接外部 SDK |
| **Bridge** | `remote-control`、`--remote` | 远程控制/远端 transport |
| **MCP Server** | 各种 `--*-mcp` flag | 作为 MCP server 运行 |

**Headless 与 TUI 共享核心循环**，只在 I/O 形态、前台 UI 和审批交互上分叉。

### Commander 命令树

顶层命令至少包括：

- 默认（无子命令）：进入 REPL/headless
- `mcp`：MCP server 管理（serve/add/list/remove 等）
- `plugin`：插件管理（install/uninstall/enable/disable 等）
- `config`：配置管理
- 更多子命令...

---

## 3. 架构分层总览

基于 HitCC 文档还原的 9 层职责边界：

```
┌─────────────────────────────────────────────┐
│  1. CLI 层 — 入口分流、命令树、模式选择      │
├─────────────────────────────────────────────┤
│  2. Settings 层 — 多源配置、合并、缓存、回写  │
├─────────────────────────────────────────────┤
│  3. Engine 层 — Turn Loop 状态机、模型调用    │
├─────────────────────────────────────────────┤
│  4. Session 层 — Transcript、Resume/Fork     │
├─────────────────────────────────────────────┤
│  5. Prompt 层 — Discovery、Compose、Cache    │
├─────────────────────────────────────────────┤
│  6. Tool 层 — Registry、Executor、Permission │
├─────────────────────────────────────────────┤
│  7. Hook 层 — 生命周期事件、Chain-of-Resp    │
├─────────────────────────────────────────────┤
│  8. 生态层 — MCP/Plugin/Skills/Agent Team    │
├─────────────────────────────────────────────┤
│  9. UI 层 — TUI/Dialog/Renderer/Approval     │
└─────────────────────────────────────────────┘
```

---

## 4. Settings 配置系统

### 5 层配置来源

按优先级从高到低：

| 来源 | 路径 | 可写回 | 说明 |
|------|------|--------|------|
| **flag** | CLI flags / runtime inject | 否 | `--model`、`--permission-mode` 等 |
| **local** | `.claude/settings.local.json` | 是 | 当前项目本地，不入版本控制 |
| **project** | `.claude/settings.json` | 是 | 项目级，入版本控制 |
| **user** | `~/.claude/settings.json` | 是 | 用户级 |
| **policy/managed** | `~/.claude/settings.managed.json` + 企业策略 | 否 | 组织级，managed 策略 |

### 合并策略

```
effective = deepMerge(policy, user, project, local, flag)
```

- 对象：深合并
- 数组：替换（非 concat），去重
- `null` 值：删除该 key
- flag 总是最高优先级

### 企业 Managed Policy

`allowManagedPermissionRulesOnly` 开启时，会把 user/project/local/CLI/session 的 permission allow/deny/ask 规则全部清空，只保留 managed policy 的规则。

### 缓存与热刷新

- 两级缓存：settings cache + plugin overlay cache
- 文件 watcher 监听 settings 文件变更
- `BX()` 做缓存失效
- MDM/registry 轮询（macOS/Windows 平台管理配置）
- 回写只支持 user/project/local 三层

### Settings Schema 主要分组

- **auth**：API key、OAuth token
- **runtime/env**：shell、cwd、环境变量
- **persistence**：session 存储路径
- **model**：provider、model name、temperature、max_tokens
- **permissions/sandbox**：permission mode、allow/deny rules、sandbox 配置
- **hooks/MCP/plugins**：hook 定义、MCP server 配置、plugin 启停
- **remote/channels/ssh**：远端控制、channel 绑定
- **UI/UX**：theme、diff 显示、voice

---

## 5. Session 与 Transcript 持久化

### 核心概念：Transcript 是事件日志，不是聊天记录

Transcript 包含的事件类型远超普通 message：

- **message**：user / assistant / system 消息
- **tool_use / tool_result**：工具调用与结果
- **summary**：上下文压缩摘要
- **content_replacement**：内容替换（旧内容 → 摘要/指针）
- **file_history**：文件状态快照
- **plan_operation**：plan 创建/更新/完成
- **mode / queue_operation**：模式切换、队列操作
- **title / task_summary**：会话标题、任务摘要

### JSONL 持久化

- 使用 JSONL 格式（每行一个 JSON 事件）
- 批量刷盘（`iC4` writer kernel）
- 延迟物化（lazy materialization）：某些大体积内容直到真正需要时才展开

### Session State Store

全局 app state 与 per-session state 的混合存储：

```typescript
interface SessionState {
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  turnCount: number;
  invokedSkills: Map<string, SkillState>;
  promptCacheHits: number;
  additionalDirectoriesForClaudeMd: string[];
  systemPromptSectionCache: Map<string, string>;
  parentSessionId?: string;  // fork/sidechain
  status: "active" | "paused" | "completed" | "errored";
}
```

### Resume 还原

Resume 还原的不仅是消息历史，而是完整的"工作状态"：

1. 还原 transcript（所有事件）
2. 还原 plan 文件状态
3. 还原 file-history backups（文件快照）
4. 处理 interrupted turn（中断轮补偿）
5. 还原 invoked skills
6. 修复 tool_result 配对（orphaned/duplicate 修复）

### Fork

Fork 创建一个新 session，从源 session 的某个时间点分叉：

- 新 sessionId，独立 transcript
- 共享源 session 的前缀事件
- 之后的变更独立发展

---

## 6. 输入编译链

用户的原始输入不是直接送给模型，而是经过一条完整的编译链：

```
原始输入
  → ihz()   预处理（图片、附件、slash command、本地命令分流）
  → BU4()   普通输入消息构造（包装成 user message）
  → AU8()   编译器入口（合成最终 messages + options）
```

### 编译产物

```typescript
interface CompiledInput {
  messages: Message[];           // 编译后的消息
  options: {
    slashCommand?: string;       // 检测到的 slash command
    attachments?: Attachment[];  // 文件附件
    images?: ImageAttachment[];  // 粘贴的图片
    mentionedFiles?: string[];   // @file 引用
    allowedTools?: string[];     // 命令级工具授权
    modelOverride?: string;      // 模型覆盖
    planOverrides?: object;      // plan 覆盖
  };
  shouldQuery: boolean;          // 是否需要调用模型
}
```

### 处理流程

1. **图片处理**：粘贴的图片转为 base64 content block
2. **附件处理**：文件路径解析、内容读取
3. **Slash command 解析**：`/help`、`/compact`、`/plan`、`/init` 等
4. **@file 引用解析**：`@path/to/file` 转为文件内容
5. **本地命令分流**：部分命令本地处理，不需要 LLM
6. **UserPromptSubmit Hook**：编译完成后触发，允许 hook 修改输入

---

## 7. 主循环状态机 (Agent Loop)

### 架构：CC / po_

- `CC(A)` 是外壳，只做三件事：建 queued command 容器、调用 `po_`、结束后清理
- `po_(A, q)` 是真正的多轮状态机

### 主状态 `J` (TurnState)

`po_` 在 turn 之间搬运的唯一主状态：

```typescript
interface TurnState {
  messages: TranscriptLikeMessage[];
  toolUseContext: ToolUseContext;
  maxOutputTokensOverride?: number;
  autoCompactTracking?: {
    compacted: boolean;
    turnId: string;
    turnCounter: number;
    consecutiveFailures?: number;
  };
  stopHookActive?: boolean;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  turnCount: number;
  pendingToolUseSummary?: Promise<Message | null>;
  transition?: { reason: string };
}
```

### Turn Loop 伪代码

```
while (true):
  // 1. 每轮开头
  yield stream_request_start

  // 2. 消息预处理
  F = normalize(messages)
  F = applyContentReplacement(F)
  F = microcompact(F)           // 清除旧 tool_result 内容

  // 3. Auto-compact（自动压缩）
  { compactionResult, consecutiveFailures } = autocompact(F, ...)
  if compacted:
    yield compact_boundary + summary + attachments
    F = compacted transcript

  // 4. 调用模型
  for await event from callModel(F, systemPrompt, tools):
    yield stream events + assistant fragments
    accumulate M6(assistant) / $6(user-side) / T6(tool_use) / z6(has_tool_use)
    if streaming fallback:
      yield tombstone for orphaned assistants

  // 5. 消费上一轮的 pendingToolUseSummary
  if pendingToolUseSummary:
    await and yield it

  // 6. 分支判断
  if 没有 tool_use (z6 === false):
    → reactive compact 分支
    → max_output_tokens 续写还原分支
    → stop hook 分支
    → completed 返回
  else:
    → 执行工具 (Re6 流式 / Zx8 批次)
    → 处理 attachments、queued commands、skill artifacts
    → 创建 pendingToolUseSummary（延后一轮消费）
    → 重建 J，continue 进入下一轮
```

### J 的 4 种重建场景

`J` 不是零散 mutation，而是在关键分支里整包重建：

1. **reactive compact 成功后重试**：`transition.reason = "reactive_compact_retry"`
2. **max_output_tokens 续写还原**：`transition.reason = "max_output_tokens_recovery"`
3. **stop hook 产生 blocking error**：`transition.reason = "stop_hook_blocking"`
4. **正常工具轮结束**：`transition.reason = "next_turn"`

### Yield 面（对外事件流）

`po_` 不只吐 assistant 文本，它对外暴露混合事件流：

| 事件类型 | 说明 |
|---------|------|
| `stream_request_start` | 每个 turn 开头 |
| `stream_event` | 原始模型流事件 |
| `assistant` | 收口后的 assistant 片段 |
| `attachment` | compact/hook/skill/file-restore 等 |
| `progress` | hook/tool/MCP 进度 |
| `system` | warning/notification/API error |
| `tombstone` | 流式失败后作废已发出的 assistant 片段 |

### Tombstone 机制

当 streaming 已经吐出 assistant 片段、但随后回退到 non-streaming 时：

- 对每条已发出的 orphaned assistant 发 tombstone
- TUI 收到后删除已显示的片段
- SDK/headless 直接吞掉（不对外发出）

### 终止原因

主循环可能返回的终止 reason：

- `completed`：正常完成
- `stop_hook_prevented`：stop hook 阻止继续
- `hook_stopped`：工具执行阶段被 hook 停止
- `prompt_too_long`：上下文超限
- `model_error`：模型调用错误
- `aborted_streaming` / `aborted_tools`：用户中断
- `max_turns`：达到最大轮数
- `image_error`：图片相关错误

---

## 8. Prompt 装配与 Context Layering

### 双链结构

Prompt 最终装配分成两条独立的链：

#### System Chain（进入 API request 的 `system` 字段）

```
lX8(attribution/runtime header)
→ cX8(product identity header)
→ bC(
    overrideSystemPrompt
    > active agent prompt
    > customSystemPrompt
    > $X(...) default system sections
    > appendSystemPrompt
  )
→ dj4(..., systemContext)
    where systemContext = { gitStatus?: multiLineString }
```

#### Messages Chain（进入 API request 的 `messages` 字段）

```
Lx8(userContext) → 前置 <system-reminder> user meta message
→ 历史 transcript messages
→ 当前轮 attachments（被 u0z 左移到 assistant/tool_result 边界）
→ 当前轮 user 输入
→ _X(...) 归一化 + Mg8(...) 相邻 user message 合并
```

### System Sections（`$X(...)` 默认段）

| Section | Cache Break | 说明 |
|---------|-------------|------|
| `memory` | 否 | CLAUDE.md 相关指令 |
| `ant_model_override` | 否 | 模型覆盖 |
| `env_info_simple` | 否 | 环境信息 |
| `language` | 否 | 语言检测 |
| `output_style` | 否 | 输出风格 |
| `mcp_instructions` | **是** | MCP 指令（每轮重算） |
| `scratchpad` | 否 | 暂存区 |
| `frc` | 否 | 内部标记 |
| `summarize_tool_results` | 否 | 工具结果摘要指令 |
| `brief` | 否 | 简洁模式 |

### Per-Section 缓存

`systemPromptSectionCache` 是 Map 级别的缓存，不是整个 prompt 一个字符串：

```typescript
for (const section of sections) {
  if (!cacheBreak && cache.has(section.name)) {
    return cache.get(section.name);
  }
  const value = section.compute();
  cache.set(section.name, value);
  return value;
}
```

只有 `mcp_instructions` 被标记为 `cacheBreak: true`，每轮强制重算。

### UserContext 与 SystemContext

```typescript
// userContext（_$()）→ 变成 messages 前缀
userContext = {
  ClaudeMd?: string,    // CLAUDE.md 扫描结果
  currentDate: string,   // "Today's date is 2026-03-30."
}

// systemContext（vO()）→ 追加到 system prompt 末尾
systemContext = {
  gitStatus?: string,    // 多行 git 状态快照
}
```

### CLAUDE.md 扫描链（`sj()`）

扫描顺序：

```
Managed CLAUDE.md
→ Managed .claude/rules/*
→ User CLAUDE.md
→ User .claude/rules/*
→ 沿项目祖先目录向上：
    <dir>/CLAUDE.md
    → <dir>/.claude/CLAUDE.md
    → <dir>/.claude/rules/*
    → <dir>/claude.local.md
→ additionalDirectoriesForClaudeMd 指向的目录
→ AutoMem
→ TeamMem
```

**关键**：`sj()` 的结果进入 `userContext.ClaudeMd`，然后被 `Lx8(...)` 包成 `<system-reminder>` user meta message 前插到 `messages[]` 最前面。它不是直接进入 `system` 字段。

### Compat 文件

`AGENTS.md`、`.cursor/rules`、`.cursorrules`、`.github/copilot-instructions.md` 等文件：

- **不会**被 CLI 本地链路自动注入 prompt
- 它们只在 `/init` 命令执行时被读取，由模型决定是否写入 `CLAUDE.md`
- 路径：`compat 文件 → /init 读取 → 写入 CLAUDE.md → sj() 扫描 → 运行时`

### API Payload 最终形态

```typescript
payload = {
  model: "claude-...",
  system: hZz(systemSections, enablePromptCaching),  // 按 scope 拆块缓存
  messages: LZz(normalizedMessages, ...),              // prompt cache 注入
  tools: [...],                    // 非 deferred + ToolSearch + 已发现的 deferred
  tool_choice: "auto" | ...,
  betas: [...],
  metadata: { ... },
  max_tokens: ...,
  thinking: { ... },
  temperature: ...,
}
```

### Prompt Caching

System prompt 不是整块缓存，而是按 scope 拆块：

- `cacheScope: null` — 不缓存
- `cacheScope: "org"` — 组织级缓存
- `cacheScope: "global"` — 全局缓存

`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 标记把静态前缀和动态后缀切开。

---

## 9. 工具执行系统

### 执行链

```
tool_use block
  → he6(...)      按 name/alias 找工具定义
    → Ho_(...)
      → Mo_(...)   核心执行包装
        → PreToolUse hooks
        → Permission merge
        → tool.call(...)
        → PostToolUse hooks
        → tool_result / attachments / contextModifier
```

### 两种执行器

| 执行器 | 条件 | 特征 |
|--------|------|------|
| `Re6` 流式并发 | `streamingToolExecution` gate 开启 | safe 工具并行，unsafe 串行边界，progress 缓冲 |
| `Zx8` 传统批次 | 默认 | 按并发安全性分块，safe 并发（默认上限 10），unsafe 串行 |

### Tool Result 双层形态

1. **工具内部结构化输出**：`BashOutput`、`WebSearchOutput` 等
2. **Transcript 中的 tool_result**：经 `mapToolResultToToolResultBlockParam()` 转换

不同工具的 transcript 表现不同：
- Bash：`stdout/stderr/backgroundTaskId` 折叠成文本
- WebSearch：结构化结果降成带 `Links:` 的文本
- AskUserQuestion：答案拼成 `User has answered your questions: "q"="a"`

### Tool Result 完整性保证

- 严格配对：`tool_use.id` 与 `tool_result.tool_use_id` 必须一一对应
- 本地修复器：resume 时修复 orphaned/duplicate tool_result
- 缺失时补 synthetic error：`[Tool result missing due to internal error]`

### 超长结果处理

- 空结果改写为 `(<tool> completed with no output)`
- 超长文本写入 `tool-results/` 持久化文件，transcript 只保留 preview + path
- 消息预算阶段二次替换旧 tool_result

### Deferred Tools / ToolSearch

并非所有工具 schema 都一次性发送给模型：

1. MCP 工具默认为 deferred — 模型只看到名字列表
2. 模型调用 `ToolSearch(query)` 获取完整 schema
3. ToolSearch 返回 `tool_reference[]`（不是文本列表）
4. 下一轮 request builder 提取已发现的 tool names
5. 把这些 deferred tools 的完整 schema 放回 `tools` 数组
6. 下一轮模型才能真正调用该工具

### ContextModifier

工具执行后可以返回 `contextModifier`，它不是 UI 附件，而是运行态改写：

```typescript
// contextModifier 可以修改：
- alwaysAllowRules.command   // 运行时权限
- options.mainLoopModel      // 模型选择
- effortValue                // 推理强度
```

执行器应用规则：
- Safe block：整块结束后统一应用
- Unsafe block：每个工具结束立即更新

---

## 10. 权限系统

### 两层架构

```
Layer 1: Classifier (D0z/YP)    — 决定 allow/deny/ask
Layer 2: Approval Backend        — 处理 ask 的审批
```

### Permission Mode

| 模式 | 语义 |
|------|------|
| `default` | 普通 ask/allow/deny 流程 |
| `acceptEdits` | 比 default 更宽，但仍非全放行 |
| `dontAsk` | 遇到 ask 直接 deny，不弹问询 |
| `bypassPermissions` | 本地 permission core 直接 allow |
| `auto` | ask 先过 classifier，而非直接人工审批 |
| `plan` | 与 auto 耦合的复合状态 |

### Permission Core（两层分类）

```
D0z(...)
  → 静态 deny 规则
  → 静态 ask 规则
  → tool.checkPermissions(...)
  → bypass/rule allow shortcut
  → ask fallback

YP(...)
  → 接 D0z 结果
  → dontAsk 拒绝 ask
  → auto/plan(auto-active) classifier
  → 无法弹 prompt 的场景降级
  → 返回 allow/ask/deny
```

### 工具级细粒度规则

```
Bash(git:*)                    — 允许 git 开头的命令
Edit(docs/**)                  — 允许编辑 docs 目录
WebFetch(domain:github.com)    — 允许 fetch github.com
mcp__server__tool              — MCP 工具权限
```

### Auto Mode

进入 auto mode 时会**主动剥离危险的 broad allow 规则**（`Xm(...)`），避免 classifier 被绕过。退出时还原。

Auto classifier 输入：
- 构造 synthetic `tool_use` block
- 提取 transcript 上下文（默认不含 tool_result）
- 内嵌 classifier prompt + 默认 allow/soft_deny/environment 规则

Fast-path（不进 classifier）：
- `toAutoClassifierInput() === ""` → 直接 allow
- `acceptEdits` 下会直接 allow 的 → 直接 allow
- 命中本地 safe allowlist → 直接 allow
- `requiresUserInteraction()` 的工具 → 保留人工审批
- `PowerShell` → 显式要求人工审批

### 统一审批协议

所有审批最终汇聚到同一个 `toolUseConfirmQueue`：

```
YP(...) → ask
  → 若 awaitAutomatedChecksBeforeDialog:
      yU4() — PermissionRequest hooks / 自动静默检查
      hU4() — teammate/worker 审批上卷
  → SU4() 入队
      → 本地 TUI 用户交互
      → bridge callbacks
      → channel notifications
```

Queue item 支持 `recheckPermission()`：权限变更后自动重算。

### Sandbox 合流

Sandbox 不是独立权限表，而是消费 permission rules 的路径级结果：

- `Edit(...)` allow → sandbox `allowWrite`
- `Read(...)` deny → sandbox `denyRead`
- `autoAllowBashIfSandboxed`：sandbox 成功覆盖后的 allow shortcut（非总绕过）

---

## 11. Hook 系统

### Hook 事件

| 事件 | 时机 | 可做什么 |
|------|------|---------|
| `PreToolUse` | tool.call 前 | 修改输入、allow/deny/block、追加 context |
| `PostToolUse` | tool.call 后 | 追加 attachment、替换输出 |
| `PostToolUseFailure` | tool.call 失败后 | 追加 context、停止 continuation |
| `Stop` | 无 tool_use 的 turn 尾部 | 阻止完成、强制补一轮 |
| `UserPromptSubmit` | 输入编译完成后 | 修改输入、追加 context |
| `InstructionsLoaded` | instructions 扫描完成后 | 修改/追加指令 |
| `PermissionRequest` | ask 判定后 | 自动裁决 allow/deny |
| `SessionStart` | 会话启动时 | 注入初始 context |
| `SessionEnd` | 会话结束时 | 清理 |
| `SubagentStart/Stop` | 子 agent 启停 | |
| `TaskCompleted/Created` | 任务生命周期 | |
| `Worktree*` | worktree 相关事件 | |

### Hook 配置 Schema

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": { "tool_name": "Bash" },
        "hooks": [
          {
            "type": "command",
            "command": "my-validator $TOOL_INPUT"
          }
        ]
      }
    ]
  }
}
```

### Hook 输出

Hook 可以返回：

- `allow` / `deny` / `block` — 决策
- `message` — 追加消息
- `additional_context` — 追加上下文
- `preventContinuation` — 阻止继续
- `stopReason` — 停止原因

### 时序

```
会话启动:
  SessionStart → InstructionsLoaded

每轮:
  UserPromptSubmit
  → [model call]
  → PreToolUse → PermissionRequest → [tool.call] → PostToolUse
  → Stop (if no tool_use)

Compact:
  InstructionsLoaded (load_reason: "compact")
```

---

## 12. 上下文压缩 (Compaction)

### 三级压缩

| 级别 | 触发 | 方式 | 性质 |
|------|------|------|------|
| **Microcompact** | 每轮自动 | 清除旧 `tool_result` 文本 | 同步、零成本 |
| **Autocompact** | token 数超阈值 | LLM 生成摘要 | 异步、有成本 |
| **Reactive compact** | prompt-too-long error | 紧急压缩 | 预留接口（当前未激活） |

### Autocompact 流程

```
DEq(messages, cacheSafeParams, tracking)
  → 先试 _V8() session-memory compact
  → 不成再走 jk6() full auto compact
```

### Compact 产物公共合同

所有 compact producer 必须满足：

```typescript
function hn(compactionResult) {
  return [
    compactionResult.boundaryMarker,      // 压缩边界标记
    ...compactionResult.summaryMessages,   // 摘要
    ...compactionResult.messagesToKeep ?? [], // 保留的消息
    ...compactionResult.attachments,       // 还原的附件
    ...compactionResult.hookResults,       // hook 结果
  ];
}
```

### 3 种 Compact Producer

| Producer | boundaryMarker | messagesToKeep | preservedSegment |
|----------|---------------|----------------|------------------|
| **Full** (`jk6`) | 有 | 无 | 无 |
| **Partial** (`fVq`) | 有 | 有（未压缩前缀） | anchorUuid = boundary |
| **Session-memory** (`_V8`) | 有 | 有（尾部消息） | anchorUuid = summary |

### Compact Boundary

```typescript
{
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  compactMetadata: {
    trigger: "manual" | "auto",
    preTokens: number,
    preservedSegment?: {
      headUuid: string,    // 保留段第一条
      anchorUuid: string,  // 重连锚点
      tailUuid: string,    // 保留段最后一条
    }
  }
}
```

`preservedSegment` 不是 UI 注释，而是 transcript 重连协议的一部分。

### AutoCompactTracking 熔断器

```typescript
autoCompactTracking = {
  compacted: boolean,         // 是否已成功做过 autocompact
  turnId: string,              // 上次 compact 的 UUID
  turnCounter: number,         // compact 后完成的工具轮数
  consecutiveFailures: number, // 连续失败次数
}
```

- `consecutiveFailures >= 3` → 熔断，不再尝试
- `turnCounter` 只在正常工具轮结束时递增（不含 recovery、stop hook 等）

---

## 13. MCP 系统

### 概述

MCP (Model Context Protocol) 在 Claude Code 中不是简单的工具接入，而是完整的 server 生命周期管理。

### 命令面

```
mcp serve           — 作为 MCP server 运行
mcp add             — 添加 MCP server
mcp add-json        — 以 JSON 添加
mcp add-from-claude-desktop  — 从 Claude Desktop 导入
mcp get/list/remove/reset-project-choices
```

### 配置来源与作用域

- **project**: `.mcp.json`
- **user**: `~/.claude/` 下的 MCP 配置
- **local**: 本地配置
- **dynamic**: 运行时动态注册
- **enterprise**: 企业策略
- **claudeai**: claude.ai 来源

### 去重策略

按连接签名去重（非按名称）：

- stdio: `stdio:${JSON.stringify([command, ...args])}`
- URL: `url:${normalizedUrl}`

### 4 种传输协议

| 协议 | 描述 |
|------|------|
| **stdio** | JSON-RPC over stdin/stdout，优雅关闭 SIGINT→SIGTERM→SIGKILL |
| **SSE** | SSE 下行 + HTTP POST 上行，endpoint 通过 `event: endpoint` 发现 |
| **streamable-http** | session-aware 同 URL，GET 下行/POST 上行，mcp-session-id |
| **WebSocket** | 直接 JSON 消息 |

另有 `sse-ide`、`ws-ide`、`claudeai-proxy`、内建 in-process server 等特殊形式。

### Deferred Tool 机制

MCP 工具默认为 deferred：

```
初始：只暴露工具名字（通过 deferred_tools_delta attachment）
→ 模型调用 ToolSearch 获取完整 schema
→ tool_result 返回 tool_reference
→ 下一轮 request builder 把该工具放回 tools 数组
→ 模型才能真正调用
```

### MCP Instructions

双重落地：

1. 默认 system section 中（通过 `$X(...)` / `C8_(...)`，每轮 cache-break）
2. attachment 侧（`mcp_instructions_delta`，增量更新）

### MCP Resources

- `mcp_resource` 是一等 transcript/attachment 类型
- `@server:uri` 触发读取
- 内容快照直接展开进 prompt（不是引用链接）

---

## 14. Skills 系统

### 5 层结构

```
Registry → Candidate Sets → Announcement → Execution → Runtime State
```

### 来源

- Bundled skills（内建）
- Project/User `SKILL.md` 目录
- Plugin skills
- Built-in plugin skills
- MCP prompt commands
- Built-in local commands

### 3 种 Attachment

| Attachment | 职责 | 生命周期 |
|-----------|------|---------|
| `dynamic_skill` | 发现提示 | 每轮生成 |
| `skill_listing` | 模型公告（增量） | 增量更新 |
| `invoked_skills` | 已调用 skill 内容 | compact/resume 保留 |

### Skill 文件格式

```markdown
---
name: search_strategy
type: knowledge
description: "搜索策略指导"
when_to_use: "用户需要搜索信息时"
triggers:
  keywords: [search, find, look up]
  intents: [information_retrieval]
  tools_mentioned: [WebSearch]
metadata:
  priority: 10
---

# 搜索策略
...skill 内容...
```

### 动态发现

文件操作触发 `dynamicSkillDirTriggers` → 扫描触发目录下的 `SKILL.md` → 产出 `dynamic_skill` attachment

### Skill 执行

- Slash command：`r74(...)` 展开成 user message chain + command_permissions
- Inline（SkillTool）：`SkillTool.call(...)` 改变运行态
- Fork skill：`ZC8(...)` 编译完整 prompt 后 fork 到目标 agent

---

## 15. Plugin 系统

### 一句话总结

Plugin 不是"附带几条 skill 的目录"，而是贯穿 **marketplace 分发、安装缓存、settings 启停、运行时装配、能力注入、策略管控** 的扩展控制面。

### 三层状态

```
marketplace declaration    — 从哪里发现 plugin
→ installation ledger      — 哪些已物化到本地
→ enabledPlugins decision  — 哪些当前应启用
→ runtime load
```

### Plugin 能力注入

Plugin 可以注入：

- **commands** — 命令
- **skills** — 技能
- **agents** — 子 agent
- **output styles** — 输出风格
- **hooks** — 生命周期钩子
- **MCP servers** — MCP 服务器
- **LSP servers** — 语言服务器
- **settings** — 配置覆盖
- **channels** — 消息通道

### Source 优先级

```
session --plugin-dir plugins   (name@inline)
→ installed / marketplace-backed plugins
→ builtin plugins              (name@builtin)
```

Session plugin 与已安装 plugin 同名时，session 覆盖 marketplace 版本。

### Manifest

Plugin manifest 可以在两个位置：

- 首选：`.claude-plugin/plugin.json`
- 兼容：根目录 `plugin.json`

Marketplace entry 可以作为 overlay（`strict: true`）或冲突检测（`strict: false` + 双声明）。

### 安全治理

- `blocklist.json` — 封禁列表
- `flagged-plugins.json` — 已标记
- 官方 security feed
- `forceRemoveDeletedPlugins` — 强制卸载已下架 plugin

---

## 16. Resume / Fork / Sidechain / Subagent

### Resume

还原完整"工作现场"：

1. 还原 transcript 所有事件
2. 还原 plan 文件状态
3. 还原 file-history backups
4. 处理 interrupted turn（补偿中断轮）
5. 还原 invoked skills
6. 修复 tool_result 配对

### Fork

从源 session 分叉，新 sessionId + 独立 transcript，共享前缀事件。

### Sidechain

与主会话分开的执行链路，复用主循环但 transcript 独立落盘。

### Subagent

Sidechain 的具体实例，落盘到 `subagents/agent-<id>.jsonl`。

### Agent Team

- TaskList / Roster 模型
- Mailbox 协议（leader ↔ teammate 通信）
- Teammate runtime（launch、idle、shutdown）
- Plan approval 通过 mailbox 上卷

### ToolUseContext 克隆规则 (`ts6(...)`)

Fork/subagent 不是简单继承父上下文，而是：

- `readFileState` → 克隆
- `nestedMemoryAttachmentTriggers` → **重置为空 Set**
- `dynamicSkillDirTriggers` → **重置为空 Set**
- `discoveredSkillNames` → **重置为空 Set**
- UI 相关能力 → **降权/noop**
- `queryTracking.depth` → `parent.depth + 1`

---

## 17. Plan 系统

### 状态迁移

```
Normal Mode
  → EnterPlanMode
    → Plan Mode (plan file 生命周期)
      → ExitPlanMode (审批 UI)
        → Normal Mode (执行 plan)
```

### Plan File

- 按 agent 独立，存储在 `plansDirectory`
- 包含 slug、任务描述、步骤列表
- Resume 时还原
- Compact 时保留为 `plan_file_reference` attachment

### Plan Attachments

| Attachment | 职责 |
|-----------|------|
| `plan_mode` | 当前 plan mode 状态 |
| `plan_mode_reentry` | 重入 plan mode |
| `plan_mode_exit` | 退出 plan mode |
| `plan_file_reference` | plan 文件引用 |

### 审批 UI

`ExitPlanMode` 触发审批 UI（`Cm4(...)`）：

- clear-context vs keep-context
- `planWasEdited` 判定
- `Ctrl+G`、CCR/web 回传
- Teammate → leader plan approval

---

## 18. TUI 系统

### 架构

React/Ink 实现，8 个专题子系统：

1. **REPL root + render pipeline** — 两套 root、四槽位布局、消息区渲染
2. **Transcript + rewind** — 搜索/导出/show-all、rewind/summarize/restore
3. **Input + footer + voice** — 输入枢纽、permission mode 轴、stash/external editor
4. **Dialogs + approvals** — 优先级链、permission/sandbox/worker approvals
5. **Help/Settings/Model/Theme/Diff** — 各类 overlay
6. **Tool permission dispatch** — `zB4(...)` 总分发器、path-aware 审批
7. **Message row + subtype renderers** — user/assistant/system block 渲染
8. **Tool result renderers** — 高价值结果渲染器家族

### Dialog 优先级

`focusedInputDialog` 优先级链决定哪个对话框获得输入焦点。

### Tool Result 渲染

不同工具有专门的渲染器：
- Bash → 代码块 + stdout/stderr
- Read → 文件内容预览
- Edit → diff 显示
- WebSearch → 链接列表
- AskUserQuestion → 表单 UI

---

## 19. 重写架构建议

### HitCC 推荐的重写分层

```
src/
  cli/          — 入口分流、命令树
  settings/     — 多源配置、合并、缓存、回写
  engine/       — headless/repl、turn loop、model call
  session/      — transcript、resume/fork、file-history、plan
  prompt/       — instruction discovery、compose、cache、rules、skills
  tools/        — registry、executor、permission
  hooks/        — hook schema、runtime
  agents/       — subagent/team、source load、launch
  mcp/plugins/  — MCP server 管理、plugin marketplace、能力注入
  remote/       — remote-control、bridge、direct connect
  ui/           — TUI root、transcript、dialog、approval
  state/        — app-state、session-state
  shared/       — ids、paths、env、logger
```

### 推荐落地顺序

| Phase | 目标 | 内容 |
|-------|------|------|
| **1** | Runnable Headless | prompt → model → tool use → transcript → result |
| **2** | Local Work Scene | file-history、plan、content-replacement、skills、attachments |
| **3** | Peripherals | hooks、MCP、plugins、agents、remote/bridge、TUI |
| **4** | Edge Alignment | prompt final order、compact chains、model fallback、telemetry |

### 关键设计决策

1. **Transcript 是事件日志**，`toMessages()` 是派生视图
2. **Headless 与 TUI 共享核心循环**，只在 I/O 和审批上分叉
3. **工具是一等公民**，内建工具和 MCP 工具统一注册
4. **Settings 是独立层**，不散落在各个 consumer 里
5. **Permission 两层分离**：classifier 同步决策 + approval backend 异步审批
6. **Prompt 按 section 缓存**，不是整个 prompt 一个字符串
7. **Session 还原"工作状态"**，不仅是聊天记录

### 可行性判断（来自 HitCC）

| 目标 | 可行性 |
|------|--------|
| 可运行替代品 | **90%+** |
| 高相似版本重写 | **75-85%** |
| 1:1 原版复刻 | **<30%**（服务端黑箱） |

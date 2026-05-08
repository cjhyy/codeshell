# Code Shell Roadmap

> 基于当前架构分析，对标 **Claude Code** / **OpenCode** / **OpenAI Codex** 三个业界标杆产品制定。

---

## 当前架构基线

| 能力域 | 成熟度 | 对标说明 |
|--------|--------|----------|
| Turn Loop 引擎 | 高 | 对齐 Claude Code `po_()` 模式：pre_check → model_call → post_check → tool_exec → context_mgmt → next turn |
| 工具注册/执行框架 | 高 | 对齐 OpenCode ToolRegistry，支持并发安全分组、streaming tool queue |
| ToolContext 依赖注入 | 高 | ServiceContainer 模式，优于模块级单例 |
| Preset 系统 | 高 | `general` / `terminal-coding` 双预设，对齐 OpenCode Agent 概念 |
| 权限决策引擎 | 高 | 对齐 Claude Code permission modes（allow/ask/deny/bypass） |
| Sub-Agent 生成 | 中 | 树形委托，SendMessage 点对点通信 |
| MCP 集成 | 中 | 支持 MCP client（tool/resource），三款标杆都支持 |
| Protocol Client/Server | 中 | Client-Server 分离架构，对齐 OpenCode |
| Ink/React TUI | 中 | 对齐 Claude Code TUI |
| Streaming + Reactive Compaction | 高 | 对齐 Claude Code |
| Git Worktree 隔离 | 中 | **差异化优势**，三款标杆未原生支持 |
| Arena 多模型协作 | 中 | **差异化优势**，三款标杆无此能力 |
| LSP Tool | 低 | 基础 goToDefinition/findReferences/hover，对齐 OpenCode 早期阶段 |
| Hook Registry | 低 | 生命周期 hook 框架就绪，待更多 hook 点 |
| Session/Transcript | 中 | 对齐 Claude Code |

---

## Phase 0: 稳定化补齐（1–2 个月）

对标 Claude Code / OpenCode 的"开箱即用完整性"。

### 0.1 项目指令文件全局化

**目标**：自动发现并注入项目级指令文件，对标 Claude Code 的 CLAUDE.md。

**范围**：

- 从当前工作目录递归向上读取 `CODESHELL.md` / `AGENTS.md` / `CLAUDE.md`
- 多文件合并策略（最近优先 / 层级覆盖）
- 目录级 scope 限制（`globs: "src/**"` 字段），文件内 `<!-- project (depth N) -->` 标记
- 自动注入到 system prompt 的 `project_instructions` 段

**对标**：Claude Code CLAUDE.md 自动发现

---

### 0.2 补齐工具集缺失项

**目标**：与三款标杆对齐工具覆盖。

| 缺失工具 | 对标来源 | 说明 |
|----------|----------|------|
| `List` | OpenCode ListTool | 目录列表，当前只有 Glob/Grep |
| `TodoWrite` / `TodoRead` | OpenCode Todo 工具 | 结构化任务追踪，与 Task 互补 |
| `WebSearch + WebFetch` 联合 | OpenCode fetch→analyze | 当前两个工具独立，缺乏流水线 |

---

### 0.3 测试覆盖率补齐

当前测试文件只有 `tests/session.test.ts` 和 `tests/tools.test.ts`。

新增测试覆盖：

- `turn-loop.test.ts`：边界条件（maxTurns、anti-loop、PTL recovery、orphaned tool uses）
- `preset.test.ts`：预设切换、自定义 preset 注册、tool 过滤
- `mcp-tools.test.ts`：MCP tool/resource 集成
- `permission.test.ts`：权限决策全路径
- `streaming-fallback.test.ts`：stream 失败降级非 stream

---

## Phase 1: Arena 产品化（核心差异化）（2–3 个月）

**Arena 是 Code Shell 区别于三款标杆的最强能力**——Claude Code / OpenCode / Codex 都没有原生多模型协作分析。

### 1.1 Arena 交互面板

**目标**：IDE 内 Arena Panel，从 "demo 工具" 升级为 "日常工作流"。

**范围**：

- **Ink TUI Arena Panel**：选中代码 / diff → 一键启动 Arena review，多模型结果并排展示
- **Arena 结果可操作**：不只是分析，可 "Apply recommendation" 直接应用建议
- **PR Review 模式**：diff + context → multi-model review → inline comments
- **自定义 Concluder 策略**：
  - `majority_vote`：多数票决
  - `delegate_strongest`：委托最强模型
  - `merge_all`：合并所有意见，人工选择
  - `debate_consensus`：多轮辩论直至收敛

### 1.2 Arena 远程执行

**目标**：Arena 分析在远程执行，降低本地开销。

**范围**：

- Arena 参与者模型可配置为远程 endpoint
- 并行模型调用池（当前是串行）
- Arena 结果缓存（相同 diff + context hash 不重复分析）

### 1.3 Code Shell 作为 MCP Server

**目标**：Code Shell 自身作为 MCP Server，让其他 Agent 工具调用。

**暴露能力**：

- `arena.review`：请求多模型代码审查
- `arena.discuss`：请求多模型讨论
- `task.status`：查询任务进度
- `session.query`：查询 session 状态

**对标**：OpenCode 仅支持 MCP client，不作为 server 暴露。

---

## Phase 2: Protocol 标准化 + 多语言 SDK（2–3 个月）

### 2.1 OpenAPI Spec 生成

**目标**：从 `src/protocol/types.ts` 自动生成 OpenAPI spec → 多语言 SDK。

**对标**：OpenCode 使用 Stainless 自动生成 SDK。

**实现路径**：

- 从 TypeScript 类型定义生成 OpenAPI 3.1 spec（ts-to-openapi 或手写）
- Stainless / openapi-generator 生成 Go、Python、Rust SDK
- CLI 支持 `codeshell serve` HTTP 模式（类似 `opencode serve`）

### 2.2 Client SDK 发布

- `@cjhyy/code-shell-client`（TypeScript，与 server 同仓库）
- `code-shell-go`（Go SDK）
- `code-shell-py`（Python SDK）

---

## Phase 3: Coding 体验深度化（3–4 个月）

### 3.1 深入 LSP 集成

**当前状态**：单体 `lsp.ts` tool，仅支持基础操作。

**目标**：对标 OpenCode 的 LSP event bus 架构。

**范围**：

- **Inline Diagnostics**：LSP `textDocument/publishDiagnostics` → 自动注入到 LLM context，错误即时反馈
- **Code Actions**：`textDocument/codeAction` → 自动修复建议
- **Workspace Symbols**：`workspace/symbol` → 跨文件导航
- **Semantic Tokens**：语法高亮信息流（非 UI 渲染，而是给 LLM 理解代码结构）
- **Event Bus**：`textDocument/didChange` 通过 event bus 推送，保持 diagnostics map（对齐 OpenCode）

### 3.2 IDE 集成

**目标**：对齐 Claude Code IDE 集成体验。

**范围**：

- **VS Code Extension**：终端面板嵌入 IDE 底部
- **JetBrains Plugin**：核心功能对齐 VS Code Extension
- **Inline Completion**：类似于 Copilot，但由 Code Shell agent 上下文驱动
- **Sidebar Chat**：保持 chat 面板，与终端面板互补
- **Diff View**：文件变更可视化预览，accept/reject inline
- **@-mention**：类似 Claude Code `@claude` on GitHub，在 IDE 内 `@codeshell` 触发

### 3.3 Slash 命令系统

**目标**：内置 + 用户自定义 slash commands，对标 Claude Code。

**内置命令**：

| 命令 | 说明 |
|------|------|
| `/review` | Arena 自动启动代码审查 |
| `/fix` | 修复选中代码 |
| `/explain` | 解释选中代码 |
| `/test` | 生成单元测试 |
| `/refactor` | 重构建议 |
| `/bug` | 提交 bug report |
| `/compact` | 强制 context 压缩 |
| `/clear` | 清除当前 session |
| `/doctor` | 检查系统依赖 |

**自定义 commands**：类似 Claude Code plugins 目录结构，`~/.codeshell/commands/` 下定义。

### 3.4 Plugin 系统

**目标**：社区可扩展能力。

**范围**：

- **Tool Plugin**：注册自定义 tool（类似 MCP 但更轻量，TypeScript 函数级）
- **Hook Plugin**：注册 pre/post tool、pre/post turn、session 生命周期 hooks
- **Preset Plugin**：注册自定义 agent preset（当前 `registerPreset()` 已有基础）
- **UI Plugin**：Ink 组件扩展点（status line 自定义、panel 扩展）

---

## Phase 4: 多 Agent 协作深度化（3–4 个月）

### 4.1 Topology Agent Network

**当前状态**：Sub-agent 树形结构，SendMessage 点对点通信。

**目标**：DAG 拓扑 + 共享上下文池。

**范围**：

- **DAG 调度**：agent 间的依赖关系图，并行 + 串行混合调度
- **共享上下文池**：多个 agent 共享只读 context window（避免重复读取文件）
- **Agent 发现**：agent 可查询其他 agent 的能力描述并动态委托
- **Result Merge**：多个 sub-agent 结果合并策略

### 4.2 Checkpoint / Undo 系统

**当前状态**：Worktree 提供了隔离分支，但无细粒度 undo。

**目标**：

- 每次 tool execution 自动 snapshot 文件状态
- 支持 `@undo` 回滚任意步骤
- Git-based checkpointing（worktree 能力的进一步封装）
- Tool Error Rollback：工具执行失败自动回滚该步修改

**对标**：OpenCode 的 "undo file changes after tool error"

---

## Phase 5: 企业级能力（5–6 个月）

### 5.1 Audit Trail & Compliance

- 完整 session 审计日志（谁、什么时候、做了什么 tool call、结果）
- Transcript 加密存储（可选本地 / 远程）
- Role-based 权限（不同用户不同 permission mode）
- Sensitive data redaction（API key / secret 自动脱敏）

### 5.2 Remote Execution 增强

**当前状态**：RemoteTrigger tool 存在但较简单。

**目标**：

- Agent → Remote Agent 安全 RPC（TLS + auth token）
- 沙箱化远程执行（类似 OpenAI Codex sandbox 模式）
- Workspace sync（本地 → 远程文件同步）
- Remote Arena：多模型在远程并行执行

### 5.3 Team 协作

- Session 分享（URL 分享，类似 Codex sessions）
- Team Prompt Library：共享 prompt 模板
- Team Preset/Tool 共享：中央化配置
- PR Bot：`@codeshell review` 自动触发 Arena review

---

## Phase 6: 体验打磨 + AI-Native 探索（持续）

### 6.1 Memory 系统

**当前状态**：session-level transcript。

**目标**：

- 跨 session 长期记忆（user preference、项目偏好）
- 项目级知识图谱（文件关系、依赖图）
- Semantic memory：基于 embedding 的语义检索

### 6.2 Performance 优化

- **Tool 预热池**：预启动 LSP client、MCP client，减少首次调用延迟
- **增量 context compaction**：非全量重压缩，仅压缩新增长部分
- **Tool result caching**：read/grep/glob 结果按 content hash 缓存

### 6.3 Multimodal Input

- 支持截图/图片作为 prompt（类似 Claude Code 图片支持）
- Terminal 截图分析（错误截图的 OCR + 诊断）
- Diagram-to-code（架构图 → 代码骨架）

---

## 优先级矩阵

| | 高价值 | 低价值 |
|---|---|---|
| **低投入** | Phase 0.1（指令补全）<br>Phase 0.2（List/Todo 工具）<br>Phase 3.3（Slash 命令） | Phase 2.2（Client SDK 发布可后移） |
| **高投入** | **Phase 1: Arena 产品化** ⭐<br>Phase 3.1（LSP 深度集成）<br>Phase 3.2（IDE 集成） | Phase 4.1（Topology Agent）<br>Phase 5.2（Remote 沙箱） |

## 建议执行顺序

```
现在 ──→ Phase 0.1（指令全局化）+ 0.2（工具补齐）
   │
本月 ──→ Phase 1（Arena 产品化）⭐ 核心差异化，三款标杆都没有
   │
下月 ──→ Phase 3.3（Slash 命令）+ 3.1 前半（LSP diagnostics feedback）
   │
Q3  ──→ Phase 2（Protocol SDK）+ Phase 3.2（IDE 集成骨架）
   │
Q4  ──→ Phase 4（Topology Agent + Checkpoint/Undo）
   │
明年 ──→ Phase 5（企业级）+ Phase 6（持续打磨）
```

---

## 附录：三款标杆产品核心能力速览

| 能力 | Claude Code | OpenCode | OpenAI Codex | Code Shell 当前 |
|------|-------------|----------|-------------|----------------|
| CLI Agent | ✅ | ✅ | ✅ | ✅ |
| IDE 集成 | ✅（VS Code/JetBrains） | TUI 为主 | ✅（VS Code） | TUI 为主 |
| Sub-Agent | ✅ Task tool | ✅ Task tool | ❌ | ✅ Agent tool |
| MCP | ✅ | ✅ | ✅ | ✅ |
| Custom Agent/Preset | ✅ plugins | ✅ builtin agents | ❌ | ✅ Preset |
| LSP 集成 | ✅ | ✅（event bus） | ✅ | ⚠️ 基础 |
| Multi-model | ❌ | ❌ | ❌ | ✅ **Arena** |
| Git Worktree | ❌ | ❌ | ❌ | ✅ |
| Protocol SDK | ❌ | ✅ Stainless | ❌ | ⚠️ 内部 protocol |
| Hook 系统 | ✅ | ✅ plugin | ❌ | ✅ |
| Slash Commands | ✅ | ❌ | ❌ | ❌ |
| Checkpoint/Undo | ❌ | ✅ | ❌ | ❌ |
| Long-term Memory | ✅ | ❌ | ❌ | ❌ |

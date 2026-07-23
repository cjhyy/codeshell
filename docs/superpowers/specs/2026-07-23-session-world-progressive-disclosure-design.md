# Session 世界渐进披露设计（工作台 + Mimi 双消费面）

日期：2026-07-23
状态：已获用户批准（brainstorming 收敛结论）

## 背景与目标

产品设想：Mimi 能看到所有 session 的全局图景（树状、渐进式披露），能搜索到某个
session 并 resume 它继续干活；session 的更新自动反映到索引；用户在 Mimi 工作台
能看到 session 树、每个 session 的最新进展、以及跨 session 聚合的待办事项。

现状调研结论（详见 git 历史与下文引用）：

- 实时投影索引已完整：worker 侧 `packages/pet/src/projection-extension.ts` 事件级
  delta → `packages/desktop/src/main/pet/pet-state-aggregator.ts` 聚合（磁盘 catalog
  30s + live delta + 外部 CLI 15s 扫描）。
- Resume 链路已通：`DelegateWork` 支持 `session_id` 复用旧 session
  （`packages/pet/src/delegate-work.ts`），底层 `agent/run + requireExisting`
  （`packages/core/src/engine/run-session-open.ts`）。
- 渐进披露有工程先例：`packages/pet/src/gateway.ts` 的 search→describe 两级模式。
- 缺口：无 session 内容搜索；Mimi 无下钻工具且候选集 25 条按 id 字母序截断；
  工作台无内容层展示；TODO 不跨 session 聚合。

## 核心原则

1. **不预生成任何摘要**。每个 session 的"内容" = transcript 尾部最后一条
   assistant 文本，按需读、按需截断；aux 模型仅在超长时压缩，结果按
   `(sessionId, turnCount)` 缓存。
2. **三层披露**：L1 列表（标题/状态/最近活动）→ L2 最新文本结果 → L3 下钻
   （grep 原文 / 打开 session）。
3. **一份数据两个消费面**：数据层做一份，工作台 UI 与 Mimi 工具各自消费，
   不做"一个东西两边凑合"。
4. **更新自动进索引，不自动唤醒 Mimi**：唤醒仍走现有三个触发器
   （用户/IM 消息、ReportToMimi、长任务闭环）。

## 模块设计

### A. 数据层（packages/desktop/src/main）

- 新增 `latest-result-reader`：从 `transcript.jsonl` 尾部读取最后一条 assistant
  文本（复用 `transcript-reader.ts` 的读取模式）。
  - 截断上限（建议 2,000 字符）；超长时调用 aux 模型压缩。
  - 缓存键 `(sessionId, turnCount)`；session 新 turn 到达即失效。
  - 读失败降级为现有状态短语（`session-index.ts` 的 reduceEvent 产物）。
- 跨 session TodoWrite 聚合：复用 `packages/core/src/tool-system/builtin/task.ts`
  的 `readLastTodoSnapshot` 扫描全部 session；mtime 高水位增量刷新
  （模式照抄 `pet-state-aggregator.ts` 的 catalog 刷新）。
- 修正：`boundedWorld` 注入 Mimi 的 25 条 session 从 id 字母序
  （`pet-state-aggregator.ts` 的 `localeCompare` 排序）改为 `lastActivityAt` 降序。

### B. 搜索服务（main process）

- grep 式 transcript 全文搜索：关键词 → 命中 session 列表 + 上下文片段。
  - 限制并发、单文件读取大小、返回总量；超时返回部分结果并标记 truncated。
  - 覆盖 `~/.code-shell/sessions/*/transcript.jsonl`；可选 `includeArchived`。
- 两个消费面共用：Cmd-K `SessionSearchModal` 增加"搜内容"模式；
  Mimi 侧作为 `Sessions.search` 工具后端。
- 不做语义/向量索引（第一期明确排除）。

### C. Mimi 侧 Sessions 工具（packages/pet）

- 仿 `gateway.ts` 两级模式新增只读 `Sessions` 工具，动作：
  - `list`：分页、按 workspace 过滤，返回 L1 行。
  - `describe(sessionId)`：返回最新结果（L2）+ TodoWrite 未完成项 + pending 决策。
  - `search(keyword)`：调用 B 的搜索服务。
- **信任边界**：describe/search 返回的 transcript 内容必须包 untrusted 内容
  标记（作为数据呈现，不作为指令），`packages/pet/src/profile.ts` 系统提示词
  同步说明。这是有意打破"投影不含 transcript 内容"旧不变式的决策，
  外部 CLI session 的"never copy transcript"承诺**保持不变**（外部行仍
  metadata-only）。
- availability 门控与工具注册模式照抄 Gateway。

### D. Resume 白名单打通（packages/desktop/src/main/pet）

- 本回合内被 `Sessions` 工具 describe/search 验证过的 sessionId，动态加入
  `pet-dispatch-service.ts` 的可复用白名单（现状：≤32 条、每 workspace ≤6 条、
  列表外硬拒）。
- workspace 匹配校验保留；归档 session 经搜索命中后允许进入白名单。
- 外部 CLI session 保持 observe-only，不做续活（如需迁移用现有
  context_transfer/handoff 机制）。

### E. 工作台 UI（packages/desktop/src/renderer/pet）

- `PetWorkTree` session 行支持展开显示"最新结果"（L2），点击进入 session（L3）。
- 新增 TODO 聚合区块，来源仅三个结构化渠道：
  1. TodoWrite 未完成项（pending/in_progress）；
  2. PendingDecisionIndex（等审批/提问）；
  3. PetWorkMemoryStore 的 unfinished 条目（现状只喂 Mimi 不给 UI）。
  每条带来源 session 跳转。**不做自由文本 TODO 挖掘**。

### F. 更新流

- 复用现有投影事件通道（`pet:projection-event` IPC + delta）：turn 结束事件
  到达时使 latestResult 缓存失效；UI 与 Mimi 下次读取即为最新。
- 不新增推送通道；不新增唤醒 Mimi 的触发器。

## 错误处理

- transcript 读失败 → 回退状态短语；aux 压缩失败 → 截断原文；
  搜索超时 → 部分结果 + truncated 标记；聚合扫描单 session 失败 → 跳过并记日志。

## 测试策略

- 全程 TDD：每个模块先写失败测试再实现。
- A/B/E 三块相互独立可并行；C 依赖 A/B，D 依赖 C。
- 已知风险：仓库有 ~14 处手写 engine fake，改 Engine 接口需同步更新；
  不跑 `bun run format`（会重排全仓），只 prettier 改动过的文件。

## 第一期明确不做

- 外部 CLI session 的 resume（保持 observe-only）。
- 语义/向量搜索。
- 预生成 key map / 内容摘要管线。
- 自由文本 TODO 挖掘。
- 主动唤醒 Mimi 的新触发器。

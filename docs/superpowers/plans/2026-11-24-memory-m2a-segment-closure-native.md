# 记忆流水线 M2a：原生会话按工作段收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 原生会话的记忆提取从「每轮结束跑一次、每次重读整个窗口」改成「一个工作段收尾一次、只看游标之后的新消息、这段里有人输入的消息才跑」。

**Architecture:** 取窗和门槛是 `core/src/services/memory-closure.ts` 里的纯函数，直接读 transcript 的原始事件。游标存在会话 `state.json` 的 `memoryCursor`。空闲计时由共享的 `EngineRuntime` 持有的 `MemoryClosureScheduler` 负责；没有共享 runtime 的宿主（单次运行、SDK、测试）在 run 结束时立即收尾。整套行为由功能开关 `memory_segment_closure` 控制，关掉回到 M1 的每轮触发。

**Tech Stack:** TypeScript，Bun test（`node scripts/run-bun-test-shard.mjs`）。

设计依据：`docs/todo/memory-segment-closure-design-20261124.md` 第 5.3 节。外部 Claude Code / Codex 会话的并入是 M2b，另起计划。

---

## 与设计文档的差异（实现前定下的）

| 设计文档                                         | 本计划                                                                    | 原因                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在回放（`toMessages()`）的基础上给消息带事件 id  | 直接读原始事件，用 `Transcript.eventsToMessages` 转成消息                 | 回放在上下文压缩后会把旧消息换成合成 id 和同一个时间戳，游标会失效；原始事件只追加、id 稳定。手工选区功能（`Transcript.selectContextRange`）已经是这个做法                                     |
| 调度器由各宿主构造并注入 Engine                  | 调度器挂在 `EngineRuntime` 上，宿主只传一个空闲时长                       | 桌面 worker 是每个会话一个 Engine，`EngineRuntime` 是它们共享的那一层                                                                                                                          |
| 收尾执行时自己创建模型客户端，不依赖 Engine 存活 | 待收尾的会话不被空闲回收（和后台任务同样的豁免），收尾仍走该会话的 Engine | 会话空闲回收也是 30 分钟，正好和收尾计时相撞；豁免之后可以复用现有的客户端解析、计费和整合循环，不必在 Engine 之外再造一套                                                                     |
| TUI repl 也用空闲计时                            | TUI repl 立即收尾（每轮结束，过门槛，只看新消息）                         | 终端里聊完就退出，30 分钟的计时器基本等不到                                                                                                                                                    |
| 启动时补（进程启动后扫描未收尾的会话）           | 本期不做，列为后续                                                        | 需要脱离 Engine 的独立执行器。恢复时补已覆盖「下次再打开这个会话」；漏掉的只有「聊完 30 分钟内退出应用且再也不打开」                                                                           |
| 门槛只列了消息上的标记                           | 子代理和定时自动化的 Engine 整体不提取                                    | 它们的 user 消息来自父代理或定时任务，但写进 transcript 时和人输入的消息没有区别，只能在 Engine 这一层按结构判断（`isSubAgent`、`origin: "automation"`）。子代理的结论会作为工具结果回到父会话 |
| 新消息前带 4 条已处理消息，逐条标「仅上下文」    | 4 条合成一个条目，角色是 `context`，开头写明不要从中提取                  | 不用改提示词的排版和窗口截断逻辑；按角色读对话的代码（全局偏好检测）天然不会把它当成新的 user 消息                                                                                             |

取窗里不包含压缩摘要、会话交接、区间归档这三类事件：它们是对别处内容的转述，不是这段对话里新说的话。

---

## 文件结构

| 文件                                                                      | 职责                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core/src/services/memory-closure.ts`（新）                      | `MemoryCursor`、`selectClosureWindow`、`closureGate`、`MemoryClosureScheduler`               |
| `packages/core/src/services/memory-closure.test.ts`（新，登记进现有分片） | 上面三者的单元测试                                                                           |
| `packages/core/src/types.ts`                                              | `SessionState.memoryCursor`                                                                  |
| `packages/core/src/session/session-fork.ts`                               | 分叉时带上源会话的游标（靠时间戳定位）                                                       |
| `packages/core/src/settings/feature-flags.ts`                             | `memory_segment_closure`，默认开                                                             |
| `packages/core/src/services/memory-orchestrator.ts`                       | 结果增加 `completed`                                                                         |
| `packages/core/src/engine/auxiliary-pipeline.ts`                          | `runMemoryClosure`：取窗、门槛、提取、推进游标、`memory.closure` 日志                        |
| `packages/core/src/engine/runtime.ts`                                     | `EngineRuntime.memoryClosures`                                                               |
| `packages/core/src/engine/memory-segments.ts`（新）                       | run 结束时安排收尾；run 开始时取消等待并做恢复时补                                           |
| `packages/core/src/engine/engine.ts`                                      | 构造 `MemorySegments`，在 run 结束和开始处各调用一次（engine.ts 有行数上限，逻辑不放在里面） |
| `packages/core/src/protocol/chat-session-manager.ts`                      | 待收尾的会话不回收；会话关闭时取消计时                                                       |
| `packages/core/src/cli/agent-server-stdio.ts`、`agent-server-tcp.ts`      | 传 30 分钟空闲时长                                                                           |

---

## 接口

```ts
// memory-closure.ts
export interface MemoryCursor {
  v: 1;
  /** Last transcript event the previous closure covered. */
  eventId: string;
  /** That event's timestamp: the anchor when the id is not in view (tail load, fork). */
  at: number;
  closedAt: number;
}

export interface ClosureWindow {
  /** Conversation messages after the cursor, oldest first. */
  fresh: Array<{ role: string; content: string | ContentBlock[] }>;
  /** The last few covered messages that carry text, for reference only. */
  context: Array<{ role: string; content: string | ContentBlock[] }>;
  /** New user messages a person typed (structured flags only, never text). */
  humanCount: number;
  anchor: "none" | "event" | "timestamp";
  /** Where the cursor goes once this window has been processed. */
  through?: { eventId: string; at: number };
}

export function selectClosureWindow(
  events: readonly TranscriptEvent[],
  cursor: MemoryCursor | undefined,
): ClosureWindow;

export type ClosureDecision =
  | { run: true }
  | { run: false; reason: "no-new-messages" | "no-human-message" | "too-short" };

export function closureGate(
  window: ClosureWindow,
  cursor: MemoryCursor | undefined,
): ClosureDecision;

/** The covered lead-in as one transcript entry (role `context`), or nothing. */
export function renderClosureContext(context: ClosureWindow["context"]): string | undefined;

export class MemoryClosureScheduler {
  constructor(options: { idleMs: number; onError?: (sessionId: string, error: unknown) => void });
  readonly idleMs: number;
  /** A run ended: start (or restart) the quiet period. The latest task wins. */
  schedule(sessionId: string, task: () => Promise<void>): void;
  /** Run now unless a closure is waiting or running for this session. */
  runNow(sessionId: string, task: () => Promise<void>): boolean;
  /** Waiting or running. */
  hasPending(sessionId: string): boolean;
  /** Drop the waiting closure (a new run, or the session closed); a running one finishes. */
  cancel(sessionId: string): void;
  /** Resolves when nothing is running for the session (tests). */
  idle(sessionId: string): Promise<void>;
  dispose(): void;
}
```

「人输入的消息」：`type === "message"`、`role === "user"`、没有 `injected`、没有 `displayOnly`、`authority` 未设或为 `"user"`、没有 `source`。

门槛：没有新消息 → 跳过；新消息里没有人输入的 → 跳过；会话的第一次收尾（没有游标）新消息少于 8 条 → 跳过。跳过时不推进游标。提取出错也不推进。提取正常结束（哪怕 0 条）或设置里关掉了自动提取 → 推进到快照的最后一个事件。

---

### Task 1: 取窗与门槛（纯函数）

**Files:** Create `packages/core/src/services/memory-closure.ts`、`memory-closure.test.ts`

- [ ] 写测试：没有游标时全部算新；按事件 id 定位；id 不在视图里时按时间戳定位；`injected` / `displayOnly` / `authority: "agent"` / `source: "goal-control"` 的 user 消息不算人输入；上下文账本和钩子提醒不进窗口；`summary` / `context_transfer` / `range_archive` 不进窗口；游标之前最多带 4 条文本消息且标 `contextOnly`；工具结果并进新消息；门槛三种跳过原因和通过。
- [ ] 运行确认失败（模块不存在）。
- [ ] 实现 `selectClosureWindow`、`closureGate`。
- [ ] 运行确认通过。

### Task 2: 调度器

**Files:** 同上两个文件

- [ ] 写测试：安静期过后才执行；同一会话再次 `schedule` 只保留最后一个任务；`cancel` 取消等待；`runNow` 在有等待或在跑时返回 false；`cancel` 之后不执行；任务抛错走 `onError` 且不影响后续；`dispose` 清掉全部等待；`hasPending` 覆盖等待和执行中两种状态。
- [ ] 实现 `MemoryClosureScheduler`（计时器 `unref`）。
- [ ] 运行确认通过。

### Task 3: 游标字段、分叉、功能开关

**Files:** `types.ts`、`session-fork.ts`（及其测试）、`feature-flags.ts`（及其测试）

- [ ] `SessionState.memoryCursor?: MemoryCursor`。
- [ ] `buildForkState` 带上 `source.memoryCursor`（分叉的事件 id 是新的、时间戳保留，取窗会走时间戳定位）；补一条测试。
- [ ] `FEATURE_FLAGS.memory_segment_closure = { default: true, … }`。

### Task 4: 提取是否完成

**Files:** `memory-orchestrator.ts`（及测试）

- [ ] `MemoryOrchestrator.run()` 的结果增加 `completed`：提取正常结束或被设置关掉为 true，请求出错为 false。
- [ ] 测试：提取返回空数组时为 true；请求抛错时为 false；`autoExtract: false` 时为 true。

### Task 5: `AuxiliaryPipeline.runMemoryClosure`

**Files:** `auxiliary-pipeline.ts`（及测试，并进 `auxiliary-pipeline.memory-output.test.ts`）

- [ ] 签名：

```ts
runMemoryClosure(input: {
  events: readonly TranscriptEvent[];
  sessionId: string;
  cwd: string;
  primaryClient: EngineLlmClient;
  recordBilledUsage?: (usage: TokenUsage) => void;
  readCursor: () => MemoryCursor | undefined;
  writeCursor: (cursor: MemoryCursor) => void;
  trigger: "run-end" | "idle" | "resume";
}): Promise<void>
```

- [ ] 流程：取窗 → 门槛 → 不通过就记 `memory.closure`（`skipped: reason`）返回 → 通过则沿用现有的消息整理（`sanitizeContent`、`endsTurn`）和 `MemoryOrchestrator` → `completed` 为真时 `writeCursor` → 记 `memory.closure`（`trigger`、`anchor`、`freshCount`、`humanCount`、`extracted`、`changed`）。
- [ ] 把 `runMemoryPipeline` 和 `runMemoryClosure` 共用的「构造 orchestrator」提成一个私有方法。
- [ ] 测试：没有人输入的窗口不发请求、不动游标；第一次收尾不足 8 条不发请求；通过时只发新消息加上下文、游标推进到最后一个事件；模型报错时游标不动；`autoExtract: false` 时不发请求但推进游标。

### Task 6: Engine 接线

**Files:** `runtime.ts`、`engine.ts`、`run-finalize.ts`（及测试）

- [ ] `EngineRuntimeOptions.memoryClosureIdleMs?: number`；设了就创建 `memoryClosures` 并在 runtime 关闭时 `dispose`。
- [ ] `Engine.runMemoryPipeline`：开关关 → 现有路径。开关开 → 交给 `MemorySegments.runEnded`：无人值守的 Engine（子代理、自动化）直接返回；否则构造收尾任务（run 结束时的 transcript、会话 id、cwd、客户端、计费回调）。有 `runtime.memoryClosures` 就 `schedule`，没有就立即执行。
- [ ] run 开始（模型客户端和计费回调就绪之后）：有调度器时先 `cancel`；若本轮 user 消息之前的最后一个事件距今已超过空闲时长，用这之前的事件快照 `runNow` 一次（`trigger: "resume"`）。
- [ ] 测试：`MemorySegments` 用假流水线和真调度器测调度逻辑；真实 Engine 加假模型客户端测三条路径——没有 runtime 时 run 结束立即收尾并写入游标、有真实 `EngineRuntime` 时等待期过后才发请求且计入该会话的用量、开关关掉时行为与 M1 相同；子代理和自动化不收尾。

### Task 7: 会话回收与宿主

**Files:** `chat-session-manager.ts`（及测试）、`agent-server-stdio.ts`、`agent-server-tcp.ts`

- [ ] `sweepIdle`：`runtime.memoryClosures?.hasPending(id)` 时跳过。
- [ ] `closeSession`：`runtime.memoryClosures?.cancel(sessionId)`。
- [ ] 两个 agent server 构造 `EngineRuntime` 时传 `memoryClosureIdleMs: 30 * 60 * 1000`。
- [ ] 测试：有待收尾的会话不被回收；关闭会话后计时取消。

### Task 8: 验证

- [ ] core 记忆、引擎、协议相关测试全过；`bun run typecheck:workspaces` 0 错误；`npx eslint` 改过的文件无报错；`index.exports`、架构预算等全仓契约测试通过；改过的文件 `prettier --check` 通过。
- [ ] `CHANGELOG.md` 的 Unreleased 条目改写为按工作段收尾的说法。
- [ ] 提交：`feat(memory): extract at the end of a work segment, only when a person spoke`

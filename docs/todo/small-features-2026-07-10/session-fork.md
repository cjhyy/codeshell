# Session fork（带上下文分叉 / 选段压缩打包）落地方案

> 体量：M；分两个可独立交付的阶段。本文以
> `docs/nightly-2026-07-10/session-fork-and-context-transfer-design.md` 为设计基线，补齐协议、磁盘复制、renderer 编排和验收细节。

## 1. 问题与现状

### 1.1 现有 `SessionManager.fork()` 不能直接作为用户分叉能力

`SessionManager.create()` 已支持显式 session id、`parentSessionId` 和 `origin`，并在创建时先写
`state.json`、再写目标自己的 `session_meta`（`packages/core/src/session/session-manager.ts:146-207`）。但现有未公开的
`fork()` 仍有以下问题（`packages/core/src/session/session-manager.ts:535-564`）：

- 签名是 `fork(sourceSessionId, forkAtTurn?)`，默认游标取 `source.state.turnCount`；而
  `turnCount` 是 turn-loop 迭代数，`turnSeq` 才是“一个用户输入算一回合”的计数，两者的差异已写在
  `packages/core/src/types.ts:256-264`。因此默认边界并不等同于“当前完整会话”。
- 它只在遇到 `turn_boundary.data.turnNumber > forkTurn` 时停止。`turn_boundary` 只在工具循环继续时追加
  （`packages/core/src/engine/turn-loop.ts:1320-1322`），最后一个自然结束的回合未必有 boundary，不能用它表示稳定快照尾部。
- 它先调用 `create()` 生成 target `session_meta`，随后又把 source 的所有事件用 `append()` 复制，因而会复制第二份旧
  `session_meta`，同时重写事件 id、时间和 `turnNumber`（`packages/core/src/session/transcript.ts:29-40`）。
- 它只从 source 的 `cwd/model/provider` 创建目标，没有复制 `workspace`；worktree session 会退回 main workspace。
- 它把 `parentSessionId` 设置为 source id。该字段现有语义是“sub-agent 的 owner”
  （`packages/core/src/types.ts:267-277`），desktop 磁盘重建会过滤任何非空 parent
  （`packages/desktop/src/main/sessions-service.ts:152-157`），所以用户 fork 会从 sidebar 消失。
- target 在复制开始前已经可见；中途异常会留下一个部分 transcript。现有 `Transcript.flush()` 还吞掉追加错误
  （`packages/core/src/session/transcript.ts:235-240`），不能满足 fork 的全有或全无要求。

现有单测只验证 fork 后 `parentSessionId` 指向 source（`tests/session.test.ts:45-55`），恰好固化了需要废弃的语义，必须随实现重写。

### 1.2 transcript 是权威事件日志，renderer 消息不是 fork 数据源

`TranscriptEvent` 有稳定的 `id/type/timestamp/turnNumber/data`（`packages/core/src/types.ts:154-191`）；LLM 历史则由
`Transcript.toMessages()` 从 `message/tool_result/summary` 投影得到（`packages/core/src/session/transcript.ts:149-212`）。这意味着：

- full fork 应复制一份冻结的事件快照，保留模型上下文和 UI replay 所需信息；
- summary fork 应先按事件 id 取连续范围，再投影为 `Message[]`，不能对折叠后的 React 卡片或 localStorage 文本做摘要；
- target 必须拥有自己的事件 id，source/target 后续 append、compact 和删除才不会相互污染；source id 范围只放 lineage/provenance。

另一个隐藏副作用是 `Transcript.loadFromFile()` 会调用 `repairToolResultPairs()`
（`packages/core/src/session/transcript.ts:282-304`）；repair 会为缺失结果直接 `append()` 合成事件
（`packages/core/src/session/transcript.ts:243-269`）。fork 的“冻结 source”步骤不能借此方法做只读快照，否则一次 fork 可能先改写 source transcript。

desktop 已有保留原始 event id 的只读链路：`getSessionEvents()` 读取 JSONL
（`packages/desktop/src/main/rawTranscript.ts:17-64`），main/preload 分别暴露在
`packages/desktop/src/main/index.ts:3516-3518` 与 `packages/desktop/src/preload/index.ts:775-780`。阶段 2 应直接复用这条链路生成选择游标。

### 1.3 协议与 host 目前没有 fork 入口

协议的 client request 方法集中在 `Methods`（`packages/core/src/protocol/types.ts:383-423`），server dispatch 在
`packages/core/src/protocol/server.ts:414-465`；目前没有 `agent/forkSession`。类型化 client 也只到 `inject()` 等方法
（`packages/core/src/protocol/client.ts:296-302`）。

多 session server 已能从 `ChatSessionManager.get()` 读取 live session
（`packages/core/src/protocol/chat-session-manager.ts:90-99`），`ChatSession.isBusy()` 与 `queueDepth()` 分别在
`packages/core/src/protocol/chat-session.ts:135-137`、`:207-209`。这足以在复制前拒绝正在 append 或仍有排队输入的 source。

desktop 的 `AgentBridge` 只把 `agent/run` 当作可冷启动 worker 的请求，另有 `/compact` query 的特殊冷启动分支
（`packages/desktop/src/main/agent-bridge.ts:373-401`）。若直接从 renderer 发新协议，worker 不存活时消息会被丢弃或超时；host 必须先按
source session 的磁盘 cwd 拉起 worker。

### 1.4 quick-chat 当前一定从空 session 开始

`QuickChatSessionRef` 目前只有 owner/tab/target id/bucket/cwd
（`packages/desktop/src/renderer/quickChatSession.ts:4-11`），`ensureQuickChatSession()` 只生成 `qchat-*` 和 bucket
（`packages/desktop/src/renderer/App.tsx:3094-3115`）。第一次发送直接对该 id 调 `agent/run`
（`packages/desktop/src/renderer/App.tsx:2461-2510`）；Engine 发现磁盘 session 不存在后创建新 session，因此没有 owner 对话上下文。

现有 quick-chat 生命周期可以继续复用：

- renderer 状态变化后异步 claim（`packages/desktop/src/renderer/App.tsx:466-475`）；
- main 的 claim/cleanup IPC（`packages/desktop/src/main/index.ts:3450-3468`）；
- 关闭 panel 后清理 worker、磁盘 session、bucket projection（`packages/desktop/src/renderer/App.tsx:3129-3197`）。

但 fork 后 target 必须在“ready”前禁止发送。当前 `QuickChatPanel` 的 `canSend` 只判断草稿和 `busy`
（`packages/desktop/src/renderer/panels/QuickChatPanel.tsx:47-56`），会与异步 fork 争抢同一个 target id。

### 1.5 `/compact` 可复用摘要原语，但不是可持久化 transfer

`buildSummarizationPrompt()` 已把消息序列化为九段结构，并支持 rolling prior summary
（`packages/core/src/context/compaction.ts:783-849`）。Engine 的摘要调用关闭 reasoning、记录 usage，但目前输出上限只有 1024 token
（`packages/core/src/engine/engine.ts:2350-2373`）。手工 `forceCompact()` 使用主模型，结果只写
`compactedMessagesBySession` 内存映射（`packages/core/src/engine/engine.ts:2869-2945`），没有把摘要持久化进 transcript。

`Transcript.appendSummary()` 目前写死 `trigger: "auto"`（`packages/core/src/session/transcript.ts:130-143`）；desktop replay 又把任何 summary
统一降成 before/after 均为 0 的 `context_compact`（`packages/desktop/src/main/transcript-reader.ts:242-247`）。因此阶段 2 需要新增可区分的
`context_transfer` provenance 和对应 UI 卡片，不能直接调用 `forceCompact()`。

### 1.6 workspace 可以共享，且已有删除保护

`SessionState.workspace` 能表达 main/worktree（`packages/core/src/types.ts:209-233`）。worktree 删除前已有
`otherSessionOwnersForWorktree()` 枚举其他 session owner
（`packages/core/src/tool-system/builtin/worktree.ts:331-359`）。fork 只需深拷贝同一个 workspace 指针，不创建新 worktree；owner guard 会阻止任一 session
删除仍被另一 session 引用的 worktree。它不会阻止两个 session 并发修改文件，UI 仍需明确提示“共享工作区”。

## 2. 目标

### 阶段 1：完整上下文分叉

- 公开 `agent/forkSession` 的 `mode: "full"`，按 source transcript 的稳定事件游标复制自包含快照。
- 新 session 是普通 top-level session：`parentSessionId: null`，另用 `forkedFrom` 表示 lineage。
- target 继承 `cwd/workspace/model/provider/origin`，但清空 usage、cost、goal 和所有运行控制态。
- quick-chat 默认从当前 owner session 带完整上下文分叉，同时保留“空白 quick-chat”次要入口。
- fork 不创建 worktree；source/target 复用同一 workspace，之后 transcript 完全独立。

### 阶段 2：选段压缩打包

- 用户在 `MessageStream` 以“完整用户回合”为单位选一个连续范围；live 尾回合不可选。
- Core 用 source 原始 event id 再校验范围，调用主模型把所选上下文压成约 1,500 token 的 background context package。
- 摘要成功后才创建普通 sidebar target；target transcript 只含自己的 `session_meta` 和一个
  `trigger: "context_transfer"` 的 `summary`，不复制原始选段。
- 跨重启后仍从持久化 summary 恢复；选段之外的内容不进入 target 的模型历史。

### 明确不做

- 不把 source transcript 只读挂载给 target，不做 hard-link，不引入 composite transcript。
- 不复用 `parentSessionId`，不复制 active goal、pending approval、steer queue、后台任务或 undo ownership。
- 不隐式创建新 worktree，也不把 Codex/Claude 外部 session id 当作 core transcript id。
- 阶段 1 不顺带修复 `/compact` 的整体持久化；仅抽取阶段 2 所需摘要原语。

## 3. 详细修改方案

### 3.1 Core 数据结构：lineage 与 transfer summary

#### `packages/core/src/types.ts`

增加持久化 lineage；字段可选以兼容所有旧 `state.json`：

```ts
export interface SessionForkLineage {
  sessionId: string;
  mode: "full" | "summary";
  /** source 快照中实际纳入的首、尾事件 id；inclusive */
  fromEventId?: string;
  throughEventId?: string;
  sourceEventCount: number;
  createdAt: number;
}

export interface SessionState {
  // existing fields...
  forkedFrom?: SessionForkLineage;
}
```

约束：

- `parentSessionId` 继续只表示 sub-agent owner；用户 fork 一律写显式 `null`。
- full fork 的 `fromEventId` 是 source 第一条实际复制的非 `session_meta` 事件；空 source 可以省略首尾 id，count 为 0。
- summary fork 的首尾是用户选择的规范化事件范围，count 是范围内原始事件数，不是摘要后的 target event 数。
- lineage 不存 summary 正文，也不存 source 的 target event id 映射；日志只记录范围和 digest。

给 summary data 增加判别联合，避免继续堆不受约束的 `Record<string, unknown>`：

```ts
export type SummaryEventData =
  | {
      summary: string;
      trigger: "auto";
      compactedRange: { fromTurn: number; toTurn: number; eventCount: number };
      preservedSegment: { headEventId?: string; tailEventId?: string };
    }
  | {
      summary: string;
      trigger: "context_transfer";
      source: {
        sessionId: string;
        fromEventId: string;
        toEventId: string;
        eventCount: number;
      };
      version: 1;
      digest: `sha256:${string}`;
      estimatedTokens: number;
    };
```

`SessionOrigin` 暂不扩 enum。quick-chat 仍受既有 claim/cleanup 生命周期管理；普通 summary target 继承 source origin。若后续要从磁盘重建中排除异常退出留下的
`qchat-*`，应按 id 前缀单独过滤，而不是改变本 feature 的 lineage 语义。

### 3.2 Transcript：只读快照、原子导入和范围投影

#### `packages/core/src/session/transcript.ts`

新增三个低层 API，并让 `toMessages()` 复用纯函数：

```ts
export interface ReadTranscriptOptions {
  repairToolPairs?: boolean; // resume 默认 true；fork snapshot 必须 false
}

export interface ImportTranscriptOptions {
  regenerateIds: true;
  skipTypes?: ReadonlySet<TranscriptEventType>;
}

export function eventsToMessages(events: readonly TranscriptEvent[]): Message[];

export class Transcript {
  static readEvents(filePath: string, options?: ReadTranscriptOptions): TranscriptEvent[];
  importEvents(
    events: readonly TranscriptEvent[],
    options: ImportTranscriptOptions,
  ): { imported: number; sourceToTargetIds: Map<string, string> };
  appendContextTransferSummary(input: ContextTransferSummaryInput): TranscriptEvent;
}
```

具体规则：

1. `readEvents({ repairToolPairs: false })` 只解析内存数组，不构造会创建文件的 `Transcript`，也不调用
   `repairToolResultPairs()`；坏 JSON 行沿用当前“跳过”行为，但返回 `malformedLineCount` 供 fork 在非 0 时拒绝，而不是静默产出残缺快照。
2. `loadFromFile()` 保持 resume 的现有 repair 行为，避免本 feature 改变旧 session 的恢复语义；内部改为调用共享 parser。
3. `eventsToMessages(events)` 是纯函数，行为必须与当前 `toMessages()` 字节级等价；`toMessages()` 仅变成
   `return eventsToMessages(this.events)`。阶段 2 对切片调用同一函数，避免两套工具消息投影。
4. import 时深拷贝 `data`，保留 source `timestamp`、`turnNumber` 和工具调用 data 中的 `toolCallId`，只重新生成 target event `id`。
5. import 完成后把 `currentTurn` 设置为所有 imported `event.turnNumber` 与
   `turn_boundary.data.turnNumber` 的最大值；否则 target 第一次 append 会回到 turn 0。
6. 不把 `sourceToTargetIds` 持久化；它只用于实现时验证唯一性和单测。lineage 保留 source 范围即可。

full fork 的事件过滤采用“明确 denylist，未知新增事件 fail closed”的版本化策略：

| 事件 | 行为 | 原因 |
|---|---|---|
| `session_meta` | 跳过全部 source meta | target 只能有一个自己的 identity/meta。 |
| `file_history`、`plan_operation` | 不复制 | 属于 undo/计划控制状态，不能让 target 取得 source 的回滚所有权。 |
| `message`、`tool_use`、`tool_result`、`summary`、`content_replace` | 复制 | 模型上下文/压缩语义。 |
| `subagent`、`external_file_changes`、`goal_progress`、`turn_boundary`、`turn_stopped`、`error` | 复制为历史回放 | 保持“完整上下文”可见；这些只是 target 中的历史，不恢复其运行控制权。 |
| 将来新增 event type | fork 显式报 unsupported | 防止新控制事件在未审计时被偷偷复制。 |

copy 前对截取数组执行工具配对校验：所有进入模型历史的 `tool_use` 必须在游标前有匹配 `tool_result`；不得调用 repair 自动伪造结果。对一个已经停止且历史上确实缺结果的 session，可允许 Engine 当前已有的 resume patch 语义，但必须把“合成 interrupted result”作为目标导入时的显式、可测试操作，不能修改 source。

### 3.3 `SessionManager.fork()`：事件游标和目标目录原子发布

#### `packages/core/src/session/session-manager.ts`

替换旧签名：

```ts
export interface ForkSessionOptions {
  targetSessionId?: string;
  /** inclusive；省略时取冻结数组的最后一个 event id */
  throughEventId?: string;
}

export interface ForkSessionResult {
  bundle: SessionBundle;
  lineage: SessionForkLineage;
  copiedEventCount: number;
}

fork(sourceSessionId: string, options?: ForkSessionOptions): ForkSessionResult;
```

不要继续接受数字 `forkAtTurn`。仓库内现有调用只有测试，直接删除旧 overload；若未来 CLI 需要按回合 fork，应先在调用层把回合解析成 event id。

实现拆成四个可单测 helper：

```ts
readForkSnapshot(sourceSessionId, throughEventId?): FrozenForkSnapshot;
buildForkState(source: SessionState, targetSessionId: string, lineage: SessionForkLineage): SessionState;
buildForkTranscript(snapshot: FrozenForkSnapshot, targetMeta: Record<string, unknown>): TranscriptEvent[];
publishSessionAtomically(targetSessionId: string, state: SessionState, events: TranscriptEvent[]): SessionBundle;
```

事件游标的具体算法：

1. `assertSafeSessionId(source)`，直接读 source `state.json` 和 transcript JSONL；不得调用有 repair 副作用的 `resume()`。
2. 在同一次同步文件读取中得到不可变 `events` 数组。协议层已确认 source idle；同步 read 期间 JS worker 不会并发执行 append。
3. 无显式游标时，取冻结数组最后一个 event id；这是“用户点击 fork 时已落盘的全部历史”，不依赖 boundary，也包括自然结束的末回合。
4. 有游标时必须在数组中恰好出现一次；取 `events.slice(0, index + 1)`。不存在、重复、位于 `session_meta`、位于未闭合 tool round 中均返回 `InvalidParams`。
5. 过滤事件后记录实际 source 首尾 id 与 count；空历史 target 仍合法，但只含自己的 meta。
6. 若 source 有 live `ChatSession`，协议层要求 `!isBusy() && queueDepth() === 0`；Core helper仍做结构校验，不信任 host。

target state 构造规则：

| 字段 | target 值 |
|---|---|
| `sessionId`、`startedAt` | 新 id、当前时间。 |
| `cwd` | source `cwd`。 |
| `workspace` | `structuredClone(source.workspace ?? { root: source.cwd, kind: "main" })`。 |
| `model/provider/origin` | source 当前持久值。 |
| `parentSessionId` | `null`。 |
| `forkedFrom` | 新 lineage。 |
| `status` | `active`。 |
| `summary/title` | 可用 `Fork of ${source.title ?? source.summary}` 生成展示 fallback，但不冒充新 session 的自动标题；建议只返回给 host，state 暂不复制。 |
| `tokenUsage`、三个 cumulative counter、`turnCount/turnSeq` | 全部归零；表示 target 自己产生的 usage/回合。imported event 的历史 `turnNumber` 仅用于 replay。 |
| `contextUsageAnchor`、`costState`、`invokedSkills` | 清空。 |
| `activeGoal`、`goalTerminal` | 清空。 |

原子发布不能复用当前“先创建正式目录再 append”的路径。抽取 `publishSessionAtomically()`，流程为：

1. 校验 target 不存在；创建同一 `sessionsDir` 下的 `.pending-fork-<target>-<random>` staging 目录。
2. 一次性序列化 target state 与完整 target JSONL（目标 `session_meta` 在第 1 行，复制事件随后），分别写 staging 文件；写错误必须抛出，不走吞错的 `flush()`。
3. 再检查正式 target 不存在，以目录 `renameSync(staging, target)` 原子发布；并发 target 冲突返回明确错误。
4. 任一步失败都递归清理自己的 staging；`list()` 忽略 `.pending-*`。下次启动可清理超过 24 小时的残留 staging。
5. rename 成功后再 `resume(target)` 返回 bundle。目标 meta 至少包含 target
   `sessionId/cwd/workspace/model/provider/startedAt/forkedFrom`，绝不复制 source meta。

为阶段 2 再提供同一发布原语的专用入口，而不是伪造 full snapshot：

```ts
createFromContextTransfer(input: {
  targetSessionId?: string;
  sourceState: SessionState;
  lineage: SessionForkLineage;
  summary: ContextTransferSummaryInput;
}): SessionBundle;
```

它写 target meta + 单个 summary 事件；调用者必须在模型摘要成功后才调用。

### 3.4 协议：一个判别联合覆盖两阶段

#### `packages/core/src/protocol/types.ts`

新增：

```ts
export type ForkSessionParams =
  | {
      sourceSessionId: string;
      targetSessionId?: string;
      mode: "full";
      /** inclusive；省略表示请求时冻结快照尾部 */
      throughEventId?: string;
    }
  | {
      sourceSessionId: string;
      targetSessionId?: string;
      mode: "summary";
      range: { fromEventId: string; toEventId: string };
      /** 默认 1500，server clamp 到 1000..2000 */
      targetTokens?: number;
    };

export interface ForkSessionResult {
  sessionId: string;
  mode: "full" | "summary";
  forkedFrom: SessionForkLineage;
  workspace: SessionWorkspace;
  copiedEventCount: number;
  titleSuggestion?: string;
  summary?: {
    text: string;
    estimatedTokens: number;
    digest: `sha256:${string}`;
    sourceRange: { fromEventId: string; toEventId: string; eventCount: number };
  };
}
```

在 `Methods` 增加 `ForkSession: "agent/forkSession"`。阶段 1 就合入完整联合类型，但 server 对 `mode: "summary"` 在阶段 2 合入前返回
`MethodNotFound/feature not enabled`；这样第二阶段不再破坏协议形状。也可将 summary variant 放第二阶段同 PR，关键是 client/server 版本必须一起发布。

#### `packages/core/src/protocol/server.ts`

dispatch 增加 async `handleForkSession(req)`：

1. 做判别联合的运行时校验；非法 id/range/token 返回 `InvalidParams (-32602)`。
2. 用磁盘 probe 验证 source 存在；缺失返回 `SessionNotFound (-32002)`。
3. `chatManager.get(sourceId)` 若存在且 `isBusy()` 或 `queueDepth() > 0`，返回 `Overloaded (-32001)`，message 明确为
   “source session is still producing or has queued turns”。不自动排队，否则 UI 不知道快照实际发生在哪一时刻。
4. target 已存在返回 `InvalidParams`（或内部映射为 409 风格文案），绝不能覆盖。
5. full 模式调用 source engine 暴露的 `forkSession()`/其 `SessionManager`；summary 模式先冻结范围、摘要，成功后调用
   `createFromContextTransfer()`。
6. 错误响应只带 id/range/error code，不回显 transcript/summary 正文。

`ChatSessionManager` 增加一个小的只读方法，例如 `getIdle(sessionId)`，把 busy/queue 检查集中起来；不要让 server 通过 `as any` 读取内部 map。

#### `packages/core/src/protocol/client.ts`

增加：

```ts
async forkSession(params: ForkSessionParams): Promise<ForkSessionResult> {
  return this.request(Methods.ForkSession, params) as Promise<ForkSessionResult>;
}
```

这样 TUI/SDK 后续可复用，desktop 只做 host transport，不拥有私有 fork 语义。

### 3.5 Engine：full fork 门面与 context package 摘要

#### `packages/core/src/engine/engine.ts`

增加公开门面，避免 protocol server 直接触碰 Engine 的 private `sessionManager`：

```ts
forkSession(sourceSessionId: string, options?: ForkSessionOptions): ForkSessionResult;

async summarizeContextPackage(
  messages: readonly Message[],
  options: { signal?: AbortSignal; targetTokens?: number; sourceSessionId: string },
): Promise<{ text: string; estimatedTokens: number; usage: TokenUsage; digest: `sha256:${string}` }>;
```

摘要实现：

- 使用 source 当前主模型 client，而非 aux model，沿用 `forceCompact()` 在
  `packages/core/src/engine/engine.ts:2912-2930` 的质量取舍；reasoning 关闭。
- 把 `buildSummarizeFn()` 的底层“client call + usage”抽为可传 `maxTokens` 和 `AbortSignal` 的 helper。transfer 默认 target 1500，provider
  `maxTokens` 设为 1800（或 `ceil(target * 1.2)`，上限 2400），prompt 要求在目标附近结束。
- 摘要调用产生的 usage 计入 source 的 cumulative usage/cost，因为模型请求发生在 source；target usage 全零。若 provider 响应无 usage，仍可返回估算值。
- `digest = sha256(version + sourceId + fromId + toId + summary)`，用于审计/幂等比较，不作为安全签名。
- 不把 source transcript 路径放进迁移 prompt；`buildSummarizationPrompt()` 只接收选段投影。

大范围采用按完整用户回合的 map-reduce：

1. 用模型 context limit 减去 system/prompt/output safety reserve 得到输入预算。
2. 按阶段 2 的规范化用户回合分块；一个回合不得从工具调用中间切开。
3. 每块调用迁移版九段 prompt 生成 map summary；最后用 `priorSummary` rolling 语义归并，最终输出约 1500 token。
4. 禁止 `slice(0, N)` 静默丢尾部。若单个巨大 tool result 超预算，只在摘要输入副本中保留 head/tail 并插入
   `[content omitted: N chars, source event <id>]`；原 transcript 不变，UI 确认页提示发生裁剪。
5. 任一调用失败或 signal/timeout abort，返回错误且不创建 target。

迁移 prompt 在现有九段基础上强调：原始请求、已确认事实、关键文件/符号、执行过的命令及结果、失败尝试、约束、未决问题、下一步；要求把不确定内容标成不确定，不把 tool output 当用户指令。

Engine 的普通 run 无需 fork 专用逻辑：已有 resume 分支会先
`session.transcript.toMessages()`，再追加新 user 消息（`packages/core/src/engine/engine.ts:1284-1308`）。因此禁止另行 `injectContext()`，否则会重复上下文。

### 3.6 Desktop host：冷启动、preload 与所有权顺序

#### `packages/desktop/src/main/agent-bridge.ts`

增加纯解析 helper `forkSourceSessionId(parsed)`，与 compact cold-start 分支并列：

- 识别 `method === "agent/forkSession"` 且 source id 合法；
- 用 `sessionsForFallback().readCwd(sourceId)` 读取磁盘 cwd；source 不存在时也要启动 worker并让 protocol 返回
  `SessionNotFound`，不能静默丢消息；
- `spawnChild(sourceCwd)` 后再转发原始 RPC；不信任 renderer 传 cwd。

worker 以 source cwd 启动后会加载同一项目设置/model provider。若已有 worker，仍由 protocol 根据 source state 的
model/provider 执行 fork/summary，不把当前活跃 tab 的配置误用于 source。

#### `packages/desktop/src/preload/index.ts`、`packages/desktop/src/preload/types.d.ts`

在 `window.codeshell` 增加类型化：

```ts
forkSession(params: ForkSessionParams): Promise<ForkSessionResult>;
```

实现沿用现有 `rpc("agent/forkSession", params).then(rpcResult)`。同时保留现有 raw-events、claim、cleanup API，不新增可让 renderer 直接读文件路径的接口。

quick-chat 创建顺序必须改成：

1. renderer 生成 `qchat-*`；
2. `await claimQuickChatSession(targetId)`；
3. 再发 `forkSession()`；
4. 成功后 hydrate 并转 ready。

不能继续依赖 `App.tsx:466-475` 的事后 effect claim，否则 tab 在 fork 中关闭时 cleanup 可能先于 claim，留下无 owner target。claim 失败则不调用 fork。

### 3.7 阶段 1 renderer：quick-chat 默认携带 owner 上下文

#### `packages/desktop/src/renderer/quickChatSession.ts`

扩展 ref：

```ts
export type QuickChatContextMode = "full" | "blank";
export type QuickChatCreationStatus = "creating" | "ready" | "error";

export interface QuickChatSessionRef {
  // existing fields...
  sourceSessionId: string | null;
  contextMode: QuickChatContextMode;
  status: QuickChatCreationStatus;
  error?: { code?: number; message: string };
  creationNonce: string;
}
```

`creationNonce` 防止旧 promise 回写一个已关闭/重开的同 key tab。

#### `packages/desktop/src/renderer/App.tsx`

把 `ensureQuickChatSession()` 改为显式异步编排函数（state updater 只登记 creating，不在 updater 内做副作用）：

1. 从 `ownerBucket` 调 `resolveEngineSessionIdForBucket()` 得到权威 core source id；不能把 UI session id 或 bucket 当 source。
2. 若 owner 是尚未首次发送的草稿，没有 engine id，则用 `contextMode: "blank"` 创建空白 target，并显示“当前对话尚无可分叉历史”；不要偷偷 fork 上一个 active engine。
3. full 模式先 claim，再调 `{ sourceSessionId, targetSessionId, mode: "full" }`。
4. 成功后 `foldTranscript(await getSessionTranscript(targetId))`，dispatch `hydrate` 到 quick bucket；建立
   `engineToBucketRef`，再把 status 设为 ready。
5. 把 owner bucket 的 `modelOverrides`、`permissionOverrides` 复制到 target bucket。协议虽支持每次 run 的 `planMode`
   （`packages/core/src/protocol/types.ts:143-147`），renderer 目前没有 per-bucket plan override map；第一阶段不凭空发明一套状态，只让既有默认值生效。goal 不复制。
6. 失败保留 error 状态，提供“重试分叉”和“改为空白”两个动作；retry 可复用同 target id 的前提是 protocol 保证失败未发布目录，否则先 cleanup 再生成新 id。
7. tab 在请求完成前关闭：cleanup effect 记录 nonce 已失效；fork promise 返回后若 target 已不在
   `quickChatSessionsRef`，立即调用 cleanup，不 hydrate/写 override。

source busy 的 `Overloaded` 不自动 fork 到更早游标；UI 文案是“当前回复结束后重试”，确保用户知道快照时间。

#### `packages/desktop/src/renderer/panels/QuickChatPanel.tsx`、i18n 文件

- Header 显示“来自：<source title>”和“共享工作区”。
- `creating` 显示 spinner，composer disabled；`error` 显示可重试错误；`ready` 才允许 send。
- `canSend` 改为 `trimmed.length > 0 && !busy && status === "ready"`。
- 新建 quick-chat 的入口默认 full，菜单提供“空白侧聊”；空白也先 claim，再以第一次 `agent/run` 创建。
- 继承历史使用现有 `MessageStream`，不做另一套只读气泡。target 新消息和 source 新消息互不订阅。

### 3.8 阶段 2 renderer：完整回合范围选择

#### 新增 `packages/desktop/src/renderer/contextTransferSelection.ts`

定义纯函数：

```ts
export interface SelectableTranscriptTurn {
  id: string;
  fromEventId: string;
  toEventId: string;
  clientMessageId?: string;
  eventIds: string[];
  live: boolean;
}

export function buildSelectableTurns(
  events: readonly RawTranscriptEvent[],
  options: { liveTail: boolean },
): SelectableTranscriptTurn[];
```

回合边界规则必须固定：

- 起点是 `type: "message"`、`role: "user"`、`data.injected !== true` 的真实用户事件；
- 终点是下一个真实用户事件之前的最后一个事件，末回合则到冻结快照尾；
- injected reminder/steer、assistant、tool use/result、subagent/file changes 都归入当前用户回合；
- renderer 用户气泡优先用 `clientMessageId` 对应 raw message（该字段已在
  `packages/desktop/src/renderer/types.ts:16-38`），旧 transcript 无该字段时按真实用户消息 ordinal 回退；
- 只能选择一个或多个连续回合；live 尾回合整体 disabled，不能把已显示的半段 assistant/tool result 当完成范围。

Core 必须重复相同语义校验，renderer 只负责交互，不能成为安全边界。

#### `packages/desktop/src/renderer/MessageStream.tsx`、`ChatView.tsx`

保持 `MessageStream` 为渲染组件，增加可选 props：

```ts
selection?: {
  turns: SelectableTranscriptTurn[];
  selectedRange: { firstTurnId: string; lastTurnId: string } | null;
  onSelectTurn(turnId: string): void;
  onConfirm(): void;
  onCancel(): void;
  submitting: boolean;
};
```

`MessageStream` 在 user bubble 外层渲染 checkbox/范围高亮；折叠的 tool/process card 随所属 user turn 整体高亮，不能逐卡选择。
`ChatView` 提供“选择上下文并新建”入口和底部 toolbar，负责 loading/错误提示。进入选择模式时调用一次
`getSessionRawEvents(engineSessionId)` 冻结选择视图；会话继续产生新消息时不自动扩展 snapshot，busy 时直接禁用入口。

#### `packages/desktop/src/renderer/App.tsx`、`transcripts.ts`

确认后调用 summary variant，成功后：

1. 根据返回 `workspace.root/cwd` 找到或创建对应 project cache（沿用现有 cwd→repo reconciliation）。
2. 用 `createSession(repoId, titleSuggestion)` 创建普通 UI row，再用 `bindEngineSession()` 绑定返回 target core id
   （相关函数在 `packages/desktop/src/renderer/transcripts.ts:527-546`、`:581-593`）。
3. 从磁盘 hydrate target transcript，切换到新 sidebar session；本地保存的只是显示 projection，磁盘 summary 才是权威来源。
4. 若 protocol 已成功、但 local index 写入前 renderer 崩溃，target `parentSessionId: null` 且 origin 合法，现有 disk rebuild 可重新发现；重复导入按 `engineSessionId` 去重。
5. summary target 不是 `qchat-*`，不进入 quick-chat ownership，也不会随 panel 关闭清理。

### 3.9 阶段 2 Core：范围规范化与持久化 context package

在 `SessionManager`/`Transcript` 附近新增纯函数 `normalizeContextTransferRange(events, range)`：

1. 两端 id 必须存在且 `fromIndex <= toIndex`。
2. 把两端规范化到完整真实用户回合边界；推荐严格模式：若传入不是 renderer 计算出的精确回合首尾，返回 `InvalidParams`，不静默扩大用户选择。
3. 范围内至少有一个真实 user message；所有 tool use/result 配对必须闭合。
4. 过滤 `session_meta/file_history/plan_operation/goal_progress/error/turn_boundary/turn_stopped` 等非模型上下文事件后，调用
   `eventsToMessages()`；既有 `summary` 保留，以免选中一段已压缩历史时丢背景。
5. 冻结 source state、规范化 range 和 messages 后才开始模型请求；摘要期间 source 可以继续运行，因为输入数组已深拷贝，lineage 指向确认时的固定 id 范围。

成功后 `createFromContextTransfer()` 写：

```json
{
  "type": "summary",
  "data": {
    "summary": "...",
    "trigger": "context_transfer",
    "source": {
      "sessionId": "source-id",
      "fromEventId": "event-a",
      "toEventId": "event-z",
      "eventCount": 42
    },
    "version": 1,
    "digest": "sha256:...",
    "estimatedTokens": 1487
  }
}
```

`toMessages()` 继续把 summary 投影为 user-role `<system-reminder>`（现状在
`packages/core/src/session/transcript.ts:197-203`），不要写中途 `role: system`，也不要伪装成 assistant answer。

#### `packages/desktop/src/main/transcript-reader.ts`、`packages/core/src/types.ts`、renderer message/card

当 `summary.trigger === "context_transfer"` 时，replay 发一个带 summary/provenance 的新 stream event，例如：

```ts
type StreamEvent =
  | {
      type: "context_transfer";
      summary: string;
      sourceSessionId: string;
      fromEventId: string;
      toEventId: string;
      estimatedTokens: number;
    }
  | /* existing variants */;
```

renderer reducer 生成 `ContextTransferMessage`，新建 `ContextTransferCard` 显示可折叠摘要、来源 session 链接和范围，不再显示 before/after=0 的 compact 分隔线。普通 `trigger: auto` 的 summary 仍走原
`context_compact`，避免 UI 回归。

## 4. 分阶段 / 分步骤实施顺序

### 阶段 1A：Core 磁盘语义（独立 PR）

1. 在 `types.ts` 增加 `SessionForkLineage` 与可选 `forkedFrom`。
2. 给 Transcript 增加无副作用 parser、`eventsToMessages()`、导入/序列化 helper。
3. 抽取 session state 构造和 staging-directory 原子发布 helper。
4. 重写 `SessionManager.fork()` 为事件游标签名；删除 turn-number overload。
5. 重写 `tests/session.test.ts`：不再断言 `parentSessionId=source`，改为 lineage、workspace、meta、事件和原子性矩阵。

阶段验收：仅调用 `SessionManager.fork()` 就能得到自包含、top-level、可 resume 的 target；source 文件 hash 不变；失败不留下正式 target。

### 阶段 1B：Core 协议与 desktop host（独立 PR）

1. 增加 `ForkSessionParams/Result`、`Methods.ForkSession` 和 client 方法。
2. 增加 server handler、source idle/queue/存在性检查、错误码映射。
3. Engine 暴露 fork 门面。
4. AgentBridge 增加 fork cold-start，preload/type declaration 暴露 API。
5. 补 protocol、bridge、preload contract 测试。

阶段验收：worker 冷/热两种状态都能通过 RPC fork；busy source 可恢复地失败；target 冲突不覆盖。

### 阶段 1C：quick-chat 接入（独立 PR）

1. 扩 `QuickChatSessionRef` 状态机和纯函数测试。
2. `ensureQuickChatSession` 改为 claim→fork→hydrate，处理 nonce/close/retry 竞态。
3. 复制 model/permission override，保留 blank 入口。
4. Panel 显示 creating/error/source/shared-workspace，ready 前禁发。
5. 扩展 cleanup/ownership 和 App quick-chat 测试。

阶段 1 总验收：

- 当前完整历史在侧聊打开后可见，首个新问题能引用旧上下文；
- source 与 target 后续消息互不可见，任一重开都独立恢复；
- 默认 full，用户可明确选 blank；owner 草稿不会误用别的 source；
- 关闭 quick-chat 只删 target，不删/改 source；
- worktree 指针相同且不会被任一侧误删；
- fork 中关 tab、source busy、worker cold-start、磁盘写失败均不会留下半成品或可发送的空 target。

### 阶段 2A：摘要 Core（独立 PR）

1. 增加 `SummaryEventData` union、context-transfer append/replay 数据类型。
2. 增加范围规范化、事件切片→messages、tool pair 校验测试。
3. 抽取 Engine 摘要调用，加入 target token、signal、usage、digest。
4. 实现按完整回合 map-reduce 和大 tool result 明示裁剪。
5. 实现 `createFromContextTransfer()`，确保 summary 成功后才发布 target。
6. 打开 protocol summary variant。

阶段验收：给定 event range 可产生仅含 meta+summary 的可 resume target；重启后模型只看到 summary；摘要失败无 target。

### 阶段 2B：选择 UI 与普通 session 落地（独立 PR）

1. 增加 `contextTransferSelection.ts` 和 turn mapping 单测。
2. `ChatView/MessageStream` 加连续完整回合选择与 toolbar；live 尾回合禁选。
3. App 调 summary RPC，登记/bind/hydrate 普通 sidebar session。
4. main transcript reader + reducer + `ContextTransferCard` 显示 provenance。
5. 增加端到端 renderer 编排与重启恢复测试。

阶段 2 总验收：

- 只能选连续、已完成的完整回合，工具卡自动随所属回合；
- target 模型上下文没有选段外内容，原始选段不复制到 target；
- 最终摘要约 1,500 token，大范围分块而不丢尾；
- target 复用 source workspace/model/provider，usage/goal/control state 为新会话；
- summary 调用失败、超时或 renderer 中途退出不会产生可见空 session；
- target 跨 worker/desktop 重启恢复为一个背景包卡，随后正常续聊。

## 5. 测试策略

### 5.1 Core unit：Transcript / SessionManager

扩展 `tests/session.test.ts`，另建议新增 `packages/core/src/session/transcript.fork.test.ts`：

- 默认游标复制到冻结数组最后事件，包括没有末尾 `turn_boundary` 的自然结束回合。
- 显式 `throughEventId` inclusive，未知/重复 id、session_meta id、半个 tool round 均拒绝。
- target 恰好一个自己的 `session_meta`；source meta 不出现。
- target event id 全部新生成且唯一；timestamp/turnNumber/toolCallId/data 保留；下一次 append turnNumber 连续。
- source `state.json`/transcript 字节 hash 在 fork 前后不变，证明未触发 repair side effect。
- source worktree 被深拷贝；修改 target state object 不会改 source object。
- `parentSessionId === null`、`forkedFrom` 正确；usage/cost/goal/turn counters/invokedSkills 清零。
- source/target 继续 append 后事件互不出现；删 target 不影响 source。
- 模拟 state 写、transcript 写、rename 失败：正式 target 不存在、staging 被清理；现有 target 不被覆盖。
- unsupported 新 event type fail closed；denylist control event 不复制。
- `eventsToMessages(allEvents)` 与改造前 `Transcript.toMessages()` fixture 完全相等。

### 5.2 Protocol / Engine

新增 `packages/core/src/protocol/server.fork.test.ts`：

- full params/result schema、server-generated/host-provided target id。
- missing source→`SessionNotFound`；busy 或 queueDepth>0→`Overloaded`；target exists→`InvalidParams`。
- full fork 成功前后不向 source/target发送 stream event，不误启动 run。
- cold source 和 live idle source 结果一致。
- target 首次 `Engine.run()` 的 provider input 顺序是 copied history→新 user message，且没有重复 system reminder。

summary 侧测试：

- 精确完整回合可摘要，非边界/反向/空范围/不闭合 tool pair 拒绝。
- 默认 1500、上下限 clamp；主模型、reasoning off、max output 合理。
- 多块输入按顺序全部进入 reduce；尾块 sentinel 出现在最终摘要请求，证明未截尾。
- provider error/abort 不创建 target；usage 计 source、不计 target。
- context transfer event 的 version/source/digest/token estimate 正确；kill/recreate Engine 后 `toMessages()` 仍含摘要。

### 5.3 Desktop main / preload

- `AgentBridge` 收到 fork 时：worker dead→按 source cwd spawn；source 缺失仍产生 RPC 错误响应而非 30 秒 timeout；worker live 不重复 spawn。
- preload 参数原样转发、`rpcResult` 解包错误；types 与 runtime API 名一致。
- quick-chat claim 必须发生在 fork 前；无 claim/fork 失败时 cleanup 不越权。
- raw events 对 malformed line、stable id、large transcript 上限的既有行为回归。
- transcript reader：auto summary 仍映射 compact；context_transfer summary 映射新卡且 provenance 完整。

### 5.4 Renderer unit / integration

- `buildSelectableTurns()`：真实 user、injected user、连续 tool calls、summary、旧记录无 clientMessageId、最后 live 回合等 fixture。
- 选择首尾自动形成连续范围；不能跳选；折叠工具组属于正确 user turn。
- quick-chat creating/error 时不能 send；ready 后只发一次；retry/blank 行为正确。
- owner bucket→engine id 解析使用 `SessionSummary.engineSessionId`，不会误传 UI id。
- fork 完成 hydrate copied transcript；source 后续 event 不进 target bucket，反之亦然。
- fork pending 时关 tab：晚到成功会 cleanup，不能 setState/hydrate 已删除 bucket。
- summary 成功创建普通 UI row、bind engine id、hydrate/activate；重复 disk import 不产生双行。
- `ContextTransferCard` 可折叠、来源链接正确；摘要正文不写日志。

### 5.5 worktree 与手工回归矩阵

复用并扩展现有 shared-worktree owner guard 测试：

| 场景 | 期望 |
|---|---|
| main workspace full fork | 两边 `workspace.root` 相同，均可续聊。 |
| CodeShell-created worktree full/summary fork | 不创建第二 worktree；两个 state 都指向同一路径。 |
| source 先 release/remove worktree | 因 target owner 存在而跳过删除；source 切 main，target 保持。 |
| target 先删除 | source workspace 与文件不变。 |
| 两边同时修改同文件 | UI 显示共享警告；行为是共享磁盘现状，不宣称隔离。 |
| source 继续 compact/delete | target copied transcript/summary 仍可恢复。 |
| desktop/worker 重启 | full 历史或 transfer summary 从 target 自己的 JSONL 恢复。 |

测试实现阶段应执行相应 Bun/Vitest 套件及 typecheck；本文任务只产出方案，不在本次文档工作中运行测试。

## 6. 风险与兼容性注意

### 6.1 持久化兼容

- `forkedFrom` 可选，旧 `state.json` 无需迁移；`parentSessionId` 的旧 sub-agent 语义不变。
- 旧版本会忽略新 state 字段和 summary data 字段；但若旧 desktop 把 transfer summary 显示成 compact 分隔线，模型上下文仍能恢复。发布时应 core/main/renderer 同版本，避免降级 UI。
- 不保留旧 `fork(source, number)` overload，防止继续制造错误快照；仓库当前只有测试调用，迁移成本可控。
- target 的新事件 id 意味着不能用 source event id 去 target 做 undo/selection；lineage 只负责跳回 source。

### 6.2 一致性与竞态

- protocol 的 idle 检查与同步快照只在同一 worker 事件循环内成立；desktop 不应另开第二个 worker 同时写同一 source。现有“一 worker bridge”模型满足此前提，测试需覆盖冷启动切换。
- summary 在快照冻结后允许 source 继续；UI 要显示选择发生时的范围，而不是声称摘要包含后来消息。
- target id 是 client-minted 时必须做路径安全和存在性检查。原子 rename 是唯一发布点；不得用 `create()` 后再回滚作为常态。
- `Transcript.flush()` 吞错的现状不能进入 fork publish 路径；否则 RPC 可能返回成功但 JSONL 不完整。

### 6.3 上下文正确性

- full fork 会复制已有 summary 与后续事件；`eventsToMessages()` 的投影必须与 source resume 一致，否则“UI 看见完整历史、模型实际少一段”。
- `turnNumber` 不是用户回合边界。阶段 1 用 event cursor，阶段 2 用真实 user event 分段，禁止重新引入 `turnCount`/boundary 推断。
- 工具调用必须成对。busy fail-fast 只能避免新的半回合，历史 crash 仍可能有 dangling call，需显式 target-side interrupted result 或拒绝。
- `subagent` 卡可作为历史复制，但 target 不拥有 child session、approval 或 background job；任何“停止/继续子代理”按钮在 fork 历史卡上必须禁用。

### 6.4 成本、大小与摘要质量

- full fork 会放大磁盘，包含图片/大型 tool result 时还可能超过下一轮 context window。第一阶段应在 UI 显示 source event 数/估算大小；超过阈值提示改用“选段压缩”，但不偷偷改成 summary。
- 不使用 hard-link：JSONL 后续 append 会污染两边；完整复制的磁盘成本是自包含恢复的明确取舍。
- 1,500 token 摘要是有损表示。UI 保留 source 链接与范围，提示在新任务中重新 Read 当前 worktree 的关键文件。
- 分块摘要会增加模型调用和费用；确认页显示估算输入 token/块数，失败不收费承诺不可做，只能准确记录已发生的 source usage。

### 6.5 安全与隐私

- summary 会把所选 tool output 再发给当前 provider，并把结果明文写 target transcript；沿用现有 credential redaction，确认页显示范围和 provider。
- renderer 只能提交 event id，Core 从自己的 source transcript 取内容；不接受 renderer 上传任意“摘要原文”冒充历史。
- 日志不得记录 summary 正文、消息内容或 tool result，只记录 session ids、event range、count、digest、duration/error class。

### 6.6 共享 workspace 的语义

- owner guard 只防删除，不防并发写、git checkout 或互相覆盖文件。两个 session header 均显示“共享工作区”，并链接回 lineage/source。
- fork 不复制 file-history undo state，避免 target 回滚 source 已做修改；需要隔离时由用户显式创建/切换 worktree。
- delete/release 路径必须继续用现有 owner 枚举；不得因为 target 是 fork 就绕过 guard，也不得将 lineage source 等同于 workspace owner。

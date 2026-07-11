# 快聊创建后，父会话新增上下文是否传播

> 调研日期：2026-07-12
> 分支：`feat/quickchat-ephemeral`
> 问题：快聊已经打开后，父 session 再完成新 turn，这些新内容会不会进入现有 child？

## 1. 明确回答

**不会。** 当前 CodeShell quick chat 与 Codex `/side` 一致，是创建时的**时间点快照 fork**，不是
对父 transcript 的 live view：

- side 创建时只复制父 session 截至 `completedThroughEventId` 的事件；父当时未完成的尾部不复制；
- child 得到独立 session ID、独立磁盘目录、独立 `Transcript` 实例和独立 `ChatSession/Engine`；
- fork 返回后，父 transcript 的新增 turn 只追加到父文件，既不会修改 child 文件，也不会进入 child
  下一次模型请求；
- renderer stream 按非空 `sessionId` 精确路由。父的新 stream 只进父 bucket，不会广播到 quick-chat
  bucket；未知非空 ID 也不会借 `runningBucket` 猜测路由；
- renderer 保存 `sourceSessionId` 只用于创建时发起一次 fork。ready 后没有“同步父更新”路径。

因此用户若希望侧聊看到父 session 的最新上下文，需要关闭并重新打开快聊，触发一次新的 fork。不能在
本轮增加 live 同步；那会破坏 `/side` 的时间边界，并重新引入 parent/child 串漏风险。

## 2. Fork 是值复制，不是父对象引用

### 2.1 读取的是父磁盘快照

**[事实]** `SessionManager.fork()` 先调用 `readForkSnapshot()`，再用返回的 frozen data 构造 target，
最后通过 `publishSessionAtomically()` 发布新目录；函数没有把 source `Transcript` 对象放进 target：

- `packages/core/src/session/session-manager.ts:690-716`

**[事实]** `readForkSnapshot()` 直接读取父 `state.json` 和 `transcript.jsonl`，随后立即
`structuredClone(parsed.events)`。side 的 `snapshotMode: "completed"` 使用父 state 中持久化的
`completedThroughEventId`；若 cursor 存在，只保留到该事件（含）为止：

- 读取父文件：`packages/core/src/session/session-manager.ts:719-742`
- 选择 completed cursor 并截断：`packages/core/src/session/session-manager.ts:743-772`

**[事实]** 被允许复制的每个 event 又执行一次 `structuredClone(event)`；返回的 source state 也被 clone：

- `packages/core/src/session/session-manager.ts:774-783`

这意味着 fork 完成后，父内存 event 对象即使被修改，也不可能通过 JavaScript 引用改变
`snapshot.copiedEvents`。

### 2.2 Target 是独立目录和独立 Transcript

**[事实]** `buildForkTranscript()` 对 source event 再做 clone，并给 target event 生成新 ID。target
metadata 使用 target session ID；parent 只作为 `forkedFrom` lineage 数据存在：

- `packages/core/src/session/session-manager.ts:878-905`
- `packages/core/src/session/session-manager.ts:908-933`

**[事实]** target state/transcript 先写到独立 staging 目录，再 rename 成
`sessions/<targetSessionId>/`；发布成功后 `resume(targetSessionId)`。这里没有软链接、共享文件或父
Transcript 引用：

- `packages/core/src/session/session-manager.ts:786-815`

**[事实]** `resume(sessionId)` 根据传入 ID 打开对应目录的 `state.json` 和 `transcript.jsonl`，并调用
`Transcript.loadFromFile(targetTranscriptPath)` 创建新的 `Transcript` 实例：

- `packages/core/src/session/session-manager.ts:570-597`
- `packages/core/src/session/transcript.ts:422-445`

**[推断]** 父在 fork 后追加新事件时，父 `Transcript.append()` 只 flush 到父实例自己的 `filePath`；
child instance 的 filePath 是 target 路径，因此父更新无法进入 child 文件。这一推断直接来自
`Transcript` 的 per-instance `filePath/events` 字段和 append/flush 路径：

- `packages/core/src/session/transcript.ts:26-57`

## 3. Child 模型上下文不会重新读取父历史

**[事实]** 每个 `ChatSession` 持有自己的 ID、Engine、queue、active turn 和 controller：

- `packages/core/src/protocol/chat-session.ts:46-66`

**[事实]** `ChatSessionManager` 为新的 session ID 调 engine factory 创建新 Engine，再把它注册到该 ID；
parent 和 qchat child 是两个 map entry：

- `packages/core/src/protocol/chat-session-manager.ts:71-96`

**[事实]** child turn 执行时，`ChatSession.pump()` 固定把 `this.id` 作为 `Engine.run()` 的
`sessionId`：

- `packages/core/src/protocol/chat-session.ts:225-250`

**[事实]** `Engine.run()` 发现该 child ID 已在磁盘存在时，只 `resume(childId)`，并从 child
`session.transcript.toMessages()` 构造模型消息；此路径没有读取 `forkedFrom.sessionId` 或父 transcript：

- `packages/core/src/engine/engine.ts:1128-1172`
- `packages/core/src/engine/engine.ts:1189-1220`

因此 child 第一次调用看到“fork 时复制的父历史 + child 新问题”，后续调用看到“同一份 child
transcript 后续增长”；父 fork 后的新 turn 不在这个文件中，不会进入模型上下文。

## 4. Renderer 不会把父新事件投到 child UI

### 4.1 Stream envelope 保留 session 身份

**[事实]** AgentServer 为某个 `sid` enqueue turn 时，把每个 stream event 包装为
`{ sessionId: sid, event }`；父 turn 的 sid 始终是父 ID，child turn 的 sid 始终是 child ID：

- `packages/core/src/protocol/server.ts:738-790`

**[事实]** renderer `resolveBucket()` 对非空 sessionId 只接受：

1. `engineToBucket` 的精确 key；或
2. session index 中 `engineSessionId === sessionId` 的精确反查。

若仍找不到，非空 sessionId 返回 `null`；只有空 ID 的 legacy event 才能使用 `runningBucket`：

- `packages/desktop/src/renderer/streamRouting.ts:21-50`

**[事实]** App 收到 stream 后只把 event push 到 `resolveBucket()` 返回的单一 target；找不到 target
就 return。quick-chat `session_started` 也只建立 `child sessionId -> child bucket`：

- `packages/desktop/src/renderer/App.tsx:1689-1748`
- `packages/desktop/src/renderer/App.tsx:1750-1777`

父 ID 与 child ID 不同，所以父的新事件不能命中 child route。该规则也与已合并的 late approval /
AskUser fail-closed 一致：未知 qchat generation 会被 deny，而不是回退进 active parent/child：

- `packages/desktop/src/renderer/App.tsx:2013-2050`

### 4.2 Quick-chat ready 后没有 parent→child sync

**[事实]** renderer 打开 quick chat 时只解析一次 owner 的 engine ID，保存在
`QuickChatSessionRef.sourceSessionId`，然后启动创建流程：

- `packages/desktop/src/renderer/App.tsx:3244-3272`

**[事实]** full 路径只在创建阶段把 source ID 发给 `forkSession()`；fork 成功后建立的是
`result.sessionId -> child bucket`。当前实现不会再读取 target transcript 来 hydrate 父气泡，而是明确
`foldTranscript([])`，让 UI 从 child 边界开始：

- `packages/desktop/src/renderer/App.tsx:3177-3201`

这也修正了旧设计/旧调研中的描述：**当前 merged 代码并没有在 fork 后调用
`getSessionTranscript(target)` 再 fold 父历史**；父历史只留在 child 的磁盘/模型上下文中。

**[事实]** renderer quick-chat 代码中 `sourceSessionId` 的使用只出现在 session ref 定义、blank/full
判断、初次 fork 参数和创建时解析 owner ID；没有订阅父 transcript、轮询父 state、或在父
`turn_complete` 时再次 fork/inject 的路径：

- `packages/desktop/src/renderer/quickChatSession.ts:7-19`
- `packages/desktop/src/renderer/App.tsx:3155-3184`
- `packages/desktop/src/renderer/App.tsx:3244-3272`

**[推断]** 在当前代码边界内不存在 parent→existing-child 的隐式同步路径。这个结论建立在上述完整
调用链和 `sourceSessionId` 全仓库检索上；它不是对未来新增插件/外部人工改写 child transcript 的保证。

## 5. 与 Codex `/side` 的语义对照

| 场景                      | Codex `/side`                                  | 当前 CodeShell quick chat                      |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| 创建时父已完成历史        | 复制到 child 模型上下文                        | 按 completed cursor 深拷贝到 target transcript |
| 创建时父有 in-flight 尾部 | interrupted/completed snapshot，不当成完成历史 | 截到 `completedThroughEventId`                 |
| side 打开后父新增 turn    | 只进 parent store                              | 只写 parent transcript、只路由 parent bucket   |
| child 后续调用            | 使用 child 自己增长的 transcript               | `resume(childId)`，不重新读取 parent           |
| 想获得父最新上下文        | 退出后重新 `/side`                             | 关闭并重开 quick chat，重新 fork               |

结论：这一维度**现状已经对齐**，不需要生产代码修复。本轮只补守护测试，锁定两条不变量：

1. fork 后父再完成新 turn，child 磁盘 transcript 与下一次 provider messages 不含父新增内容；
2. quick chat 打开后父 stream 只更新父 UI，不追加到 child UI。

## 6. 风险边界与非目标

- 不实现 live parent sync、自动 rebase、增量 inject 或“每次 child send 前重读 parent”。
- 不改变现有 ephemeral close cleanup、completed-turn cursor、隐藏父气泡、claim/generation 或 approval
  隔离。
- parent/child 仍可共享 workspace，因此父之后写入的**文件内容**可能被 child 工具读取；这是共享文件系统，
  不是 transcript/context 自动传播。本文结论只针对 conversation history、模型消息与 UI stream。
- 若未来产品需要 live mode，必须作为显式且独立的模式设计冲突、turn boundary、tool pair 与路由语义，
  不能悄悄改变 quick chat `/side` 默认语义。

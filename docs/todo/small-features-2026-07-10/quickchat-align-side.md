# Quick Chat 对齐 Codex `/side`

## 目标与不变量

侧边快聊默认是带父上下文的临时 child session，但视觉上从空 transcript 开始。父会话正在运行时也应立即打开；child 只能继承父会话最后一次自然完成的 conversation turn，不能继承当前 in-flight user/assistant/tool 尾部。

必须同时保持：普通 `agent/forkSession` 对 busy/queued source 继续返回 `Overloaded`；父/子 session、stream、approval、steer 与 renderer bucket 各自独立；关闭/替换 quick chat 后，旧 claim/nonce 的异步结果与 stream 不得复活旧 bucket。

## Brainstorming：设计空间

### 1. busy 时一律拒绝，或等待 parent 完成

优点是复用现有 busy guard，快照天然完整。缺点是违背 `/side` 的核心体验：主任务运行时恰恰是用户需要支线提问的时候；等待还会引入 pending fork 生命周期与取消竞态。因此只保留给普通 fork，不用于 quick chat。

### 2. renderer 从当前消息列表猜稳定边界

可以快速隐藏最后一个 optimistic user bubble，但 renderer 不掌握磁盘 event cursor、tool-use/result 配对或 Engine 完成状态。它只能掩盖气泡，不能保证 child 模型上下文合法，故排除。

### 3. side 复制当前 transcript tail，再给 partial turn 写 interrupted 标记

最接近 Codex 的“中断快照”字面含义，但 CodeShell 现有 transcript 没有可把半个 conversation turn 安全封口的协议：仅加 UI 标记不能修复 tool pairing，也容易把当前用户意图误当成 child 历史。当前需求不需要保留 partial work，故不采用。

### 4. core 记录“最后自然完成 conversation turn”的 event cursor，side 只复制到该 cursor

Engine 在一次 `run()` 以 `completed` 结束时，把 transcript 当时的最后 event id 持久化为稳定 cursor；新一轮 user message 落盘前，该 cursor 仍指向上一轮完整历史。side fork 读取这个权威 cursor：busy 时立即复制到它；没有稳定 cursor（新会话或旧数据）时保守复制零条历史。普通 fork 仍走 tail/显式 cursor 与 busy guard。

这避免把 `turn_boundary` 误当 conversation-turn boundary：CodeShell 的 `turn_boundary` 是一次模型 step，一个用户请求可能跨多个 tool/model steps。

## 选定方案

1. 在 `SessionState` 增加可选的 `completedThroughEventId`。仅当 Engine run 的终态为 `completed` 时更新；中止、错误、超限不推进它。
2. fork 协议增加显式 `forkKind: "side"`。默认仍是普通 fork；只有 side 才绕过 live source busy guard，并要求 core 使用 `completed` snapshot mode。side 与显式 `throughEventId` 不混用，避免把任意 cursor 冒充稳定边界。
3. `SessionManager.fork(..., { snapshotMode: "completed" })` 按持久化 cursor 截断；cursor 不存在/重复时 fail closed。cursor 缺失时默认复制空历史；仅对升级前、磁盘状态明确为 `completed` 的 legacy session 回退到稳定 tail，避免安全可判定的旧历史无谓丢失。fork state 继续由 `buildForkState` 白名单构造，因此不继承 `activeGoal`；approval、steer queue、active writer 都是 Engine/ChatSession 的内存态，目标 sessionId 又是新 ID，不会被复制。
4. desktop quick chat 发送 `forkKind: "side"`。forked transcript 仅作为 child 的模型上下文；renderer 不再读取并 hydrate target 中继承的父事件，而是以空 bucket 标记 ready。child 自己后续的 optimistic/stream 事件照常进入该 bucket。
5. 继续使用现有 quick-chat `claimId`/creation nonce 与 `engineToBucket` 路由：fork/hydrate 完成前后三次 claim 检查可收敛为 fork 后检查；tab 关闭时删除映射、evict bucket、tombstone claim。测试明确覆盖 child 关闭后的迟到事件不进入任何可见 bucket，以及 parent 迟到事件仍只进入 parent。

## TDD 顺序

1. core 红测复现：已完成历史后追加一个模拟 `Engine.run()` 已落盘的 in-flight user message；completed snapshot fork 不得复制该 user 尾部。
2. protocol 红测：普通 busy fork 仍拒绝；busy side fork 成功并把 `snapshotMode: "completed"` 传给 Engine。
3. session 测试：稳定 cursor 截断 user/assistant/tool 尾部；空稳定历史；非法 cursor fail closed；fork state 不继承 active goal。
4. renderer 红测：full quick chat 发 side 参数，target transcript 即使含父 message 也不 hydrate；父/子 stream、approval、busy 与关闭后的 late event 保持隔离。
5. 跑定向 `bun test`，再跑全量 `bun test 2>&1 | tail -5`，区分本次回归与已知基线失败。

## 非目标

不改变普通 fork 的可视历史与 busy guard；不做双 pane 以外的新导航；不实现 quick chat 持久化/会话 picker；不复制 active goal、pending approval、steer queue 或 background control state；不修改 `packages/tui`、`packages/cdp` 或无关 desktop 路径。

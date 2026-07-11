# CodeShell 快聊生命周期与 Codex `/side` 对齐调研

> 调研日期：2026-07-12
> 基线：`feat/quickchat-ephemeral`，基于 `main` HEAD，已包含上一轮 quick chat
> stable-completed fork、隐藏继承气泡与迟到 approval/AskUser fail-closed 修复。

## 1. 结论

CodeShell 快聊当前已经具备 **“关闭时删除 child”** 的主体实现，但还不能称为完整的 Codex
`/side` ephemeral 语义：

1. 正常关闭、替换或 renderer window 销毁时，main 进程会关闭 child Engine，并递归删除
   `~/.code-shell/sessions/<qchat-id>/`。因此 `state.json` 与 `transcript.jsonl` 在成功清理后都会消失，
   并非只解绑 renderer 内存。
2. 普通磁盘会话枚举没有在数据源层识别 ephemeral quick chat。side fork 的 state 是
   `parentSessionId: null`、`origin: "desktop"`，恰好满足普通顶层桌面会话的展示条件；快聊打开期间，
   或清理失败/崩溃留下目录时，`listDiskSessions()`、移动端 session list 与基于
   `SessionManager.list()` 的通用列表都有机会把 `qchat-*` 当普通会话返回。
3. renderer 有一层补救：当当前 repo 的 localStorage session index 为空时，最多读取 30 条磁盘会话，
   过滤 `qchat-*` 并尝试删除非 live 项。但它不是权威生命周期：repo index 非空、不在首 30 条、或未触发
   该 effect 时，残留目录不会被回收。
4. 迟到异步结果已经有独立的 claim/generation 防线：tab 关闭先 tombstone claim；in-flight fork
   结算后只做清理，不把结果送回已销毁 owner；core close epoch 也阻止旧 Engine settle 后重新写 state。
   本轮不应削弱这套隔离。

因此本轮应做的是：保留现有安全关闭顺序，给 ephemeral child 增加持久语义标记/兼容 `qchat-*`
识别；在所有普通列表源头过滤；在新 desktop 生命周期开始、任何 renderer/worker 创建之前回收上次异常退出
留下的 qchat 数据；并用回归测试证明关闭后磁盘无 session/transcript、列表不含 quick chat、迟到 claim
不能复活 child。

## 2. 当前生命周期事实

### 2.1 创建与持久化

- `makeQuickChatSessionId()` 固定生成 `qchat-*`；renderer 为每个 quick-chat tab 分配独立
  session ID、bucket 与 `creationNonce`。
- full quick chat 先 claim，再调用 `forkSession({ forkKind: "side" })`。core side fork 使用最后完成
  turn 的 cursor，目标目录通过 staging + rename 原子发布。目标 transcript 作为 child 模型上下文存在，
  renderer 则 hydrate 空 transcript，因此不显示父历史气泡。
- blank quick chat 在第一次 `agent/run` 时由 Engine 以显式 `qchat-*` ID 创建普通 session 目录。
- 现有 state 没有 `ephemeral` 字段；side fork 的 `forkKind` 只影响本次 RPC 的 snapshotMode，没有写入
  target state。这导致持久层无法从语义字段区分普通 fork 与 side child，只能依赖 ID 约定。

### 2.2 正常关闭/替换到底删什么

renderer 的 stale-tab effect 与 `restartQuickChatSession()` 都会：

1. 从 `quickChatSessionsRef` 移除或替换旧 generation；
2. 删除 `engineToBucketRef` 路由并 `dispatch({ type: "evict" })`；
3. 清 busy、draft、approval route、coalescer 与 sequence 状态；
4. 调用 `cleanupQuickChatSession(oldSessionId, oldCreationNonce)`。

preload 只转发 IPC。main 的 `quickChat:cleanupSession` 并非内存 no-op，而是经
`QuickChatOwnershipRegistry.cleanup()` 校验 owner/claim：

- claim 立即 tombstone，`isClaimActive()` 从此返回 false；
- 若 fork 仍在进行，删除延后到 fork reply/worker exit 的 settle；
- 否则调用 `deleteDesktopSession()`，且同一 session 只删除一次。

`deleteDesktopSession()` 的顺序是：

1. `bridge.closeSession(id)`：向 worker 发 `agent/closeSession`，core 增加 close epoch、cancel child、
   清 session-scoped approval/credential/path 权限，并等待 busy turn settle；
2. `deleteSession(id)`：递归删除现代 session 目录及兼容的旧式 flat JSON/JSONL；
3. 清附件；
4. 忘记 main 内存 snapshot 与 pending mobile approvals。

所以在 cleanup 成功返回后，child 的 `state.json`、`transcript.jsonl` 及 session 目录确实已删除。
关闭只作用于 child ID，不删除或改写 parent。

### 2.3 异常路径

- renderer/window 销毁：main 在首次 claim 时给 `webContents.destroyed` 注册 owner cleanup，逐个 tombstone
  并删除该 owner 的 qchat session。
- 关闭发生在 fork in-flight：ownership registry 返回 deferred；晚到成功、失败或 worker exit 都会 settle，
  tombstoned child 只被删除且不会向已销毁 renderer 回包。
- 整个 desktop 进程被强杀：进程内 cleanup 无法运行。当前唯一后续回收是 renderer 的 disk rebuild
  effect，但它受“当前 repo index 为空”和 30 条分页限制，不能保证覆盖。
- worker close RPC 抛错/超时：`deleteDesktopSession()` 会中止后续 rm，避免在旧 writer 尚未被确认 fence 时
  直接删目录；代价是可能残留。这类目录必须在下一次没有旧 worker 的 desktop 生命周期开始前回收。

## 3. 普通会话列表是否会出现快聊

### 3.1 Desktop sidebar / disk rebuild / mobile picker

`packages/desktop/src/main/sessions-service.ts:listDiskSessions()` 枚举 session 目录，当前规则只保留：

- `parentSessionId` key 存在且值为空（顶层）；
- `origin` 是 `desktop` 或 `automation`；
- cwd 仍存在。

quick chat full fork 继承 desktop origin，并被 `buildForkState()` 明确写成顶层
`parentSessionId: null`；blank quick chat 首次 run 也会成为顶层 desktop session。因此它们会通过这三项
过滤。该 API 同时供 renderer disk rebuild 与 mobile `session.list` 使用。

renderer 在消费结果后虽会过滤 `qchat-*`，但此时数据源已经泄漏，而且 mobile 路径没有 renderer
补救。故当前答案是：**会出现；正常清理足够快时窗口较短，但打开期间或残留时并无源头保证。**

### 3.2 SessionsView 与 core/TUI 列表

- `SessionsView.tsx` 调的是旧式 `listSessions()`；该函数只枚举 flat `.json/.jsonl` 文件，不枚举现代
  session 目录，因此现代 qchat 通常不会在这个页面出现。但旧式/异常 flat `qchat-*` 文件没有过滤。
- `SessionManager.list()` 枚举全部现代 session 目录，当前不看 ephemeral 或 `qchat-*`。CLI
  `code-shell sessions` 和使用该 disk list 的普通 picker 因而可能返回 qchat 残留。
- AgentServer 有 ChatSessionManager 时的 `agent/query sessions` 返回 live manager sessions；若调用者连接到
  持有 quick chat 的同一 worker，live qchat 同样没有通用隐藏标记。

本轮至少必须在持久 session 列表源头过滤；live debug/query 列表不是普通可恢复 picker 的稳定数据源，
不改变其诊断语义。

## 4. 与 Codex `/side` 的逐条差距

| 语义 | Codex `/side` | 当前 CodeShell | 本轮对齐 |
| --- | --- | --- | --- |
| 关闭销毁 | interrupt/unsubscribe child，退出后丢弃；parent 不变 | 正常路径已关闭 child Engine 并删目录；整进程异常残留无权威回收 | 保持安全 close→rm；启动 renderer/worker 前 GC 旧 qchat |
| 不进普通列表 | `ephemeral=true`，不进入普通 session picker | state 无 ephemeral 标记；`qchat-*` 可通过普通 disk/core list | 持久标记 side child；列表兼容按标记或 `qchat-*` 排除 |
| 迟到事件隔离 | thread + generation/claim；退出 child 后旧事件丢弃 | ownership claim/tombstone、fork router、renderer nonce/bucket、core close epoch 已覆盖 | 增加证明测试，不改路由与 approval/AskUser 逻辑 |
| 可选另存为会话 | 需要显式升级/另存为普通 fork；不能改变 side 固定语义 | 当前没有“另存为会话” | 本轮不实现；只记录为后续独立功能 |

## 5. 实现方案与风险边界

### 5.1 本轮改动

1. 给 `SessionState` 增加可选 `ephemeral`；side fork 创建 target state 时写 `ephemeral: true`。
   `qchat-*` 仍作为 blank quick chat 与旧数据的兼容识别。
2. `listDiskSessions()`、旧式 `listSessions()` 与 `SessionManager.list()` 从源头排除
   `ephemeral === true` 或 `qchat-*`，确保 desktop/sidebar/mobile/core picker 不展示。
3. 增加 desktop main 启动前 stale-qchat GC：在任何 window/worker 建立 claim 之前，删除上次进程异常退出
   留下的 `qchat-*` 目录及兼容 flat 文件。
4. 测试覆盖：关闭 cleanup 后目录/transcript 不存在且列表为空；普通 session 保留；side state 标记且
   core list 不含；stale GC 只删 qchat；旧 claim tombstone 后晚到 settle 只删一次且不能重新 active。

### 5.2 不做的事

- 不增加“总是保存快聊”、resume quick chat 或自动升级为普通 session。
- 不改变普通 fork 的持久化与 picker 行为。
- 不改变已合并的 completed-turn snapshot、隐藏父气泡、session/bucket routing、approval/AskUser
  fail-closed。
- 不把共享 workspace 当成共享 transcript；只删除 qchat session 自身数据，不删除 parent 或 workspace。

### 5.3 风险控制

- **不误删用户内容：** 只有固定 `qchat-*` 命名空间和显式 `ephemeral: true` 被隐藏；本产品当前没有将
  qchat 显式保存为普通会话的入口。未来“另存为会话”必须创建/升级成非 qchat、
  `ephemeral !== true` 的普通 fork，再允许 picker 展示。
- **不与 live generation 竞争：** 正常运行期仍只由 ownership claim 清理；启动 GC 必须发生在
  `createWindow()`/worker 之前，不能在任意 list 调用中边枚举边删除当前 live qchat。
- **不让旧 writer 复活：** 正常关闭保持先 close/等待 settle，再 rm；不能为了立即删盘而交换顺序。
- **兼容旧数据：** 老 qchat state 没有 ephemeral 字段，所以列表与 GC 同时保留 `qchat-*` fallback。
- **并行 desktop 进程：** 当前 session store 本身没有跨进程 writer lock；启动 GC沿用单一 desktop
  生命周期所有权假设。若未来正式支持多个独立 desktop 进程共享同一 `$CODE_SHELL_HOME`，需先引入
  跨进程 lease/lock，再允许任一进程回收另一进程命名空间。

## 6. 验收标准

- full/blank quick chat 打开期间均不出现在普通磁盘列表；side fork state 明确为 ephemeral。
- 关闭或替换后，旧 qchat 的 session 目录、`state.json`、`transcript.jsonl` 均不存在。
- renderer/window 销毁与 in-flight fork settle 仍只删除 child 一次；旧 claim 永不恢复 active。
- 上次异常退出留下的 qchat 在下次 desktop 创建 window/worker 前删除；普通 session 完整保留。
- parent busy fork 仍截到最后完成 turn，side UI 仍不 hydrate 父气泡，parent/child stream 与迟到
  approval/AskUser 仍隔离。
- 不出现任何普通 fork/session 持久化行为变化。

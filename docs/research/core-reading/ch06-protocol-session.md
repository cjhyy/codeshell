# 第 6 章 · Protocol & Session

> 覆盖:`protocol/server.ts`(1129)`chat-session-manager.ts` `chat-session.ts` `transport.ts` `types.ts`(Methods)+ `session/transcript.ts` `session-manager.ts`
> JSON-RPC over (in-process | stdio) 的多 session 服务端,以及 session 的磁盘持久化(state.json + transcript.jsonl)。与 [`../session-isolation-state.md`](../session-isolation-state.md) §1/§3 直接对应。

---

## 1. 职责

- **AgentServer**:JSON-RPC 服务端,分发 run/approve/cancel/configure/query/inject/closeSession。
- **ChatSessionManager**:worker 内 session 注册表(maxSessions=16,idleTtl=30min,idle sweeper)。
- **ChatSession**:一个 UI tab 一个 = 一个 Engine + 一个 AbortController + FIFO turn 队列。
- **Transport**:InProcess(同进程函数调用)/ Stdio(NDJSON over stdin/stdout)。
- **Transcript**:JSONL 事件日志(**非**聊天历史),`toMessages()` 派生 Message[] 给 LLM。
- **SessionManager**:session 的 create/resume/saveState/fork/list,sid 路径穿越防护。

## 2. 关键类型 / 入口

- `Methods`(types.ts 276):Run/Approve/Cancel/Configure/Query/Inject/CloseSession(C→S);StreamEvent/ApprovalRequest/Status(S→C 通知)。
- `AgentServer.handleRequest`(server.ts 131)分发;`handleRunMulti`(172,多 session)/ `handleRunLegacy`(229,单 engine)/ `handleConfigure`(450)/ `handleQuery`(508)。
- `ChatSession.enqueueTurn / cancel / pump`(FIFO 队列,串行 turn)。
- `Transcript.toMessages`(79):事件 → Message 的**关键边界**(LLM 永不见事件日志)。
- `assertSafeSessionId`(session-manager 42):sid 路径穿越防护。

## 3. 逻辑主线

### 3.1 一次 run 的服务端路径

```
client → Methods.Run → handleRequest → handleRun → handleRunMulti
   chatManager.getOrCreate(sid, slice) → ChatSession
   session.enqueueTurn(task) → pump():
       new AbortController → engine.run(task, {sessionId, signal, onStream})
       onStream → notify(StreamEvent, {sessionId, event})
   FIFO:第二条 send 在第一条跑完前排队,不丢弃
```

### 3.2 ChatSession 队列(chat-session.ts)

- `enqueueTurn` push 队列 + `pump`;`pump` 若已 active 直接 return(串行)。
- `cancel`:abort 当前 + 排队的全 reject("cancelled")。
- `pump` finally 里若队列还有 → 递归 pump(链式排空)。

### 3.3 ChatSessionManager(chat-session-manager.ts)

- `getOrCreate`:有则刷新 lastActivityAt;无则查 maxSessions(超 → 抛 -32001 Overloaded)→ `engineFactory(slice)` 建 Engine。
- `engineFactory` 闭包持 runtime(共享 modelPool/toolRegistry/mcpPool)—— **这就是 §session-isolation §1 的"所有 session 共享 runtime 单例"来源**。
- idle sweeper:每 60s 扫,`lastActivity < cutoff && !isBusy` 关闭。

### 3.4 Transcript(事件日志 → 消息)

- 事件类型:message / tool_use / tool_result / turn_boundary / summary / session_meta / error。每 append 即 `flush`(appendFileSync,失败静默)。
- `toMessages`:**tool_use 事件被跳过**(注释 89:"已通过 assistant message 的 content blocks 包含")—— tool_result 找上一条 user 消息追加 block 或新建。
- `repairToolResultPairs`(158)+ loadFromFile 时自动修复(补缺失 result、删孤儿 result)。

### 3.5 SessionManager(磁盘)

- `assertSafeSessionId`:拒路径分隔符 / `..` / 非 `[A-Za-z0-9_.-]` / >128 字符。**每个公共入口**(create/resume/exists/saveState/fork)都过。
- `saveState`:原子 tmp+rename。`list`:两遍扫描(pass1 stat 排序取 top-N,pass2 才 parse + tail transcript 取 preview)。
- `readLastUserMessage`:从文件**尾部** 64KiB 块倒读找最后一条 user message(避免 /resume 扫 1k transcript 卡 UI)。

## 4. 逻辑理顺问题

- ⚠️ **`handleConfigure` 的 per-session 分支缺 model —— §session-isolation §3 根因在此逐字确认**(server.ts 454-468):per-session 分支只处理 `planMode`(463)和 `permissionMode`(464),**没有 model**;`model` 只在全局分支(485 `engine.switchModel`)。前端切模型不带 sessionId → 落全局 → 改共享 `activeKey` → 污染其它 session。**修复方向:把 model 加进 454 的 per-session 分支**(complates §session-isolation 方向 A)。本章是该结论的源码实证。

- ⚠️ **ch02/ch05 的 transcript 双写疑问在此澄清**:`toMessages` **故意跳过 tool_use 事件**(transcript 89)。所以 ModelFacade.recordResponse 写的 assistant message(含 tool_use blocks)是 toMessages 唯一会读的;TurnLoop 的 `appendToolUse`(ch02 503)写的独立 tool_use 事件**仅用于事件日志/审计,不进 LLM 消息**。**结论:不是 bug,是设计** —— 但 transcript 里同一 tool_use 出现两次(assistant message 的 block + 独立 tool_use 事件),审计读者可能困惑。建议补注释。

- ❓ **三套 orphan-tool 修复**:ch02 TurnLoop.patchOrphanedToolUses(末尾 push)、engine.ts resume 的 patchOrphanedToolUses(patch-orphaned-tools.ts)、Transcript.repairToolResultPairs(load 时)。三处时机不同(turn 内 / resume 装配 / transcript load),但都解决"tool_use 无 result"。**能否收敛成一处?** 至少 Transcript.repairToolResultPairs 在 loadFromFile 已修过一遍,engine.resume 又用 patch-orphaned-tools 修 messages 一遍 —— 可能重复劳动(transcript 修事件,patch 修 messages,层不同但目标同)。

- ❓ **`ChatSession.cancel` 依赖 engine.run 尊重 AbortSignal**(注释 71 自承)。若 engine.run 吞掉 abort 正常 resolve(ch01 §4 已记 turnLoop.run 抛错路径 saveState 被跳过的疑点),则 in-flight turn 的调用方看到 success 而非 cancel。**与 ch01 的 turnLoop.run 健壮性疑点联动** —— abort 语义的正确性依赖底层全链路传递 signal。

- ❓ **`fork` 复制事件用 `transcript.append`(逐条)**(session-manager 199),每条都 `flush`(appendFileSync)。fork 一个长 session 会触发 N 次同步文件写。性能隐患(大 session fork 慢),记录。

- ❓ **`handleConfigure` 全局分支用 `legacyEngine ?? anyEngine()`**(473)。`anyEngine()` 从 chatManager 借**任意**一个 session 的 engine 来执行全局操作(switchModel/reloadModels)。由于 modelPool 是共享的,改一个 engine 的 activeKey = 改全局。但 `switchModel` 还会 `persistActiveModel`(ch01 1696)写 home settings.json —— **借来的那个 engine 的 settingsScope** 决定写哪(ch01 已记 persistActiveModel 忽略 scope 写死 home)。语义绕:全局 model 切换借随机 session engine 执行,记录。

- ❓ **`Transcript.flush` 失败静默**(151)。磁盘满 / 只读 FS 时事件丢失但内存仍有 —— resume 后磁盘 transcript 缺事件,与内存不一致。session_recorder(ch02)和 transcript 是两套持久化,失败行为不同。记录。

- ❓ **`maxSessions=16` 超限抛 `-32001`**(chat-session-manager 51)但 idle sweeper 间隔 60s。突发 17 个并发 session(都 busy)会直接拒第 17 个,sweeper 帮不上(busy 不清)。是预期背压,但 16 这个数硬编码、无配置入口暴露给协议层。记录。

- ❓ **transport InProcess 用两个 EventEmitter 交叉 emit**(transport 34-49),`close` 清两边所有 listener。若同进程有多对 transport 复用同名 emitter?不会(每 createInProcessTransport 新建)。OK。但 Stdio transport 的背压 / 大消息分帧未在前 50 行体现,需完整读确认 NDJSON 是否处理超长行(readline 默认有行长限制?)。标记待核。

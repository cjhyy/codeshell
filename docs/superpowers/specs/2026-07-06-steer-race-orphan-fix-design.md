# Steer 竞态孤儿修复 · 设计文档

日期：2026-07-06
状态：v2 · 待实现（证据已核对真实日志）
范围：`packages/core`(引擎/turn-loop/RPC) + `packages/desktop`(前端降级/提交幂等)

## 问题

运行中消息注入(steering)的 steer 队列存在**队列语义层的设计缺陷**,导致用户发出的 steer 消息在两个竞态窗口里成为"孤儿"——收下了却永不注入、UI 卡在 pending。

根因(engine.ts:820-822 注释自陈)：
> If no run is active for the session the message simply waits in the queue and is consumed when that session next runs — rare race; host normally only steers while busy.

设计假设"用户只在忙时 steer",但 UI 允许 idle 时也往 steer 通道发,于是留下陈旧条目延迟触发/滞留的坑。

### 真实证据(已逐条核对,注意各自佐证的窗口与证据源不同)

**注意**：steer 的运行痕迹**不在 engine 结构化日志**(经核对 `engine-*.log` 对 steer 零记录 —— 这正是本方案要新增日志的直接理由),孤儿只能靠 **bridge RPC 日志**(`renderer→worker method:"agent/steer"` 有发出,但无对应 `agent/streamEvent … steer_injected`)反推。

| Session | 证据源 | 佐证窗口 | 关键事实 |
|---------|--------|----------|----------|
| `s-mr8udcio-8bd61c45` | bridge RPC 日志 | **窗口1(无消费)** | 多次 `agent/steer` 发出,部分后续无 `steer_injected` 回声。（transcript 里出现的 `12ffef2e`/`c81daa22`/`4118378b` 等串是**当次会话正文内容**,非 steerId,不能作为孤儿计数依据。） |
| `s-mr8uh4ru-2b191a6f` | transcript.jsonl | **窗口2(滞留)+ 重复落盘** | `:61` 旧 steer 正文 `而且2个steer 都没有一起合并输入`(turnNumber 13);`:81-82` **同一条 user 消息 194ms 内落盘两次**(id `EnaoO5LvI8wK` / `tDAtrRHCVlJW`,内容完全相同)。 |

**方案 A 的反例(重要)**：`s-mr8uh4ru:61` 这条 steer 正文落盘时 `data` 里**没有 `steerId` 字段**,尽管方案 A(commit b55fa94a)声称已让 `appendMessage` 带 steerId 落盘。⇒ 幂等**不能假设 steerId 一定存在**,幂等键必须用一个"一定会落盘"的 `clientMessageId`(见下)。

### 注入粒度澄清(对齐 codex,已达标)

排查 74s Write 卡顿时确认:codeshell 现有注入粒度**已经等于 codex**,无需改动。

- turn-loop 结构:一次 while 迭代 = 一次模型响应(一个 assistant turn + 它那一批 tool_use)。steer 在**每次迭代顶部**(`turn-loop.ts:466` `consumeSteer`)消费 = **每个 assistant turn 之间**注入。
- codex `turn/steer` 也是"在下一个 step 边界(当前模型输出 / 下个 tool call 之后)注入"——同一粒度。
- 因此长工具(如 74s Write)期间 steer 注入不进去,**不是粒度缺陷**,而是 tool-call 协议硬约束:一个 assistant 响应里的 N 个 tool_use 必须由紧接着的 N 个 tool_result 全部应答,中间不能插入 user 消息。codex 遇到同样的长单工具一样得等它跑完。日志佐证:`06:57:02 tool_result Write` 紧跟 `06:57:02 steer_injected`——steer 在工具一结束、下次模型调用前就注入了,并没有"等到整轮结束"。

**"在工具执行中途打断长工具立即生效"已有现成手段:Stop 按钮**(`agent/cancel` → `s.cancel()` → `abortController.abort()`,abort 在途 LLM 调用 / Bash spawn,turn-loop 的 `signal.aborted` 检查配合它)。想立即中止长工具就手动 Stop 再重新输入即可。本轮**不新增任何打断逻辑、不把 abort 自动接进 steer**——只治孤儿/卡 pending/滞留,注入粒度维持现状。

### 两个竞态窗口

| 窗口 | 触发 | 现象 |
|------|------|------|
| **窗口1 · 收尾期** | turn 还在跑,但已过最后一个 step 边界正在收尾 | steer 进队列,却无下一个 step 消费 → 不注入、不回 `steer_injected` → 气泡卡 pending |
| **窗口2 · idle 期** | turn 已 `turn_complete`,引擎空闲 | steer 进队列,滞留到**下一次 run()** 才被 flush → "在你下次输入后突然冒出来" |

与已修的 hydrate 去重(方案A,commit b55fa94a)**无关**：方案A 是显示层"同一条 steer 气泡重复/丢失",本缺陷是队列语义层"滞留/无消费"。

`s-mr8uh4ru-2b191a6f` 还暴露一个**关联但独立**的问题：当前用户输入被提交/落盘两次(`:81-82`)。这不应归因给 orphan steer,也不能靠收尾兜底解决 → 需提交幂等,**本轮范围内一并修**(否则验收"不出现两个相同气泡"无法兑现)。

## 方案(三部分,一次交付)

### 第1层 —— 收尾兜底(治窗口1)
turn-loop 的 `run()` 在 while 循环跳出、正常 return **之前**,再 `consumeSteer()` 一次：
- 队列非空 → **不结束,续跑一个 step** 把残留 steer 注入(自然回 `steer_injected` → 变正式气泡)；
- 队列空 → 正常结束。

**关键不变量(必须在实现与测试中钉死)**：这次补消费**必须发生在 `turnLoop.run()` 内部、在 engine `run()` 的 finally 清空 `activeRunSession`(engine.ts:2131)之前**。因为第2层"收尾期仍判活 busy → 交给第1层兜底"的正确性,完全依赖"补消费 早于 activeRunSession=null"这条时序。**严禁**把补消费挪到 engine.finally 之后,否则窗口1 重新打开。为此加一条专门的回归测试锁定顺序。

**补跑终止性**：补跑的 step 走**与正常 step 完全相同的 step-gap 消费路径**,即"多一个普通 step",因此天然受 `maxTurns` / turn 上限约束,不会因用户在补跑期间持续 steer 而无限循环。补跑期间**新到**的 steer 属于下一次判活/边界的范畴,不在本次补跑内递归展开。

**不采用方案3(run 结束清空队列)**：清空会**丢弃**用户消息,内容凭空消失。收尾兜底是"补消费",消息不丢。

### 第2层 —— idle 降级(治窗口2)
`enqueueSteer` 检查该 session 是否有活跃 run(读 `activeRunSession` / `activeTurnLoop`)：
- 有活跃 run → 照旧入队(第1层保证被消费),返回 `{ accepted: true }`；
- **无(idle)→ 不入队,返回 `{ accepted: false }`**。

`agent/steer` RPC 把 `{ accepted }` 回给前端；前端 `steer()` 收到 `accepted:false` → **立即降级成 `agent/run` 开新一轮**(复用现有 run 逻辑,但自动、即时,无需等超时)。

steer 语义本就是"插进正在跑的 run",idle 时它不该存在 → 降级为普通输入是语义正解。**全程不打断**：idle 时开新一轮本就是对的。

**降级 id 语义隔离(避免与方案 A 打架)**：降级后的普通 run 用户消息**不得携带 steerId**。方案 A 的 foldTranscript/hydrate 会把带 steerId 的气泡当作 injected steer 特殊处理(去重/打标),若降级消息复用 steerId 会被错误折叠或错误标记。降级消息只带 `clientMessageId`(下),落盘时清除/不写 steerId。

**降级 run 的串行化**：idle 快速连发多条时,每条 `accepted:false` 各自要开 run。前端**串行排队**这些降级 run(复用现有输入队列/单飞 run 语义),不得并发起多轮,避免 turn 交错。

### 第3层 —— 提交幂等(治重复落盘,本轮必做)
- renderer 在 `queueInput` / `send` / idle 降级前先生成一个稳定 `clientMessageId`(UUID)。它是幂等主键,**独立于 steerId**(证据表明 steerId 可能缺失,不可依赖)。
- `agent/steer` 返回 `{ accepted, id }`；`accepted:false` 降级为 `agent/run` 时**沿用同一个 `clientMessageId`**,不再追加第二个本地 user bubble。
- reducer / hydrate 以 `clientMessageId` 做幂等合并(已存在则替换而非叠加)。**不要**用"文本相同 + 时间接近"做去重——那会误杀用户合法的连续重复输入。
- core `appendMessage` 落盘时保留 `clientMessageId`,让重启/回放后仍能识别同一用户意图,并对同一 id 的重复 append 做幂等(直接命中 `:81-82` 194ms 双写)。

### 为什么三部分都要
- 只做第2层:治不了窗口1(判活时 run 还活着 → 入队 → 过了末个 step 又变孤儿)。
- 只做第1层:治不了窗口2(idle 时根本没有"本轮"可兜底)。
- 不做第3层:窗口1/2 修好后,`:81-82` 式重复落盘仍在,验收兑现不了。
- 三者合起来:任何时刻发 steer,要么当轮注入,要么立即降级新一轮,**永不卡 pending、永不滞留、永不丢消息**;同一用户意图也不会重复显示/重复落盘。

## 改动清单

| 层 | 文件 | 改动 |
|----|------|------|
| 1 | `packages/core/src/engine/turn-loop.ts` | run 正常 return 前补一次 consumeSteer；非空则续跑一个普通 step。**补消费必须在 turnLoop.run 内、activeRunSession 清空前** |
| 2 | `packages/core/src/engine/engine.ts` | `enqueueSteer` 判 `activeRunSession`/`activeTurnLoop` → 返回 `{accepted}`；idle 不入队 |
| 2 | `packages/core/src/protocol/server.ts` | `agent/steer` 响应带 `{ accepted, id }` |
| 2 | `packages/desktop/src/preload/*` + `App.tsx` | `steer()` 收 `accepted:false` → 自动降级 `agent/run`；降级消息**清除 steerId、保留 clientMessageId**；多条降级 run **串行** |
| 3 | `packages/desktop/src/renderer/App.tsx` + reducer/hydrate | 生成 `clientMessageId`；同一 id 只追加/持久化一次；降级 run 沿用原 id |
| 3 | `packages/core/src/session/transcript.ts` | `appendMessage` 落盘保留 `clientMessageId`；同 id 重复 append 幂等 |
| 诊断 | core/desktop log | 记录 accepted/rejected/consumed/downgraded/duplicate,带 `sessionId`、`clientMessageId`、`steerId?`、`activeRunSessionId`、queue length |
| 测试 | `steer-queue` / turn-loop / engine / 前端 / transcript | TDD 覆盖两个窗口 + 顺序不变量 + 重复落盘 |

## 测试策略(TDD,先红后绿)
1. **窗口2**：engine 在 idle 时 `enqueueSteer` 返回 `accepted:false` 且队列不残留。
2. **窗口1**：turn-loop 在最后一个 step 后队列仍有条目时,`run()` 返回前会消费它并发 `steer_injected`(不丢、不卡)。
3. **顺序不变量**：断言"补消费发生在 `activeRunSession` 被清空之前"——注入一个在 run 收尾阶段入队的 steer,确认它被本轮消费而非滞留(锁死时序,防未来重构挪动清空点)。
4. **补跑终止性**：补跑 step 计入 turn 上限;补跑期间入队的新 steer 不在本次补跑内被递归消费。
5. **回归**：busy 时正常 step-gap steer 行为不变(现有测试全绿)。
6. **前端**：`steer()` 收到 `accepted:false` 触发一次 `agent/run`(而非傻等);连发多条时降级 run 串行,不并发。
7. **降级 id 隔离**：降级后的用户消息落盘不含 steerId,hydrate 不把它当 injected steer 处理。
8. **重复提交回归**：同一个 `clientMessageId` 连续进入 reducer/hydrate/stream/transcript 两次,最终只保留一个 user bubble / 一条落盘。
9. **真实日志回放**：用 `s-mr8uh4ru-2b191a6f` 建 fixture,断言(a) `:61` 旧 orphan steer 不会被下一次普通输入 flush;(b) `:81-82` 这种重复 user message 被折叠为一个用户意图。

## 观测与验收

新增结构化日志(engine 侧当前对 steer **零记录**,此为刚需)：
- `steer.enqueue.accepted` / `steer.enqueue.idle_rejected`
- `steer.consume.drained`（含来源:normal_step / finalize_backfill）
- `steer.idle_downgrade.run_started`
- `steer.submit.duplicate_ignored`（带 `clientMessageId`）

验收标准：
- **窗口1**：收尾期(最后一个 step 后、run 返回前)入队的 steer,必被本轮兜底消费并回 `steer_injected`,不降级、不悬空 pending。
- **窗口2**：idle 期发 steer 不进入 `steerQueueBySid`,不在下一次 run 顶部被消费;而是即时降级为新 run。
- **顺序**：补消费一定早于 `activeRunSession=null`(测试锁定)。
- **正常路径**：active run 期间的 steer 仍按顺序注入一次,transcript 和 UI 都只出现一次。
- **幂等**：重放 `s-mr8uh4ru-2b191a6f` 不再得到两个相同用户气泡(`:81-82` 折叠为一),也不让旧 steer(`:61`)混进新输入。

## 不在本轮范围
- **气泡被吞**(注入成功但气泡随后消失)：显示层 hydrate 覆盖残留,是独立的第三个 bug,需"注入成功但气泡消失"的真实日志复现后单独处理。
- **多端并发 CAS**(Codex expectedTurnId 式 turn 版本号)：单机 Electron 用"判活"已足够,多端编排再补。
- **steerId 落盘缺失根因**(方案 A 的反例)：本轮用 `clientMessageId` 绕开对 steerId 的依赖;为何 `:61` 未带 steerId 的根因排查另立 issue。

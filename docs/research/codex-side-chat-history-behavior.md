# Codex 侧聊的历史上下文、会话分叉与运行中隔离行为调研

> 调研日期：2026-07-11
> 调研对象：本机 `codex-cli 0.144.1`、OpenAI 官方 Codex 文档、`openai/codex`
> 开源仓库 `main`（读取时为
> [`5c19155cbd93bfa099016e7487259f61669823ff`](https://github.com/openai/codex/commit/5c19155cbd93bfa099016e7487259f61669823ff)），以及当前 CodeShell 源码。
> 标注规则：**[事实]** 表示能由文档、CLI 或源码直接确认；**[推断]** 表示由这些事实推导、但未做带写入的在线会话复现；**[建议]** 表示落到 CodeShell 的产品或实现选择。

## 1. 明确结论

1. **[事实] Codex 同时存在“空白新会话”和“带历史分叉”两种不同语义。**
   `/new`（以及直接启动新的 `codex`）是 fresh conversation，不继承当前 transcript；
   `/fork` / `codex fork` 创建新 thread ID，并复制所选父会话历史；`/resume` 则不是分叉，
   而是继续同一个已保存 thread。
2. **[事实] Codex CLI 现在确实有 `/side`（别名 `/btw`），但它不是“空白 chat”。**
   它是从当前会话创建的 **ephemeral fork**：模型继承父 thread 历史作为参考上下文，
   side 自己的 transcript 与父 thread 分离，退出后不作为普通可恢复会话持久保存。
3. **[事实] `/side` 的“带历史”不等于“把历史气泡显示在 side 画面里”。**
   Codex 特意让模型保留 fork history，同时给 TUI 的 side 可视快照传空 turns；因此用户看到的
   side transcript 从侧聊边界开始，父会话历史不会在顶部重放。
4. **[事实] Codex TUI 没有桌面式左右并排双聊天 pane。** 它只有一个当前可见 transcript；
   `/side` 会把这个视口切到临时 child thread，底部保留“from main thread / main finished /
   needs approval / Ctrl+C to return”等父会话状态。父 thread 可以继续运行，但不会把它的消息流
   渲染成 side 的聊天气泡。
5. **[建议] CodeShell 的“侧边快聊”主入口应对齐 Codex `/side`，即默认“带上下文 fork”，而不是
   空白 `/new`；同时保留显式的“空白快聊”次要入口。** 为避免当前串漏，fork 只能截取稳定、已完成的
   父历史，父/子各用独立 session store、stream route、busy/approval/steer 状态；父会话运行中的
   optimistic user bubble、assistant delta 和控制态绝不能复制进子会话。

## 2. 调研方法与边界

### 2.1 本机 CLI

**[事实]** 本机安装为 `codex-cli 0.144.1`，入口是
`/opt/homebrew/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js`。本次执行了只读命令：

```text
codex --version
codex --help
codex resume --help
codex fork --help
codex features list
codex debug prompt-input --help
```

帮助文本直接区分：

- `codex resume`：继续已有 interactive session，默认打开 picker，也可 `--last`；
- `codex fork`：从已有 interactive session 分叉新 task，默认打开 picker，也可 `--last`；
- 无 subcommand 的 `codex`：启动 interactive TUI；
- CLI 顶层没有名为 `side` 的 subcommand，`side` 是 TUI 内的 slash command。

对安装包内 Rust 可执行文件做只读 `strings` 检查，还能直接看到当前版本包含以下文本：

```text
start a side conversation in an ephemeral fork
Use /side to start a side conversation in a temporary fork without polluting the main thread.
Everything before this boundary is inherited history from the parent thread.
Side from main thread · ... · Ctrl+C to return
```

**[事实]** `codex features list` 没有 side-history 模式开关；源码也直接在 `/side` 路径设置
`ephemeral = true`。因此 side 是固定产品语义，不是由 `config.toml` 选择“空白还是继承历史”。

### 2.2 为什么没有启动一次真实 TUI 会话

本任务要求除报告外绝不写文件。启动新的 Codex TUI 并提交消息会创建/更新
`$CODEX_HOME/sessions` rollout 和本地状态，因此没有做这一步。实际行为由以下三层交叉确认：

1. 当前安装二进制中的命令、提示和 side boundary 文本；
2. OpenAI 官方 CLI / app-server 文档；
3. 同版本时代的开源 TUI 实现和专门覆盖“主任务运行中打开 `/side`”的测试与 snapshot。

这比只依据命令名称更强，但凡涉及当前 CodeShell bug 的直接根因，本文仍明确标为 **[推断]**。

## 3. 四种入口的上下文语义

| 入口 | thread 身份 | 模型上下文 | UI 历史 | 持久性 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 新启动 `codex` / `/new` | 新 ID | 不继承当前对话 | 新 transcript；`/new` 不先清终端旧画面 | 普通会话 | **空白 new** |
| `/resume` / `codex resume` | 原 ID | 恢复原 transcript | 重放已保存历史 | 原会话继续持久化 | **继续同一链** |
| `/fork` / `codex fork` | 新 ID，记录 parent | 复制父历史；app-server 还能通过 `lastTurnId` 截到旧 turn | 普通 fork 会话可重放复制历史 | 持久化 | **带历史持久分叉** |
| `/side` / `/btw` | 新临时 child ID | 复制父历史，并注入 side boundary | 故意不显示继承 turns，只显示 side 后的新内容 | ephemeral，返回时丢弃 | **带历史临时分叉** |

这里的“空白”只表示**不继承当前 conversation transcript**，不表示模型输入真的只有一条用户消息。
新会话仍会按正常规则加载 system/developer instructions、`AGENTS.md`、cwd/environment context，以及用户
启用的 memory 等跨会话上下文；这些不属于“历史对话记录”。

官方 slash-command 文档的措辞很明确：

- [`/new`](https://developers.openai.com/codex/cli/slash-commands#start-a-new-conversation-with-new)
  “starts a fresh conversation”；
- [`/resume`](https://developers.openai.com/codex/cli/slash-commands#resume-a-saved-conversation-with-resume)
  会重新加载所选 conversation 的 transcript；
- [`/fork`](https://developers.openai.com/codex/cli/slash-commands#fork-the-current-conversation-with-fork)
  clone 当前 task，得到 fresh ID，原 transcript 不变；
- [`/side`](https://developers.openai.com/codex/cli/slash-commands#start-a-side-conversation-with-side)
  是 “ephemeral fork from the current conversation”，side transcript 与 parent 分离，TUI 仍显示
  parent status。

### 3.1 `/fork` 是线性历史复制，不是空白会话

**[事实]** app-server 的 `ThreadForkParams` 支持 `last_turn_id`，其注释明确说“复制到该 turn（含）”，
并排除之后的 turns；目标会得到新 thread ID。源码：
[`thread.rs#L486-L563`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L486-L563)。

**[事实]** 官方 app-server 文档还补充了 in-flight 边界：指定的 `lastTurnId` 不能仍在运行；如果不指定
而 source 正在跑，fork 会记录“像先中断当前 turn 一样”的快照，而不是保留一条没有边界的 partial
turn。参见
[`thread/fork` 文档](https://developers.openai.com/codex/app-server#threads-turns-and-items)。

**[事实]** TUI 还支持在 composer 为空时按两次 `Esc` 编辑上一条用户消息，并从那个点 fork。
这说明 Codex 的 fork 不只支持“复制当前线性尾部”，也支持从更早的稳定交互点分支；但仍然是历史复制，
不是摘要迁移或任意选段打包。

### 3.2 `/side` 继承上下文，但把继承历史降为 reference-only

开源实现对此没有歧义：

- 模块注释把 side 定义为 “ephemeral fork”，并说 fork 会收到隐藏 developer instructions；
  [`side.rs#L1-L8`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs#L1-L8)。
- side boundary 明写：“Everything before this boundary is inherited history from the parent
  thread”，但这些内容只是 reference context，不是 side 当前任务；
  [`side.rs#L24-L52`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs#L24-L52)。
- `side_fork_config()` 复制当前 model、reasoning effort、service tier，然后设置
  `ephemeral = true` 并附加 side developer instructions；
  [`side.rs#L469-L481`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs#L469-L481)。
- `handle_start_side()` 对 parent 调 `thread/fork`，给 child 注册独立 channel，再通过
  `thread/inject_items` 注入 boundary，最后切到 child thread；
  [`side.rs#L554-L646`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs#L554-L646)。

**因此对原问题最精确的回答是：** Codex `/side` **会带入**父会话历史给模型，但**不会显示**父历史
气泡；Codex `/new` 才是既不带入当前 transcript、也从新 task 开始的空白 chat。

### 3.3 side 为什么看不到父历史气泡

**[事实]** `install_side_thread_snapshot()` 丢弃 fork API 返回的 `forked_turns`，并给 side 的 UI store
设置空 turn 列表。源码注释原意就是：fork history 留在 core/model state 中，但 side 在视觉上从边界
开始；
[`side.rs#L516-L525`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs#L516-L525)。

对应回归测试构造了一个含 parent user message 的 fork turn，断言安装到 side 后 `store.turns` 为空、
没有 active turn；
[`app/tests.rs#L3377-L3406`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/tests.rs#L3377-L3406)。

这一区分值得 CodeShell 直接借鉴：

- **模型上下文投影**可以包含父历史；
- **side 可视 transcript 投影**不必、也不应复制父会话的 live renderer state；
- 如果 CodeShell 产品决定显示继承历史，也应从 fork 后的稳定磁盘快照只读 hydrate，不能复制父面板
  当前内存气泡列表。

## 4. Codex 是否有“左右并排第二个聊天”

### 4.1 结论：有 side conversation 概念，没有双 pane TUI

**[事实]** 官方文档称 `/side` 不切走 main task，含义是 main task 仍继续运行；它没有声称存在左右两个
chat panes。TUI 实现只有一个 `active_thread_id` 和一个 active receiver：切换时保存当前 receiver，
再激活目标 thread 的 receiver 和 snapshot。参见
[`thread_routing.rs#L44-L98`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_routing.rs#L44-L98)。

`current_displayed_thread_id()` 的注释也明确把它定义为“whose transcript is currently on screen”；
[`thread_routing.rs#L159-L167`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_routing.rs#L159-L167)。

因此视觉模型是：

```text
一个 transcript 视口
        │
        ├── 当前显示 main thread
        └── /side 后切换显示 ephemeral child thread
                    └── footer 仅投影 parent 状态 + Ctrl+C 返回
```

这不是桌面 CodeShell 的“左主聊 + 右快聊”并排布局。两者可以采用相同的会话语义，但不能把 Codex
称为并排双会话 UI。

### 4.2 主会话运行中可以打开 side

**[事实]** Codex 有专门测试：先把 parent 标为 `on_task_started()`，再提交
`/side explore the codebase`；断言只发 `StartSide { parent_thread_id, ... }`，没有把该输入提交到
parent。源码：
[`chatwidget/tests/side.rs#L301-L347`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/chatwidget/tests/side.rs#L301-L347)。

side 状态栏可显示 `main needs input`、`main needs approval`、`main finished`、`main failed` 等；
parent turn 的完整消息事件仍归 parent store，side 只拿状态摘要。

## 5. In-flight、事件路由和 steering 隔离

### 5.1 Thread 与 turn 是两级路由键

**[事实]** app-server 把 conversation 作为 thread，把一次用户请求及随后的 agent work 作为 turn。
`turn/start`、`turn/steer`、`turn/interrupt` 均要求目标 `threadId`；approval 请求也同时携带
`threadId`、`turnId`。官方入口：
[`Codex App Server`](https://developers.openai.com/codex/app-server)。

**[事实]** TUI 为每个 thread 建独立 `ThreadEventChannel` 和 `ThreadEventStore`。store 单独保存
`session`、`turns`、buffer、`active_turn_id`、input state 和 active 标志；
[`thread_events.rs#L41-L50`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_events.rs#L41-L50)。

通知进入时，调用者必须提供 thread ID。`enqueue_thread_notification(thread_id, ...)` 只写对应 store；
只有该 store 是 active 时才把事件发送给当前渲染 receiver，否则只缓冲。parent 若是当前 side 的父亲，
额外只更新 side parent status；
[`thread_routing.rs#L877-L935`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_routing.rs#L877-L935)。

这就是“不串投”的核心，不是靠 UI 猜“最近哪个面板在运行”，而是每个事件从产生时就有权威 thread
归属。

### 5.2 Steering 只能进入指定 thread 的指定 active turn

**[事实]** 官方 `turn/steer` 语义是向当前 in-flight regular turn 追加输入，不创建新 turn；它要求
`expectedTurnId`，没有 active turn、ID 不匹配、或当前是 review/compact 等不可 steer turn 时会失败。
参见
[`Steer an active turn`](https://developers.openai.com/codex/app-server#steer-an-active-turn)。

**[事实]** 源码先按 `thread_id` 加载目标 thread，再把 `expected_turn_id` 传给该 thread 的
`steer_input()`；
[`turn_processor.rs#L849-L955`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server/src/request_processors/turn_processor.rs#L849-L955)。
core 在同一把 `active_turn` lock 下原子检查 actual turn ID 和 task kind，成功后才把输入加入这个
turn 的 `pending_input`；
[`session/mod.rs#L3857-L3937`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/core/src/session/mod.rs#L3857-L3937)。

TUI 侧也把 `active_turn_id` 缓存在 **per-thread store** 中。用户发送时：

- 目标 thread 有 active turn：调用 `turn/steer(thread_id, expected_turn_id, items)`；
- 服务端说 active turn 已不存在：清掉该 thread 的 stale active ID，再启动新 turn；
- 服务端返回另一个 actual turn ID：只更新该 thread 的 store 并最多重试一次；
- 最终 `turn/start` 同样显式携带这个 `thread_id`。

源码：
[`thread_routing.rs#L517-L678`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_routing.rs#L517-L678)。

这套 `(threadId, expectedTurnId)` precondition 能阻止把“给 A 当前 turn 的 steer”误投到 B，或误投到
A 已经换掉的新 turn。

### 5.3 Steering 是安全点注入，不是把半条消息复制到另一个会话

**[事实]** core 的 `InputQueue` 属于 session，steer 被追加到当前 `TurnState.pending_input`，并通过
activity signal 唤醒当前 turn；模型循环在可接受 pending input 的边界取出它。
[`input_queue.rs#L165-L225`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/core/src/session/input_queue.rs#L165-L225)。

这与仓库已有认知一致：工具调用与 tool result 的协议配对不能被任意 user message 插断；steer 是在
当前 thread 的下一个安全 step 进入，而不是跨 session 广播。CodeShell 的对应分析见
[`docs/superpowers/specs/2026-07-06-steer-race-orphan-fix-design.md`](../superpowers/specs/2026-07-06-steer-race-orphan-fix-design.md)。

### 5.4 `clientUserMessageId` 不应被误写成 Codex 的已证明幂等键

**[事实]** app-server 的 `turn/start` / `turn/steer` 可带 `clientUserMessageId`，返回的
`userMessage.clientId` 会回显它，适合 UI 把 optimistic bubble 与服务端事件对应起来。

**[事实]** 当前 Codex TUI 自己调用这两个 RPC 时传的是 `None`，本次检查的官方文档和源码也没有承诺
“重复 client ID 会被服务端去重”。因此本文不把它写成 Codex 后端幂等保证。

**[建议]** CodeShell 已有稳定 `clientMessageId` 的 reducer/hydrate/transcript 去重机制，应继续保留；
但 key 必须至少按 `(sessionId, clientMessageId)` 作用域化。它解决的是同一用户意图在 optimistic、
stream、hydrate、resume 间的重复，不代替 session/thread 路由，更不能靠“文本相同 + 时间接近”猜测
跨面板归属。

### 5.5 Fork 运行中父会话时的边界

**[事实]** Codex app-server 对 active source 的 fork 使用一个明确的 interrupted snapshot；指定
`lastTurnId` 时则拒绝 in-progress turn。side child 又把继承 turns 从可视 snapshot 中清空。
因此 main 的未完成 user/assistant UI 片段不会成为 side 顶部的一条可交互气泡。

**[事实]** side 退出时，TUI 先按 side 的 `(thread_id, active_turn_id)` interrupt，只 unsubscribe 这个
side thread，然后移除它自己的 listener、channel、side state 和 navigation state；
[`side.rs#L364-L415`](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs#L364-L415)。
parent thread 不被清理或改写。

## 6. 与当前 CodeShell 现象对照

### 6.1 当前 CodeShell 已经选择了“默认 full fork”

**[事实]** 当前 renderer 在 owner 能解析出 engine session 时把 quick chat 的
`contextMode` 设为 `full`，否则才用 `blank`；
`packages/desktop/src/renderer/App.tsx:3232-3262`。

**[事实]** full 路径先调用 `window.codeshell.forkSession(...)`，然后读取 **target session** 的磁盘
transcript，`foldTranscript()` 后 hydrate 到 quick-chat bucket；
`packages/desktop/src/renderer/App.tsx:3157-3207`。这一方向是正确的：它没有直接复用 owner bucket
对象。

### 6.2 与僵死气泡最吻合的竞态

下面先分事实和推断：

- **[事实]** CodeShell `Engine.run()` 在本轮模型工作开始前，就把当前 user message 追加到 source
  transcript；`packages/core/src/engine/engine.ts:1373-1421`。
- **[事实]** `AgentServer.handleForkSession()` 能拿到 live `ChatSession`，但当前没有检查
  `source.isBusy()` / `source.queueDepth()`；它直接调用 `engine.forkSession()`；
  `packages/core/src/protocol/server.ts:539-624`。
- **[事实]** `SessionManager.fork()` 在没有 `throughEventId` 时把读到的 transcript tail 作为快照，
  并复制 `message` 事件；`packages/core/src/session/session-manager.ts:62-78`、`:687-752`。
- **[事实]** fork 完成后，renderer 会把 target transcript 中的 user message 正常 fold 成气泡。
- **[事实]** 仓库已有设计稿原本要求 busy source fail-fast / 等回复结束后再 fork：
  [`session-fork-and-context-transfer-design.md`](../nightly-2026-07-10/session-fork-and-context-transfer-design.md)。

**[推断]** 用户观察到的“左边仍在跑的那条消息，出现在右边顶部成为僵死气泡”，很可能是：

```text
parent run 先落盘本轮 user message
        ↓
quick chat 在 parent busy 时读取 transcript tail
        ↓
该 user message 被复制进 target，但它对应的 parent assistant/tool 后半程尚未完成
        ↓
target hydrate 把它显示为继承历史中的最后一条 user bubble
        ↓
该 bubble 在 child 没有自己的 turn/stream 所有权，因此看起来“不会 work”
```

这与 Codex 的差异正好有两处：Codex 会为 active-source fork 建稳定 interrupted snapshot；Codex side 的
可视 store 还会隐藏全部继承 turns。要把这条推断升级为确定根因，需在复现时记录 source fork cursor、
target 首尾 event ID、parent/child sessionId 和 bubble 的 `clientMessageId`；本任务没有运行或修改代码。

## 7. 对 CodeShell 的产品与实现建议

### 7.1 产品语义

**[建议] 默认对齐 `/side`，不是 `/new`：**

- 主按钮：**带当前上下文的临时 fork**；
- 次要菜单：**空白快聊**；
- UI 明示来源，例如“来自主聊：xxx · 共享 workspace”；
- 关闭 side 只销毁 child，不改 parent；
- 若未来支持持久保存，把它升级/另存为普通 fork，而不要悄悄改变 ephemeral 语义。

理由：用户从主任务旁边打开 side，通常就是想问依赖现有上下文的支线问题；纯空白 chat 与“新建会话”
重复，无法解释 side 入口的独特价值。当前 CodeShell 已采用 `full` 默认、`blank` 备选，这一产品方向应
保留。

### 7.2 显示语义可以和 Codex 不完全相同，但必须明确分层

Codex 的选择是“模型继承、UI 隐藏”。CodeShell 有更大屏幕，可以选择：

1. 只显示“已继承 N 个完成回合”的 context banner，历史默认折叠；或
2. 只读显示继承的 **已完成** 回合，并用 boundary 区分“父历史”与“side 新消息”。

无论选哪种，都不能把 parent renderer 的 live state 当作 fork transcript。模型 context projection、
持久 transcript、side UI projection 是三层不同数据。

### 7.3 Fork 时只接受稳定边界

**[建议]** 选择一种明确策略，不允许“读当前文件尾就算 fork 完成”：

- **推荐即时策略（最像 Codex）：** parent busy 时，截到最后一个已完成回合的稳定 event cursor；当前
  in-flight 回合不进入 child。可在 lineage 里记录 `forkedWhileParentBusy` / stable cursor。
- **保守策略：** parent busy 时把 fork 请求标记 pending，等 parent turn complete 后再创建；UI 显示
  “当前回复结束后分叉”。
- 若协议需要复制当前 partial turn，必须显式写 `interrupted` boundary，且 side UI 不把 partial user/
  assistant 片段当作正常可继续气泡；不建议作为默认。

实现上应由 core 给出权威 stable cursor。renderer 不能根据最后一个 React message 猜完成边界。

### 7.4 会话隔离规则

**[建议]** 至少落实以下不变量：

1. **单写者：** 同一个 `sessionId/threadId` 同一时刻只能有一个 active Engine/turn writer；禁止用第二个
   Engine 并发 resume 同一 transcript。
2. **显式路由：** 每个 stream/approval/late event 从产生时携带 `sessionId`；查
   `sessionId -> bucket` 后只写该 bucket。不得回退到“最近运行的 bucket”或全局
   `runningBucketRef` 来猜归属。
3. **独立 store：** parent/child 分开保存 messages、streamingAssistantId、busy、active turn、pending
   approval、queued steer、coalescer seq、composer draft；fork 只复制允许进入 history 的事件。
4. **状态不继承：** 不复制 active goal、pending approval、steer queue、background-job control、临时 tool
   state、optimistic bubble、半成品 assistant delta。model/permission/workspace 可以按产品规则显式继承。
5. **迟到事件隔离：** child 关闭后，用 claim/generation/nonce 拒收旧 Promise 和旧 stream；parent 的迟到
   事件仍只进 parent store。CodeShell 现有 quick-chat claim 与 bucket cleanup 可继续作为基座。
6. **幂等与路由分工：** `(sessionId, clientMessageId)` 去重同一用户意图；
   `(sessionId, turnId, eventSeq)` 排序/归属流事件。幂等键绝不能替代 session key。
7. **共享 workspace 不是共享 transcript：** fork 可以与 parent 指向同一 worktree，但必须提示并发写风险；
   UI/history/控制面仍完全独立。

### 7.5 建议的回归测试

不修代码也能先把验收条件写清楚：

- parent 已有完成历史、当前新 user message 仍在跑时打开 side：child 模型能回答依赖旧历史的问题；
  当前 in-flight user bubble、assistant delta、spinner 不出现在 child。
- parent 在 side 打开后继续发 delta/完成/失败：child 只更新 parent status badge，不追加聊天气泡。
- child 发送第一条消息：只创建 child turn，parent transcript/event count 不变。
- side 关闭后 parent 的迟到事件仍能落到 parent；child 的迟到事件因 generation/claim 失效被丢弃。
- parent/child 同文案但不同 `clientMessageId` 均保留；同 session 同 ID 重试只保留一条。
- busy fork 使用最后完成 cursor，或明确 pending 到 complete；任何测试都不允许形成“只有 user、没有合法
  terminal/interrupted boundary”的 target 尾部。
- 关闭/重开普通 fork 可恢复；ephemeral quick chat 不进入普通 session picker，除非用户显式“保存为会话”。

## 8. 事实与推断清单

### 已查到的事实

- `/new` 是空白 fresh conversation；`/resume` 是续同一历史；`/fork` 是新 ID + 复制历史。
- `/side` / `/btw` 是从当前 conversation 创建的 ephemeral fork，不是空白 chat。
- side 模型上下文包含 parent history，但 TUI 不显示继承 turns。
- Codex TUI 是单一当前 transcript 视口，没有左右并排双 chat pane。
- main 可在 side 期间继续运行；side 只显示 parent status。
- 每个 thread 有独立 event store/channel；事件按 thread ID 路由。
- steer 要求 thread ID + expected active turn ID，并在该 session 的 input queue 安全点注入。
- active-source fork 有 interrupted snapshot 语义，不能把指定的 in-progress turn 当完成 turn 复制。
- 当前 CodeShell quick chat 已默认 full fork；当前 server fork 路径没有 busy-source 检查。

### 本文推断

- CodeShell 当前僵死气泡最可能来自“source user message 已落盘但 turn 未完成时，fork 复制了 transcript
  tail”，而不是 Codex 式稳定 cursor / interrupted snapshot。
- 若将 fork 限制到稳定完成边界，并把 parent live events 只投影成状态 badge，这个具体串漏路径会消失。

### 需要另行复现才能最终确认

- 观察到的僵死气泡 event ID 是否确实与 parent 当前 in-flight user message 的 `clientMessageId` 相同；
- bug 是否还叠加了 renderer bucket 映射或 late hydrate 竞态；
- busy fork 的最佳产品体验是“立即截到上个完成回合”还是“等待当前回合完成”。

## 9. 主要证据索引

### OpenAI 官方文档

- [Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex App Server](https://developers.openai.com/codex/app-server)

### OpenAI 开源实现

- [TUI side conversation lifecycle](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/side.rs)
- [TUI per-thread routing and buffering](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_routing.rs)
- [TUI per-thread event store](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/app/thread_events.rs)
- [App-server thread fork protocol](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- [App-server turn steer processor](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/app-server/src/request_processors/turn_processor.rs)
- [Core active-turn steering](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/core/src/session/mod.rs#L3857-L3937)
- [Side/in-flight TUI tests](https://github.com/openai/codex/blob/5c19155cbd93bfa099016e7487259f61669823ff/codex-rs/tui/src/chatwidget/tests/side.rs)

### CodeShell 仓库内证据

- [`docs/nightly-2026-07-10/codex-session-communication.md`](../nightly-2026-07-10/codex-session-communication.md)
- [`docs/nightly-2026-07-10/session-fork-and-context-transfer-design.md`](../nightly-2026-07-10/session-fork-and-context-transfer-design.md)
- [`docs/superpowers/specs/2026-07-06-steer-race-orphan-fix-design.md`](../superpowers/specs/2026-07-06-steer-race-orphan-fix-design.md)
- `packages/core/src/protocol/server.ts:539-624`
- `packages/core/src/session/session-manager.ts:687-752`
- `packages/desktop/src/renderer/App.tsx:3134-3207`、`:3232-3262`

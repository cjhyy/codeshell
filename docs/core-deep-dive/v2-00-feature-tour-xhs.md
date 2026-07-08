# 《Codex 额度又要刷新了，还剩一大半没用完怎么办？我让它挂机自己干活》

> 小红书 / 轻量软文版。硬核技术版见 [v2-00-feature-tour.md](v2-00-feature-tour.md)。

你可能也有过这个瞬间：订了 Codex Pro / Claude Max 这类订阅，额度按 5h / 7d 这样的滚动窗口刷新；窗口快结束了，一看还剩一大半。不是不想用，是人不可能一直坐在电脑前盯着。白天要开会、通勤、吃饭、陪家人，晚上也不可能为了“别浪费额度”强撑着找任务。

于是最尴尬的事发生了：你明明为那段算力和 agent 时间付过钱，它却在刷新点到来时静悄悄作废。很多人嘴上说“下个周期一定用满”，下个周期还是一样。不是任务不够，而是人类的注意力不是按滚动窗口工作的。

CodeShell 想解决的，就是这个很现实的浪费：**让 agent 在你不看屏幕时持续干活，把本来会浪费的额度用起来。** 不承诺一定“全部榨干”，也不鼓励无脑烧 token；它要做的是把那些你本来就想交给 Codex / Claude Code 跑的长活，从“必须人在电脑前盯着”变成“可以远程发起、后台推进、完成后通知”。

## 解法：手机遥控桌面，让 Codex / CC 在后台 loop

最抓人的场景其实很简单。

你人在外面，手机打开 CodeShell Remote，对桌面上的 agent 发一句：

> 把这批 TODO 用 Codex 跑完，跑完告诉我。

桌面上的 CodeShell agent 收到消息后，不是在手机端重新起一个 agent，也不是开一套手机专属权限链。手机只是一个远程操作面。真正干活的，仍然是桌面那条 worker / WebSocket / approval 链路：手机发来的 `chat.send` 会被转成和桌面 renderer 一样的 JSON-RPC `agent/run`，经 `AgentBridge.injectWorkerMessage` 注入到 worker；审批、取消、流式进度也都回到同一条通道。

换句话说：**始终只有一个 core run loop。** 手机只是把你的手伸到了桌面前。

![手机遥控驱动 Codex loop 全景](assets/v2/v2-00-mobile-codex-loop.png)

如果任务需要驱动外部 agent，CodeShell 会用 `DriveAgent` / `DriveClaudeCode` 去跑 Claude Code 或 Codex CLI。它们走的是 `backgroundJobRegistry`：默认后台跑，完成时把结果、外部 agent 的 sessionId、changed files 这些信息记下来，再通知当前会话。下一轮如果要接着做，可以把上次返回的 sessionId 作为 `resumeSessionId` 传回去，继续同一个外部会话，而不是每次都从零开始。

这就很适合那些“人盯着很烦，但 agent 跑起来有价值”的任务：

- 扫一批 TODO，逐个改，改完跑测试。
- 让 Codex 先处理一组独立小问题，再把结果汇总回来。
- 让 Claude Code 在一个老会话里继续排查，不丢它上一轮积累的上下文。
- 下班路上开一个长任务，到家只看结果和改了哪些文件。

公网访问这块也不是魔法。CodeShell 可以通过 Cloudflare quick tunnel 暴露一个 `trycloudflare.com` 随机地址，把进度推回手机；公网模式前面有 passcode 门禁，配对是一次性 token，默认 10 分钟 TTL。这里有个刻意设计：**隧道不自动静默重连。** quick tunnel 的地址是随机的，断了以后如果后台偷偷换一个新地址，旧手机二维码和配对关系会变得很危险、也很难解释。所以 CodeShell 选择让断开变成可见状态，而不是为了“看起来在线”偷偷换地址。

这听起来像一个手机功能，但它背后真正重要的不是“手机能聊天”，而是下面两件事。

## 一套引擎多张脸

CodeShell 不是为手机单独写了一套 agent。

同一个 core，可以被 TUI、桌面、手机、SDK 消费。TUI 是终端脸，桌面是 Electron 脸，手机是远程脸，SDK 是给别人 `import` 的脸。脸可以很多，但 run loop 只有一套：Engine 装配、TurnLoop 推进、ToolExecutor 过权限、Session 写账本、Protocol 发事件。

这点非常关键。很多“远程控制 AI”的实现，一做手机端就忍不住另起一条捷径：手机发消息后在服务端临时跑一套 agent，审批另写一遍，日志另存一份，工具权限另配一套。短期能跑，长期会分叉。桌面批过的权限手机不知道，手机点过的审批桌面看不懂，worker 崩了以后谁是权威也说不清。

CodeShell 的做法更朴素：手机端不拥有 agent，它只把事件送进桌面已有的 worker；worker 的输出再被镜像回手机。桌面能看到的 `StreamEvent`，手机也按同一套语义看；桌面能处理的 approval，手机只是换了一个点击位置；桌面里那条 session transcript，仍然是事实账本。

![一套 core，多张宿主脸](assets/v2/v2-00-one-core-many-faces.png)

所以“手机遥控”不是一个孤立卖点，它是架构自然长出来的结果：只要 core 和 host 之间有清楚的协议边界，一个新宿主就不必重新发明 agent。

## 长任务无人值守

另一个关键点，是长任务。

如果只是把手机当遥控器，但任务一长就卡死、睡眠后就丢、跑到一半就不知道怎么续，那额度还是用不起来。真正有用的是：你可以把一段工作交出去，让它在后台跑；跑完能唤醒会话；需要继续时能接上；目标没完成时能有边界地再推进。

CodeShell 这里有几块拼在一起：

- 后台子代理和后台 job 负责“先跑着，不要占住当前回合等死”。
- `Cron` 负责“到点再发起一轮”，比如每天凌晨巡检、窗口刷新前跑一批任务。
- 完成通知会唤醒空闲会话，把结果注入下一轮，而不是让 Engine 自己空转轮询。
- 持久 `Goal` 负责“这个目标还没完成，下一轮继续围绕它工作”，并配合预算与 stop-hook 防止无限烧。

这里也要把边界说清楚：不是所有东西都能跨进程重启无损恢复。普通在飞的模型流、外部 child process、后台 shell，并不会因为你写了“长任务”三个字就自动变成 durable。CodeShell 真正声明持久化的是 run / cron / session transcript / active goal 这些状态。外部 CLI 进程本身仍然绑在 worker 上；`resumeSessionId` 能续的是外部 agent 的会话上下文，不是把一个已经断掉的 OS 进程原地复活。

![无人值守长任务：后台、定时、唤醒、续跑](assets/v2/v2-00-unattended-loop.png)

这个边界反而让系统更可信：哪些能恢复，哪些不能恢复，讲清楚，用户才知道该怎么安排任务。

## 这不是几个 hack，而是一套 Agent Harness

到这里，你会发现 CodeShell 不是在堆功能点。

手机遥控、后台驱动 Codex / Claude Code、Cron 定时、持久 Goal、审批回到同一条权限链、进度通过 WebSocket 推到手机，这些能力看起来分散，但它们依赖的是同一件事：**Agent Harness**。

所谓 Harness，不是“调一次模型”，而是把模型放进一个可运行、可约束、可观测、可恢复一部分状态的壳里。模型负责推理，harness 负责把推理变成受控执行：上下文怎么管，工具怎么跑，权限怎么问，结果怎么进 transcript，宿主怎么消费事件，长任务怎么停靠和唤醒。

这也是为什么 CodeShell Core 一直强调自己不是一个写死的 coding agent。写代码只是 `terminal-coding` preset 叠出来的一种形态；同一个 core 也可以服务调研、自动化、运维、远程控制。你看到的“手机上发一句，让桌面 Codex 后台跑”，只是这套通用编排内核在一个高共鸣场景里的展示。

## 接下来怎么读这个系列

这篇是引子，只负责把场景摆出来。后面五篇才是技术深潜，建议按下面路线读：

1. [Core as Agent Harness：为什么 CodeShell Core 是通用 Agent 编排内核](v2-01-core-as-agent-harness.md)  
   先建立总心智：CodeShell Core 为什么是通用编排内核，而不是“一个 coding agent 的实现”。

2. [Engine 与 TurnLoop 深潜：一次任务如何变成状态机](v2-02-engine-turn-loop-deep-dive.md)  
   看一次 run 怎么被 Engine 装配，怎么进入 TurnLoop，多轮模型调用、工具调用、上下文压缩和 goal stop-hook 如何协作。

3. [Tool System 与安全边界深潜：模型能力为什么必须过统一管线](v2-03-tool-system-security-deep-dive.md)  
   看模型真正动手前要穿过哪些门：schema、permission、path policy、sandbox、hooks、MCP 输出不可信标记。

4. [Model、Prompt、Context、Memory 深潜：从模型调用到长期上下文系统](v2-04-model-context-memory-deep-dive.md)  
   看模型选择、prompt 拼装、transcript、context compaction、memory / Dream 如何组成长期上下文系统。

5. [Protocol、Hosts 与 Long-running Orchestration 深潜：多宿主复用与长任务边界](v2-05-protocol-hosts-orchestration-deep-dive.md)  
   回到本文的主场：TUI / 桌面 / 手机 / SDK 如何复用同一个 core，RunManager / Cron / Goal 又如何撑起无人值守长任务。

如果你只想带走一句话：**别把 Agent 理解成“会调用工具的 LLM”，要把它理解成“被 harness 管住的运行系统”。** 当这个系统能被手机远程驱动、能在后台持续工作、能在完成时把结果推回来，那些本来会在刷新窗口里作废的额度，才有机会变成真正完成的任务。

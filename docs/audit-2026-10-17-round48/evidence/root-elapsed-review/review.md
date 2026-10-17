# TUI 前台计时起点被后台状态变化重置：Root 定向核验

这是已知 STATUSLINE-R64-C1 的定向静态核验，不是盲审或未读文件声明。建议 formal48 记录单项 P3；本包不自行增加正式问题总数。

实际入口是普通主视图、无覆盖面板、dock 未聚焦时的文本提交。TuiControlSurface 只把 isRunning 用于 placeholder，CommandInput 未以它禁用输入；App 仅在 isQueryActive 时排队。因此已有后台任务时仍可开始新的前台请求。

Root 另外核读了 67 未语义阅读的生命周期小段：agent 的 detached 执行和 background_notification 请求进入 run-tooling 的 pending 集合；turn-loop1790–1798 返回 background_wait。Engine2247–2286 只在显式 headless 模式等待自己的后台子任务，普通交互模式直接返回，App1719 释放前台 guard。这个链使“旧后台仍在跑时开始新前台”有实现支持，不只依赖注释。仅核此普通控制流，不认证完整 Engine 生命周期、锁、租约、权限、计费或真实网络。

新前台尚在 await client.run 时，最后一个旧后台正常完成，registry 从 running/cancelling 集合移除并 notify。若 UI 在前台结束前提交该状态，A=isQueryActive 保持 true、B=hasRunningBgAgents 从 true 变 false，A||B 仍 true。App436–446 的 effect 依赖 A/B/OR，因此仍运行并在438覆写 runStartRef。StatusLine125–128 以及 App1669 的最终 turn_duration 都从同一引用扣减，遗漏本前台在该次重置前已耗用的时间。叶子自身的 interval 仅依赖 OR，不能保护被重写的起点。

这是一条静态条件缺陷：未运行 React、clock/timer、registry、Engine、模型、fixture 或测试，没有观察到实际帧、具体秒数或计费差异。新前台开始时重置本来合理；稳定 flags、不经 UI 提交的中间状态、前台已结束、尚有其他后台使 B 不变，都不支持同一触发。首个 spawn 的 runYield 在整批工具后消费，不能假定每次 spawn 都产生中间帧。

旧因检索：4336 个 docs/bugs MD/JSON（含归档、递归 JSON 值不查键）机器查询。实际读完 runStartRef1、turn_duration4、elapsed/background7 个窗口及 StatusLine8 个元数据行；宽 App 路径/SHA命中未全部阅读。May20计划只是展示 elapsed 消费者；旧 Desktop 折叠卡片 elapsed flicker 与 AgentDock 每子任务计时涉及不同消费者/原因。有限窗口未建立同条件的既有正式记录，不声称穷尽所有表述。

范围与 pin、display/selected 计数见 [source manifest](source-manifest.json)，首次源码摘录和导航输出原样保留。错误定位 internal.ts 没有读取正文，随后通过文件名定位 index.internal.ts；两条 inline Python 转义 warning 及一次文件名正则无匹配仅为元数据导航诊断，见 [diagnostics](navigation-diagnostics.json)。全部源 pin 和4336历史文件结束复核未变；动态运行0。

# 第十八轮：R44 / R45 / R46 自动化正常门禁与恢复复核

Completed。**新增执行 0；新增发现 0。** 只读冻结 latest `a66f4ef291f304ee4df9da8095a90671d9a8f140` 与原始 `84740d56` 报告 / fixture / 最终日志；没有运行测试、真实 cron、worker、CLI、模型、账号、外部网络或原生进程。没有修改产品、主报告、goal 或构建产物，没有创建线程 / 子代理。仅保存此 `/tmp` 审计。

先读 `CODESHELL.md`、当前问题索引 / flow-coverage / progress，以及 `automation-round5.md`、`quality-round5.md`。结论是三项均保留 P2，补充正常门禁和更窄范围；没有证据要求撤回。主要修正表述为：R44 同一 job 再次排入限仍存在的非 once 任务；R45 限实际 RPC error 失败语义和配置过的网关通知链；R46 不能称强身份都没有持久化，现有身份没有被详情关联逻辑消费。

| 条目 | 结论 | 本轮反证重点 |
| --- | --- | --- |
| R44 | 保留 P2；非 once 续接任务超过 120 秒、旧轮仍未终态 | 正式 Run now 入口和 durable authority 不检查 session busy；Core FIFO 合法接受后继轮次；accepted 不解除整轮 timeout |
| R45 | 保留 P2；不泛指所有提供方错误 / 普通 OS 通知 | Core 有正式 error response 分支；Main 丢掉失败语义；网关可见但依赖配置和授权，未实际外发 |
| R46 | 保留 P2；仍统一为一个归属根因 | cronJobId / clientMessageId 已存在，详情完全不用；RunStore / lastRunId 不能补救生产 plain Engine 路径 |

## R44：生产门禁没有排除 timeout 后再排队

正式入口为 `packages/desktop/src/renderer/automation/AutomationView.tsx:517–518,750–765` → preload `index.ts:1025` → Main `index.ts:7078–7080` → `automation-service.ts:275–278` → `CronScheduler.runNow:916–925`。UI `AutomationView.tsx:337–350` 的 pending 只覆盖 IPC 和 refresh；Main runNow 本来就是 fire-and-forget，不能用按钮的短暂 busy 排除两分钟后的再次点击。这个入口接线为本轮源码确认；原 timeout fixture 第二次直接调用实际 scheduler，没有点击完整 Desktop Run now UI。

仍在第一轮 executor Promise 内时，scheduler `scheduler.ts:1125` 正确跳过同 job 重入。失败发生在 Desktop `index.ts:3524–3549` 的续接 helper：`mobile-remote/handle-client-event.ts:131,145,159–182` 默认整轮 120 秒，只识别相同顶层 response id，`agent/runAccepted` 通知不满足匹配。到时退订并返回普通结果，runner `automation/runner.ts:100–106` 不把 reason 当失败，scheduler `:1144–1151,1168–1174` 结算并释放 running/controller。没有 cancel 被发给 worker，也没有后续终态重新占用的路径。

真正的续接权威门禁没有遗漏安全校验：`automation-host.ts:438–450` 先验证 durable Session / 项目 / 根；`automation-authority.ts:224–282,309–320` 检查存在性、稳定根与目录对应关系，失效时 stop，不会把坏根交 worker。它不检查 session 是否 busy，因此健康绑定而仍在执行的 session 可以再次通过。Main AgentBridge `agent-bridge.ts:1995–2018` 阻挡配置变更 / 根迁移，不按同 session 正在运行拒绝普通续接。

Core 正式多会话协议 `server.ts:2034–2069` 先 enqueueTurn、再发 RunAccepted、最后 `:2071–2085` 等实际结果。`chat-session.ts:173–193,464–466` 在忙时把后继输入排进 FIFO，不并行启动第二个 Engine。Main 续接参数 `index.ts:3527–3533` 未设置 clientMessageId；Core `run-session-open.ts:117–140` 的重复输入 receipt 保护也不能按同一个 job / prompt 识别这些独立注入。原 fixture 的两个不同 RPC id 与无 clientMessageId 帧符合生产形状。

原动态证据使用实际 Main 闭包 / helper、runner、scheduler、ChatSession + fake Engine；仅把 helper 的 120000ms 压成 20ms，没有真实等两分钟。旧轮 busy、queueDepth=1、放行后同 prompt 执行两次已在 `resume-timeout-observed.json` 和双基线最终日志中记录。它不是完整实际 AgentServer / Electron / LLM E2E；本轮只用真实协议源码补足 helper → FIFO 衔接，没有重跑。

**范围与恢复：**

- 普通两分钟内终态、健康的未结算 scheduler 重入、单个 Engine 内的串行保护均正常。
- `scheduler.ts:1175–1178` 会在结算后删除 once job，因此同一个 once id 不会按这条入口再次触发。R44 的再排队结论应明确限保留下来的非 once / 周期任务；一次性任务仍有提前结算，但本审计不把它扩写为同 id 重复运行。
- 用户可以暂停计划避免后续 timer；`scheduler.ts:711–732` 的 pause 不撤回已经交给 worker 的旧轮或 FIFO。超时后 job controller 已清，`scheduler.abort:353–359` 会返回 false，不能据此声称自动化 cancel 一定能找回旧轮。
- 原对话仍 busy 且 Stop 可见时，正式 App `App.tsx:2505` → `useRunController.ts:930–985` → preload `:554–563` 发 agent/cancel；Core `chat-session.ts:277–293` abort active 并 drain queued。这是本轮静态恢复接线，未新点击 UI 或运行 cancel fixture；不是保证已经执行的副作用可撤回。
- Hub `serve/automation-worker.ts:105–142` 使用 waitForRunCompletion；admission timeout / sendFailed 会 await stopAndWait 再按 unknown outcome 失败，error / cancelled / 非 completed reason 也有明确分类。其 active reservation 直到 finally 才释放（`:143–146`）。正常独立 headless Desktop runner 直接 await Engine.run（`automation-host.ts:368–375`），不走旧整轮 helper。不能把 R44 泛化为所有 host。

建议仍为 P2：合法长任务 / 排队 / 审批等待可跨过两分钟，之后正常再次触发会累积重复提示。只把 timeout 改成 throw 虽可修 completed 文案，仍会释放 scheduler 占用；应跟踪 admission 与真正终态 / 明确取消，不能仅调大超时。

## R45：明确拒绝后 completed；外部可见范围受配置约束

原 fixture 是符合 JSON-RPC 的受控 error 帧，不是实际 provider 初始化失败实验。应严格写成“worker / bridge 返回实际 error response 时”，不能把所有提供方错误统称为此路径。真实 Engine 内部分错误会返回非 completed 的 EngineResult，不能仅凭原 fixture 推定它们都生成 `-32603`。

不过正式 Core 确实有拒绝分支，故无需为证实错误格式再跑模型：`server.ts:1931–1938` 的 requireExisting probe 异常、`:1967–1978` 的 getOrCreate 异常、`:2093–2101` 的非取消 run 异常都返回错误。明确、合法的保护例为 `chat-session-manager.ts:184,406–422` 默认 16 个 resident session 的容量限制：另一个健康磁盘 session 尚未 resident 时，getOrCreate 可抛 Overloaded，协议返回该错误而不是 SessionNotFound。此处仅源码可达证明，没有新造 17 个会话或执行模型。相同 Main bridge 在配置更新 / 根迁移时也会明确拒绝（`agent-bridge.ts:1995–2015`），但不把它包装成 Core 动态复现。

Main `index.ts:3540–3549` 只有 SessionNotFound 转 stop，其他已识别 helper error 变 `{text:"",reason:res.message}`。实际 runner `runner.ts:100–106` 丢掉普通 reason，scheduler `scheduler.ts:1144–1151` 发 job_end；notification mapper `automation-notification.ts:55–68` 本来明确区分 failed 与 completed，却被上游错分类送入 completed。原无压缩时钟的即时 error fixture 动态证明了完整这一段，不依赖 R44。

**通知不是无人消费，但不保证每台设备都会外发：**

- Main `index.ts:3585–3589` 调 publishGatewayControlEventBestEffort；`:1049–1066` 先进入 GatewayControlServer.publish，再尝试 direct delivery。`im-gateway-control-server.ts:35–49` 允许 automation.completed，`:382–419` 持久后才使事件可见，`:467–487` 提供真实授权 `/v1/events` 消费。
- direct sender `im-gateway-service.ts:724–775` 仅在 live watcher 未拥有流、有配置、目标仍授权、渠道支持 direct 且有必需上下文时发送；否则由正确 owner 后续消费或不发送。`chat/notification-relay.ts:106–134,161–162` 保留目标授权 / 进度去重并发送 event.text，不会重新推导自动化真实结果。
- 此链本轮仅静态核验，未监听真实网关 / 向任何渠道发消息。publish 也可因未启动或 outbox 满而失败，不能声称所有用户都必然看到外部成功通知。
- 普通 OS 成功通知不在结论内：Main 此处调用的 `desktop-notification-routes.ts:72–87` 只处理 job_missed；缺失目标 urgent stopped 是另一明确分支。stream / 日志可能保留真实错误，不能声称失败痕迹全部丢失。

P2 保留：正确拒绝应该映射 failed / stopped，而不是告诉已配置的生命周期消费者“已完成”。失败后计划保持 enabled、修好原因可再次 runNow；这属于 transient failure 正常重试，不会修正已发布的旧 completed event。SessionNotFound / durable authority-invalid 的 stop 分支、Hub `automation-worker.ts:135–142` 的错误分类、Hub receipt `panels/hub-automations.ts:212–249` 的 failed/cancelled/interrupted 均为正常保护。

## R46：有强身份线索，但没有实际补救这条关联逻辑

**不能沿用“强身份没有持久化”的过宽表述。** 真实 Main `automation-host.ts:352–360` 公告 name+date、精确 cronJobId、clientMessageId。`liveSession.ts:69–77` 保存 cronJobId，`app/useHostSubscriptions.ts:439–495` 正式接收并 upsert；Main catalog `session-catalog-store.ts:18–35` 的保存白名单保留 cronJobId。只要该 catalog row 仍在，这个稳定任务身份已经存在。

独立 headless runner `automation-host.ts:336,368–373` 还传 `automation:${job.id}:${stablePromptHash(job.prompt)}` 作为 clientMessageId。真实 `run-session-open.ts:245–249` → `session-manager.ts:1622–1641` 把它与 runId 写入 state；`server/sessions-service.ts:201–223,398–407` 可把 clientMessageId / runId 返回磁盘摘要。所以新执行 session 并非只能凭名称、目录和时间识别。

**这些字段仍未参与当前详情。** `AutomationView.tsx:159–162` 对本地 row 仅比较完整 title / RunStore cronJobName；`:175–181` 的 RunStore 回退仍按名称；`:202–214` 的磁盘回退只用 origin、cwd、prompt 与 24 小时条件。该函数既不读取 cronJobId，也不读取磁盘 clientMessageId / runId 作为任务归属。renderer `rebuildFromDisk.ts:10–20,60–68` 也没有把这些磁盘字段转成明确 automation job identity。即使给原 A/B fixture 补这些已有字段，当前分支仍不会读取；没有必要只为重复证明这一静态事实重跑。

Production plain Engine runner 不向 RunManager 提交，`lastRunId` 仅 `core/automation/runner.ts:147` 的另一 RunManager executor 赋值；详情 `AutomationView.tsx:1166–1170` 已明确说明该生产场景 lastRunId 常空。引入现有 RunStore 不能自动救回这些 session。

原 UI fixture 的可达证据仍有效：真实 placeLiveAutomationSession 给出正确 cronJobId 和日期标题，实际详情遗漏它；同项目 disk A/B 的实际详情把 B 纳入、按更新时间排序后当作最近执行（`:230–233,603`），真实历史按钮 `:1192–1195` 把 B 对象交 onOpenDiskSession。动态末端仅为实际组件回调，没有再执行完整 Main transcript open；真实 UI 接线存在，未声称跨权限读取或打开任意路径。

**范围和恢复：** history 区域 `AutomationView.tsx:1151` 仅 standalone job 展示；绑定续接任务没有此独立执行列表。cwd / origin / archived / 去重保护均存在，原已确认污染限定同项目 automation sessions；不扩大到任意其他项目或越权数据。若标题偶然完全等于 job.name，或旧 RunStore 同名记录存在，本地记录可以被纳入，但这不是稳定 job identity 保护，也无法保证名称碰撞正确。原 transcript / sidebar 没丢，用户可去侧栏 / SessionsView 人工辨认原会话；重开自动化页不会自行修正此谓词。

保留一个 P2，实时遗漏与磁盘错归属不分开计数。修复应优先已保存 cronJobId，并为新旧磁盘 session 建立明确、持久的 job provenance。已有 host clientMessageId / transcript 首次输入可作为兼容迁移线索，但 state.clientMessageId 是当前轮身份，后续人工 run 会更新，不能当成永不变化的 automation 主键。共同 cwd、相似 prompt、时间接近只能用于提示候选，不能直接认领为另一 job 的结果；所有显示关联仍须在原 session / 文件授权之内。

## 证据、计数和未新执行的原因

已读 `docs/review-2026-10-12/reproductions/automation-round5/` 的两份完整脚本、observed JSON、最终原始日志，以及 `validation/latest-a66f4ef2/` 对应复跑日志。两冻结快照已有最终 **2 文件 / 7 测试 / 38 Bun expect / 0 fail / 0 skipped**，均有 Completed 收尾；其中 resume 3/20，display 4/18，后者还包含本轮未扩查的 R47/R48。它们是既有执行，**本轮不重复累计；本轮 0 文件 / 0 测试 / 0 断言执行**。

原脚本在 Host / Core 导入前 exact-origin guard，无实际网络；通过 guarded runner 运行。resume fixture 使用真实闭包抽取避免启动 Main/Electron，fake transport / fake Engine 的边界明确；display 是真实 React 组件 + mini DOM / IPC 替身。没有自然两分钟、真实模型、完整 Electron 和外部 gateway 送达证据。本轮不伪装补齐这些限制。

关键 automation / Core / renderer / gateway / storage 文件的 `84740d56..a66f` diff 为空；Main index 差异只有 Panel stable scope 初始化 / 接线，不在上述闭包 / IPC。没有切换基线或使用新 origin 代码。latest 产品 tracked diff 干净，只有 root 持有的未跟踪 docs 目录。所有具体反证问题已由现有动态证据和精确生产源码回答，因此不为计数新增或重跑 fixture。

Completed。

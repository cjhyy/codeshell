# 外部运行时会话问题清单（2026-11-19）

来源：一次 Claude Code 外部运行时会话（开着 Goal，目标是"做完、发版、网页对齐桌面端"）的复盘。
只列问题、证据和候选方向，**技术方案待定**。代码位置以当日 `origin/main`（71ffe8702）为准，动手前先 `git log` 看有没有人已经改过。

状态：⬜ 待出方案 · ✅ 已决定方向

---

## T1 ✅ 外部会话开放电脑操控（已决定开放）

**现象**：外部 CC/Codex 会话只能用 `browser_*`，没有任何电脑操控工具；用户在别的地方打开的页面、桌面应用都动不了。

**证据**

- 外部工具评审清单 `packages/core/src/tool-system/external-tool-exposure.reviewed.json`：52 项，不含任何 CUA 工具。
- 原生会话的 CUA 走 Host MCP：`computer-use/service.ts:165` `hostMcpServersEnv()` → `CODE_SHELL_HOST_MCP_SERVERS`（`agent-bridge.ts:474`），服务名 `host:cua-driver`（`cua-driver-host.ts:22`），声明见 `cua-driver-host.ts:204` `mcpDeclaration()`（带活动 socket/token、应用档案目录）。
- 外部 CC 启动时用 `--strict-mcp-config` + `--allowed-tools` 只放行 CodeShell 桥（`coding/src/external-runtimes/claude-code/mcp-config.ts:161-183`），所以用户自己装的 cmux-cua 也进不来；Codex 侧同样把非桥 MCP 全部 `enabled:false`（`codex/runtime.ts:366-395`）。

**候选方向（待选）**

- A. 把 Host 的 `host:cua-driver` 也挂进外部会话：CC 多给一个 `--mcp-config` 条目、Codex 加一个 enabled 的 mcp_server；保留现有输入闸门（PR#239：网页内只能后台 set_value）、会话 lineage `_meta`、光标/舞台、权限授给 CodeShell Computer Use.app。
- B. 通过桥转发：在 `codeshell_tools` 里注册 CUA 代理工具并进 exposure 评审，走 `ToolExecutor` 审批。统一审批，但工作量大。
- C. 放行用户自己的 cmux-cua：最省事，但它不受 CodeShell 闸门和审批控制，和 `mcp-config.ts:161` 注释里的安全立场冲突。
- 不论选哪种，都要同步：exposure 评审快照、外部会话的工具指引（何时用 browser\_\* 何时用 CUA）、审批 UI 文案。

---

## T2 ⬜ 外部会话永远拿不到用户的浏览器面板标签页

**现象**：用户说"浏览器我已经打开腾讯云了"，`request_panel_access` 返回 "No BrowserPanel tab is open for this task"，只能另开一个未登录的任务窗口让用户再登一次。

**证据**

- 外部会话固定绑定独立浏览器桶 `external-runtime:<sessionId>`：`external-runtime-browser-bucket.ts:8`，注册于 `agent-bridge.ts:2353`；渲染端后来想改绑会被直接忽略（`browser-session-ipc.ts:125`）。
- 面板授权查找 `panel-access-request.ts:131` → `defaultPanelFor` → `activeGuestForSession`（`browser-driver/active-guest.ts:249`），只在该会话绑定的桶里找活动 guest。用户的面板在项目桶（`browser:p:<projectId>`）里，**结构上不可能命中**。
- 同理，Cookie 跟 sessionId 走：每开一个新外部会话就是空 Cookie jar，要重新登录（本机已有多个 `browser:p:external-runtime:s-*` 分区）。原生会话此前已改成按 profile/workspace 分层，外部会话没跟上。

**待定**：外部会话是否复用项目 profile 分区；若坚持隔离，`panelFor` 至少要能跨到用户可见窗口的项目桶去找并请求授权；工具说明里不要再暗示这条路可用。

---

## T3 ⬜ 有后台任务时 Goal 整体挂起，前台工作也停了

**现象**：用户登录腾讯云后，代理只截了一张白屏就以"下一轮接着做"结束；随后 Goal 进入"等待后台任务"，浏览器那条线一直没人动，直到 DriveAgent 后台任务结束把它唤醒；唤醒后又先处理后台结果，才回到浏览器。

**证据**

- `external-runtime-goals.ts:365` `waitForBackgroundWork()` 把整个 Goal 标成 waiting；`afterTurn(..., waitingForBackgroundWork)` 直接返回，不再自动续轮。
- 当时的 `goal_progress.waiting.tasks` 只有那一个 DriveAgent 任务。

**待定**：区分"确实无事可做只能等后台"和"还有自己的下一步"；后者应继续自动续轮。判断依据（模型显式声明？最后一轮是否给出待办？）待设计，注意别回退 PR#312 的空转修复。

---

## T4 ⬜ DriveAgent 用 `claude -p` 时 Bash 全被静默拒绝，却报"完成"

**现象**：后台 worker 跑了约 12 分钟，git / bun test / node / prettier 全被拒，最后只留下未提交的改动；通知显示"外部代理任务完成"。

**证据**

- 启动参数：`coding/src/cc-orchestrator/agent-adapter.ts:55-77`，`-p` 非交互，`--permission-mode` 原样透传，无 `--permission-prompt-tool`、无 `--allowedTools`；stdin 为 ignore（`external-agent-driver.ts:308`）。`-p` 下所有 ask 立即拒绝（`external-runtimes/claude-code/permissions.ts:13-14`）。
- 拒绝不可见：结果解析只读 session id / result / is_error，忽略 `permission_denials`（`agent-adapter.ts:79-98`）；进度把拒绝显示成泛化的 "Tool reported an error"（`external-agent-progress.ts:62-70`）；正常退出即标 completed（`drive-agent.ts:886-907`）。
- 已有可复用的审批通路：外部 CC 主运行时用 `--permission-prompt-tool`（`runtime.ts:243-248`）；`desktop/src/main/cc-room/approval-bridge.ts:59` 已把 `can_use_tool` 接到 UI。
- 工具说明与实际不一致：schema 文案（`drive-agent.ts:152`）说默认 `bypassPermissions`，但外部会话里实际默认 `"default"`（`:1105-1112`）；`:1256` 注释也过期；没有说明 `acceptEdits` 会挡住 Bash/git/测试。

**待定**：权限请求接审批 UI，还是隔离 worktree 内放宽（`bypassPermissions` 或窄 `--allowedTools`）；拒绝次数要计入结果（降级/失败而不是完成）；修正说明文案。

---

## T5 ⬜ 后台任务看不到是什么、卡住也看不出来

**证据**

- 完成通知正文 `background-notification-content.ts:134-137`：`name || "外部代理任务 <jobId>"`；DriveAgent 入队时不带 `name`（`drive-agent.ts:868-903`），但其实有 `description`（`:1268`，prompt 前 40 字）没被用上。
- 运行中视图 `DriveAgentTaskView.tsx:323-365` 有阶段/最近活动/60s 静默提示，但没有"被权限拦住 / 已拒绝 N 次"状态。
- Goal 的等待条只显示截断到 40 字的 prompt 作标签。
- 未核实：外部会话里这个任务的卡片是否渲染了、能不能点进详情视图。

**待定**：任务要有人话标题（模型给 title，或辅助模型摘要）；运行中显示当前在做什么、是否被拦；Goal 等待条能点开到任务。

---

## T6 ⬜ 提问太频繁、输入框太多

**现象**：10 分钟内两次 `wait_for_user`，每次都是一大段 A/B/C 加附加问题，同一个问题在界面上出现三次、两个输入框。

**证据**

- 三份同样的内容：
  1. 回复正文——工具说明 `external-runtime-goal-tools.ts:17-18` 写着 "Ask the same question in your reply"，Goal 提示词 `external-runtime-goals.ts:511` 也要求"在回复里问并调用"。
  2. `GoalReplyCard.tsx:56-112`（`GoalBar.tsx:333-345` 渲染在主输入框上方），**自带 Textarea**（`:77`）；而主输入框发消息同样能清掉等待（`external-runtime-service.ts:1691-1693`），这个输入框是多余的。
  3. `goal_progress.gaps = "等待你的回复：…"` 在消息流里留下一条永久行（`GoalProgressView.tsx:174-175`，`MessageStream.tsx:559`），回答后也不收起。
- ask_user 卡片也各自带输入框（`AskUserMessageView.tsx:286`），和 Goal 卡同时存在时只是禁用、不隐藏（`ChatView.tsx:2221-2223`）。
- 无频率限制：`waitForUser`（`external-runtime-goals.ts:215-255`）无冷却/计数/去重，第二次调用直接覆盖第一次。
- 提示词逼它停：`external-runtime-goals.ts:510` "发布等对外动作不要自己做"；"把所有决定合成一个问题"让问题变长。

**待定**：去掉"回复里再问一遍"；问题只在一个地方展示、只用主输入框回答（选项可做成 chips）；同一轮禁止第二次 `wait_for_user`、加冷却；提示词改为"给出默认做法，非必要不问"；回答后收起"还差"行。

---

## T7 ⬜ 浏览器跳转不等加载就截图

**现象**：`browser_navigate` 立即返回 "Navigated to …"，紧接着 vision 截图是白屏，模型据此结束本轮；腾讯云控制台还多次出现 "Observation incomplete: child frame did not respond within 1999ms"。

**待定**：navigate 是否默认等 DOM ready/首帧；vision 截图前是否等绘制；白屏时提示模型 `wait` 而不是收工。

---

## T8 ⬜ 结论没核实就当事实

**现象**：代理根据部署记录文档断定"线上还停在 11-13 那版、Passkey 那批未上线"，并据此规划了 schema 迁移和备份；连上服务器后才发现 Passkey 那批早已上线，真正缺的只有 #68。

**待定**：属提示词/工作习惯层面——涉及"线上是什么状态"的结论要先查真实状态，或在回复里明确标注"依据文档推断、未核实"。

---

## T9 ⬜ 对生产环境的越权与危险命令

**现象**

- 用户只说了"研究下怎么连接"，代理就自行生成临时 SSH 密钥并通过网页终端写进生产服务器 `authorized_keys`。它在提问里提过这个计划，但用户没有明确同意。
- 一条 `rm -rf $B/$N`（变量可能为空）被 Bash 安全检查拦下。

**待定**：Goal 下"对生产的写操作/新增凭据"是否必须显式同意；用户回复不是明确同意时，模型应如何理解。

---

## T10 ⬜ 后台委派失败后主会话重做

**现象**：DriveAgent 12 分钟没有可用产出，最后测试、提交、开 PR 全部是主会话在唤醒后补做的。T4 修好后大部分会消失；另需考虑后台任务失败/被拦时是否尽早通知主会话，而不是等它跑完。

---

## T11 ⬜ "目标已暂停"但会话还在干活，状态分不清

**现象**：Goal 跑满本轮时间预算后自动暂停（`goal_progress.gaps = "达到本轮时间预算；目标已暂停，可继续。"`，`goalLifecycle.phase = "paused"`）。随后 Mimi 把用户在微信里的回复作为一条新消息转进同一个会话，会话以普通轮次继续工作了三十多分钟，而 Goal 状态一直是 paused。界面上同时出现"目标已暂停"和"正在工作"。

**待定**："目标暂停"和"会话停止"是两件事，界面要分开表达；会话在已暂停的 Goal 下收到新消息继续干活时，是恢复 Goal（重新计预算）、还是明确显示"目标暂停中，正在处理一条新消息"，需要定规则。Mimi 转入的消息是否应该走"继续 Goal"而不是普通消息。

---

## T12 ⬜ 微信通知"需要你决定"没有内容

**现象**：Goal 因时间预算暂停时，提醒系统发出 `session.blocked` 通知，文案是"需要你决定"，但没有任何具体问题（Mimi 事后自查：`无具体问题，delivery=withdrawn`）。用户只能回"需要决定什么内容。肯定是继续"。

**待定**：预算用完的暂停不是"需要决定"，应是另一种通知（"已暂停：跑满时间预算，回复'继续'即可"），或者按用户既有授权直接续期不打扰；`session.blocked` 通知必须带上具体问题，没有问题就不发。另：同日 08:51 还有一条 `pet.notice.outbox_failed kind=session.blocked`，未查。

---

## T13 ⬜ 暂停后用户发的消息被空转吞掉

**现象**：Goal 暂停 2 秒后，用户在桌面端发了一条具体要求；该轮 2 秒结束，`turn_complete.outcome.didWork = false`，没有任何回复。用户的要求是后来靠 Mimi 转述才被执行的。

**证据**：会话日志在同一秒有 `session.stopped` → `session.started`；该轮没有任何助手输出。根因未查（疑与 Goal 暂停收尾和新消息提交的竞态有关）。

---

## T14 ⬜ 桌面发消息会顶掉运行时，排队中的 Mimi 请求随之失败，回执还说不清

**现象**

- Mimi 在 17:57 向该会话提交了"继续收尾"的委派（已受理、待启动）。会话上一轮当时已经结束，但这条请求排了 13 分钟一直没启动。
- 18:10 用户在桌面端发了一条消息，运行时会话在同一秒被停止并重启（和 T13 是同一个特征，这条桌面消息同样 2 秒空转、没被执行）。
- 排队中的 Mimi 请求因此失败：`external runtime session was replaced before its queued turn`。
- Mimi 发给用户的微信说"一条旧请求失败……上一轮的收尾请求已另行受理"。从记录看，失败的很可能就是最新那条请求本身，这句话是错的。

**待定**：排队的委派为何在会话空闲时不启动；运行时被替换时排队的轮次要带过去，或者立刻失败并说明是哪一条；回执要带结构化的任务标识，让 Mimi 不会说错。

---

## T15 ✅ 目标默认 30 分钟就暂停（已决定：对标 Codex，取消默认时间预算）

**现象**：外部会话的 Goal 每轮默认 30 分钟（`external-runtime-goals.ts:8` `EXTERNAL_GOAL_DEFAULT_TIME_MS`），到点就暂停，不管有没有进展。等 CI 的发版类目标一定会被打断。

**Codex 的做法**（取自本机 codex 0.162 内置的目标提示词）：状态为 active / paused / blocked / usageLimited / budgetLimited / complete；没有时间预算，用时只做展示；token 预算只有用户明确要求才设；`paused` 只在用户明确要求时出现，模型不得自行暂停；同一阻塞连续三轮才标 `blocked`；每次续轮先判断上一轮是"有进展 / 确认在等 / 无进展"。

**方向**：取消默认时间预算；系统只在"连续无进展"或用户显式设了预算时停，并且用不同于"用户暂停"的状态表达。

---

## T16 ⬜ 点了继续，会话在干活但界面没有任何输出

**现象**：用户点"继续目标"后，运行 81 秒内输出日志里没有任何流式事件（无请求开始、无文字、无工具调用），但同一时段桌面日志里有该会话的 Bash 审批请求，说明 CLI 在执行。用户看不到反应，9 秒内连点 5 次暂停/继续（Goal revision 6→11），该轮以 `aborted_streaming`、`didWork:false` 结束；下一轮同样没有输出。两条"被吞掉"的用户消息（T13）也是零输出事件，疑为同一根因：运行时重启或恢复后，输出没有接到会话的输出通道上。

**待定**：查清输出绑定为何丢失；连点暂停/继续要幂等。

---

## 小问题

- 每次 run 都记录两条 `session_started`（同一 runId），疑似重复发射。
- `state.json` 的 `turnCount` 比实际 run 数少一（唤醒轮未计入？）。
- ToolSearch `select:` 在转录里结果为空字符串，确认是否只是记录问题。
- 网页端：有新输出跟随滚动时展开过程列表，列表还在移动，手指点下去可能落在别的工具卡片上（CI 上 `test-history-details-browser.mjs` 因此偶发失败，测试已改为等卡片静止后再点）。真实用户是否会遇到未验证。

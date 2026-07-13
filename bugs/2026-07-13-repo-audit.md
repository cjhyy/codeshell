# CodeShell 仓库持续审计问题清单（2026-07-13）

审计基线：`main@5fe604a8d9f09aecbff7995b151067e779370323`。本文件汇总本轮持续审计中已确认的问题、需要二次复核的高风险候选，以及已经修复但与本次日志现象有关的历史项。行号均以该基线为准，后续修改可能造成少量漂移。

状态说明：

- **确认**：已通过代码闭环、确定性复现、真实日志或现有行为测试确认。
- **需复核**：静态路径成立，但仍需在真实 Electron/多窗口威胁模型或完整执行链上确认影响与优先级。
- **历史已修复**：本次日志确实命中过，但当前源码已经包含修复；旧进程/旧安装包仍可能表现为未修复。

本次审计基线共登记 **58 个确认问题**（P0 5、P1 42、P2 11）、**4 个待复核候选**，另附 **1 个历史已修复项**。其中部分 Goal/Steer 相关项已在同一工作树修复；当前状态以文末“Goal / Steer 控制专项复核”为准，不再把基线统计误解为“修复后仍有 58 个”。

## P0 — 发布阻断 / 跨租户泄漏 / 未信任代码执行

### P0-01 Desktop 首屏引用未定义的 `activeRepoKey`（确认）

- **影响**：Desktop `App` 首次渲染直接抛 `ReferenceError`，主界面不可用。
- **证据**：`packages/desktop/src/renderer/App.tsx:4385-4391` 的 effect 依赖引用了作用域中不存在的 `activeRepoKey`。
- **复现/测试**：Desktop typecheck 命中该行；`AppQuickChat` 相关用例曾得到 `0 pass / 30 fail`，均为同一异常。
- **建议修复**：改用真实存在且语义稳定的 repo identity，补首屏 smoke test，并让 Desktop 独立 typecheck 成为合并门禁。

### P0-02 TCP 多连接后台通知与自动续跑串流泄漏（确认）

- **影响**：非 session owner 的 TCP 客户端可收到其他客户端的后台任务结果；还可能抢走该 session 自动 wake 后的完整模型输出。
- **证据**：`packages/core/src/cli/agent-server-tcp.ts:140-149` 为每个连接创建 server，却共享 `ChatSessionManager`；`packages/core/src/protocol/server.ts:344-404` 的进程级通知订阅没有 owner 过滤；`packages/core/src/tool-system/builtin/agent-notifications.ts:504-510` 向所有订阅者分发。
- **复现/测试**：双连接复现中，B 收到 A 的 `SECRET` background completion，并收到 A wake turn 的 `session_started/text_delta/turn_complete`；现有 TCP 测试只覆盖 approval owner。
- **建议修复**：通知总线事件携带并强制核验 connection owner；只有 owner server 能 drain/wake，其他连接不得收到 payload。

### P0-03 TCP 可越权读取并 fork 其他连接的 session（确认）

- **影响**：同一 TCP host 上的客户端可枚举、读取他人完整 transcript，并 fork 出包含其上下文和 workspace 的副本。
- **证据**：共享 manager 见 `packages/core/src/cli/agent-server-tcp.ts:140-149`；`packages/core/src/protocol/server.ts:1796-1801,1824-1829,1872-1890` 的 list/detail 无 owner 校验；fork 路径 `server.ts:603-621,719-767,839-856` 也未核验 source owner。
- **复现/测试**：`conn-b` 成功读取 `conn-a` 的 `TOP_SECRET_TRANSCRIPT` 并创建 `stolen-copy`；原 session owner 仍为 `conn-a`。
- **建议修复**：把 list/detail/fork/source snapshot 全部纳入统一 connection ownership guard；测试 B 对 A 的 session 全部返回拒绝。

### P0-04 未信任项目的 MCP 配置在 trust gate 前被启动（确认）

- **影响**：打开未信任仓库后，仓库提交的 `mcpServers` 可在模型运行前启动任意本地命令。
- **证据**：Desktop 正确传入 trust 值：`packages/desktop/src/main/agent-run-metadata.ts:24-39`；但 stdio factory 在 `packages/core/src/cli/agent-server-stdio.ts:224-265` 用默认 `projectTrusted=true` 预读项目配置并注入 Engine；连接发生在 `packages/core/src/engine/engine.ts:1736`。
- **复现/测试**：同一临时项目中，factory 读到 `evil` server，而显式 `SettingsManager(..., false)` 返回空集合。
- **建议修复**：所有项目配置读取必须使用请求携带的真实 trust；禁止把未过滤的预合并 MCP config 传进 Engine。

### P0-05 远期 cron / 大间隔因 `setTimeout` 32 位溢出立即热循环（确认）

- **影响**：`30d` 等大于约 24.8 天的间隔或远期 cron 被运行时压成约 1ms，任务会提前执行并可能持续高频触发。
- **证据**：`packages/core/src/automation/scheduler.ts:602-619,630-665` 将完整远期 delay 直接传给 `setTimeout`，没有分段长定时器。
- **复现/测试**：最小复现 25ms 内触发 21 次；现有测试没有覆盖 `2^31-1ms` 以上 delay。
- **建议修复**：用最大安全 delay 分段唤醒，到达最终时间才 fire；同时为 interval 与 cron 两条路径加 fake-clock 边界测试。

## P1 — 高影响正确性、安全与数据一致性

### P1-01 工具调用无进展 busy-loop 没有运行时熔断（确认）

- **影响**：模型可反复调用逻辑相同、结果相同的工具数十至数百轮，消耗巨量 token，任务看似“卡住”但持续执行。
- **证据**：含工具调用会清零 stop block：`packages/core/src/engine/turn-loop.ts:988`；Goal judge 只在无工具响应时介入：`turn-loop.ts:1153`；工具结果后固定继续：`turn-loop.ts:1361,1563`；默认 Goal 上限为 300 turns：`packages/core/src/engine/goal.ts:232`。`DriveAgentJobs` 又绕过 `packages/core/src/tool-system/investigation-guard.ts:68,137,175` 的有限去重。
- **复现/测试**：真实会话 turn 37–44 连续 8 次相同参数、相同结果 digest，累计 11,519,016 tokens，最终人工 abort；日志中 10:52–10:55 共 23 次 list。
- **建议修复**：对 `toolName + canonical args + result/error digest` 做跨轮 fingerprint，达到阈值后强制停止、询问或改变策略；排除 call id 并稳定排序参数。

### P1-02 Desktop Goal hydrate 的异步响应会被自身 state 更新取消（确认）

- **影响**：磁盘上真实 active goal 存在，但右上角不显示或显示旧状态。
- **证据**：`packages/desktop/src/renderer/App.tsx:1141-1186` 先提交 transcript state，再 await `goalGet`；transcript 变化触发 effect cleanup，把较慢响应标记为 cancelled。
- **复现/测试**：使用 deferred `goalGet` 可稳定丢弃真实 Goal 响应；现有 App 测试只 stub `null`。
- **建议修复**：按 sessionId/goalId 使用独立 hydration generation；不要让本次 hydrate 自身更新触发取消，响应落地前做 CAS 式 freshness 校验。

### P1-03 TUI `/resume` 不恢复持久化 Goal 状态（确认）

- **影响**：恢复含 active goal 的 session 后，`/goal` 错误显示“没有活跃目标”，清除/驱动语义与磁盘不一致。
- **证据**：`packages/tui/src/ui/App.tsx:293` 的 `activeGoalRef` 从 null 开始，仅消费当前进程 live event；`packages/tui/src/cli/commands/builtin/core-commands.ts:512` 的 resume 没有 `goalGet` 对账。
- **复现/测试**：恢复一个 state.json 含 activeGoal 的旧 session 即可；缺少 resume+goal hydration 测试。
- **建议修复**：resume 成功后读取目标快照并按 goalId hydrate；切换 session 时清掉旧 session 的本地 Goal。

### P1-04 Goal 终态 CAS 重试仍可用旧 `summary` 覆盖并发新值（确认）

- **影响**：Goal 终态保存成功，但旧 run bundle 携带的非 Goal 字段覆盖另一个 writer 的新 summary/title 等状态。
- **证据**：`packages/core/src/session/session-manager.ts:823-875` 仍允许 whole-state 保存；终态 read-merge-retry 后存在回到 whole-state 快路径的窗口；代码债也记录在 `TODO.md:33`。
- **复现/测试**：用两个 detached state writer 已复现新 summary 被旧值写回；现有 Goal tombstone 测试聚焦 activeGoal，不覆盖非 Goal 字段 permutation。
- **建议修复**：终态重试只能 field-level merge Goal 领域字段；禁止运行期业务继续提交 detached whole-state。

### P1-05 workspace 切换推进 revision 后，active worker fallback 会丢 `turnSeq`（确认）

- **影响**：磁盘 `turnSeq` 落后一轮，文件历史可能把两个用户回合合并为一次 undo 边界。
- **证据**：main 侧 workspace 更新在 `packages/desktop/src/main/session-workspace-service.ts:249-345`；worker 最终保存/回退在 `packages/core/src/engine/engine.ts:2576` 附近，live bundle 没有同步外部 revision/turnSeq。
- **复现/测试**：workspace switch 与运行中保存交错时，磁盘 `turnSeq` 可稳定少 1；`TODO.md:33` 已记录该边界。
- **建议修复**：workspace mutation 经 active worker 或向 live bundle 回填最新 revision 与所有并发字段；加入 switch×turn save permutation 测试。

### P1-06 TUI 丢弃 stream envelope 的 `sessionId`（确认）

- **影响**：切到 session B 后，session A 的后台 wake 输出会写进 B transcript，甚至把当前 session 偷切回 A；并发 approval 也会相互覆盖。
- **证据**：`packages/tui/src/ui/App.tsx:912` 只传 `envelope.event`；`App.tsx:587,632` 无条件处理 session_started 与共享主代理 buffer；全局 pending approval/question 位于 `App.tsx:307,411`。
- **复现/测试**：A 启动后台任务→resume B→A completion wake，可稳定污染 B；现有 stream routing 测试无 A/B envelope 场景。
- **建议修复**：所有 stream、approval、question 状态按 envelope sessionId 分桶；只有当前 session 可投影到 UI。

### P1-07 Desktop 多窗口 RPC 数字 ID 碰撞（确认）

- **影响**：窗口 B 的响应可提前结算窗口 A 的不同请求，A 的真实响应随后被忽略。
- **证据**：每个 preload 从 `nextRpcId=1` 开始：`packages/desktop/src/preload/index.ts:134-209,330`；bridge 广播响应给所有窗口：`packages/desktop/src/main/agent-bridge.ts:301,518-525`。
- **复现/测试**：两窗口首个请求 wire id 都为 1，较快的 B response 同时 resolve A/B Promise。
- **建议修复**：由 main 分配全局 request nonce，或在 ID 中包含 window/webContents identity，并只单播给原 sender。

### P1-08 移动端可把非可信 cwd 升级为 `bypassPermissions`（确认）

- **影响**：攻击者可让旧房间继续在非可信目录运行，却通过另一个可信 cwd 的检查取得免审批模式。
- **证据**：权限根据客户端 cwd 判断：`packages/desktop/src/main/index.ts:1388`；`packages/desktop/src/main/mobile-remote/room-manager.ts:438-454` 复用只匹配 `sessionId+kind`，不校验 cwd，随后更新 mode 并重启。
- **复现/测试**：旧房间 cwd=`/untrusted-sensitive`，第二次以同 sessionId 和 `/trusted` 请求后，spawn #2 仍在旧 cwd 且 mode=`bypassPermissions`。
- **建议修复**：复用房间必须要求 canonical cwd 一致；权限决策必须绑定最终 spawn cwd，而非请求字段。

### P1-09 删除/撤销设备不终止已认证 socket（确认）

- **影响**：用户删除被盗手机后，只要连接不断，该设备仍可聊天、审批、启动任务。
- **证据**：认证后 deviceId 被缓存到 socket WeakMap，后续事件只检查缓存：`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:220-234`；删除只改磁盘：`packages/desktop/src/main/index.ts:2921`。
- **复现/测试**：真实 WS 中删除设备后，在线列表仍含该设备，且 `session.list` 继续被 dispatch。
- **建议修复**：维护 deviceId→sockets 索引；revoke 时主动 close 并清认证状态，且每个敏感事件重新核验 revoked 状态。

### P1-10 Pet 路径审批被投递到错误 work session（确认）

- **影响**：Pet 等待路径审批时，卡片出现在普通工作聊天；回答又按 Pet engineSessionId 回传，造成 UI/transcript 跨会话污染。
- **证据**：`packages/desktop/src/renderer/App.tsx:2317-2334` 在 Pet bucket 解析失败时回退 `activeBucket`；Pet host 在 `packages/desktop/src/renderer/pet/PetChatHost.tsx:132-173` 没有独立 AskUser/approval UI。
- **复现/测试**：在 Pet 读取 cwd 外路径，审批卡稳定出现在当前 work session。
- **建议修复**：Pet 使用独立 bucket 与 approval state；禁止 unresolved bucket 回退到 active work chat。

### P1-11 Pet 超过 120 秒被报失败但 worker 继续运行（确认）

- **影响**：前端解除 busy 后用户可再次发送，而旧 turn 仍后台运行，产生重叠/不可见排队和迟到流。
- **证据**：`packages/desktop/src/main/agent-bridge.ts:861-904` 对 requestWorker 固定 120s timeout；`packages/desktop/src/main/pet/pet-dispatch-service.ts:128-140` 超时不 cancel；renderer 在 `PetChatHost.tsx:50-57` 清 busy。
- **复现/测试**：执行超过 120 秒的 Pet 任务，两分钟后 UI 显示失败，projection 仍为 running，后续流继续到达。
- **建议修复**：长 run 不使用短 RPC completion timeout，或超时时显式 cancel 并等待终态；UI busy 由真实 run lifecycle 驱动。

### P1-12 插件安装在 registry 写失败后留下孤儿目录（确认）

- **影响**：UI 报安装失败、列表不可见，但重装又报“already installed”。
- **证据**：`packages/core/src/plugins/installer/install.ts:82-94` 先 rename 到 finalDir，再写 registry；catch 只清已不存在的 tmpDir。远程来源元数据也有同类窗口：`installFromSource.ts:49-61`。
- **复现/测试**：故障注入得到 `finalDirLeft:true, registered:false`，第二次安装失败。
- **建议修复**：目录与 registry 使用事务/补偿删除；启动时检测并修复孤儿安装。

### P1-13 并发升级同名插件会删掉唯一备份（确认）

- **影响**：两个升级都失败时，正式插件目录与旧版本备份可同时消失。
- **证据**：`packages/core/src/plugins/installer/update.ts:45-64` 的 backup 名只含 `process.pid`；Desktop IPC `packages/desktop/src/main/index.ts:2301` 无按插件锁。
- **复现/测试**：两个 Promise 并发升级后 `liveExists:false` 且 entries 为空。
- **建议修复**：使用随机唯一备份名，并以 plugin install key 做跨窗口/进程锁；rollback 后再清备份。

### P1-14 卸载插件不触发运行中 hooks/MCP 重载（确认）

- **影响**：磁盘和 UI 已删除插件，当前 Engine 仍可执行其 hook 命令或调用其 MCP server。
- **证据**：`packages/desktop/src/renderer/extensions/PluginsTab.tsx:101-193` 中 install/update 发 hot reload，uninstall 没有；hook 仍捕获在 `packages/core/src/plugins/loadPluginHooks.ts:216`；MCP reconcile 在 `packages/core/src/engine/engine.ts:2939`。
- **复现/测试**：静态调用链闭环；extensions 测试没有卸载后的运行时断连用例。
- **建议修复**：卸载成功后统一 signal reload；Engine reconcile 时先移除旧 hook、关闭已删除 MCP，再加载新集合。

### P1-15 未信任项目仍可注入 `mcpServerOverrides`（确认）

- **影响**：项目可给已安装插件 MCP 注入 env、credentialRef 等敏感覆盖，绕过 workspace trust。
- **证据**：危险字段列表 `packages/core/src/settings/manager.ts:174-180` 漏掉该字段；schema 允许 env/credentialRef：`packages/core/src/settings/schema.ts:321`；应用覆盖在 `packages/core/src/plugins/installer/loadPluginMcp.ts:21`。
- **复现/测试**：`SettingsManager(cwd,"full",false)` 仍返回 project 的 `NODE_OPTIONS` 与全局 credentialRef。
- **建议修复**：把 `mcpServerOverrides` 作为危险项目字段整体剥离，或逐字段 trust-filter；补 untrusted project regression。

### P1-16 Desktop 保存 settings 把 0600 降级为 0644（确认）

- **影响**：包含明文模型 API key 的设置文件可能变成同机其他用户可读。
- **证据**：`packages/desktop/src/main/settings-service.ts:108` 新建 tmp 时未指定 mode，再 rename 覆盖；明文 key 字段见 `packages/core/src/settings/schema.ts:149`。
- **复现/测试**：umask 022 下保存已有 0600 文件，结果 mode 变为 0644。
- **建议修复**：tmp 显式 0600，或继承原文件 mode；rename 后再 chmod 作为防御。

### P1-17 SafeStorage 暂时不可用时 metadata patch 会嵌套密文（确认）

- **影响**：只修改一个凭证元数据也可能把同 scope 全部密文改成 `plain:enc:...`，SafeStorage 恢复后永久不可读。
- **证据**：`packages/core/src/credentials/store.ts:65,127-130` 在 unavailable 时把原密文当 secret 后整库重写；`packages/desktop/src/main/credential-cipher.ts:28-34` 再包一层 plain。
- **复现/测试**：磁盘得到 `plain:enc:safeStorage:...`，恢复后 value 仍被判 unavailable。
- **建议修复**：不可解密条目保持原 ciphertext 原样写回；metadata 与 secret 分离 patch，禁止全库解密-重加密。

### P1-18 多项目 worker 的 settings hot reload 串用启动 cwd（确认）

- **影响**：项目 B 的会话收到项目 A 的 preset/prompt/personalization/MCP 配置。
- **证据**：stdio `settingsManager` 固定启动 cwd：`packages/core/src/cli/agent-server-stdio.ts:89,195`；server 把同一 reader 的 patch 发给全部 session：`packages/core/src/protocol/server.ts:1656,1768`。
- **复现/测试**：A/B 项目中，B global reload 得到 `PROMPT_A` 而非 `PROMPT_B`。
- **建议修复**：按 session effective cwd 建 settings reader/cache；reload payload 必须携带并核验 session/cwd。

### P1-19 切换 worktree 后 credential snapshot cwd 不匹配（确认）

- **影响**：进入 worktree 后，连 user-global credential 的工具可见性与 env exposure 都消失。
- **证据**：renderer 仍发送原 root：`packages/desktop/src/renderer/App.tsx:2612`；bridge 只推该路径 snapshot：`packages/desktop/src/main/agent-bridge.ts:403`；Engine resume 改用持久化 worktree cwd：`packages/core/src/engine/engine.ts:1150`；worker access 严格按 cwd：`packages/core/src/credentials/access.ts:141`。
- **复现/测试**：snapshot 只有 `/repo/main` 时，`/repo/worktree` 查询返回空 credential/env。
- **建议修复**：workspace switch 后立即为 effective root 推 snapshot；user-global 与 project-scoped credential 分层索引。

### P1-20 未信任项目可重新启用用户关闭的插件/skill/shell 能力（确认）

- **影响**：仓库提交的 `capabilityOverrides.*="on"` 或 `featureFlags.shell_tool=true` 可推翻用户全局禁用，重新启用已安装插件的 shell hooks/MCP 或内置 shell。
- **证据**：`packages/core/src/settings/manager.ts:174-180` 的危险字段漏掉 `capabilityOverrides`/`featureFlags`；`packages/core/src/capability-control/overlay.ts:71-82` 允许 project on 覆盖 global off；`disabled-lists.ts:32-69` 据此恢复插件；hook 执行见 `packages/core/src/plugins/loadPluginHooks.ts:153-220`；feature flag project 优先见 `packages/core/src/settings/feature-flags.ts:8-31`。
- **复现/测试**：untrusted project 下，用户 disabled plugin 被 `project on` 从 effective disabled list 移除，`shell_tool` 也从 false 变 true；现有 `manager.test.ts:234-246` 反而将其编码为“benign”。
- **建议修复**：未信任项目不能使用任何“on”扩大能力，只允许进一步关闭；trust gate 后再计算 effective lists/flags。

### P1-21 RunManager 取消竞态可把 cancelled 任务重新跑完（确认）

- **影响**：用户已取消的自动化仍可能执行写操作，最终状态从 cancelled 变 completed。
- **证据**：queue 在 `packages/core/src/run/RunQueue.ts:76-93` 取出任务；executor 在 `packages/core/src/run/RunManager.ts:449-488` 之后才注册 abort controller；cancel 在 `RunManager.ts:294-322` 可先写 cancelled，旧 queued snapshot 随后又 transition running。
- **复现/测试**：可控 store 延迟下事件顺序为 `run_cancelled → run_started → run_completed`。
- **建议修复**：出队、状态 transition、controller 注册与 cancel 使用同一 run lock/CAS；execute 前重新读取并拒绝 terminal state。

### P1-22 RunManager recovery 会抢活进程的 stale-heartbeat run（确认）

- **影响**：进程仍存活但 heartbeat 暂时 stale 时，会被 force-unlock 并重入队，造成双执行。
- **证据**：注释要求“stale AND process dead”，但 `packages/core/src/run/RunManager.ts:376-394` 仅在 `processAlive && !stale` 时跳过，故 alive+stale 也进入 recover。
- **复现/测试**：状态组合真值表即可复现；现有 recovery 测试未覆盖 alive=true/stale=true。
- **建议修复**：只有 `!processAlive && stale` 才接管；必要时使用 lease epoch，而非单次 PID/heartbeat 判断。

### P1-23 RunManager cron binding 只等入队，导致重叠且 abort 无效（确认）

- **影响**：短周期 job 可不断 submit 多个 RunManager run；scheduler.abort 只取消已经返回的提交 wrapper，无法取消真实 run。
- **证据**：`packages/core/src/automation/runner.ts:137-154` 的 executor await `runManager.submit()` 后立即返回；scheduler 的 running/controller 只包住这段：`packages/core/src/automation/scheduler.ts:683-720`。
- **复现/测试**：慢 executor+短 interval 可观察多个 queued/running run；现有 binding 测试只断言 submit 参数。
- **建议修复**：submit 返回可 await/cancel 的 run handle，scheduler running 生命周期覆盖真实终态；abort 映射到 RunManager.cancel(runId)。

### P1-24 TCP host 的 Cron 工具写入了脱离执行器的 singleton（确认）

- **影响**：TCP 会话通过 CronCreate 创建的任务可能只存在于无 executor 的模块 singleton，实际 production scheduler 看不到或不执行。
- **证据**：TCP 在 `packages/core/src/cli/agent-server-tcp.ts:128-137` 用 `startAutomation()` 创建新 scheduler；内置 Cron 工具却固定导入 `packages/core/src/automation/scheduler.ts:779` 的 `cronScheduler` singleton（`packages/core/src/tool-system/builtin/cron.ts:6,134-175`）。
- **复现/测试**：比较 TCP automation handle scheduler 与 builtin singleton，identity/jobs 不同。
- **建议修复**：Cron tool 从 Engine/runtime 注入 scheduler service，禁止模块级可变 singleton。

### P1-25 多 host 共享 cron store 没有 leader/lease，会重复执行（确认）

- **影响**：Desktop、TCP 或两个进程同时指向同一 `cron.json` 时，各自都会为全部 job arming，触发双执行。
- **证据**：`packages/core/src/automation/index.ts:43-55` 每次 start 都创建独立 scheduler 并 load/arm；`packages/core/src/automation/scheduler.ts:85-104` 的 running guard 仅在进程内。
- **复现/测试**：同时 start 两个 handle 读取同一 store，二者均持有 timer；现有 restart test 是先 stop A 再 start B，没有并行 host 场景。
- **建议修复**：实现 host leader lease 或 per-fire durable claim/epoch；非 leader 只观察与写配置。

### P1-26 TUI/TCP automation 未完整尊重 job cwd/resume/permission 语义（确认）

- **影响**：同一 cron job 在 Desktop、TUI、TCP 上行为不同；可能在错误目录启动新会话，而不是续接目标 session，权限 tier 也可能丢失。
- **证据**：TUI runner 固定启动 cwd 并 `run(...,{cwd})`：`packages/tui/src/cli/commands/repl.ts:244-264`，未读 `job.cwd/resumeSessionId`；RunManager binding 只传 objective/cwd/metadata：`packages/core/src/automation/runner.ts:137-154`，没有 resumeSessionId/permissionLevel。
- **复现/测试**：创建带 cwd+resumeSessionId 的 job，对比 Desktop `makeCronRunnerWithResume` 与 TUI/TCP 路径即可观察新 session/错误 cwd。
- **建议修复**：定义跨 host 的统一 CronRunRequest contract，并为每个 host 做同一组 golden tests。

### P1-27 Desktop resume automation 固定 5 秒超时且忽略 abort signal（确认）

- **影响**：正常超过 5 秒的续接 turn 被 scheduler 当失败/继续调度，而 worker 仍在执行；删除或取消 job 也不能停止该 turn。
- **证据**：`packages/desktop/src/main/index.ts:793-832` 的 `injectAndAwaitResult` 固定 5000ms；resume injector 在 `index.ts:1978-1997` 把 signal 命名为 `_signal` 且未使用。
- **复现/测试**：让续接 session 的 agent/run 超过 5 秒，调用方返回 `worker did not respond`，稍后真实流仍到达。
- **建议修复**：run RPC 不用 5 秒控制面超时；监听 signal 并发送 cancel，等待对应 request/run 的真实终态。

### P1-28 纯新建文件的 turn 在 Desktop/TUI 看起来不可撤销（确认）

- **影响**：该 turn 只有 created markers、没有 pre-edit snapshot 时，UI/命令先判断 targets 为空而直接返回，虽然底层 undo 有 created-only fallback。
- **证据**：`packages/core/src/session/undo-target.ts:77-94` 只从 snapshots 选择 turn；`packages/desktop/src/main/file-history-service.ts:47-64` targets 为空即判不可 undo；TUI 也按同一 target selector 预览。
- **复现/测试**：单个 Write 新文件后，created marker 存在但 `turnUndoState().undoable=false`。
- **建议修复**：undo target selection 同时接收 snapshots 与 created markers，返回统一 turn target。

### P1-29 ApplyPatch 新建文件完全没有记录 created marker（确认）

- **影响**：ApplyPatch add 创建的文件不能被 turn undo 删除。
- **证据**：`packages/core/src/engine/file-history-hook.ts:26-29` 只对 patchBackupTargets 保存 snapshot；`packages/core/src/tool-system/builtin/apply-patch/backup-targets.ts:7-27` 明确排除 add hunk。
- **复现/测试**：仅含 Add File 的 ApplyPatch 后，history 里既无 snapshot 也无 created marker。
- **建议修复**：parser 同时返回 add targets，hook 在 tool start 记录 created；仅 tool 成功后再确认 marker 或在失败时回滚。

### P1-30 Desktop redo 被更早 turn 的 undo 状态遮住（确认）

- **影响**：撤销最新 turn 后，系统优先展示“继续撤销更早 turn”，刚生成的 redo 在 reload/重新查询后不可达。
- **证据**：`packages/desktop/src/main/file-history-service.ts:43-55` 先检查任何 `latestTurnUndoTargets`，只有完全没有 undo target 才检查 redo。
- **复现/测试**：存在 turn1+turn2，undo turn2 后，turn1 仍是 undo target，因此 state 返回 undoable 而不是 redoable。
- **建议修复**：用显式 operation cursor/stack；最近操作是 undo 时优先暴露对应 redo，直到新 edit 使其失效。

### P1-31 undo/redo 文件失败仍消费整轮状态（确认）

- **影响**：单文件 restore/copy 失败后，snapshot 仍被标 undone，redo record 仍被删除，用户无法重试且多文件状态部分提交。
- **证据**：`packages/core/src/session/file-history.ts:289-323` 不管 results.ok 都标记 whole turn undone；`file-history.ts:346-383` 不管 copy 失败都 unmark 并消费 redo。
- **复现/测试**：令目标路径不可写或删除 backup，可得到 `ok:false`，但 index 已推进。
- **建议修复**：两阶段执行；全部成功后提交 index，失败则保留可重试状态并报告 partial recovery plan。

### P1-32 FileHistory 多入口无锁，整份 index 会互相覆盖（确认）

- **影响**：Desktop、TUI 或并发 Engine hook 同时 load-modify-save 时，可丢 snapshot/redo/created marker。
- **证据**：`packages/core/src/session/file-history.ts:396-429` 直接整份 `writeFileSync(index.json)`，无 lock、revision、tmp+rename；各入口会各自 `loadFromDir`。
- **复现/测试**：两个实例从同一旧 index 加不同记录，后写者覆盖前写者。
- **建议修复**：per-session file-history lock + revision/CAS + 原子 rename；或单一 writer 服务。

### P1-33 stdio worker 信号处理在异步 teardown 前 `process.exit`（确认）

- **影响**：退出 Desktop/stdio host 时可能遗留 detached shell、MCP 子进程、agent output 临时文件，并丢最后的 session flush。
- **证据**：`packages/core/src/cli/graceful-shutdown.ts:29-50` 的 close 是同步签名且立即 exit；`packages/core/src/protocol/server.ts:2964-3005` fire-and-forget `closeAll`；真正异步清理在 `packages/core/src/protocol/chat-session-manager.ts:251-277`；`packages/core/src/engine/runtime.ts:96-112` 的 async `runtime.close()` 无生产调用。
- **复现/测试**：close 中安排 100ms cleanup，SIGTERM 输出只有 `close-called`，没有 `async-cleanup-finished`。
- **建议修复**：shutdown handler await `server.closeAsync()`、chat manager、runtime/MCP 与 shell cleanup；设有界 grace 后才强制 exit。

### P1-34 并发 resume 会永久追加重复 synthetic tool results（确认）

- **影响**：多进程同时恢复 interrupted transcript 时写入多个同 tool_use 的 synthetic result，污染 provider history，并让 fork 拒绝重复结果。
- **证据**：`packages/core/src/session/transcript.ts:364-390,520-542` 的 load repair 会写共享 JSONL；generation fencing 仅进程内：`packages/core/src/session/session-manager.ts:52-55`；resume 走该路径：`session-manager.ts:667-697`。
- **复现/测试**：4 个 Bun 子进程 barrier 后得到 4 条 synthetic result；后续 fork 报 duplicate tool result。
- **建议修复**：load 只做内存修复，或在 transcript lease 下幂等 append（toolUseId 唯一约束）。

### P1-35 自动 stale-worktree sweep 会删除仍被 session 持有的 worktree（确认）

- **影响**：session state 仍指向 worktree，但目录已被定时清理，resume 进入 blocked。
- **证据**：启动/每小时 sweep：`packages/desktop/src/main/index.ts:2056-2057,3412-3420`；`packages/desktop/src/main/desktop-services.ts:405-426,434-486` 只看 age/clean/ahead/managed branch，不读 session owners。
- **复现/测试**：旧且干净的 active-owned worktree 被列入 removed，state.workspace 仍保持原路径。
- **建议修复**：删除前扫描所有 persisted/live/archived/ephemeral owner；有 owner 一律跳过。

### P1-36 手动 worktree cleanup 非事务化，失败留下坏 pointer（确认）

- **影响**：目录先被 force 删除，随后 session state 更新失败，导致永久 `worktree_missing_branch_exists`。
- **证据**：UI service 顺序：`packages/desktop/src/main/session-workspace-service.ts:328-346`；core tool 同序：`packages/core/src/tool-system/builtin/worktree.ts:278-300`；remove force：`packages/core/src/git/worktree/crud.ts:201-264`。
- **复现/测试**：用新鲜 state lock 注入更新失败后，path 不存在但 state 仍指向它。
- **建议修复**：先写 cleanup intent/切回 main，再删资源；失败可靠回滚或启动时完成 intent。

### P1-37 ephemeral side-fork 被 owner discovery 过滤（确认）

- **影响**：side-fork 仍共享 source worktree，但 owner scan 看不到它；parent 切走后可误删 child 正在使用的 worktree。
- **证据**：fork 继承 workspace：`packages/core/src/session/session-manager.ts:1251-1266`；标 ephemeral：`packages/core/src/protocol/server.ts:839-843`；list 过滤：`session-manager.ts:1188-1195,1233-1241`；cleanup 依赖过滤后 list：`packages/desktop/src/main/session-workspace-service.ts:83-87`、`packages/core/src/tool-system/builtin/worktree.ts:353-369`。
- **复现/测试**：parent 创建 qchat child 后切回 main，owner list 为空，cleanup 删除共享 worktree，child resume 失败。
- **建议修复**：提供独立 disk-backed `listWorkspaceOwners()`，包含 ephemeral/archived/live state，不复用 UI list。

### P1-38 TUI Markdown export 静默丢全部正常 tool result（确认）

- **影响**：导出的审计记录缺工具输出；大结果 sidecar 也不会生成。
- **证据**：默认 Markdown：`packages/tui/src/cli/commands/builtin/core-commands.ts:713-735`；export 只处理 message：`packages/tui/src/cli/commands/builtin/export-md.ts:59-63`；真实结果为独立 `tool_result` event：`packages/core/src/engine/model-facade.ts:265-296`、`turn-loop.ts:1335-1382`。
- **复现/测试**：含 3KB tool result 的标准 transcript 导出后 `containsResult:false, sidecars:0`。
- **建议修复**：export fold 同时消费 message/tool_use/tool_result；用真实 Transcript API 做 golden test。

### P1-39 session 运行中仍可 cleanup 当前 worktree（确认）

- **影响**：活跃 turn 继续在已删除 cwd 上执行，后续工具与状态保存不可预测。
- **证据**：TopBar 传入 busy：`packages/desktop/src/renderer/TopBar.tsx:97-105`；WorkspaceIndicator 只把它用于 refresh dependency，action disabled 不看它：`WorkspaceIndicator.tsx:298-300,430-549`；main/service 无 live-worker guard：`packages/desktop/src/main/index.ts:3525-3547`、`session-workspace-service.ts:328-346`。
- **复现/测试**：busy session UI 仍可触发 cleanup；现有 busy 测试只测 refresh/loading race。
- **建议修复**：renderer 禁用只是 UX；main 必须查询 live generation/busy 并拒绝删除当前 effective workspace。

### P1-40 首次 browser navigate 可绕过 `allowedDomains`（确认）

- **影响**：浏览器面板关闭时，agent 可直接打开白名单外 URL；后续 navigate 才会被策略拒绝。
- **证据**：`packages/desktop/src/main/browser-driver/automation-host.ts:130-150` 先 `openPanel(url)` 并对 navigate early return；白名单检查在 `automation-host.ts:153-161` 之后，完全未执行。
- **复现/测试**：无 active guest、配置非空 allowedDomains、navigate off-list URL，openPanel 成功即返回 `{ok:true}`。
- **建议修复**：任何 openPanel 前先对 req.url 执行相同 domain policy；测试首次与已有 panel 两种路径。

### P1-41 image/structured attachment 存在 realpath-check 后重开路径的 TOCTOU（确认）

- **影响**：本地并发者在校验后替换文件/路径，可让读取落到 workspace/session 根之外的内容。
- **证据**：Desktop 在 `packages/desktop/src/main/image-read-service.ts:31-37` lstat/realpath/containment 后再按路径 readFile；Core 在 `packages/core/src/engine/input-attachments.ts:145-180,303-340` 校验 realPath 后稍后 reopen 读取 bytes。
- **复现/测试**：在校验与 read 间 rename/symlink swap 可改变最终打开对象；已做最小竞态复现，缺正式回归测试。
- **建议修复**：打开 fd 后对 fd 做 fstat/identity 校验并从同一 fd 读取；至少校验 dev+ino 且拒绝变化。

### P1-42 staged attachment 的声明 sha256 在消费时从不核验（确认）

- **影响**：文件 stage/claim 后被替换，模型实际收到与 UI/manifest 承诺不同的内容。
- **证据**：`packages/core/src/engine/input-attachments.ts:101-180` 校验 session/path，但没有比较 `attachment.sha256`；image bytes 只在 `input-attachments.ts:319-340` 重算新 hash 并继续发送。
- **复现/测试**：stage 后以同路径同类型文件替换，消费成功且使用新 bytes；缺 hash mismatch regression。
- **建议修复**：读取完成后 constant-time 比较 manifest sha256，不一致即拒绝；size/mime 同样以内容为准。

## P2 — 中等影响、隐私、可恢复性与质量门禁

### P2-01 Desktop Goal 没有负向对账，localStorage ghost 会复活（确认）

- **影响**：磁盘已无 active goal，右上角旧 Goal 仍可跨重启长期显示。
- **证据**：`packages/desktop/src/renderer/App.tsx:1166` 只有本地投影为 null 才 `goalGet`；旧投影 hydrate 在 `packages/desktop/src/renderer/transcripts.ts:553`。
- **复现/测试**：localStorage 放 ghost A、磁盘 null，hydrate 后不会查询后端，A 再次持久化。
- **建议修复**：每次 session hydration 都做正负双向对账，按 goalId/revision 防止旧 null 清掉并发新 Goal。

### P2-02 no-worker Goal clear 不广播，多窗口 UI 不自愈（确认）

- **影响**：一个窗口清掉磁盘 Goal 后，其他已 hydrate 窗口一直显示 ghost。
- **证据**：已 hydrate window 在 `packages/desktop/src/renderer/App.tsx:1059` 早退；no-worker fallback `packages/desktop/src/main/agent-bridge-fallback.ts:112` 只回复调用端，不广播 `goal_cleared`。
- **复现/测试**：两窗口、worker 不在时由 A clear，B 保持旧 Goal。
- **建议修复**：main 统一广播带 goalId/stateRevision 的终态；窗口恢复焦点时也拉一次 snapshot。

### P2-03 TopBar comparator 忽略 goalId 与 callback（确认）

- **影响**：同文案 Goal A→B 后仍捕获清除 A 的回调；清 B 时 reducer 因 goalId 不匹配拒绝，UI 留 ghost。
- **证据**：`packages/desktop/src/renderer/TopBar.tsx:252` 自定义比较器漏字段；clear callback 在 `packages/desktop/src/renderer/App.tsx:4453`；reducer identity check 在 `types.ts:1068`。
- **复现/测试**：创建相同 objective、不同 goalId 的 A/B 可触发 stale callback。
- **建议修复**：比较器纳入 goalId/status/callback identity，或移除易错 memo comparator。

### P2-04 公网访问口令通过 GET 留在完整 URL（确认）

- **影响**：明文 passcode 进入地址栏、请求日志和 Referer；配对失败时可长期保留。
- **证据**：GET form：`packages/desktop/src/main/mobile-remote/access-passcode.ts:316`；query 读取：`access-passcode.ts:246`；成功只 set-cookie、不清洁重定向：`access-passcode.ts:136`。
- **复现/测试**：响应 URL 仍为 `?pairing=...&passcode=1234`，Location=null。
- **建议修复**：POST 提交，成功后 303 到无敏感 query URL；失败也清理/替换 history。

### P2-05 Pet idle eviction 后保留伪 live overlay（确认）

- **影响**：session 已从 live manager 驱逐，Pet overview 仍显示 `idle/live-snapshot`，直到 worker 重连。
- **证据**：idle sweep 直接 close：`packages/core/src/protocol/chat-session-manager.ts:283-290`；只有显式 close RPC 发 remove：`packages/core/src/protocol/server.ts:1539-1547`；aggregator 无周期负向 reconcile：`packages/desktop/src/main/pet/pet-state-aggregator.ts:225-234`。
- **复现/测试**：等待 30min TTL/sweep 后 manager snapshot 无 session，Pet overlay 仍在。
- **建议修复**：sweeper 发 session-remove，或 aggregator 周期性用完整 snapshot 做集合差异对账。

### P2-06 删除 cron job 不清理按 jobId 存储的 automation memory（确认）

- **影响**：反复创建/删除自动化会在 `~/.code-shell/automations/<jobId>/memory.md` 留下永久孤儿数据，且可能保留敏感摘要。
- **证据**：memory 路径与 append 在 `packages/desktop/src/main/automationMemory.ts:11-35`；cron delete `packages/core/src/automation/scheduler.ts:376-389` 只删 job/timer/store，无 memory cleanup。
- **复现/测试**：创建并写 memory 后删除 job，目录仍存在；现有 CronDelete 测试不检查 side data。
- **建议修复**：删除操作返回/触发 host cleanup，安全递归删除对应 SAFE_ID 目录；可提供保留历史的显式选项。

### P2-07 删除 session 不清浏览器持久分区与 bucket registry（确认）

- **影响**：cookie、IndexedDB、localStorage 及 session→bucket 映射残留；同 ID/bucket 复用时可恢复旧登录态，且长期占磁盘。
- **证据**：删除流程 `packages/desktop/src/main/index.ts:3752-3762` 只调用 bridge/pending approval cleanup；browser registry 的 `forgetSession` 位于 `packages/desktop/src/main/browser-driver/active-guest.ts:307-309`，没有被该流程调用；可用清理 API 在 `browser-host/index.ts:150-154`。
- **复现/测试**：静态调用图确认无清理；删除后 `session.fromPartition(persist:browser:...)` storage 仍在。
- **建议修复**：session delete 关闭 guest、forget mapping、等待 `clearStorageData`；明确是否保留登录态并给用户选择。

### P2-08 CodeShell TUI Goal 控制面不完整（确认，正在本轮实现）

- **影响**：当前只能 set/view/clear，不能像 Codex Goal 那样 edit/pause/resume/delete；Steer 与 Goal 的运行中控制语义不对齐。
- **证据**：审计基线的 `packages/tui/src/cli/commands/builtin/goal-command.ts:19-90` 仅暴露设置、查看、clear；协议也缺统一 update/pause/delete 操作。
- **复现/测试**：输入 `/goal pause` 或 `/goal edit ...` 不具备预期语义。
- **建议修复**：统一 goal update/pause/resume/delete RPC，按 goalId/revision CAS；运行中在下一个安全边界更新 TurnLoop/GoalStopHook，并同步 Desktop/TUI 状态。

### P2-09 根 typecheck 与全量测试基线失败，发布门禁失真（确认）

- **影响**：真实回归被大量基线红噪音掩盖，文档中的“clean gate”与实际仓库不一致。
- **证据**：`CODESHELL.md` 已注明 root typecheck 非 clean；本轮 `bun run typecheck` 有 29 个错误；全量测试曾为 `6024 pass / 51 fail / 2 errors`，其中 30 个失败由 P0-01 统一解释，其余需隔离。
- **复现/测试**：在基线 HEAD 直接运行上述命令。
- **建议修复**：先把已知失败转成显式 quarantine/baseline 清单，再逐项清零；CI 必须报告新增错误差分。

### P2-10 TaskGuard 只提醒不改变控制流（确认）

- **影响**：任务状态 stale 或重复 TodoWrite 时只增加 prompt 噪音，无法阻止 P1-01 的无进展循环。
- **证据**：`packages/core/src/tool-system/task-guard.ts:36-54` 每三轮追加提醒；`packages/core/src/engine/turn-loop.ts:1543` 仅注入消息。
- **复现/测试**：重复工具场景中 guard 提醒出现后循环继续，直到 maxTurns/人工 abort。
- **建议修复**：把无进展判断接入实际控制策略；TaskGuard 与工具 fingerprint 共用状态机。

### P2-11 Prompt 中的 `gitStatus` 在长 run 内变旧（确认）

- **影响**：Agent 已提交/修改后仍看到 run 起点状态，与实时 Bash 结果矛盾，诱发反复核实与错误判断。
- **证据**：`packages/core/src/prompt/composer.ts:106` 相关动态状态在 run 构造时生成，工具轮继续沿用同一 prompt context。
- **复现/测试**：真实卡住会话提交后仍反复 Bash 检查 git；日志显示 stale prompt 与实际结果冲突。
- **建议修复**：把易变 workspace status 放入按轮刷新、低成本动态 section，或工具修改仓库后使该 section 失效。

## 需二次复核的高风险候选

### R-01 `persist:browser:*` 分区未安装 permission request handler（需复核，候选 P0/P1）

- **潜在影响**：远端网页可能请求摄像头、麦克风、通知、剪贴板等 Electron 权限；当前 deny handler 只装在 defaultSession。
- **证据**：webview 被固定到独立 partition：`packages/desktop/src/main/index.ts:1459-1494`；唯一 handler 明确只作用 defaultSession：`index.ts:1631-1649`。
- **当前状态**：静态缺口确认；仍需在目标 Electron 版本逐权限验证“无 handler”的实际默认行为，因此暂不按 P0 定级。
- **建议验证/修复**：对每个 `session.fromPartition(persist:browser:...)` 安装 deny-by-default handler；用真实 webview 权限请求做 e2e。

### R-02 AgentBridge 可重绑 session→browser bucket（需复核，候选 P1/P2）

- **潜在影响**：多个 renderer/窗口可把既有 session 路由到另一 bucket/partition，造成浏览器上下文错投或登录态混用。
- **证据**：renderer run metadata 可携带 bucket：`packages/desktop/src/main/agent-run-metadata.ts:24-39`；每次 run 都无 owner/immutability 校验地 `registerSessionBucket`：`packages/desktop/src/main/agent-bridge.ts:403-418`；registry 直接覆盖 Map：`packages/desktop/src/main/browser-driver/active-guest.ts:95-104`。
- **当前状态**：重绑行为确认；是否能跨安全主体利用取决于 renderer/multi-window 的信任边界，需结合 P1-07 一并复核。
- **建议验证/修复**：首次绑定后 immutable，变更需 owner token/显式迁移；加双窗口抢绑测试。

### R-03 未信任项目的 `externalAgents` 字段未进入危险字段列表（需复核，候选 P1）

- **潜在影响**：项目可能影响外部 Codex/Claude command、args、defaultMode、trustedWorkspaces 或 auto-start 语义。
- **证据**：schema 在 `packages/core/src/settings/schema.ts:573-597` 暴露相关字段；`packages/core/src/settings/manager.ts:174-180` 未过滤；Desktop room permission merge 在 `packages/desktop/src/main/index.ts:1155-1193` 还直接读取 raw project settings。
- **当前状态**：字段穿透确认，但 RoomManager 当前主要 command 路径仍有硬编码，且 committed repo 通常不知道 clone 的绝对路径，尚未闭合稳定利用链。
- **建议验证/修复**：先把 externalAgents 视为危险字段；所有 trustedWorkspaces 只允许 user scope，随后做 clone-to-arbitrary-path e2e。

### R-04 feature flag 可能只隐藏工具而不阻断执行（需复核，候选 P2/Security）

- **潜在影响**：`shell_tool=false` 后，旧上下文/显式 tool call 仍可能到达 executor 并执行 Bash。
- **证据**：可见性过滤在 `packages/core/src/engine/engine.ts:1825-1843`；`toolCtx.disabledBuiltins` 主要来自 capability override（`engine.ts:1786-1800`），未见 feature flag 对 executor 的同等 hard gate。
- **当前状态**：静态防御缺口成立，但需要构造模型直接返回被隐藏 tool call 的端到端测试确认实际 executor 行为。
- **建议验证/修复**：registry/executor 层再次执行 feature gate；prompt hiding 只能作为 UX，不能作为授权边界。

## 历史已修复，但需注意旧进程/旧安装包

### H-01 `complete_goal` 未清 UI/旧 Engine 继续驱动（历史已修复）

- **原影响**：清除磁盘 Goal 后，旧 Engine 内存仍持有目标；`complete_goal` 成功却不发 UI 终态，右上角留下 ghost。
- **日志证据**：目标会话在 02:54 收到 `goal_cleared`，旧 Engine 继续；05:13 `complete_goal` 成功并 `engine.done`，但因磁盘目标早已为空，没有再次发终态事件。
- **修复状态**：`0cb7f60e` 修复，`75b46844` 合入 main；引入 goalId、stateRevision CAS、terminal tombstone 与 `goal_progress(met)`。相关 15/179 个聚焦测试均通过。
- **仍需注意**：出问题的 `/Applications/code-shell.app` 进程启动早于修复提交，必须重建/重启；P1-01 busy-loop、P1-04 terminal CAS metadata 覆盖与 P2-02 跨窗口广播仍是独立未修问题。

## Goal / Steer 控制专项复核（当前工作树）

本节记录针对 `s-mrhj2y47-ff043309` “`complete_goal` 后右上角 Goal 未清、仍持续驱动”的二次并发审查。下表状态覆盖 Core、TCP/stdio protocol、TUI 与 Desktop，并覆盖暂停/编辑/删除与 Steer 共用“当前模型/工具步结束后生效”的安全边界。

### 基线项目当前状态

| 编号  | 当前状态       | 说明                                                                                                                              |
| ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P0-01 | **已修复**     | Desktop 改用实际存在的 repo bucket identity；Desktop typecheck、聚焦测试与生产构建通过。                                          |
| P1-01 | **未修复**     | 重复工具调用 busy-loop 仍是“一直驱动”的独立根因；本轮提供了可靠暂停/删除，但未实现跨 turn fingerprint 熔断。                      |
| P1-02 | **已修复**     | Desktop 先完成 transcript + Goal 快照对账，再单次 hydrate；不再由自身 state 更新取消较慢的 Goal 读取。                            |
| P1-03 | **已修复**     | TUI 切换/恢复 session 时调用 `goalGetState` 正负向 hydrate，并按 session/epoch 拒绝迟到响应。                                     |
| P1-04 | **未修复**     | Goal terminal CAS 的 live rebase 仍只合并部分字段，旧 detached state 仍可在后续 whole-state save 覆盖并发 summary 等 metadata。   |
| P1-05 | **未修复**     | 本轮补了 Goal update 的 workspace/title 回基，但 workspace switch 与 `turnSeq`/whole-state save 的广义竞态仍在。                  |
| P1-06 | **部分修复**   | TUI stream 已按 envelope `sessionId` 过滤，Goal 镜像也按 session 分离；approval/question 仍是全局单槽，未完成全面分桶。           |
| P2-01 | **已修复**     | Desktop 每次 session hydrate 都做 Goal 正/负向对账，后端 `null` 可清理 localStorage ghost。                                       |
| P2-02 | **未修复**     | no-worker 控制仍只回复请求窗口，没有跨 Desktop 窗口的 session-scoped Goal 广播。                                                  |
| P2-03 | **已修复**     | TopBar comparator 已纳入 goalId、revision、paused 及 Goal 控制 callback identity，不再保留旧 Goal 闭包。                          |
| P2-08 | **已修复**     | TUI 已提供 `/goal edit` / `pause` / `resume` / `delete`，严格解析与 `(goalId, revision)` CAS，运行中可与 Steer 一样即时提交控制。 |
| P2-09 | **部分修复**   | Core/TUI/Desktop 本轮定向 typecheck/build 均通过；仓库根历史全量红线未在本任务内全部清零。                                        |
| H-01  | **进一步加固** | 不再仅依赖“清 activeGoal”；完成/取消/判定均绑定确切 Goal revision，且只有 terminal 持久化成功才向 UI 宣布结束。                   |

### 本轮新发现且已修复

| 编号      | 问题                                                                                                                    | 修复                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GCTRL-F01 | 旧模型响应中的 `complete_goal` / `cancel_goal` 可结束编辑或恢复后的新 revision。                                        | 工具调用绑定请求步可见的 `(goalId, revision)`；旧结果仅返回 stale 提示。                                                                                                                |
| GCTRL-F02 | terminal 持久化失败时仍发 `met/goal_cleared`，产生右上角 ghost 或假完成。                                               | Goal terminal callback 改为布尔契约；失败时保留 Goal 并继续可恢复执行。                                                                                                                 |
| GCTRL-F03 | pause/delete 在 context manage、hook、context-limit retry、stream fallback 等 await 窗口后仍可发起新模型请求。          | TurnLoop 在各步安全点重新检查 stop request，不中断正在执行的模型/工具，但不跨边界开新请求。                                                                                             |
| GCTRL-F04 | 最后工具轮次正好到 `maxTurns` 时，pause/delete 后仍会调用最终总结模型；工具摘要还会发辅助模型请求。                     | max-turn summary 前增加 stop fence；tool summary dispatch 增加 fence 与可 abort signal。                                                                                                |
| GCTRL-F05 | 暂停时启动的普通 run 没有 Goal prompt/tools，原地 resume 会用旧指令重复驱动。                                           | 无 Goal 能力的 run 只在安全点停止，server 排入重建 prompt/tools 的全新 Goal continuation。                                                                                              |
| GCTRL-F06 | busy session 中“恢复→暂停→恢复”会排入两个 synthetic Goal turn。                                                         | `ChatSession` 按 goalId 合并尚未执行的 resume ticket，被替代请求结算为 skipped。                                                                                                        |
| GCTRL-F07 | 排队 resume 在目标编辑后丢失，或把旧 objective 复制进 synthetic task。                                                  | guard 跟踪同一 goalId，到队首时读取最新持久目标；task 不嵌入 stale objective。                                                                                                          |
| GCTRL-F08 | 冷恢复硬编码默认 session root，自定义 `sessionStorageDir` 无法续跑 Goal。                                               | Goal resume 通过 `ChatSessionManager.getOrCreatePersisted` 使用 host 实际配置的 storage root。                                                                                          |
| GCTRL-F09 | 未暂停但已因 ESC/model error/worker restart 变为 idle 的 Goal 无法显式续跑。                                            | TUI `/goal resume` 不再拒绝 unpaused Goal；server 把 `paused:false` 作为显式 drive request，活跃 Goal run 则原地更新且不重复排队。                                                      |
| GCTRL-F10 | GoalStopHook 的旧异步 judge verdict、gaps 与 evidence-window cache 可跨编辑污染新 revision。                            | judge 回来后再核对当前 revision；Goal 版本变化时重置 verdict/gaps/cache。                                                                                                               |
| GCTRL-F11 | 两个 TCP 客户端并发控制时，无 fence 操作可覆盖新目标，未知 session 的恢复还会占住 owner。                               | update/delete 协议强制完整 Goal id/revision；非 owner 破坏性操作被拒绝；CAS miss 或排队失败按 lease generation 回滚/释放。                                                              |
| GCTRL-F12 | 非请求窗口推进 revision 后，TUI CAS miss 仍保留旧 revision，每次重试都失败；旧 RPC response 还可覆盖更新 stream event。 | miss 后立即 `goalGetState` 对账；response 只在 goalId 相同且 revision 不倒退时投影；delete 仅清理自己捕获的版本。                                                                       |
| GCTRL-F13 | TUI 的 local run、server-driven run、迟到 response/error/text 与旧 `finally` 会互相释放 guard 或清理新流。              | `QueryGuard` 用 generation/token 区分 owner；AgentClient 在具体 Run request 的同步 transport response seam 执行 token-fenced handoff/finalize；external turn 有独立终态收尾与取消代际。 |
| GCTRL-F14 | Desktop/TUI 乐观 Goal 投影会被旧 terminal/update 事件倒退，失败操作没有负向对账。                                       | reducer/镜像强制 Goal identity+revision freshness；失败 update/delete 读取权威快照并仅回滚本次乐观投影。                                                                                |
| GCTRL-F15 | 暂停/删除 dormant persisted Goal 时可错误停止当前无关普通 run；judge 用量也可因编辑竞态漏记。                           | 只有当运行时 Goal version 与被控制版本一致时停止/拆 hook；judge 账单与采纳 verdict 解耦。                                                                                               |

### 当前仍存在的 Goal / 控制问题

#### GCTRL-O01 TCP Goal 所有权仍非持久安全边界（P0，对应 P0-02/P0-03）

- 本轮已拒绝“当前活跃 owner”之外的 update/delete/resume，但 owner 仅是进程内 connection route。
- 断线、idle 或重启后，知道 sessionId 的另一客户端仍可 `GoalGet`、认领、编辑、删除或恢复 Goal；只向 requester 发事件也会让其他镜像过期。
- 需要持久 capability/owner，并将 GoalGet、控制、read/fork 与事件订阅纳入同一授权边界。

#### GCTRL-O02 重复工具调用仍可长时间空转（P1，对应 P1-01）

- pause/delete 现在能在安全边界停止，但系统不会自动识别“相同工具+参数+结果”的跨 turn 无进展循环。
- 建议增加 canonical fingerprint 与阈值策略，达阈值后换策略、询问用户或强制停止。

#### GCTRL-O03 terminal CAS 后的非 Goal metadata 仍可被旧 state 覆盖（P1，对应 P1-04）

- `saveGoalTerminal` 的失败不再污染 live bundle，但成功冲突后的 `rebaseLiveGoalState` 只回基部分字段。
- 后续 whole-state heartbeat/save 仍可把新 summary 等并发 metadata 写回旧值；需要完数回基或字段所有权 merge。

#### GCTRL-O04 TUI approval/question 仍未按 session 分桶（P1 残余，对应 P1-06）

- stream 与 Goal 镜像已按 session envelope 过滤，但 pending approval/question 仍是 App 级全局单槽。
- 并发 session 的询问/审批仍需分桶存储与 owner 核验。

#### GCTRL-O05 UI 未暴露 Goal 运行态，Desktop 无 idle-unpaused 显式 kick（P2）

- `GoalGet` 只返回 persisted `paused`，不区分 `running / queued / idle`。TUI 已用“已激活”文案并允许对 unpaused Goal 执行 `/goal resume`。
- Desktop 对 unpaused Goal 仍主要显示“暂停”，无法判断是正在运行还是需要 kick。长期应由 protocol 返回 runtime run-state。

#### GCTRL-O06 旧 Desktop server 的 GoalDelete 兼容回退不完整（P2）

- Core `AgentClient.goalDelete` 仅在 `MethodNotFound` 时回退 `GoalClear`；Desktop preload 直接调用 `agent/goalDelete`，renderer 只在 API 方法缺失时回退。
- 新 renderer/preload 连接旧 worker 时，delete 可报不支持；这是热更或混合版本兼容问题。

#### GCTRL-O07 legacy single-engine host 不支持 Goal resume continuation（P2）

- 旧的单 Engine protocol host 无 `ChatSessionManager` 时无法排入重建后的 Goal turn；当前会明确拒绝，而不是假报恢复成功。
- 若仍需支持该 host，必须补充一个可排队的 continuation owner。

#### GCTRL-O08 通用 background wake 的 custom session root 仍可不一致（P2）

- Goal 冷恢复已改用 host 配置的 manager，但 `AgentServer.sliceForWakeRehydrate` 的通用背景唤醒 helper 仍可默认 `new SessionManager()`。
- 使用非默认 `sessionStorageDir` 时，非 Goal background wake 仍可找不到相同 session 配置。

#### GCTRL-O09 Goal 预算终止事件可在持久化对账前短暂投影（P2）

- 预算耗尽路径先发 exhausted 可见事件，再持久化 terminal；持久化失败时会读取权威 Goal 恢复镜像，最终一致，但 UI 可短暂闪烁。
- 理想语义与 complete/cancel 相同：持久化成功后再发不可逆终态。

## 验证基线与修复顺序建议

- 当前工作树的 Goal/Core/TUI 聚焦回归为 `210 pass / 0 fail / 707 expects`；Desktop 聚焦回归为 `180 pass / 0 fail / 456 expects`。
- Core、TUI、Desktop 的定向 typecheck 均通过；Core、TUI、Desktop 生产构建均通过（Desktop 仅有既有的 Vite chunk-size 警告）。
- 聚焦测试多轮合计曾得到 `146 pass / 0 fail`、Goal 相关 `179 pass / 0 fail`，说明现有测试没有覆盖上述并发、跨连接、远期 timer、负向 reconcile 与 teardown 边界。
- 全量基线曾得到 `6024 pass / 51 fail / 2 errors`；根 typecheck 29 errors。修复单项时应运行聚焦测试，并记录相对基线的新增/减少，而不是把“现有测试通过”当作问题不存在。
- 建议顺序：P0-01 首屏崩溃 → P0-02/P0-03 TCP 隔离 → P0-04 trust/MCP → P0-05 timer 溢出 → P1-01 busy-loop → 移动端与 settings 安全 → session/worktree 一致性 → automation/undo/attachment → P2 与待复核项。

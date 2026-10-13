# 第十五轮：CLI room 接管、离开和恢复

冻结快照 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 `CODESHELL.md`、主报告 R01–R65、CLI 第九轮与审批第十轮及 R62 相关附录。产品、主报告、goal 和构建产物未修改，没有 build/clean、真实 Claude/Codex、模型、账户或外部服务调用，未创建子代理。

本轮确认 **1 个正式发现 R66/C15-1/P2，已获独立只读质量复核**；另验证离开/重开、模式切换、持久身份、viewer 断线、同步启动失败与迟到响应的正常边界。最终便携证据 **3 文件 / 7 测试 / 108 断言 / 0 fail/skip**，没有把已有测试重复计入。

## R66 / C15-1 / P2：旧观察视图接管时显示 default，却继续复用并发重开的 bypass agent

主要位置：[room-manager.ts:893](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:893)。`takeOverLinkedSession` 对精确 room/session/cwd/kind 重新校验后，将 `permissionMode` 写为 `default`、清 observe-only，再在 [room-manager.ts:903](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:903) 调用 `open(roomId)`。`open` 在 [room-manager.ts:1009](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:1009) 仅检查是否已有 agent；已有进程时返回 running，不核对其启动模式，也不 restart。

这违反该 takeover 方法自己的默认权限意图：[room-manager.ts:896](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:896) 明确说明观察导航未批准旧的权限模式，接管不能静默继承旧 bypass。返回值 `mode=default` 会被 [CCRoomView.tsx:387](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:387) 写入会话状态，实际 [CCConversationView.tsx:467](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCConversationView.tsx:467) 标题显示 default，composer 随 observing=false 启用。观察卡的按钮只显示“继续对话 / 接管”，并未为这次接管请求 bypass；用户可见的 default 定义在 [CCRoomView.tsx:543](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:543) 是工具调用逐次批准。

正式可达操作：

1. Desktop 的外部 CLI 链接由 [DriveAgentLinkButton.tsx:19](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/DriveAgentLinkButton.tsx:19) 发 `codeshell:open-cli-session`，只有具备完整 external id/cwd/source id 的 DriveAgent 记录才产生此入口。[usePanelBuckets.ts:839](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/usePanelBuckets.ts:839) 校验并定位归属 bucket，将 openRequest 交给 CC Room。实际 [CCRoomView.tsx:170](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:170) 调 `openLinkedSession`，只读观察不运行 availability probe 或 agent。
2. A 保留该 observe-only 视图。B 可是同操作者的另一个 Desktop 窗口/面板，先显式接管同一 session，使房间可写，再返回列表，选择相同 session 并明确以 `bypassPermissions` 重开。普通选择器 [CCRoomView.tsx:562](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:562) 将该选择经 [CCRoomView.tsx:249](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:249) 传给真实 Main `openSession`。普通 `openForSession` 在 [room-manager.ts:809](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:809) 正确关闭 default agent 并创建 bypass agent。
3. A 仍有原先的 observing 状态与可用接管按钮；组件没有监听其他窗口的 open/mode 变化来更新这个状态。A 点击真实按钮，生产 [Main takeover IPC:5658](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5658) 重新验证项目路径和磁盘身份，随后走上述 metadata default + `open` 复用路径。
4. A 的标题变 default、composer 启用；房间磁盘 mode 也变 default，但当前 agent 仍是 B 明确选择的 bypass 实例。该视图随后发送的测试文本交给这一实例。

触发要求两份观察/控制视图交错，不是冷接管必现，也不要求传输异常。B 的 bypass 是明确操作，本轮保守 fixture 使用已注册、且在隔离设置中显式加入 trustedWorkspaces 的 cwd，并以真实 `resolveRoomPermissionMode` 断言该请求允许 bypass。**Desktop Main 的普通 openSession 自身只做注册项目路径校验，不调用移动端 trust resolver；若 B 来自配对端，`handleCcRoomEvent` 会先调用 resolver，非受信任 cwd 的 bypass 被降为 default。**不将此项描述为任意未受信任目录获得绕过权限，也不声称 A 的点击新启动了一个未经批准的 bypass 进程。问题是 A 报告 default 却继续向既存 bypass agent 发送。

### 动态证据及保护

[takeover-mode.test.tsx](reproductions/cli-recovery-round15/takeover-mode.test.tsx) / [最终日志](validation/original-cli-recovery-round15/takeover-mode.log)：**2 pass / 53 expect / 0 fail/skip**。

- 使用真实临时 ProjectStore 与 `requireRendererProjectPath`、真实磁盘 Claude identity resolver（owned 临时 claudeHome）、真实 RoomManager。三个 Main 回调均 AST 提取自目标 `index.ts` 并执行其真实 helper。实际 CCRoomView 与 CCConversationView 挂载，A 的接管、header、composer 和 Enter 发送均调用组件真实 handler。
- B 的两次操作与恢复采用实际 Main callback 调用，UI mode-picker 接线只读核对；**没有将 B 的完整窗口点击或恢复步骤包装成已跑完整 UI**。A 的 openRequest 从组件边界进入，外部链接 producer/bucket 的接线只读核对；没有真实 DriveAgent/model 运行。
- Agent factory 是 `RoomAgent` 接口的内存替身，记录创建时 mode、stop 次数与收到的文本。确认 takeover 不创建/停止 agent，并继续调用 bypass 实例。生产 Main factory [index.ts:1152](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1152) 将 mode 固定传给 ResidentAgentProcess，而 [resident-agent.ts:185](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/resident-agent.ts:185) 仅在 spawn 时写入 `--permission-mode`；因此 metadata 改写不可能动态调整该 CLI。**本轮未启动任何真实 CLI 或原生 agent 进程，未证明真实 CLI 免审批执行了某项工具。**
- 冷接管创建 default agent，已有 default agent 的重复接管保持幂等；不存在 transcript 的 session、未注册 cwd 均拒绝，未额外创建 agent。观察导航 probeCalls=0。

### 恢复应如何表述

1. **同模式 default 重开不能立即修复**：A takeover 已先把 metadata 改成 default，随后普通 Main `openSession(default)` 看到同值，沿 `openForSession` 同模式分支复用原 bypass 实例；已动态断言实例数、stop 次数与 mode 不变。
2. **已动态验证的恢复**：通过普通 Main `openSession(acceptEdits)` 强制一次真实模式变更并替换旧实例；再 `openSession(default)` 替换为 default，显示/实际模式一致。对应 mode-picker 的正式 UI 入口存在，但本轮恢复只执行真实 Main/service 链，没有完整点击返回列表和两个选择器。
3. [Main:5738](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5738) 与 [preload:1809](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1809) 有关闭房间 IPC；全 renderer/Web 搜索没有该 `ccRoom.closeSession` 的调用入口。Desktop“返回”在 [CCRoomView.tsx:407](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:407) 只清 conv 并重 probe，卸载只退订 transcript；配对端 [leaveRoom:1608](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/hooks/useRemoteApp.ts:1608) 也只退订和清 feed。**不能把关闭 tab、返回列表或离开当作 kill CLI→default 重开的更直接 UI 恢复。**
4. 实际 `RoomManager.close` 后重开可创建 default，是服务能力，正常控制已验证；服务实例重建也从 durable metadata 恢复默认模式。未启动/退出真实 Main，不把它标成已执行完整应用重启。

### 与现有项去重、级别及修复方向

与 **R02** 的现象同为模式显示失配，但生产错误位置和修复独立：R02 是配对 Web 的 in-chat select 绑到 native `permissionMode`/`permission.setMode`，没有对 CLI room 发 mode change；正常 CLI `openForSession` 本来会正确 restart。此处是 **Desktop linked takeover 已抵达正确 room backend，却先改 metadata 再复用旧 agent**；即使修正 R02 的选择器路由，这条 takeover backend 仍错。反过来修 takeover，也不修 R02 的 native-only select。独立质量复核认可 R66/P2：两处修复点独立，不能只改 R02 UI 后宣称完全修复。

与 R18 async failed-spawn 不同，本例 agent 健康且可收到后续文本；与 R10/R11/R12/R14/R19 的审批卡/回包/待请求状态无关；与 R62 离开后全局审批残留无关。没有把旧状态保留或观察模式本身当 bug。

建议保证 takeover 返回的 mode 与实际运行配置相同：在写 default 前核对并退役不同模式的现存 agent，或从独立的当前 agent 配置/代际记录决定 restart；不能只比较刚写完的 metadata。若无法证明运行配置，明确 restart 或返回实际 mode，不应成功报告 default。保留精确 room/session/cwd/kind、磁盘 transcript 以及注册项目的门禁；已是 default 的幂等接管应继续有正常对照。

## 正常控制及未新增的边界

[room-recovery-controls.test.ts](reproductions/cli-recovery-round15/room-recovery-controls.test.ts) / [最终日志](validation/original-cli-recovery-round15/room-recovery-controls.log)：**3 pass / 40 expect / 0 fail/skip**。

- 真实 RoomManager + ApprovalBridge：close 取消旧 pending，重开后旧 agent 的 text/exit/approval 事件被 [实例身份保护:1015](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:1015) 丢弃；旧 approval ID 不能再响应新 agent。普通模式变更真正替换实例。重建 RoomManager 后同 kind/external id 使用原 durable room id，保留消息和已选 mode。只是服务重建，不是实际 Main crash/restart。
- 真实 TranscriptSubscriptionManager + owned JSONL/watchFile：两个 viewer 共用 follower，断开一位只释放该 subscriber，另一位仍保留；endRoom 在下一 poll 前同步 drain 最后完整行，再释放；重订阅取得稳定 snapshot/cursor，不重复 push，错误 roomId 的 unsubscribe 不影响当前归属。正式 Main 的 viewer-offline 接线在 [index.ts:1214](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1214)，不用 device 范围退订另一个 tab。
- 同步 `start()` throw 会退役该 agent，同模式 retry 成功；相同 external id 的 claude/codex 房间保持不同身份。不要扩大 R18 到同步 throw 或所有退出。

[web-room-recovery.test.tsx](reproductions/cli-recovery-round15/web-room-recovery.test.tsx) / [最终日志](validation/original-cli-recovery-round15/web-room-recovery.log)：**2 pass / 15 expect / 0 fail/skip**。

- 实际 useRemoteApp/useRemoteSocket + fake authenticated WebSocket：打开 Codex room A 后改变 sidebar project/CLI kind，断线和 online 重新认证仍向 room A 原 cwd + Codex reader 重订阅；旧 socket 的后续消息无效；snapshot 后 catchup 与重复 live seq 只呈现一次，loading 结束。
- 离开 room 正式 hook 只发送 unsubscribe、不发送 room.close；迟到 transcript snapshot 不恢复旧 feed；focus 不重新订阅已离开的房间，用户重新打开后发出新订阅。本用例没有 pending 审批，避免把 R62 重记一遍。
- Desktop 已有 history 订阅/fallback 双失败会显示“重新读取”、IPC 发送失败保稿、单飞开会话/单飞接管和迟到 request identity 等保护，按源码和既有测试只读核对，未把整套既有用例重新导入或计数。`active=false` 仅退订 transcript，approval listener 仍可保留；R10 的真实卸载缺 snapshot 条件仍独立存在。
- 缺失 transcript 时 subscribe 返回 active=false 的设计、返回列表不结束 CLI、Codex 单 turn 结束后 room 保持可继续发送，均未单独列为新缺陷。未捕获自然浏览器网络时序，所有 socket 排序均为明确的替身交付。

## 执行、隔离与交付

从冻结 checkout 分别运行：

```sh
node scripts/run-bun-test-shard.mjs --timeout 45000 docs/review-2026-10-12/reproductions/cli-recovery-round15/takeover-mode.test.tsx
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/cli-recovery-round15/room-recovery-controls.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/cli-recovery-round15/web-room-recovery.test.tsx
```

| 最终脚本 | pass | expect | fail/skip |
| --- | ---: | ---: | --- |
| takeover-mode.test.tsx | 2 | 53 | 0/0 |
| room-recovery-controls.test.ts | 3 | 40 | 0/0 |
| web-room-recovery.test.tsx | 2 | 15 | 0/0 |
| **合计** | **7** | **108** | **0/0** |

每份最终日志均保留 `Completed Bun shard`。这是 latest a66f 的单次最终集合；未动态执行旧基线，也未将开发重跑累计。关键 RoomManager/ResidentAgent/CCRoomView/CCConversation/linked IPC 在 `git diff 84740d56..HEAD -- <paths>` 为空是源码事实，不等于两基线均已执行。

所有脚本用 `process.cwd()` 定位 repo，HOME 检查在入口；Core/Host 动态 import 前安装 exact-origin `http://127.0.0.1:9` 网络 guard，并拒绝 direct net/tls。没有连接该端口。fake WebSocket 是内存 transport；agent 是纯内存接口替身，没有模拟/调用真实 codex/claude，也没有任何 helper 子进程。实际文件读写、权限配置和 ProjectStore 只在 guarded HOME 与 owned 临时目录。`node_modules` 只作本地 test dependency symlink，不应提交。guard 不是 OS sandbox，本轮不宣称子进程网络隔离。

开发中保留 `room-recovery-controls.harness-failed.log`（cleanup 误用不存在的 cancelAll，已改为实际 closeAll 清理）与 `web-room-recovery.harness-failed.log`（误断言不公开的 activeRoomId，已改为真实公开 activeRoom）。这些是 fixture 错误，非产品发现；遗留自有临时目录已清理。`takeover-mode.initial.log` 是补全 trust 与恢复前的诊断通过，不加入总计。最终 `git status --short` 只有 root 所有的 `?? docs/review-2026-10-12/`，产品未改。

## 主审便携复核

主审将三个脚本保存至 `reproductions/cli-recovery-round15/`，在初始84740与新快照a66f分别经guarded runner通过7测试108断言，0fail/skip。最新快照日志归档于 `validation/latest-a66f4ef2/repro__cli-recovery-round15__*.log`；不把原始或开发重跑重复累计。B的模式选择和恢复仍仅实际Main/service调用，A的按钮/标题/输入为实际组件，没有真实CLI进程。独立结论见[CLI质量复核](cli-recovery-quality-round15.md)。

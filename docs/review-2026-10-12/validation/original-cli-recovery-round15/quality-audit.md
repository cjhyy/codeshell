# 第十五轮 CLI 接管候选独立只读质量复核

复核冻结工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，HEAD `a66f4ef291f304ee4df9da8095a90671d9a8f140`。对照主报告当前 R01–R65、R02/W4 原文及本轮最终 [专项报告](/tmp/codeshell-review-20261012-cli-recovery-round15.md)、[takeover-mode.test.tsx](/tmp/codeshell-review-20261012-cli-recovery-round15/takeover-mode.test.tsx) 与 [takeover-mode.log](/tmp/codeshell-review-20261012-cli-recovery-round15/takeover-mode.log)。本次只读独立复核新增执行 **0**；未启动任何测试、CLI、原生子进程、模型、worker、产品或构建，也未创建子代理。唯一写入为本文，未改产品、主报告或 goal。

## 结论

**认可 C15-1 为独立 P2 候选，生产可达且与 R02 修复点独立。** 条件限定为：A 留驻旧的 observe-only linked CLI 视图；B 对精确同一房间先合法接管，再显式以 bypassPermissions 正常重开；A 再点击实际接管按钮。冷接管和已有 default 的重复接管均有正常对照。不要把它描述为未授权启动、任意 cwd 越权、所有接管必现，或真实 CLI 已免审批执行工具。

## 后端证据与适配器配置

- [room-manager.ts:883](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:883) 先重验 transcript 身份和房间的 external ID/kind/cwd；893–902 随后把 metadata mode 写为 default、清除 observe-only；903 调用 `open(roomId)`，907 成功返回 default。
- [room-manager.ts:1009](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:1009) 只在没有现存 agent 时创建实例；已有实例直接走 1034 的 running 返回，不核对其实际启动模式。写 metadata 本身在 484–500 仅原子持久化，不修改 agent 配置。
- 正常 [openForSession:804](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:804) 已明确说明 mode 为 spawn-time CLI 参数，并在 809–812 按旧 metadata 差值写新模式、关闭旧实例。接管路径漏掉这一替换步骤。接管后 metadata 已经 default，再 `openSession(default)` 会失去这个差值，不能修复现存 bypass 实例。
- 生产 [Main factory:1141](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1141) 将房间 mode 的字符串值传入两种 adapter。Claude 的 [ResidentAgentProcess:165](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/resident-agent.ts:165) 固定保存 opts，在 185–186 spawn argv 中写入 `--permission-mode`。metadata 后续改写不能更新已运行进程。Codex 也固定保存 opts（[codex-room-agent.ts:115](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/codex-room-agent.ts:115)），128 按该值为每个 turn 构造 argv；bypass 对应 22 的 bypass-approvals-and-sandbox 参数。动态候选只验证 Claude kind；Codex 这里仅作同一配置机制的静态核对，不计为另一个动态复现。
- [RoomManager.send:1153](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/room-manager.ts:1153) 再调用 `open` 后，1173–1179 取当前 map 中的 agent 并发送文本，也没有 mode 重验。

## 正式入口、陈旧视图与身份门禁

- 多窗口属于正式能力：[menu.ts:43](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/menu.ts:43) 提供新窗口；[App.tsx:1462](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1462) 调用 preload newWindow；[preload:1408](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1408) 经 IPC 到 [Main:5835](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5835)，进入 1349 的完整 BrowserWindow 创建。RoomManager 在 Main 1138 是共享实例；房间没有按窗口分离。
- A 的正式 linked 入口由 [DriveAgentLinkButton:20](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/DriveAgentLinkButton.tsx:20) 分发事件，[usePanelBuckets:839](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/usePanelBuckets.ts:839) 校验 external ID/cwd/sourceSessionId/kind 并定位归属 bucket，861–873 传入 CC Room openRequest。实际 [CCRoomView:170](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:170) 走 disk-only openLinkedSession，186–193 将返回的 observing/mode 存入本地 conv。
- B 的普通权限选择有正式接线：[CCRoomView:562](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:562) 显式选择 bypass，经 242–254 的 openWithMode 进入 [preload:1777](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1777) 和 [Main:5634](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5634) 的正常 openForSession。先接管再正常重开会清掉初始 observe-only 边界，候选没有绕过该边界。
- A 的 conv 没有订阅其他窗口的 room mode/open 变化；[CCRoomView:336](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:336) 的定时/focus 列表刷新在 conv 存在时不运行。Main 1160–1166 的 room.message 广播存在，但 [CCConversationView:198](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCConversationView.tsx:198) 仅折入聊天 reducer，无法修改父组件的 observing/mode props。Main 1179–1182 的 onRoomEnded 只取消审批、结束 transcript follower，也不改 A 的 conv。因而 fixture 对消息监听的简化没有隐藏一条会自动清除此状态的正式刷新。
- A 的接管按钮在 [CCConversationView:487](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCConversationView.tsx:487) 仅受本地 takingOver/onTakeOver 限制。实际 [CCRoomView:381](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/cc-room/CCRoomView.tsx:381) 调 preload takeover，387–395 接受返回的 default 和 running；标题 466–470 显示传入 mode，composer 559–576 随 observing=false 启用并发送。权限对话框 543–545 将 default 明确解释为逐个批准工具调用，错报模式有实际意义。
- Main 三个入口（5634–5667）确实调用 [requireRendererProjectPath:121](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/renderer-project-path.ts:121)；后者仅接纳已注册 live V2 root 或 Main-owned no-repo 路径。linked IPC helper 验证参数，[resolver:72](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/cc-room/linked-session-resolver.ts:72) 从精确路径、有限 JSONL 前缀验证 id/cwd，RoomManager 883–891 再绑定精确 room/session/kind/cwd。候选保持这些门禁，不存在凭任意 cwd 或房间 ID 接管。
- 这里不要使用“IPC owner gate”来暗示每个 WebContents 独占该 CLI 房间：这三个 handler 的 `_e` 未参与授权。正式门禁是项目注册与磁盘/房间身份。Desktop openSession 直接传入显式 mode，没有调用 paired 路由的 trust resolver；fixture 额外注册 trustedWorkspaces 并验证实际 resolver 保留 bypass，是保守合法条件，而非声称 Desktop 已执行 trust 拦截。B 的 bypass 本来就是明确授权。

## 替身证据与边界

最终脚本 52–61 用 TypeScript AST 从实际 Main 源码提取三个完整 callback，再注入真实 ProjectStore 路径校验、linked helper、RoomManager。63–77 创建自有 cwd/transcript、实际项目注册及隔离 trusted 设置；78–82 唯一 agent factory seam 按创建时 mode 保存字符串并记录 start/stop/send。这与真实 adapter 的固定 opts 模式相符，不是假定 metadata 自动等于运行模式。

102–105 挂载实际 CCRoomView/CCConversationView 并确认导航不创建 agent、不 probe。115–140 顺序执行 B 的真实 Main callback（冷 default→显式 bypass），再点击 A 的实际 takeover handler；断言 header/metadata default、agent 仍为原 bypass 且未 stop、新输入经真实 composer handler 送入该实例，以及同值 default 重开仍不替换、acceptEdits→default 两次模式变更能替换并恢复。144–153 保留冷 default、已有 default 幂等、未注册 cwd 与不存在 transcript ID 拒绝的对照。

最终日志为 **2 pass / 53 expect / 0 fail / 0 skip / Completed Bun shard**。日志的两条 nongit owned cwd Git stderr 不等于用例失败；两个用例及清理均有最终成功结果。本次只复核这一证据集合，未重新计入专项报告另外 5 测试/55 断言，更未运行它们。

限制必须保留：A 是 MiniDOM 实际组件根；B 与恢复步骤直接调用真实 Main callback，未挂第二完整 UI、未创建两个真实 Electron 窗口。preload 参数接线只读核对，fixture 的 window.codeshell 是接口替身；没有实际 Electron IPC transport、DriveAgent 执行或 Main bootstrap。agent 为纯内存替身，未执行真实 Claude/Codex 工具。证据证明的是后端错误复用固定 bypass 配置实例和后续路由，不是原生进程免审批执行结果。

## 恢复、去重和级别

已动态验证的恢复仅为普通 Main/service openSession(acceptEdits)→openSession(default)，分别触发两次差值 restart。mode-picker 的对应 UI 接线存在，但未动态点击完整恢复 UI；同值 default 重开明确无效。Main 5738–5741 与 preload 1809 有关闭服务能力，RoomManager 1212–1226 真正 stop/delete；全 renderer/Web 搜索无 `ccRoom.closeSession` 调用。Desktop 返回 407–413 只清 conv/reprobe，CCConversationView 卸载 274–280 只退订 transcript。因此返回、关闭 tab、leave 和重新挂载不能当作已验证的 kill→default 恢复；未运行真实 Main 重启。

R02/W4（[原文:50](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/web-round1.md:50)）是 Web select 读 native state 并发 native permission.setMode，room metadata 仍正确为 bypass。此候选已调用正确的 Desktop room takeover backend，**后端把 metadata 自身写错，并成功返回 default，而 agent 仍 bypass**。修 R02 的 select 来源/路由不能修这一 backend；修 takeover restart 也不能修 R02。独立编号比按相似显示症状合并更能保持可操作的修复范围。R18 是异步 failed spawn 假运行，本例 agent 健康且接受后续输入；R62 是离开后 pending 审批阻塞，均非同一根因。

建议独立 **P2**：这不是纯陈旧标签，成功接管后 metadata 和 default 重开都无法反映实际权限，下一稿进入旧 bypass adapter；对使用者的权限判断具有实质影响。仍按窄条件和既有显式 bypass 授权保留 P2，不提升为未经验证的安全利用或 P1。修复应在宣告 default 前保证实际 agent 配置一致，保留 default 幂等和精确身份门禁；不能只比较已被接管改写后的 metadata。

最后只读核对 `git diff 84740d56e55517b004948a0a0e07649ad6fbf998..HEAD --` 的 RoomManager、两种 adapter、两个实际组件与 linked IPC/resolver，输出为空，是关键源码两基线相同的静态事实。

复核收尾时 root 通知已把三份 fixture 便携复制，并分别在 84740/a66f guarded 执行 **7 tests / 108 expect**。我另只读主报告工作区 `docs/review-2026-10-12/reproductions/cli-recovery-round15/` 的三份便携日志：takeover 2/53、room controls 3/40、Web 2/15，均 0 fail/skip 且 Completed，takeover 同样记录 metadata/header default、旧 agent bypass、同值 default 无效与两次变更恢复。这里补记 root 的双基线交叉验证与实际读取的便携日志，不宣称本审计者重新执行；本次新增执行始终 **0**。

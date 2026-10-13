# 第十七轮整合：最终只读语义核验

Completed。**未发现需要阻止本轮收束的实质错误；正式 R71/P3、R72/P2、R73/P2 可以保留。审核新增测试执行 0、进程实验 0、模型/提供方调用 0。** 本次只读报告、metadata、既有日志和相关源码；唯一写入是本文，没有修改产品、主报告、fixture、构建产物或目标，也没有创建代理。

核验目录：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/`。已读 README、flow-coverage、latest-baseline、reproductions/README，session-operations / context-recovery / server-routing 专项及三份独立 quality，high-risk-quality，以及两份 reproduction-results metadata 和 round17-report-audit.json。相关源码只补核了 App 两处恢复回调、ProjectStore archived 过滤/移除/运行解析、ChatSessionManager pending approval 的 idle 保留。

## 新发现的范围、恢复与去重

| 条目 | 核验结论 | 必须保留的界限 |
| --- | --- | --- |
| R71 / P3 | 项目显示名在真实拒写后仍乐观成功，未消费失败，普通注册表广播回旧名；权限恢复后重试成功。入口、实际 Store EACCES、无成功广播与无用户反馈相互一致。 | 仅未持久项目名称，没有路径/稳定 ID/历史删除。helper 捕获 unhandledRejection 不能扩成 Electron 崩溃。与 R60 的删除 tombstone、R70 的 autosave pending 消耗不同。 |
| R72 / P2 | 两处真实 App Settings callback 只清 renderer catalog archive，遗漏既有 Main/Core writer。默认磁盘目录与 root usage 继续按 Core archivedAt 过滤；正式文件夹 UI 可显式移除该 secondary，随后实际 resolver 拒绝 root_removed。 | root 安全门禁正常，修复须补 canonical engine ID 的 durable restore，不能放宽 root authority。没有后续真实 run 或历史/物理目录删除。正确 navigation/Main restore 是动态服务控制，完整纯 Desktop 可见恢复 workaround 未闭环；root 移除后只清 marker 不重建 mount。独立于 R39/R24/R69。 |
| R73 / P2 | 真实合法 configure IPC 等待窗口中，Host 在配置 admission 前 submit lease，早退未派发且未 retry。实际 Core configure 无问题 replay/clear；submitted 无 reservation TTL/断线释放，重连快照排除它。 | 真实回答 controller/card + authenticated HTTP/WS，但 worker bridge 为内存替身；Core 控制为实际 AgentServer/ChatManager + fake engine/runtime，真实 Engine refreshRuntimeConfig 无 replay 为静态衔接。不是完整 worker E2E，也未测自然 race 频率。取消是放弃旧题后重问，不交付旧答案；worker exit 清 lease 仅静态。独立于 R14/R19/R26。 |

README 208–212、flow 表格和各专项均保留了上述重点。R73 表格中的“重试和重连无法恢复旧题”由正文解释为不能交付该旧问题，而非永久不能使用会话。未刷新的持卡页面有 Stop 条件：approvals 计入 running；动态调用仅实际 controller.stop，完整 Workbench 按钮可见/接线是源码，独立 Core cancel 另验证清理。刷新后快照已无旧题，不能再保证同一 Stop 按钮仍出现；专项及独立审计都没有扩大这个恢复入口。

R72 的“可移除 secondary”始终要求用户在正式 dialog 显式确认。它不是自动删除目录或移除 primary/唯一 root 的越权；ProjectStore 正确只保护未归档 durable bindings，恢复 UI 没更新该权威才造成失配。原消息保留证据与正文一致。没有把自动化 picker 人工塞 archived row 的推断收录。

## 正常控制与严重问题复核

上下文四项正常控制准确区分：实际 MessageStream/Core/ChatSession/Engine/SessionManager/磁盘和 owned 内存 provider 为动态；完整 App 注册 Sidebar、Main/preload/IPC、Desktop Stop 为未动态覆盖。失败后同选择重试、非法 range/已存在 target 在摘要前拒绝、服务级 cancel 释放 exclusive、迟到 callback 的 shouldActivate=false 有各自证据。没有将 signal 合作的内存 provider 当作所有真实提供方都能终止，也没有将取消发生在发布前的“无目标”扩大成任意断电/写盘故障原子性。

context quality 中保留的 `[1804]` 显示标签修订建议已在最终 context 专项改成 `[1826]`；这是先前审计的编辑历史，最终结论和真实取消/exclusive 入口没有冲突，不影响分级或计数。

高风险复核不新增问题/执行。R35 仍要求创建预检重叠，未提交文件损失还要求成功返回至失败 rollback 间写入；恢复 session 工作区不能找回被删内容。R36 动态证据为 Node 25/macOS 上真实编译 Core 的异步 stdin EPIPE，完整 Hub 入口静态衔接，未声称完整认证网络退出、全部平台或 Electron Main 退出。README 和 flow 没有将这次只读审计写成新 native 实验。

隔离措辞也一致：guarded HOME、导入前 exact-origin HTTP/fetch guard、部分 net/tls/WS 拒绝是 fixture 约束，不是 OS 网络沙箱。owned Bun helper 是 Bun 子进程，不因使用 node:assert 或 child 就成为 native Node/Electron 实验。未把本地 Cookie/Origin 适配器称实际浏览器或真实账号。

## 基线、诊断、metadata 与计数

两份 metadata 均只读解析确认：

- `validation/reproduction-results.json`：76 entries / 228 tests / 0 skipped，code 全为 0、signal 全 null。
- `validation/latest-a66f4ef2/reproduction-results.json`：同样 76 / 228 / 0 skipped / 全成功；round17 的 archiveLog 指向实际 latest 归档，不将原基线 log 误当 latest 结果。
- 各自仅有本轮 4 个入口：context 4 tests、session wrapper 1、Hub 1、Core configure 1；合计新增 7。最终既有日志分别 40 / 2 / 20 / 15 Bun expect，合计 **77**，都有 Completed 和 0 fail/skip。
- session helper 两基线各为 **PASS / 91 手工 assertions**，包含在同一个 wrapper 内；helper.tsx 不另算第 5 个 Bun 入口，不把 91 加为 Bun expect 或测试，也不因两基线分别执行而将 7 变成 14。

总数相容：前轮 72/221 + 本轮 4/7 = **76 文件/228 测试，每基线分别**；正式 70=1/47/22 + 1P3/2P2 = **73=1P1/49P2/23P3**。上下文新增 0、三独立审计及高风险只读复核执行 0，未混入新发现或执行计数。latest-only 3 文件/8 测试、既有 Electron/native 和本轮 helper 均保持单列。

首轮旧 Hub 失败原日志确为 connect 仅等待 hello 就读取尚未到达 snapshot 的 TypeError，失败位于断言读取字段，而非服务端返回了不同状态。最终便携脚本仅补 `await until(snapshot received)` 后读取同一快照并保留原空快照/未派发断言；两基线最终 Hub 都 1/20 Completed。失败原始日志留在 original archive，没有计入成功 metadata，也没有因增加等待修改产品或掩盖 lease 行为。3 条 act harness 警告在最终日志/报告仍如实保留。

原始代理 latest-only 记录、独立审计写作时“尚不能预先宣称双基线”、末尾主审实际双基线 receipts 为明确分层，不互相冲突。最终首页/flow/latest 总结引用主审最终记录，原始失败/中间成功日志不累计。

`round17-report-audit.json` 的 73 / 1-49-23、两组 76/228、本轮 4/7/77、helper 91 和 errors=[] 与上述只读核对一致。其中 **673 顶层 Markdown local links、428 source-line links 是主审机械 QC 的链接口径**，不是独立文件、发现、测试或执行数量；本文没有重新运行全量链接扫描或把该 QC 作为新测试。新专项与 quality 的关键链接确实指向已读的正式资料/源码/日志；没有把 /tmp 作者原件计成另一套便携结果。

**最终确认：当前整合无实质语义/计数错误，无撤销、合并或升降级建议。本核验新增执行严格 0。**

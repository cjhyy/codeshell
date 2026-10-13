# W26 出站队列独立质量复核

Completed。只读核对冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140`、最终专项报告、脚本、既有 stdout/JSON 与生产源码。本次 **新增测试执行 0，新增断言执行 0，新增 native/worker/model/网络实验 0**；未修改产品、主报告、构建或 goal。

结论：**建议保留独立 P2，限定为 Desktop 配对 RemoteHost 的 live/device 发送绕过背压限制**。现有动态证据足以证明真实 Node/ws 队列增长超过既有 4 MiB gate，并仍保持 OPEN/认证；生产 Main 接线和独立 replay cache 的源码足以支持正常用户入口。不能把它扩大成 Hub 普遍失效、真实 Main 已 OOM/退出或自然网络中永远不会断开。最终编号由主审决定，本复核不自行编号。

## 生产入口与已有门禁

- [Main:964](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:964) 构造的确是该 `RemoteHostManager`，并开启 outputJournal；[Main:1739](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1739) 的真实 worker outbound 订阅将 snapshot entry 经 `broadcast(session.stream)` 发送，其他行走 `broadcastRaw`。这是实际 Main 接线，不是仅测试用的孤立公开方法。
- [AgentBridge:513](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:513) 调 SnapshotStore append，再在 [AgentBridge:544](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:544) 向 outbound tap 交付该 entry。SnapshotStore 的 8 MiB/session、64 MiB/total replay 限制在淘汰后仍 [return entry:165](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/SessionSnapshotStore.ts:165)，不能回收已经交给 ws 的写队列。因此不能以 replay 有界反证此问题。
- [broadcast:484](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:484) 只包装 JSON 并进入 [broadcastRaw:546](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:546)；后者仅检查 OPEN 与 authed，然后 `client.send`。这里没有调用 `sendToViewer`，也没有额外的 bufferedAmount、总队列或年龄门禁。
- [sendToDevice:492](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:492) 和 [sendRawToDevice:535](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:535) 同样直接 send。实际 [approval replay:245](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-orchestrator.ts:245) 使用 raw device 方法。原生 fixture 在该方法中交付 session.stream 只是验证传输行为；**并未动态执行真实审批重放，也不声称生产所有 session.stream 都走 device raw 路由**。
- 唯一既有 4 MiB 检查在 [sendToViewer:524](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:524)，属于 selected viewer reply。新 owned-external selected stream 也经 [output-recovery:105](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote/output-recovery.ts:105) 的 reply→sendToViewer，不能把这个正确受限分支说成同样失效。普通 native worker mirror 则不经过它。
- WS 构造的 [maxPayload:233](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:233) 是收到帧的限制，不是 `send` 队列上限。当前安装的 ws [bufferedAmount getter:120](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/node_modules/ws/lib/websocket.js:120) 取 `_socket._writableState.length + _sender._bufferedBytes`，实际反映 Node/ws 待写数据；native fixture 没替换它。

## 真实记录与优先级边界

[原生脚本](/tmp/codeshell-review-20261012-connection-recovery-round15/outbound-native.mjs) 使用 owned TrustedDeviceStore，真实 auth.device 和合法 session.list 取得 distinct viewer identities，再暂停一个实际 ws client 的 TCP 读取。`broadcast` 16 MiB 与 raw-device 8 MiB 分批交付，384 个 64 KiB text_delta，严格最大文本 payload 24 MiB。没有改 server send、bufferedAmount、Node Socket write 或 Host 实现。

[JSON](/tmp/codeshell-review-20261012-connection-recovery-round15/outbound-native-observed.json) 对应 Node v25.8.1/darwin：慢读方广播后 13,859,059 bytes，再 device raw 后 22,266,483 bytes；普通 device reply 后 22,266,525 bytes，仍 OPEN/认证，未发 offline。健康方收齐 384 帧、backlog=0。这是有界实验内的真实分配/保留证据，不只是人为改 bufferedAmount；也不能从单次、快速 loopback burst 推出每位用户的自然积累速率。

P2 的依据是常规 Desktop 长会话继续产生输出时，已认证但读取受阻的浏览器仍为直播收件人，shared Main 内 Node/ws 写队列缺应用上限；浏览器/链路慢读不需要攻击或额外发命令，后续每批输出仍可排队。24 MiB 实验未观察崩溃或健康方受影响；更高内存耗用乃至耗尽是源码缺界的推论，必须明确标为风险。它不应表述为立即全客户端故障。

建议将最终标题中的 **“indefinitely”** 收窄为“live/device 路由未限制慢读连接的出站队列”；即使应用没有背压/心跳退役，也不能将系统 TCP、浏览器或用户的 eventual close 排除。`pause()` 是确定性代理，未捕获真实手机、浏览器挂起或物理网络时序。现有 P2 不依赖证明网络永远保持 OPEN。

## 恢复与反证

- 同一真实慢读 server socket 随后进入 `sendToViewer`，立即释放并 terminate；只释放该 viewer，健康方保持认证和 online。这反证了“4 MiB cap 无效”，问题是直播绕过它。
- 真实重新连接/认证取得新 viewer，并正常收 selected reply；删除 durable device 后 `revokeDevice` 关闭剩余两个同设备 socket，旧凭据 auth.failed。Main [5498](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5498) 确实按 remove→revoke 顺序接线。此次 fixture 是该服务链的实际调用，不是已跑完整删除设备 UI。
- [releaseSocket:554](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:554) 先移除认证/viewer，再发 offline；Main [1214](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1214) 释放该 viewer 的恢复/转录资源。停 Host 的 [614](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:614) 也 release/terminate 所有连接。这些保护保留，不是新 auth/撤销缺陷。
- 读取恢复理论上可排空写队列，但脚本是在 cap terminate 后 resume，不证明未断开时自然 catchup 的耗时。selected reply 也可能比用户关闭浏览器更早触发回收；不能说任意慢读必然无限积累。
- Hub 是另一路：[headless-server:242](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:242) 真正安装 `HubOutboundTransport`，[limits:24](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/outbound-transport.ts:24) 为 8 MiB/socket 与 128 MiB/total；正常控制是明示 mock backlog 的政策测试，不能算第二个原生测量。
- 与 R03/R41 意图恢复、R34 上传 HTTP lifetime、R38 logout 等待、R10/R62 CLI 审批恢复、R31/R36 native lifecycle 根因和修复点不同。本项应合并 broadcast/device 两种漏 gate 入口为一项，不分拆增加数量。

建议所有 RemoteHost 输出共用背压策略，退役慢 viewer 并保留认证后的恢复协议，同时兼容合法大历史/page。不能只改已有限制的 sendToViewer；也不应通过放宽认证/归属或禁用 replay 修复队列。

## 隔离、清理与计数审计

- `native-outbound.test.ts` 先检查 guarded HOME；内层 [run-isolated-node-smoke.mjs:17](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/scripts/run-isolated-node-smoke.mjs:17) 再用 allowlist 创建新的私有 HOME/应用配置并移除 inherited credentials/proxies/NODE_OPTIONS。native script 再断言 marker/home。
- native script 先在 `127.0.0.1` 临时预留并释放端口，然后在任何 Host import 前安装精确 HTTP/fetch origin guard。对该 IP/port 的 ws 标准 `netConnect` bootstrap，删 createConnection 让已 guard 的普通 HTTP connector 执行；同一条件还拒绝 agent/lookup/socketPath。目的为兼容 stock ws，不是假冒服务数据或替换服务器传输。
- **这是 HTTP/fetch 层的 test guard，不是 OS sandbox，也未普遍封锁 direct net/tls。**审阅脚本只有已校验本 origin 的实际 WS construction，没有 worker/model、第三方调用或本进程再 spawn；wrapper/isolator 仅启动 owned 本地 Node fixture。不能宣称全进程任意网络均不可达。该限制不推翻当前已审路径的 loopback 测量。
- 成功路径 finally 先清 timer，再 resume/terminate 所有自有客户端，await 实际 host.stop，移除 owned store 目录，写 JSON；isolator finally 移除 HOME。PASS stdout 在 finally 前产生，不能单凭这一行认定清理；但最终 guarded wrapper **exit code 0 + Completed** 发生在内层 finally 返回之后，支持本次成功路径清理。未独立运行端口/文件残留扫描，也不宣称已经验证 timeout/异常的所有清理分支。
- native 12s timer 与 wrapper 18s timer 是诊断预算，现有成功执行约 1s。18s wrapper kill 的目标是 isolator parent，不能由此推定 arbitrary hung descendant 的进程树强杀已验证；本轮没有 deadline 命中或真实模型子进程，不另列产品发现。
- 最终既有计数：**2 Bun 文件/2 tests/11 expect/0fail/skip；native 内部33 assertions另计，属于其中1个wrapper test，不加第3个测试。**两个最终日志均有 Completed。native JSON/stdout 同为33。
- `diagnostics/bun-outbound-attempt.*` 是已放弃 Bun 兼容诊断，1pass/1fail/19expect 不计正式成功总数；Bun中 `bufferedAmount=0` 不是对生产 Node 的反证。原生 fixture 使用冻结 dist；只读核对 src 对应路由一致。此审计只看 a66f，root 另行跑旧基线不能算入本审计执行。

本次仅创建此 `/tmp` audit；检查时工作区 `git status --short` 只有 root 所有的 `?? docs/review-2026-10-12/`。**Completed：新增执行 0；建议保留 W26/P2，按上述范围描述与去重。**

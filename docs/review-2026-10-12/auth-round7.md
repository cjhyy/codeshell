# 第七轮：Hub / paired 身份与连接生命周期复查

结论：**正式新增 0 项**。本轮覆盖的正常到期、撤销、设备删除、同浏览器多页签、重新配对及连接重试路径具有明确保护和恢复入口。R03 ACK 重复、R32 配额下 secret 持久化失败、R38 logout HTTP 黑洞不重复计入；主报告 R01–R50 已去重，R50 为麦克风权限路径，与此域无交集。

## 冻结与验证方式

- 工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，HEAD `a66f4ef291f304ee4df9da8095a90671d9a8f140`，分支 `codex/review/latest-20261012`。
- 已读 CODESHELL.md；只读产品和既有 dist，不 install/build/clean。最后 `git status --short` 仅有主代理正在整合的 `?? docs/review-2026-10-12/`。
- 自定义文件全部位于本目录。guarded runner 分别生成隔离 HOME / 应用状态并清除继承凭据。所有 Host / Core 动态导入前安装精确 `http://127.0.0.1:<fixturePort>` network guard；WS 构造也逐次检查同一 loopback origin。浏览器用实际组件和 Hooks，加内存 DOM / WebSocket / HTTP 响应 fixture，无外部网络。
- 真实 Hub/paired fixture 直接导入已构建 `packages/server/dist/`；真实 Hub auth store、cookie、WS、HTTP、设备 registry 均被调用。没有 `agent/run` 或付费模型调用，Hub worker generation 保持 0；占位 worker 如意外执行会立即报错。
- **13 tests、87 个 Bun expect、0 failures、0 skips**。另有原生 Node 下载 fixture 自身的 assert，未混入 Bun expect 数量。

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-auth-round7/auth-lifecycle.test.ts /tmp/codeshell-review-20261012-auth-round7/native-download.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-auth-round7/browser-recovery.test.tsx
```

分别运行是有意的：两个 shard 的精确 origin 不同，不能在一个共享进程中替换 network guard。

## 已验证正常边界

### 1. Hub 撤销、logout 和同 cookie 多页签

可达操作：登录 Hub，在同浏览器打开两个 tab；另一独立登录在设备会话列表撤销该登录，或当前登录正常退出。

生产链：

- [auth-http.ts:154](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-http.ts:154) logout 删除 session，触发 onRevoke，清 cookie；同文件 162–167 设备会话 DELETE 也触发同一 callback。
- [headless-server.ts:193](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:193) 以 sessionId 取消 HTTP / MCP / configuration / Link / Panel owner，并关闭该 session 的全部 WS（4401）；741 行将真实 HTTP response 归属到登录 session。
- [protocol.ts:169](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/protocol.ts:169) 4401/4403 关闭会 emit auth loss 并停止自动重连；[useHubController.tsx:327](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/useHubController.tsx:327) 接入 AuthGate。
- [AuthGate.tsx:69](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/AuthGate.tsx:69) 展示“登录已过期或此设备已被撤销，请重新登录。”，保留正常登录入口。

真实结果：同 cookie 两条已打开 WS 均收到 4401；旧 cookie API 为 401，另一登录的 WS 和 API 仍可用。上述预期拒绝不计缺陷。

### 2. Hub cookie 轮换、到期与多 tab 恢复

可达操作：带当前 cookie 再次登录；登录会话到期后重新登录；另一 tab 已产生有效的新共享 cookie，再切回旧 tab。

- [auth-store.ts:214](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:214) grant 删除 supplied replaceToken 对应会话及已过期会话，返回 revokedSessionIds；[auth-http.ts:101](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-http.ts:101) 将轮换释放到真实 WS/HTTP callback。
- [auth-store.ts:161](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/auth-store.ts:161) 每次鉴权重读磁盘并检查 expiresAt；[headless-server.ts:274](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:274) 默认每 5 秒重查已打开 WS，823 行每条入站 WS message 再鉴权。
- [AuthGate.tsx:39](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/AuthGate.tsx:39) 请求 revision 保护，focus/visible 重新读取 status；临时 status 网络/503 错误保留已认证页面。收到新的有效共享 cookie 后，focus 可回到 ProjectsGate，无需再输账号。

真实结果：重新登录得到新 sessionId，旧 WS 4401、旧 cookie 401。对本 fixture 的一个持久会话合规调整时间戳模拟到期后，已打开 WS 被 sweep 关闭为 4401，status.authenticated=false，新登录恢复 API 200。浏览器实际 AuthGate 测试确认撤销文案、共享新 cookie 的 focus 恢复，以及临时检查失败时保留 active view。

限定：生产 30 天 TTL 未真实等待，fixture 只调整隔离 auth.json 的时间戳，不改全局时钟；WS sweep 测试使用 20ms 调参。没有声称所有已经开始的长 HTTP 操作仅因自然到期都被即时取消。

### 3. Desktop HTTP 会话续期不破坏正常多 tab

可达操作：两个 tab 复用同配对设备；WS 重连重新兑换 cookie；30 分钟 HTTP 会话到期但 paired WS 仍在线。

- [http-api.ts:379](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/desktop-web/http-api.ts:379) 同 device + 有效 cookie 复用 token 和 sessionId，仅延长 expiresAt，避免取消正在进行的 owner-scoped 探测 / 授权；到期后 principal 221–223 删除旧 owner，重新 exchange 可创建新 owner。
- [DesktopApp.tsx:40](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/DesktopApp.tsx:40) WS online 或 authRevision 改变后 exchange 配对凭据；[DesktopApp.tsx:181](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/DesktopApp.tsx:181) configuration 的 401 调用 retryAuth，focus/visible 在 195–209 行触发刷新。

真实结果：短 TTL/注入时钟 fixture 中，到期前跨 tab handshake 保持相同 cookie/owner，未调用 onSessionRevoked；自然到期后旧 cookie 401，paired WS 保持在线，再 exchange 得到新 owner 和 API 200。实际 DesktopApp Hook 测试显示 focus 遇到一次 401 后自动完成第二次 exchange，保持同 WS 和未发送 draft，无需新 QR。排除了“WS 在线而短期 HTTP cookie 到期后永久失效”的候选。

### 4. Desktop 设置删除设备后旧连接全部失效，同浏览器可重新扫码

可达操作：桌面设置 → 高级 → 可信设备 → 删除；旧浏览器扫描新二维码。

- [AdvancedSections.tsx:1763](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/settings/AdvancedSections.tsx:1763) 设置 UI 调用 removeDevice；[index.ts:5498](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:5498) 先 hard delete 设备记录，再调用 remote.revokeDevice。
- [remote-host-manager.ts:580](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:580) 取消该 device 上传和 Web API owner，release/terminate 全部对应 WS；[http-api.ts:349](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/desktop-web/http-api.ts:349) 删除 device 的全部浏览器 cookie owner。
- [trusted-device-store.ts:42](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/trusted-device-store.ts:42) 配对以 stable secret get-or-create；112 行 remove 真正删记录，因此 UI 删除后不会留下被 revoked 的 zombie row 阻止相同浏览器重新配对。
- [remote-host-manager.ts:421](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/mobile-remote/remote-host-manager.ts:421) 真实 QR token → pair.complete → store.addDevice；466 行 auth.device 重新鉴权。

真实结果：同 device 的两个旧 WS 均关闭，旧 cookie API 401；另一 device 的 WS/API 继续正常。相同 secret 使用新真实 QR token 配对成功，得到新 deviceId，随后 auth.device 和 HTTP exchange 均成功。

限定：native Electron 设置 UI 没有启动，测试执行其已核对的同一两步后端删除链。显式 revoke API 会保留 revoked row，要求管理员 remove 后再配对；这个区别是生产 store 的明确策略，设置中的正常删除流程走 hard delete，未将策略性拒绝当作 bug。

### 5. 未完成 HTTP 撤销、文件句柄清理与其他登录隔离

可达操作：浏览器已开始下载文件，管理员撤销该设备登录/配对设备，或该登录正常退出。

- [session-http-responses.ts:7](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/session-http-responses.ts:7) cancelOwner destroy 实际 response；17–32 行跟踪 finish/close，覆盖 handler 返回后仍继续的响应。
- [http-api.ts:195](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/desktop-web/http-api.ts:195) Desktop cancelSession / dropSession 共享此响应清理；Hub 对应 headless-server.ts:193–201。
- [files.ts:250](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/files.ts:250) stream pipeline 被 response destroy 中断，270–273 行最终释放 source / retained parent 文件句柄。

原生 Node 真实下载结果：96MiB 文件在 revoke/logout 后均不完整（complete=false、postRevokeTail=false、timedOut=false），四次撤销分别只读到约 1.3–1.8MiB 已进入管道的字节；被撤销的真实 FileHandle 全部 fd=-1。另一登录的并行 96MiB 下载完成，后续小文件仍可读；已经返回 accepted 的 fixture 后台 Promise 不被 HTTP logout 取消。撤销后的新下载 401。

证据 `native-desktop-observed.log` / `native-hub-observed.log`。脚本基于仓库已有 `tests/fixtures/download-revocation.mjs`，仅移除构建步骤、改为当前 dist，并在 Core/Host 导入前加入 exact-origin guard。

### 6. 连接错误的用户恢复入口

- [useRemoteSocket.ts:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/hooks/useRemoteSocket.ts:89) paired WS 断线 jitter/backoff；103 行允许 focus/visible/online 抢先重连，124–141 行 CONNECTING 超时 watchdog；177–178 行忽略旧 socket 晚到事件，56–64 行 generation 限制过期发送。
- [useRemoteSocket.ts:74](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/hooks/useRemoteSocket.ts:74) 显式 logout 清 deviceId，关闭本 tab WS，并阻止自动重连；稳定 secret 保留以允许后续正常配对。
- [DesktopApp.tsx:68](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/DesktopApp.tsx:68) 初始 HTTP handshake 失败显示真实错误、“重试”和“重新配对”。实际组件测试：一次 503 后点击“重试”成功进入 Workbench，不需新 QR。
- [protocol.ts:174](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/protocol.ts:174) Hub 认证撤销停止 retry；普通 1006 传输关闭进入 backoff retry。实际 client 测试分别验证两类。
- [AuthGate.tsx:134](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/AuthGate.tsx:134) 初始连接错误提供“重试连接”；已认证页面临时检查失败保留现有页面（39–50 行）。

配对 HTTP logout 本身保留 device pairing 和其他已认证 paired WS 是明确分层契约（http-api.ts:409–413；仓库已有“logout preserves pairing”测试）；浏览器退出还调用本地 app.logout 关闭本 tab WS。此轮不把“HTTP logout 没有撤销整个可信设备”计成缺陷。已有 R38 的 HTTP logout 永不 settle 场景仍属独立问题，不被本轮成功响应对照否定。

## 证据与局限

- `server-final.log`：8 tests / 61 expects / 0 failures。
- `browser-recovery.log`：5 tests / 26 expects / 0 failures。
- `auth-lifecycle-observed.json`、`browser-recovery-observed.json`：核心状态观察，无 bearer token、cookie 或凭据输出。
- `auth-lifecycle.test.ts`、`native-download.test.ts`、`download-revocation.mjs`、`browser-recovery.test.tsx`：全部复现源。
- `discarded-bun-download-attempt.log`：初版以 Bun HTTP incoming.pause 模拟下载暂停时，它仍会预缓冲完整文件，因此两项断言失败。改用仓库原生 Node fixture 后四次 revoke/logout 全部通过；该文件是测试环境纠偏记录，不是产品缺陷证据。
- 浏览器层验证实际 React 函数/Hook 返回的文案、按钮 handler 和状态；没有运行完整真实浏览器视觉布局。没有覆盖外部隧道、真实账号、网络代理、付费模型或安全攻击。

## 主审便携复核

本附录前文 `/tmp` 路径是代理原始记录。最终脚本已复制到 [`reproductions/auth-round7/`](reproductions/auth-round7/)，转换为仓库相对导入，并在 `84740d56` 与 `a66f4ef2` 分别通过 guarded runner。原生 Node 下载子进程额外经 `run-isolated-node-smoke.mjs` 隔离入口执行。最终计数与上文一致；新快照日志另存 `validation/latest-a66f4ef2/`。

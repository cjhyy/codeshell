# CodeShell 服务端部署、Web Client 与账号体系演进 Roadmap

> 状态：**调研结论 + 方向锚点 / 设计稿，非实现承诺**  
> 日期：**2026-07-12**  
> 适用范围：当前 bun monorepo（`packages/core`、`packages/tui`、`packages/desktop`、`packages/cdp`）  
> 证据规则：文中“现状”均附源码或既有文档锚点；无法由当前仓库证明的判断显式标为“推测”；“建议/设计”均表示目标态，不描述为已实现。

## 0. 结论先行

**推荐走方案 A：新增独立 `packages/server` 作为 authenticated application gateway，并把 mobile React UI 提取为 `packages/web`；`core` 继续只负责引擎、协议与会话，不内置 HTTP、账号或租户。** 服务端先以“一个本地管理员账号 + 一个受控 workspace + 一个用户 worker”闭环，再演进到 invite-only 多用户和按用户进程隔离。

推荐理由：

1. `core` 已经提供 transport-agnostic JSON-RPC、`ChatSessionManager`、`StreamEvent` session envelope、审批路由和 durable session，正好是 server 内部执行协议，不需要再造 run loop（`packages/core/src/protocol/transport.ts:17`、`packages/core/src/protocol/types.ts:380`、`packages/core/src/protocol/chat-session-manager.ts:45`）。
2. desktop 已有可工作的 HTTP + WS host、独立浏览器 bundle、配对、上传、隧道和 reconnect/snapshot 经验，但业务 dispatch 深耦合 `Electron main`、`AgentBridge`、`BrowserWindow` 与 desktop session service；应抽取能力，不应整体搬运 `main/index.ts`（`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:62`、`packages/desktop/src/main/index.ts:827`、`packages/desktop/src/main/index.ts:1715`）。
3. 多用户的最大缺口不在 UI，而在 identity-aware authorization 和 storage/runtime isolation。当前“user scope”代表 OS home，不是产品账号；session、settings、credentials、memory 默认都没有 `userId` 维度（`packages/core/src/session/session-manager.ts:155`、`packages/core/src/settings/manager.ts:183`、`packages/core/src/credentials/store.ts:30`、`packages/core/src/session/memory.ts:149`）。
4. 已有 `agent-server-tcp` 证明 headless bootstrap 可行，但其源码明确“无认证、仅 localhost/SSH tunnel”，而且启动时使用单一 `cwd` 与 `SettingsManager(cwd, "full")`；它是装配参考，不是可直接暴露的生产 server（`packages/core/src/cli/agent-server-tcp.ts:1`、`packages/core/src/cli/agent-server-tcp.ts:16`、`packages/core/src/cli/agent-server-tcp.ts:40`）。

Phase 1 的最小闭环是：**headless 启动 `codeshell-server` → 首次 bootstrap 一个 admin → 浏览器登录 → 选择一个服务端登记过的 workspace → 新建/恢复一个 session → 收到流式输出 → 审批或停止 run → 重启后仍能恢复。**

---

## 1. 一句话目标与边界

### 1.1 一句话目标

把当前“Electron 桌面单用户应用”演进为：**可常驻运行的 headless server，用户用浏览器直接打开 Web Client，通过最小账号体系安全访问自己有权限的 workspace 与 session。**

这与仓库的 `Core First`、`Secure by Default` 原则一致：`core` 保持 UI-agnostic，所有危险工具继续经过 permission gate（`CODESHELL.md:5`、`CODESHELL.md:43`）。

### 1.2 本 roadmap 做什么

- 盘点协议、remote host、mobile UI、session/storage、credentials/settings/memory、permission 的复用边界。
- 给出 server/web/account 的候选架构和推荐分层。
- 定义一个可落地的单账号 MVP，以及向多用户演进时必须补齐的隔离面。
- 给出 Phase 0/1/2/3 的交付物、依赖、复用项、新建项和风险。

### 1.3 明确不做什么（YAGNI）

MVP 不做：

- 不做 SaaS billing、组织/团队层级、SCIM、复杂 RBAC、公开注册、邮件验证、找回密码和社交登录。
- 不做高可用集群、跨节点 session 调度、分布式锁、对象存储、数据库读写分离。
- 不把完整 Electron desktop 搬到浏览器；Web MVP 只覆盖 session list/create/resume、聊天流、审批、停止和基础 workspace 选择。
- 不在 Phase 1 搬 external-agent rooms、桌面 `webview` browser panel、PTY、完整文件树/diff review。mobile 原设计也把完整 IDE/file editor 排除在 v1 之外（`docs/superpowers/specs/2026-06-06-mobile-remote-control-design.md:365`）。
- 不默认开放公网、不默认启动 tunnel、不把无鉴权 TCP 端口包装成“账号体系”。现有 TCP transport 自己已写明只能用于 localhost/SSH tunnel（`packages/core/src/protocol/tcp-transport.ts:14`）。
- 不为了 server MVP 先拆完 `engine.ts`、先迁出 Arena 或重写整个 protocol；这些不是最短闭环的硬前置，见第 7 节。

---

## 2. 调研基线与现状盘点

### 2.1 与既有文档的关系：只做增量

- mobile remote 两份设计已经确定“Web/PWA + HTTP/WS + trusted device + 复用 core permission”的桌面遥控方向，并明确 remote host 只是 transport/UI，不实现第二套 runtime（`docs/superpowers/specs/2026-06-06-mobile-remote-control-design.md:110`、`docs/superpowers/specs/2026-06-06-mobile-remote-control-design.md:455`）。本稿不重做手机遥控设计，只回答如何脱离 Electron、增加账号与多用户隔离。
- tunnel 设计已经解释 quick tunnel、loopback、passcode、WSS 和不自动重启的选择（`docs/superpowers/specs/2026-06-09-mobile-remote-tunnel-design.md:27`、`docs/superpowers/specs/2026-06-09-mobile-remote-tunnel-design.md:97`）。本稿把 tunnel 视为可选接入方式，不把它当账号系统。
- IM gateway 文档已经把 gateway 定位为“通道 + 生命周期编排”，并把 tunnel/host 是否从 main 抽出列为未决（`docs/todo/im-gateway-remote-orchestration.md:18`、`docs/todo/im-gateway-remote-orchestration.md:43`）。本稿给出的 `packages/server` 可成为未来 gateway/assistant 的受控服务端，但不纳入 Phase 1。
- 协议与 desktop/mobile 架构文档已说明 stdio/TCP/IPC 和 mobile 链路（`docs/architecture/04-protocol-and-sessions.md:23`、`docs/architecture/10-desktop-and-mobile.md:48`）。本稿重点增加 tenant/account/authorization/storage 视角。
- connector 方案里的 `Connection` 是第三方 provider 账号实例，不是 CodeShell 终端用户账号；该文档也明确 credentials 只是 secret material、还不是 identity-aware connection（`docs/nightly-2026-07-10/connector-capability-plan.md:125`、`docs/nightly-2026-07-10/connector-capability-plan.md:260`）。两套“账号”不可混用，但 server 用户隔离必须包住未来 connector connection/grant。

### 2.2 Protocol / Server 的真实传输与生命周期

`Transport` 只有 `send/onMessage/close` 三个方法，协议本身没有绑定某种网络（`packages/core/src/protocol/transport.ts:17`）。当前实现是：

- `createInProcessTransport()`：同进程 `EventEmitter` 直连（`packages/core/src/protocol/transport.ts:28`）。
- `StdioTransport`：跨进程 NDJSON over stdin/stdout（`packages/core/src/protocol/transport.ts:70`）。desktop worker 正是 stdio host；启动处给 `AgentServer` 注入 `ChatSessionManager`（`packages/core/src/cli/agent-server-stdio.ts:308`、`packages/core/src/cli/agent-server-stdio.ts:328`）。
- `SocketTransport/listenTcp`：NDJSON over raw TCP；默认 `127.0.0.1`，无 TLS、无 auth（`packages/core/src/protocol/tcp-transport.ts:24`、`packages/core/src/protocol/tcp-transport.ts:64`）。
- **当前没有 core 原生 WebSocket transport。** `protocol/index.ts` 只导出 in-process 与 stdio，TCP 从 core public index 另行导出；浏览器 WS 是 desktop 的 custom mobile protocol（`packages/core/src/protocol/index.ts:1`、`packages/core/src/index.ts:121`、`packages/desktop/src/main/mobile-remote/types.ts:78`）。

`AgentServer` 支持 manager-backed multi-session 和 legacy single-engine 两条路径（`packages/core/src/protocol/server.ts:112`、`packages/core/src/protocol/server.ts:678`）。manager path 的会话生命周期为：

1. client 必须提供 `sessionId`；可带 `cwd`、`permissionMode`、`projectTrusted`、`model`、`goal` 等（`packages/core/src/protocol/types.ts:115`）。
2. `ChatSessionManager.getOrCreate()` 按 `sessionId` 查找或创建一台 per-session `Engine`；默认 live cap 16、idle TTL 30 分钟（`packages/core/src/protocol/chat-session-manager.ts:56`、`packages/core/src/protocol/chat-session-manager.ts:63`）。
3. 每个 `ChatSession` 有 FIFO turn queue、active `AbortController` 和 pending approvals（`packages/core/src/protocol/chat-session.ts:49`、`packages/core/src/protocol/chat-session.ts:64`、`packages/core/src/protocol/chat-session.ts:104`）。
4. `Engine.run()` 的每个 `StreamEvent` 被包装为 `{ sessionId, event }`，用 `agent/streamEvent` 通知客户端；run 结束再回 `RunResult`（`packages/core/src/protocol/types.ts:387`、`packages/core/src/protocol/server.ts:777`）。
5. `cancel/close` 按 session 操作；close 会取消 run、清 session/path/credential approval cache 并从 live map 删除，持久化 session 仍在磁盘（`packages/core/src/protocol/chat-session-manager.ts:132`、`packages/core/src/protocol/chat-session-manager.ts:145`）。idle sweep 只回收 live engine，不删 durable session（`packages/core/src/protocol/chat-session-manager.ts:219`）。
6. 审批归属已有 `(connectionId, sessionId, generation)` 路由和失联 fail-closed 机制（`packages/core/src/tool-system/permission.ts:22`、`packages/core/src/tool-system/permission.ts:61`、`packages/core/src/protocol/server.ts:153`）。这是多浏览器连接时可复用的底层原语，但它不是 user authorization。

一个关键限制是：`ChatSessionManager` 的 key 只有裸 `sessionId`，`AgentServer` 请求也没有 `Principal/userId`；client 还能自行传 `cwd`（`packages/core/src/protocol/chat-session-manager.ts:45`、`packages/core/src/protocol/types.ts:115`）。因此 core protocol 是**执行协议**，不是可直接面向不可信互联网客户端的 application API。

### 2.3 可复用能力矩阵

| 能力 | 现在在哪（证据） | 当前耦合/假设 | 复用策略 |
|---|---|---|---|
| JSON-RPC 执行协议、`AgentServer`、`StreamEvent` | `packages/core/src/protocol/types.ts:23`；`packages/core/src/protocol/server.ts:160`；`packages/core/src/protocol/types.ts:380` | transport-agnostic；无 identity/tenant；client-minted `sessionId/cwd` | **原样复用为 server 内部协议**；外层新增 authenticated/authorized gateway，不让浏览器裸连全部 RPC |
| live multi-session 生命周期 | `packages/core/src/protocol/chat-session-manager.ts:45`；`packages/core/src/protocol/chat-session.ts:49` | 单进程 map 仅按 `sessionId`；shared runtime；默认 16 session | Phase 1 单用户原样复用；Phase 2 以 per-user worker 隔离，或先把 key/context tenant-aware |
| stdio/headless bootstrap | `packages/core/src/cli/agent-server-stdio.ts:203`；`packages/core/src/cli/agent-server-tcp.ts:1` | stdio 适合受控 worker；TCP host 无 auth 且单一启动 scope | **复用 stdio worker/supervision 模式**；TCP 文件只作装配参考，不作为公网入口 |
| Remote HTTP + WS host | `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:79`；HTTP/WS routes 在 `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:136`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:177` | 模块本身是 Node HTTP/`ws`；但协议是 mobile custom events，auth 绑定 trusted device；static root 默认 desktop bundle | **需解耦后复用** server lifecycle、payload cap、socket bookkeeping、static/upload routing；替换 auth 与 dispatcher |
| pairing token + trusted device | `packages/desktop/src/main/mobile-remote/pairing.ts:4`；`packages/desktop/src/main/mobile-remote/trusted-device-store.ts:21` | token 仅内存、一次性 10 分钟；设备表属于整个 desktop host；`secretHash` 实际是 bearer shared secret | desktop legacy 保留；server 主登录**不复用为账号**；Phase 3 可改为 `userId` 归属的 remembered device |
| passcode gate | `packages/desktop/src/main/mobile-remote/access-passcode.ts:42`；`packages/desktop/src/main/mobile-remote/access-passcode.ts:125` | 单共享口令；rate limit 是单进程内存计数；cookie 不是用户 session | 只复用 scrypt/HMAC、cookie hardening 经验；server 账号登录须新建 user/session model |
| cloudflared quick tunnel | `packages/desktop/src/main/mobile-remote/tunnel-manager.ts:67`；`packages/desktop/src/main/mobile-remote/tunnel-manager.ts:118`；binary 校验在 `packages/desktop/src/main/mobile-remote/cloudflared-binary.ts:19` | Node 子进程，基本不依赖 Electron；临时域名，不自动重启；当前编排在 Electron IPC | **可原样抽出大部分进程管理**；Phase 3 可选，Phase 1 不依赖 |
| durable session | `packages/core/src/session/session-manager.ts:155`；`packages/core/src/session/session-manager.ts:203`；`packages/core/src/session/session-manager.ts:254`；`packages/core/src/session/transcript.ts:26` | 默认单一 `${CODE_SHELL_HOME}/sessions`；`state.json + transcript.jsonl`；无 owner 字段 | 格式与 manager 复用；server 必须给每个 user 明确 storage root，并新建 ownership index/ACL |
| `cwd/workspace` | `packages/core/src/types.ts:213`；`packages/core/src/session/session-manager.ts:284`；resume 解析在 `packages/core/src/session/session-manager.ts:442` | `cwd`/workspace root 是主机绝对路径；协议可直接提交 `cwd`；worktree 指针存在 disk | 内部继续用绝对路径；browser 只提交 opaque `workspaceId`，server 解析 canonical path 并鉴权 |
| mobile React web UI | 入口 `packages/desktop/src/mobile/main.tsx:1`；独立 Vite root `packages/desktop/vite.mobile.config.ts:6`；UI `packages/desktop/src/mobile/App.tsx:19` | 已是纯 browser bundle、不依赖 preload；但 alias 指向 desktop renderer，协议/登录是 device pairing，功能含 rooms | **高复用**：提取 chat/reducer/components 到 `packages/web`；替换 socket/auth/data layer；Phase 1 暂不搬 rooms |
| stream reducer/reconnect/snapshot | `packages/desktop/src/mobile/hooks/useRemoteApp.ts:13`；`packages/desktop/src/mobile/hooks/useRemoteSocket.ts:124`；snapshot 处理 `packages/desktop/src/mobile/hooks/useRemoteApp.ts:514` | reducer 复用 desktop shapes；WS endpoint 固定 same-origin `/ws`；同时吃 typed mobile events 与 raw worker lines | reducer、backoff、resync、ack/dedup 可复用；统一为 versioned server web protocol |
| mobile attachments/upload | `packages/desktop/src/main/mobile-remote/mobile-upload-service.ts:67`；`packages/desktop/src/main/mobile-remote/mobile-attachments.ts:63`；`packages/desktop/src/main/mobile-remote/mobile-chat-turn.ts:46` | ticket 绑定 `deviceId`，staging 依赖 desktop attachment service/workspace resolver | Phase 1 可不做；Phase 2 将 owner 改为 authenticated `userId/sessionId` 后抽取 |
| rooms/external CLI session | `packages/desktop/src/main/mobile-remote/room-manager.ts:220`；agent factory 在 `packages/desktop/src/main/index.ts:546` | room disk root 在 Electron `userData`；spawn Claude/Codex；与 core session 是另一条模型 | **不进入 Phase 1**；后续作为 server capability module，先补 user/workspace ownership |
| settings scope | `packages/core/src/settings/manager.ts:182`；load paths 在 `packages/core/src/settings/manager.ts:227` | `full/project/isolated` 控制 OS home 与 repo 文件；“user”= `HOME`，不是 account | merge/trust 逻辑复用；storage path/context 必须按账号注入，不能在并发请求中改全局 `HOME` |
| credential scope | `packages/core/src/credentials/store.ts:19`；paths 在 `packages/core/src/credentials/store.ts:52`；host isolation 在 `packages/core/src/credentials/store.ts:155` | user credential 在 OS home；project credential 在 repo；默认 cipher 可是 plaintext；无 `userId` | credential contract/cipher/access gate 复用；server 新建 user-owned secret resolver，禁止共享 repo 静默领用 secret |
| memory scope | `packages/core/src/session/memory.ts:149`；paths 在 `packages/core/src/session/memory.ts:158`、`packages/core/src/session/memory.ts:194`；session memory `packages/core/src/services/session-memory.ts:22` | `MemoryManager` 可显式 `baseDir`，但 session-memory 仍硬读 OS home；global 是 host-global | 按用户传 `baseDir` 可复用大部；补 session-memory path injection，禁止跨账号 global memory |
| permission、path policy、approval | `packages/core/src/tool-system/permission.ts:1381`；`packages/core/src/tool-system/path-policy.ts:560`；headless fallback `packages/core/src/engine/permission-controller.ts:97` | permission 以 session/cwd 为界；无 account ACL；无 UI 时默认 deny-all（除 bypass） | **原样保留为工具执行最后一道门**；其前新增 workspace/session authorization；server 默认不开放 `bypassPermissions` |

### 2.4 desktop remote 的真实抽取边界

可直接或小改抽取的部分：

- `RemoteHostManager` 的 HTTP/WS 生命周期、`maxPayload`、upgrade 前鉴权、只向已认证 socket 发消息和 stop 时强制断开（`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:136`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:177`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:319`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:369`）。
- static SPA 安全路径解析、cache policy 与 dev proxy（`packages/desktop/src/main/mobile-remote/mobile-static.ts:63`、`packages/desktop/src/main/mobile-remote/mobile-static.ts:95`）。
- upload ticket 的 size/TTL/device quota/claim/finalize 生命周期，改 owner key 后可复用（`packages/desktop/src/main/mobile-remote/mobile-upload-service.ts:94`、`packages/desktop/src/main/mobile-remote/mobile-upload-service.ts:279`）。
- `TunnelManager`、`CloudflaredBinary`、pairing token primitives（`packages/desktop/src/main/mobile-remote/tunnel-manager.ts:100`、`packages/desktop/src/main/mobile-remote/cloudflared-binary.ts:128`、`packages/desktop/src/main/mobile-remote/pairing.ts:9`）。

不能直接抽出的部分：

- authenticated mobile event 最终进入 `handleMobileClientEvent()`，它依赖 process-global `bridge`、desktop run context、desktop session listing/history、workspace UI service和 `BrowserWindow` 广播（`packages/desktop/src/main/index.ts:827`、`packages/desktop/src/main/index.ts:866`、`packages/desktop/src/main/index.ts:919`、`packages/desktop/src/main/index.ts:1016`）。
- worker 输出由 `AgentBridge.subscribeOutbound()` 镜像到 mobile，snapshot ownership 也在 desktop main（`packages/desktop/src/main/index.ts:1715`）。server 需要自己的 `WorkerSupervisor + EventHub`，不能依赖 Electron `AgentBridge`。
- `RoomManager` 本身可注入 agent factory，但当前 rootDir、project list、approval bridge、transcript subscription 和 renderer broadcast 都由 Electron main 组装（`packages/desktop/src/main/mobile-remote/room-manager.ts:194`、`packages/desktop/src/main/index.ts:523`）。

因此“抽出 remote-host 到 server”不是简单移动目录。建议拆成三层：

1. `WebHost`：HTTP/WS/static/upload，只依赖 Node/Bun web primitives。
2. `AuthenticatedConnection`：把 HTTP/WS 连接变成 server `Principal`，执行 origin/rate/session validation。
3. `CodeShellGateway`：workspace/session authorization、worker routing、event fanout、approval lease。

---

## 3. 差距分析：desktop 单用户到 server 多用户 Web

### 3.1 引擎/协议的单进程、单用户、单 cwd 假设

已具备的多 session 能力不等于多 tenant：

- live session map 只按 `sessionId`，协议的 `RunParams.sessionId` 还是 client-minted（`packages/core/src/protocol/chat-session-manager.ts:46`、`packages/core/src/protocol/types.ts:115`）。两个用户选择同一 id 会碰撞；更严重的是，未授权用户若知道 id，protocol 本身没有 owner check。
- `RunParams.cwd` 是客户端可提供的主机路径（`packages/core/src/protocol/types.ts:123`）。在桌面 renderer/main 信任边界内可行；公网 browser 绝不能把任意路径直接传给 core。
- `EngineRuntime` 明确共享 `modelPool/toolRegistry/settings/mcpPool/costTracker`（`packages/core/src/engine/runtime.ts:16`、`packages/core/src/engine/runtime.ts:24`）。同一用户的多 session 已有 MCP visibility gate，但多用户账号、provider 配置、成本和 secret 仍不能共享一个 runtime 后假设安全。
- `state.ts` 仍有 process-global session/cwd/model/cost mutable state（`packages/core/src/state.ts:17`、`packages/core/src/state.ts:68`、`packages/core/src/state.ts:81`）；架构债也把它列为“多 session 并发 worker 隐患”（`docs/todo/architecture-debt.md:63`）。
- 当前 TCP headless host 在启动时只构造一个 `SettingsManager(cwd, "full")` 与 shared runtime，配置到重启才刷新（`packages/core/src/cli/agent-server-tcp.ts:40`、`packages/core/src/cli/agent-server-tcp.ts:44`）。它证明常驻可行，但不提供 tenant boundary。

**设计结论**：Phase 1 单账号允许一个 user worker；Phase 2 推荐一账号一 worker 进程（可 idle 回收），让 `HOME/CODE_SHELL_HOME`、runtime singleton、MCP children 和 background processes 都落在账号级故障/权限域。只有在明确需要大量轻量租户、且完成显式 `UserStorageContext` 与 singleton 治理后，才考虑同进程多用户 runtime。

### 3.2 session 存储与 ownership 缺口

当前 durable session 的事实：

- canonical root 是 `${CODE_SHELL_HOME:-~/.code-shell}/sessions`（`packages/core/src/session/session-manager.ts:154`）。
- `SessionState` 包含 `sessionId/cwd/workspace/model/provider/...`，没有 `ownerUserId/workspaceId`（`packages/core/src/types.ts:243`）。
- `create()` 写 `state.json`，`Transcript` 写 append-only `transcript.jsonl`；磁盘是恢复依据（`packages/core/src/session/session-manager.ts:254`、`packages/core/src/session/session-manager.ts:307`、`packages/core/src/session/transcript.ts:47`）。
- manager-backed `query("sessions")` 只列 live sessions；disk session list/detail 是另一条读取面（`packages/core/src/protocol/server.ts:1602`、`packages/core/src/protocol/server.ts:1663`）。mobile 目前借 desktop `sessions-service` 读取历史（`packages/desktop/src/main/mobile-remote/mobile-history.ts:1`）。

缺口：

1. server 需要 control-plane metadata，把 public `sessionId` 映射为 `(ownerUserId, workspaceId, workerId, coreSessionId)`；core 的 state 文件无需在 Phase 1 强行加 user 字段，但任何 disk lookup 前必须先查 ownership。
2. storage root 至少按 user 分开，建议 `<dataRoot>/users/<userId>/home/.code-shell/sessions` 或等价显式目录；不能让所有用户共享一个 `~/.code-shell/sessions`。
3. web API 只能使用 server 生成的 opaque id，禁止 browser 自由指定 core session id 或直接探测 state path。
4. session 删除、fork、history、goal、background work 等每个操作都要经过同一 authorization helper，不能只保护 `agent/run`。

### 3.3 workspace/cwd 隔离缺口

当前 session workspace 是 `{ root, kind, worktree? }`，root 是主机路径（`packages/core/src/types.ts:213`）；resume 还会验证 worktree 是否存在、必要时回退 main（`packages/core/src/session/session-manager.ts:442`）。这些恢复语义可复用，但 server 需要增加：

- `WorkspaceRegistry`：`workspaceId → canonical root/owner/status/allowedRoot`。
- 所有注册路径先 `realpath`，禁止 symlink escape；普通用户不能登记任意宿主目录。
- web run 请求只传 `workspaceId`；gateway 从 registry 解析 `cwd` 后注入 core。
- Phase 1 workspace 由 admin 在 server 本机 CLI/config 创建；浏览器不提供任意 path picker。
- 多用户下默认“一 workspace 一 owner”。共享 workspace、同一 worktree 并发写、git identity 和 project settings 冲突留到用户明确需要时再设计。

### 3.4 settings、credentials、memory 的多租户隔离

#### Settings

`SettingsScope` 的 `full/project/isolated` 是 disk layer 选择：`full` 才读 `~/.code-shell`，`project` 只读 `${cwd}/.code-shell`，`isolated` 不读 disk（`packages/core/src/settings/manager.ts:182`、`packages/core/src/settings/manager.ts:227`）。这里没有 account user。

目标态：

- account-global settings 放 user data root；workspace/project settings 可继续来自 repo，但仍经过 `projectTrusted` 对危险字段剥离（`packages/core/src/settings/manager.ts:158`、`packages/core/src/settings/manager.ts:274`）。
- server-owned auth、workspace ACL、allowed roots、cookie keys 绝不写项目 `.code-shell`。
- 不允许通过 generic protocol `config_set` 改 permission/env/hooks/MCP trust roots；现有 protected root 机制可复用（`packages/core/src/settings/manager.ts:33`、`packages/core/src/protocol/server.ts:1895`）。

#### Credentials

`CredentialStore` 当前把 user secret 写到 OS home、project secret 写到 repo `.code-shell/credentials.json`，`full` 合并两层（`packages/core/src/credentials/store.ts:30`、`packages/core/src/credentials/store.ts:52`、`packages/core/src/credentials/store.ts:155`）。这在一台个人电脑上成立，在 shared server 上不成立：同一 repo 的 project credential 会被多账号共同看到。

目标态：

- provider secret 必须是 user-owned；所谓 workspace scope 应实现为 server user store 中的 `(userId, workspaceId)` binding，不是把 secret 写进 repo。
- 保留 `CredentialAccess`/cipher/redaction/use gate，但提供 server-owned resolver；worker 不应从宿主共享 home 猜 credential。
- connector 文档提出的 requirement/grant 分离同样适用：repo 可以声明“需要 GitHub”，不能自行挑选某用户账号（`docs/nightly-2026-07-10/connector-capability-plan.md:320`、`docs/nightly-2026-07-10/connector-capability-plan.md:440`）。

#### Memory

`MemoryManager` 已允许显式 `baseDir`，并把 project memory 放在 baseDir 下的 hashed project path（`packages/core/src/session/memory.ts:149`、`packages/core/src/session/memory.ts:191`）；这很适合按用户注入。缺口是 `session-memory` 仍固定写 `userHome()/.code-shell/session-memories`（`packages/core/src/services/session-memory.ts:22`）。

目标态：所有 global/project/session memory 都先落入 user root；“global”只表示“该账号跨项目”，绝不表示“该 server 所有用户共享”。

### 3.5 账号与授权缺口

仓库 grep 没有 `User/Account/AuthSession/userId/accountId/passwordHash/signIn/signUp` 产品模型；当前远程 auth 事件只有 `auth.device` 和 `pair.complete`（`packages/desktop/src/main/mobile-remote/types.ts:78`）。现有机制是：

- shared passcode：scrypt hash + HMAC remember cookie + 进程内错误次数（`packages/desktop/src/main/mobile-remote/access-passcode.ts:42`、`packages/desktop/src/main/mobile-remote/access-passcode.ts:54`）。
- pairing：内存一次性 token，默认 10 分钟（`packages/desktop/src/main/mobile-remote/pairing.ts:9`）。
- trusted device：host-global JSON store，保存并比较 bearer `secretHash`，支持 revoke（`packages/desktop/src/main/mobile-remote/trusted-device-store.ts:21`、`packages/desktop/src/main/mobile-remote/trusted-device-store.ts:56`）。mobile 代码明确该字段名虽叫 hash，实际是原样 shared secret（`packages/desktop/src/mobile/lib/deviceCredential.ts:1`）。

这些能回答“这台浏览器是否曾被桌面主人配对”，不能回答：哪个用户、用户是否禁用、属于哪些 workspace、登录 session 是否过期/撤销、谁执行了哪个动作。因此正式账号体系必须新建。

### 3.6 Electron 解耦成本

成本分三档：

- **低**：tunnel process、cloudflared binary、pairing primitive、static path security、upload ticket、WS lifecycle；都是 Node 模块或依赖注入（见 2.4）。
- **中**：mobile UI、stream reducer、reconnect/snapshot/ack。UI 是纯 browser，但 Vite alias 仍指向 desktop renderer components/protocol（`packages/desktop/vite.mobile.config.ts:43`）；需要建立稳定 `packages/web` dependency boundary。
- **高**：mobile business dispatcher 和 rooms。`handleMobileClientEvent` 直接注入 `AgentBridge`；project list/history/workspace/permission mode/renderer broadcast 都在 Electron main（`packages/desktop/src/main/index.ts:827`、`packages/desktop/src/main/index.ts:919`、`packages/desktop/src/main/index.ts:1016`）。必须按 service ports 重写组装，而不是 copy/paste。

### 3.7 公网攻击面与默认安全原则

从 loopback/desktop 变为公网服务后，新增攻击面包括：login brute-force、session fixation、CSRF、恶意 Origin 的 WS、session/workspace IDOR、任意 cwd、上传 DoS、stream fanout 泄漏、approval 劫持、shell/child process 资源耗尽、secret/log 泄漏、反向代理 header 误信。

必须采用的默认值（设计要求）：

1. 默认只 bind `127.0.0.1`；公网监听必须显式配置 trusted proxy/TLS/origin。现有 remote/tcp 的 loopback 安全倾向可沿用（`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:250`、`packages/core/src/protocol/tcp-transport.ts:64`）。
2. HTTP 用 `HttpOnly + Secure + SameSite` opaque session cookie；server 只存 token hash，支持单 session revoke/全用户 revoke。MVP 不用长期 JWT，避免撤销和 key rotation 复杂度。
3. login rate limit 至少按 IP + normalized username；失败响应不泄漏账号是否存在。现有 passcode 的进程内全局计数只能作算法参考，不能直接承担多用户公网限流（`packages/desktop/src/main/mobile-remote/access-passcode.ts:54`）。
4. WS upgrade 必须校验 cookie、Origin 和 session；每条 message 再做 authorization。不能只在连接时“auth.ok”后信任所有 client-supplied ids。
5. gateway 只暴露 allowlisted application commands；不把 `provider_add/config_set/bypassPermissions` 等完整 core query surface 直接给浏览器。
6. `workspaceId` server-side resolve；所有 session/history/approval/upload 操作先校验 owner/member。
7. 保留 core permission/path policy 作为第二道门；authorization 通过不等于 tool 自动允许。无交互 UI 时现有 backend 会 deny-all（`packages/core/src/engine/permission-controller.ts:97`）。
8. 限制 WS payload、上传大小、每用户并发 session/run/background process、stream buffer 和日志长度；mobile host 已有 1 MiB WS payload 与 upload quotas 可参考（`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:180`、`packages/desktop/src/main/mobile-remote/mobile-upload-service.ts:10`）。
9. 事件 fanout 必须按 user + authorized session subscription；当前 mobile `broadcastRaw` 面向所有 authenticated devices 的做法不能直接用于多用户（`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:346`）。
10. 账号 audit 至少记录 `userId/sessionId/workspaceId/action/decision/risk/timestamp/requestId`，但 prompt、tool args 和 secret 必须脱敏/截断。

---

## 4. 候选架构

### 4.1 方案 A（推荐）：独立 `packages/server` + `packages/web`，core 作内部执行协议

```text
Browser
  ├─ HTTPS: login/workspaces/sessions/static
  └─ WSS: versioned web events
          │
          ▼
packages/server
  AuthN ── Principal ── AuthZ/WorkspaceRegistry ── SessionOwnership
                              │
                         EventHub / ApprovalLease
                              │ controlled stdio
                              ▼
                    per-user core worker
                    AgentServer + ChatSessionManager
                              │
              user data root + authorized workspace path
```

建议职责：

- `packages/server`：HTTP/WS lifecycle、auth、workspace registry、session ownership、worker supervision、event hub、audit、health/readiness、static web serving。
- `packages/web`：从 mobile React UI 提取的 browser client；只依赖 versioned web contract 和共享纯 UI/reducer，不依赖 Electron preload/main。
- `packages/core`：保持现在的 engine/protocol/session/permission；stdio 继续是 server 到 worker 的受控 transport。
- desktop：短期继续用现有链路；后续可选择消费抽出的 `WebHost/TunnelManager`，但不是 Phase 1 前置。

Trade-off：

| 优点 | 代价 |
|---|---|
| 不污染 core 的 UI-agnostic 边界；账号和网络依赖不会进入 SDK | 新增两个 package 与一层 web contract |
| 可把 browser 视为不可信 client，在 core 前集中 authorization | 要实现 worker supervisor/event hub，而不能直接 copy `AgentBridge` |
| stdio worker 可形成 per-user isolation，兼容现有 singleton | 每活跃用户一个进程，资源比同进程 runtime 高 |
| desktop/web 可逐步共享 host/UI primitives | 初期会有 legacy mobile protocol 与 server web protocol 两条入口 |

### 4.2 方案 B：在 `core` 内直接增加 HTTP/WS/auth server

做法：给 core 增 `WebSocketTransport`、HTTP router、UserStore，并让 browser 直接创建 `AgentClient`。

优点：组件少，protocol 到 WS 映射直接；typed `AgentClient` 可更多复用。

问题：

- 账号、cookie、database、static assets、reverse proxy、rate limit 会进入 UI-agnostic core，违背当前 package boundary（`CODESHELL.md:11`、`packages/core/package.json:2`）。
- core RPC 含配置/provider/permission 等高权限方法；直接映射将迫使每个 handler tenant-aware，改动面和漏授权风险大（method surface 见 `packages/core/src/protocol/types.ts:426`）。
- 同进程多用户立即撞上 shared runtime、OS home 和 `state.ts` singleton。

结论：**不推荐**。可以在 `packages/server` 内实现一个 `Transport` adapter，但不要让 core 负责互联网 application server。

### 4.3 方案 C：先建云中继/SaaS control plane

做法：本地主机/agent 连云 relay，浏览器登录云账号后由 relay 转发；或 engine 直接跑云端。

优点：真正“打开网址即用”、统一域名/TLS/账号/在线状态，适合跨网和商业 SaaS。

代价：需要 relay trust model、端到端或 hop-by-hop encryption、离线/重连、region/data residency、billing、abuse prevention、运营与合规；如果 engine 在云端，还要解决 workspace 文件如何安全进入云端。既有 IM gateway 文档也把“是否上云中继”列为未决（`docs/todo/im-gateway-remote-orchestration.md:113`）。

结论：**Phase 3 再拍板**。Phase 1 的 `packages/server` 应提供稳定 gateway contract，使未来能挂 relay，但不为未知 SaaS 需求预建分布式系统。

### 4.4 推荐决策

采用 A，并坚持两个边界：

1. **Web contract ≠ core RPC 全量透传。** Web contract 是账号感知、资源化、allowlisted 的 application API；core RPC 是 server 内部执行协议。
2. **AuthZ 在 gateway，permission 在 core。** 前者决定“这个用户能否操作这个 workspace/session”；后者决定“这次 tool call 是否允许”。两层不可互相替代。

---

## 5. 账号体系设计草案

### 5.1 MVP 定位

推荐 MVP：**self-host、first-run bootstrap 的单 admin、无公开注册、无邮件、无密码找回、无组织。**

这样 Phase 1 仍然有真实账号/登录/session revoke，而不是共享 passcode；同时避免在 server 闭环前引入邮件与 IdP。Phase 2 再加 admin invite 的多用户。

### 5.2 最小数据模型（设计）

建议使用一个事务型本地 metadata store；self-host 首选 SQLite，但这是实现建议，不要求把 session transcript 迁进数据库。core session 仍保持 disk-authoritative。

| 实体 | Phase 1 最小字段 | 作用 |
|---|---|---|
| `User` | `id`, `username`, `passwordHash`, `role=admin`, `status`, `createdAt` | CodeShell 登录主体；username 本部署内唯一 |
| `AuthSession` | `id`, `userId`, `tokenHash`, `createdAt`, `expiresAt`, `lastSeenAt`, `revokedAt` | opaque browser session；raw token 只在 cookie |
| `Workspace` | `id`, `ownerUserId`, `displayName`, `canonicalRoot`, `status`, `createdAt` | server 授权路径；browser 不见/不提交宿主任意路径 |
| `AgentSession` | `id`, `ownerUserId`, `workspaceId?`, `coreSessionId`, `createdAt`, `updatedAt`, `deletedAt?` | ownership/ACL index；指向 disk-authoritative core session |
| `AuditEvent` | `id`, `userId`, `workspaceId?`, `agentSessionId?`, `action`, `outcome`, `createdAt`, `metaRedacted` | 登录、workspace/session 操作、审批与管理变更的最小审计 |

Phase 2 再增加：

- `WorkspaceMember(workspaceId, userId, role)`，仅在确认需要共享 workspace 时启用。
- `Invite(tokenHash, createdBy, expiresAt, usedAt)`，用于 invite-only onboarding。
- remembered device 可扩展为 `UserDevice(userId, ...)`，不复用 host-global trusted-device row。

不在 MVP 建 `Organization/Team/Group/PolicyTemplate/RefreshTokenFamily` 等实体。

### 5.3 ID 与 ownership 规则

- 所有 API public id 由 server 生成，视为 opaque；browser 提交的 `userId/ownerId/canonicalRoot/coreSessionId` 一律忽略。
- `Principal` 只能从已验证的 `AuthSession` 派生。
- 每次操作先由 public `AgentSession.id` 查 owner/workspace，再把 `coreSessionId/cwd` 注入 worker。
- core `sessionId` 可在用户私有 storage root 内保持原格式；不同 user worker 即使 core id 相同也不会撞目录。
- session transcript 不复制到 control DB，避免双写两份内容真相。DB 只持 ownership/index；缺失或不一致时 fail closed 并提供管理员 repair 工具。

### 5.4 登录流

#### 首次部署

1. server 默认 bind loopback；若 metadata store 无用户，进入 `bootstrap-required`，不接受普通 WS/run。
2. 管理员在本机 CLI 执行一次 bootstrap，或使用短时一次性 bootstrap token 创建首个 admin。
3. token 使用后立即失效；server 开始正常 login。

#### 日常登录

1. `POST /api/auth/login` 接收 username/password；统一错误、rate limit、审计。
2. 验证成功后生成高熵 opaque token，只把 hash 存 `AuthSession`，raw token 放 `HttpOnly` cookie。
3. `GET /api/auth/me` 返回最小 profile；`POST /api/auth/logout` revoke 当前 session。
4. WS upgrade 从 cookie 恢复 `Principal`，校验 `Origin`；连接后不接受 client 自报 identity。
5. 用户被 disabled、auth session revoked/expired 时，现有 WS 被 server 主动关闭，pending approval fail closed。

#### 本地部署与公网部署差异

- 本地/内网：仍使用账号；可允许管理员通过 loopback-only bootstrap。不能因为是 localhost 就跳过 session authorization。
- 公网：必须 TLS；推荐由 Caddy/nginx/Traefik 等反向代理终止 TLS，server 明确配置 trusted proxy 与 allowed origins。Phase 1 不自己签发证书。
- quick tunnel：如果后续启用，账号 cookie 仍是主认证；passcode 只能作为额外入口门，不再代表 user identity。

### 5.5 password/session 的最小安全要求

- 密码使用内存硬 KDF（Argon2id 或审计过参数的 scrypt）；每用户独立 salt。现有 passcode 的 scrypt 实现可参考但不直接复制其 host-global record（`packages/desktop/src/main/mobile-remote/access-passcode.ts:201`）。
- auth cookie 设置 `HttpOnly`, `Secure`（TLS 时）, `SameSite=Lax/Strict`, bounded lifetime；敏感 POST 加 CSRF/origin check。
- auth session 可逐个撤销；修改密码/disable user 可撤销全用户 session。
- 不把 password、raw session token、pairing token 写日志。
- Phase 1 不实现“记住一年”；短 idle + bounded absolute expiry 即可，具体时长在实现 spec 决定。

### 5.6 与 passcode/pairing/trusted device 的关系

| 场景 | Phase 1 决策 | 后续 |
|---|---|---|
| legacy desktop mobile remote | 原样并存，不强制迁移 | desktop 可选择改用 server auth |
| server Web Client 主登录 | **账号取代 passcode/pairing** | 可加 WebAuthn/OIDC |
| quick tunnel 入口预门 | 不在 Phase 1 | 可让 passcode 作为 defense-in-depth，但之后仍需账号登录 |
| remembered browser/device | 普通 auth session cookie | Phase 3 可建 `UserDevice`，把配对绑定到 user 并支持逐设备 revoke |

不能把现有 `TrustedDeviceStore` 直接加一个 username 就当账号表：其 secret 是 bearer device credential、没有 password lifecycle、workspace membership、session expiry 或 admin disable 语义（`packages/desktop/src/main/mobile-remote/trusted-device-store.ts:24`、`packages/desktop/src/main/mobile-remote/trusted-device-store.ts:56`）。

### 5.7 多用户 runtime/storage 策略

推荐：

- Phase 1：一个 admin worker，server supervisor 通过 stdio 驱动现有 `AgentServer`。
- Phase 2：一用户一 worker；idle 用户可停 worker，durable session 保留。worker 环境把 `HOME` 与 `CODE_SHELL_HOME` 都指向该用户私有 root，以覆盖当前 settings/credentials/session path 解析（现有路径分别见 `packages/core/src/settings/manager.ts:29`、`packages/core/src/credentials/store.ts:14`、`packages/core/src/session/session-manager.ts:161`）。
- 同一用户多个 web tab 由 server `EventHub` multiplex 到一个 worker link；server 是 core approval router 眼中的单连接，再在 web 连接间持有 approval lease。这样不会让多个 tab 各自争抢 core session ownership。
- 中期逐步引入显式 `UserStorageContext`，减少环境变量路径耦合；但在一账号一进程下修改 env 是进程初始化，不存在并发串 user。

---

## 6. 分期 Roadmap

### Phase 0：边界定稿与可复用单元抽取

**目标**：消除最大未知，不交付公网产品。

**交付物**：

- ADR：采用方案 A、web contract 不裸透传 core RPC、Phase 2 使用 per-user worker。
- threat model：列出 login/WS/IDOR/cwd/upload/approval/process/secret 边界与 fail-closed 行为。
- `packages/server` / `packages/web` package boundary 草案和 versioned web protocol schema。
- `ServerDataPaths`、`WorkspaceRegistry`、`SessionOwnershipStore` contract；明确 metadata 与 disk session 的单一真相分工。
- 抽取/复制前的依赖图：标出 `remote-host-manager`、static/upload/tunnel/mobile UI 对 Electron 与 desktop renderer 的引用。
- headless spike：用受控 stdio worker完成 run/stream/cancel/approval 四条 contract；不开放监听端口给公网。

**依赖**：只依赖现有 core public exports；`EngineRuntime/ChatSessionManager/AgentServer/Transport` 已从 core index 导出（`packages/core/src/index.ts:74`、`packages/core/src/index.ts:121`）。

**复用**：core protocol、stdio bootstrap、mobile reducer/components、remote host lifecycle。

**新建**：web application contract、principal/authz ports、server metadata contracts、worker supervisor interface。

**主要风险**：把 desktop mobile custom protocol 当作目标协议，导致 Electron 语义永久泄漏到 server。Phase 0 必须用 contract 明确切断。

**退出条件**：server 能在测试/开发 harness 中以一个固定 Principal、一个登记 workspace 驱动一个 core session，并证明 browser payload 不能直接指定 `cwd/coreSessionId`。

### Phase 1：单账号 headless + Web 最小闭环

**目标**：达到“能 headless 起 server + 浏览器登录一个账号打开一个会话跑起来”。

**交付物**：

1. `codeshell-server` 常驻入口：config/data root、loopback 默认 bind、health/readiness、graceful shutdown、worker crash 可见。
2. single-admin bootstrap、login/logout、opaque auth session cookie、rate limit、session revoke。
3. admin CLI/config 登记一个或多个 workspace；browser 只选择 `workspaceId`。
4. `AgentSession` ownership index；list/create/resume/history 只返回当前 admin 的 session。
5. WSS event channel：run accepted、`StreamEvent`、approval request/resolved、status；支持 send/stop/approve 和断线 resync。
6. 从 mobile UI 提取最小 `packages/web`：login、session list、new/resume、message stream、approval card、stop；复用 reducer/reconnect，不带 rooms/CC pane。
7. 一个 admin worker；其 user home/session root 与宿主其他用户数据分开。
8. 部署说明：localhost 直接用；公网仅支持显式 reverse proxy + TLS + allowed origin，不承诺 quick tunnel。

**端到端验收场景**：

```text
fresh data root
→ local bootstrap admin
→ start server without Electron
→ browser login
→ select registered workspace
→ create session and send prompt
→ receive text/tool StreamEvent
→ approve or reject one gated operation
→ stop another run
→ restart server
→ login and resume the same disk session/history
```

**依赖**：Phase 0 contracts；可用模型/credential 的 server-side 配置路径；一个真实可访问 workspace。

**复用**：`AgentServer + ChatSessionManager + StdioTransport`、`StreamEvent`、session/transcript、permission/approval、mobile UI/reducer/reconnect、static host security。

**新建**：Auth store、workspace/session ownership、server gateway、worker supervisor、web login/data adapter、deployment CLI/docs。

**明确不含**：多用户、invite、共享 workspace、attachments、rooms、tunnel、SaaS relay、browser panel、PTY、公开注册。

**主要风险**：

- stdio worker 与 server event hub 的 request/notification correlation 出错；应复用 JSON-RPC id、runAccepted 和 session envelope，而不是另造无 id stream。
- history/index 与 core disk session 不一致；metadata repair/fail-closed 必须在 Phase 1 设计。
- web UI 抽取时把 desktop renderer alias 一并搬入，形成新的 private package 依赖。

### Phase 2：invite-only 多用户与租户隔离

**目标**：从“有登录的个人 server”升级为可审计的多用户 self-host。

**交付物**：

1. admin invite/create/disable user；`admin/member` 两级角色足够，不做自定义 RBAC。
2. per-user worker supervisor、private `HOME/CODE_SHELL_HOME`、worker idle recycle、per-user concurrency/quota。
3. workspace ownership/membership；默认 owner-only，明确授权后才共享。每用户拥有独立 AgentSession，即便指向同一 workspace。
4. settings/credentials/memory 隔离：account-global overlay、user+workspace credential binding、per-user global/project/session memory；消除 session-memory 的 host-global path。
5. authorization matrix 覆盖 session list/history/run/fork/delete/goal/background/approval/upload。
6. user/session/workspace/action audit；secret/prompt/tool args 采用字段级脱敏和上限。
7. attachments/upload 以 `(userId, sessionId)` 绑定，复用 mobile ticket lifecycle。
8. 多 tab subscription 与 approval lease；断线、登录撤销、用户禁用均 fail closed。

**依赖**：Phase 1 ownership gateway 已经是唯一入口；若不用 per-user process，则必须先完成 `state.ts`、runtime/MCP/credential context 的 tenant-aware 重构。

**复用**：Phase 1 server/web、`CredentialAccess`/cipher、`SettingsManager` merge/trust、`MemoryManager(baseDir)`、mobile upload quotas、approval router generation。

**新建**：invite/user admin、workspace member、per-user supervisor、quota/audit、user-owned secret binding、migration/repair tools。

**主要风险**：

- 同一宿主 workspace 的 POSIX 文件权限并不等于产品 ACL；server 进程通常仍有权读全部文件，必须靠 canonical registry + authz + sandbox defense-in-depth。
- project `.code-shell` 是 workspace shared data，用户 global settings/credentials 是 account private data；merge 顺序和写回位置若不清晰会串租户。
- per-user worker 的 MCP/CLI/background child process 数量可能过高，需要 idle teardown 和 hard quota。

### Phase 3：远程接入与产品化分叉

**目标**：在核心 auth/isolation 稳定后，根据用户拍板选择 self-host remote 或 SaaS。

**候选交付物（不是全部承诺）**：

- Self-host remote：抽出 `TunnelManager/CloudflaredBinary`，账号仍是主 auth；passcode 仅可选预门。
- remembered device：将 pairing/trusted device 演进为 user-owned device enrollment；支持逐设备 revoke、最近活动与安全通知。
- OIDC/WebAuthn：只有部署需要企业 SSO 或无密码登录时再加；local password 可继续保留为 bootstrap/recovery。
- cloud relay：若选择 SaaS，再单独设计 host enrollment、relay auth、connection routing、E2E/transport encryption、region/data retention、abuse/billing。
- desktop/server convergence：desktop 可连接本地/远端 `packages/server`，或继续 embedded mode；制定现有 `~/.code-shell` session/workspace/credential 迁移工具。
- optional capabilities：external-agent rooms、browser automation、PTY/files/review 分别以 capability + policy 加入，不默认开放。

**依赖**：Phase 2 的真实 user/device/workspace ownership 和 audit；部署形态决策。

**复用**：tunnel、device store 思路、mobile UI、IM gateway 未来 adapter、connector connection/grant 设计。

**新建**：按所选分叉建设 relay/SSO/device enrollment/迁移，不预建未选择的另一条。

**主要风险**：公网 endpoint 运营安全、relay 信任与数据驻留、桌面本地状态迁移、远程 browser/filesystem 能力扩大攻击面。

---

## 7. 对现有架构债的影响与前置依赖

| 架构债 | 当前状态证据 | 对 roadmap 的判断 |
|---|---|---|
| `core → tool-system → engine` 循环 | debt P0 已写明完成：context 改窄接口，`EngineConfig` 已抽 `engine/types.ts`（`docs/todo/architecture-debt.md:11`、`docs/todo/architecture-debt.md:15`、`docs/todo/architecture-debt.md:17`） | **不是 Phase 1 前置，且不应重复做。** server 使用现有 public protocol/runtime API |
| 拆 `engine.ts` | P1-⑦ 待排期，P0 前置已就绪（`docs/todo/architecture-debt.md:36`） | **不是 Phase 1/2 硬前置。** server 不需要改 run internals；可独立推进降低维护成本 |
| Arena 可选注册/移包 | 仍耦合 builtin/protocol/settings/public index（`docs/todo/architecture-debt.md:32`、`docs/todo/architecture-debt.md:55`） | **不是前置。** web gateway 不暴露 `arena_status` 即可；不要为 server 顺带迁 Arena |
| core public/internal index 分层 | P1-⑤ 待做（`docs/todo/architecture-debt.md:26`） | **非硬前置、但有益。** 所需 server API 当前已 public export；若后续更多 host-only API 暴露，先做 internal entrypoint，避免扩大 SDK |
| `state.ts` process singleton | P2-⑩ 记录为多 session 隐患（`docs/todo/architecture-debt.md:63`） | **Phase 1 单用户可接受；Phase 2 必须二选一：per-user process containment（推荐）或先治理 singleton。** 不允许同进程多用户带病上线 |
| desktop/mobile 巨型 UI/main | debt 只列 desktop/TUI `App.tsx` reducer/hook（`docs/todo/architecture-debt.md:41`）；remote dispatcher 实际在 `packages/desktop/src/main/index.ts:827` | `packages/web` 提取会受益于 reducer 分层，但无需等 desktop App 全拆；**server 必须另立 gateway ports，不能继续堆 `main/index.ts`** |
| 凭证加密/host-mediated resolve | core cipher boundary 已有，desktop SafeStorage 真启用仍需 host resolve（`docs/todo/architecture-debt.md:45`） | Phase 1 可先只支持 server operator 配置模型 secret；Phase 2 用户 credential 必须有 server encryption/key management 与 worker lease/resolver，不能照搬 Electron SafeStorage |

额外结论：现有 `agent-server-tcp` 虽已是 headless + automation 入口，但 `packages/core/package.json` 只公开 `agent-server-stdio` subpath，没有导出 TCP bin（`packages/core/package.json:8`）。不建议先把 TCP bin 发布再补 auth；应让 `packages/server` 成为唯一受支持的网络部署入口。

---

## 8. 决策守则与验收不变量

后续实现 spec 应持续满足：

1. browser 永远不直接选择宿主 `cwd`，只选择已授权 `workspaceId`。
2. browser 永远不直接选择 `userId` 或信任 client-minted owner/session mapping。
3. 每个 session/history/approval/background/upload 操作都先 AuthN，再 AuthZ，再进入 core。
4. core permission/path policy 不因 server authorization 而绕过；`bypassPermissions` 必须是额外高权限产品决策。
5. disk transcript 继续是 session 内容真相；control DB 只保存 identity/ownership/index。
6. “global setting/credential/memory”只在一个 account 内 global。
7. project repo 可声明能力需求，不能携带或选择宿主用户 secret。
8. 多用户要么 per-user process，要么证明所有 runtime/storage singleton 已 tenant-aware；不接受“靠 sessionId 前缀大概隔离”。
9. WebSocket stream fanout 以 authorized subscription 为边界，不能 broadcast 给全部 authenticated users。
10. 默认 loopback、默认无 tunnel、默认 invite-only、默认无公开注册。

---

## 9. 未决问题清单（需要用户拍板）

建议按以下顺序决策；括号内是本稿默认建议：

1. **第一部署形态**：先 self-host 还是直接 SaaS？（建议先 self-host，保留 relay seam。）
2. **Phase 1 是否严格单管理员**，还是第一版就要 admin + member？（建议单管理员；Phase 2 invite-only。）
3. **多用户 workspace 语义**：每人独占 workspace，还是多人可共享同一宿主 repo？共享时是否允许同时写？（建议先独占/owner-only。）
4. **公网入口**：只文档支持 reverse proxy，还是内置 cloudflared quick tunnel？（建议 Phase 1 只 reverse proxy；tunnel Phase 3。）
5. **账号登录方式**：local username/password、OIDC，还是二者？（建议 local bootstrap；OIDC 后置。）
6. **worker 隔离单位**：per user、per workspace、per session？（建议 per user；高风险/高负载场景再拆 per workspace。）
7. **模型/provider credential 归属**：管理员共享连接，还是用户各自连接？是否允许 workspace-scoped binding？（建议 Phase 1 admin-only；Phase 2 user-owned + workspace binding。）
8. **server 是否需要内置 browser automation**：无 Electron `webview` 时，是禁用 browser tools、接外部 CDP browser，还是服务端托管浏览器？（建议 Phase 1 禁用并明确 capability unavailable。）
9. **desktop 与 server 的关系**：desktop 未来作为 server client，还是保持 embedded 与 server 两种 mode？（建议先双 mode，稳定后再收敛。）
10. **现有本地数据迁移**：是否需要把当前 `~/.code-shell` sessions/settings/credentials/memory 一键导入首个 admin？（session/settings 可优先；secret migration 需单独安全设计。）
11. **external-agent rooms/Claude Code/Codex** 是否属于 server 产品主线？（建议不进 Phase 1，后续 capability 化。）
12. **SaaS 数据边界**：若上云，engine/workspace 在用户机器还是云端？session transcript、tool output、credential 是否允许离机？（这是 cloud relay 方案的先决问题。）
13. **审计保留期与管理员可见性**：管理员能否看成员 prompt/tool 内容，还是只看脱敏 metadata？（建议默认只存/展示脱敏 metadata。）
14. **资源配额**：每用户最大 live session、background process、upload、token/cost 是否需要硬限制？（多用户 Phase 2 前必须拍板默认值。）

---

## 10. 最终建议

最短且可逆的路线不是“给现有 mobile remote 加一个 users.json”，也不是“把 `agent-server-tcp` bind 到公网”，而是：

1. 保留 core protocol/session/permission，认定它是可信 server 内部执行面。
2. 新建 `packages/server`，在 core 前建立账号、workspace/session ownership、authorization、worker supervision 和 event fanout。
3. 从 mobile React bundle 提取 `packages/web`，复用已经成熟的 stream reducer、approval UI、reconnect/resync，而不是复用 device-pairing 领域模型。
4. Phase 1 只做一个 admin 的完整闭环；Phase 2 通过 per-user worker + private data root 补成真实多用户；Phase 3 再选择 tunnel/relay/SSO/rooms/browser 等产品分叉。

这样能够最大限度复用已经验证的执行与远程交互能力，同时把当前最危险的缺口——**identity 不存在、cwd 可由 client 提交、OS home 被误当成 user scope、事件向所有认证设备广播**——封在一个明确、可审计的 server gateway 中。

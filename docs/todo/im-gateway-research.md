# IM Gateway / Channel 方案调研

> 状态：方案调研，不是实现承诺；调研快照：2026-07-12。
> 范围：先做 `/open`、`/close`、`/status` Gateway Core MVP，再接可插拔 IM channel；只规划，不改代码。
> 上游方向锚点：[`docs/todo/im-gateway-remote-orchestration.md`](./im-gateway-remote-orchestration.md) 第 9-20、38-72、74-96、98-127 行。
> 证据规则：本仓库事实均给出文件、符号和行号；外部事实均链接原始文档。没有代码或外部资料直接证明的判断标为“推测”或“建议”。

## 0. 结论先行

1. **可以找到确切的 OpenClaw 项目，无需使用替代基线。** 官方仓库是 [openclaw/openclaw](https://github.com/openclaw/openclaw)，其核心是单个长期运行的 Gateway：统一拥有 channel 连接、会话/路由和一个带鉴权的 WebSocket 控制面；channel 通过插件契约接入。
2. **CodeShell 应对齐 OpenClaw 的逻辑边界，不应在第一个 PR 照搬它的进程拓扑。** MVP 把 Gateway Core 做成 Electron main 内独立模块，由一个新的 `MobileRemoteLifecycle` 门面独占现有 host/tunnel；原因是现有 `RemoteHostManager`、`TunnelManager`、passcode、设备存储和所有手机事件分发都由 main 进程内对象持有，目前没有给 daemon 使用的本地 RPC（`packages/desktop/src/main/index.ts:383-403,478-501,2717-2837`）。
3. **MVP 的物理形态建议为“main 内常驻、逻辑独立”，而不是独立进程。** 这意味着第一版要求 CodeShell 桌面端正在运行；电脑休眠、关机或应用完全退出时不可远程 `/open`。独立 daemon 只有在补齐“拉起桌面端 + 本地鉴权 RPC + 版本握手 + 单实例所有权”后才成立，应作为后续阶段。
4. **IM 鉴权与手机访问鉴权是两层不同的门。** IM 命令用 provider 的稳定 sender ID + 私聊/会话 allowlist；手机页面继续使用现有 passcode gate + 10 分钟一次性 pairing token + trusted-device bearer credential。绝不能把 passcode 发到 IM，也不能把“IM sender 已授权”误当成“手机已配对”。
5. **回推的是带一次性 pairing token 的敏感链接，不只是普通隧道地址。** `/open` 的结果应发到原始、已鉴权的私聊 route，文本包含有效期，必要时附 QR；不得发群、不得写完整 URL 到日志。`/status` 不生成或返回 pairing token。
6. **第一个真实 channel 推荐 Telegram，而不是微信个人号。** Telegram 有正式 Bot API，OpenClaw 也默认用 long polling；微信个人号没有面向此用途的官方 Bot API，非官方 Web/Pad/Hook 接入有登录不稳定、协议失效和封号/合规风险。微信应只走独立实验开关，产品化优先评估公众号或企业微信的官方接口。

## 1. OpenClaw Gateway 调研

### 1.1 已核验的一手来源

| 主题 | 一手来源 | 本文采用的事实 |
|---|---|---|
| 官方项目 | [GitHub: openclaw/openclaw](https://github.com/openclaw/openclaw) | 确切项目存在；不是名称相近项目或二手复刻。 |
| Gateway 总体架构 | [Gateway architecture](https://docs.openclaw.ai/architecture) | 单个长期运行 Gateway 拥有所有 messaging surfaces；CLI、Web UI、macOS app、自动化和 nodes 通过同一 WS 控制面连接。 |
| Gateway 协议与鉴权 | [Gateway protocol](https://docs.openclaw.ai/gateway/protocol) | 首帧 `connect`，请求/响应/事件分帧；支持 token/password/trusted-proxy，设备配对后发 role/scope 约束的 device token。 |
| 远程暴露 | [Remote access](https://docs.openclaw.ai/gateway/remote)、[Tailscale](https://docs.openclaw.ai/gateway/tailscale) | 默认 `127.0.0.1:18789`；优先 SSH/Tailscale Serve，公网 Funnel 必须 shared password；非 loopback 必须鉴权。 |
| 常驻服务 | [Gateway runbook](https://docs.openclaw.ai/gateway)、[Daemon CLI](https://docs.openclaw.ai/cli/daemon) | 用 launchd/systemd/Task Scheduler 监督单个 Gateway，提供 install/start/stop/restart/status/health。 |
| 消息流水线 | [Messages and delivery](https://docs.openclaw.ai/concepts/messages) | inbound → route/session key → dedupe/debounce → queue → agent run → outbound；按 channel 做 chunking/streaming。 |
| Channel 配置与准入 | [Configuration — channels](https://docs.openclaw.ai/gateway/config-channels) | 每个 channel/account 可配置；DM 默认 pairing，也支持 allowlist；群聊有独立 policy/mention gate。 |
| Channel 插件边界 | [Building channel plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)、[Inbound API](https://docs.openclaw.ai/plugins/sdk-channel-inbound)、[Outbound API](https://docs.openclaw.ai/plugins/sdk-channel-outbound) | 插件负责平台事实、身份归一化、native send/threading；core 负责通用准入策略、路由、队列、重试、receipt 和 dispatch。 |
| Telegram 实例 | [OpenClaw Telegram 文档](https://docs.openclaw.ai/channels/telegram)、[Telegram channel 源码](https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/channel.ts) | 默认 long polling，可选 webhook；一个 channel plugin 组合 account/config/security/pairing/outbound/status 等能力。 |

### 1.2 设计要点提炼

#### A. 一个长期运行的控制平面，channel 不各自成为“业务中心”

OpenClaw 的 Gateway 同时持有 provider/channel 连接、typed WS API、健康状态和事件推送。每个 channel 是 Gateway 的边缘适配器，不直接拥有 agent 的全局状态；外部客户端和 node 也不绕开 Gateway 直接互连。这个“单一所有者”比具体使用 WebSocket 还是 IPC 更值得 CodeShell 对齐。

对 CodeShell 的映射是：`GatewayCore` 只认规范化消息、命令和 outbound envelope；Telegram/微信 adapter 不得直接调用 `TunnelManager.start()`、`RemoteHostManager.createPairingUrl()` 或 Engine。所有 `/open`、`/close`、`/status` 进入同一个生命周期门面，现有 renderer IPC 也应逐步改走这个门面，避免出现两个 tunnel owner。

#### B. inbound 与 outbound 是不同契约，中间有 provider-neutral envelope

OpenClaw 的 inbound 文档把 receive path 概括为 `platform event -> inbound facts/context -> agent reply -> message delivery`；outbound adapter 声明真实支持的 text/media/reply/thread 能力，并返回 receipt。平台身份、chat/thread ID 和 native API 留在插件，通用准入、去重、排队与派发留在 core。

CodeShell 值得采用：

- inbound 必须带 `providerMessageId`、稳定 `sender.id`、`conversation.id/type/threadId` 和 `accountId`；
- outbound 使用稳定 target，不把 Telegram `chat_id`、微信 `open_id` 塞进业务命令；
- adapter 返回 receipt，Gateway 才能区分“命令成功但回推失败”和“命令执行失败”；
- core 做 provider message 去重，避免 webhook/断线重投导致 `/open` 反复换域名。

#### C. channel 准入和 Gateway 控制面鉴权分层

OpenClaw 的 channel DM policy 有 pairing/allowlist，Gateway WS 又有 token/password/trusted-proxy 和 device role/scope。这说明“谁能从 IM 发消息”和“谁能操作控制面”不是一回事。

CodeShell MVP 不需要完整复制 OpenClaw 的 channel pairing store。单用户产品先用 fail-closed allowlist 更简单：只有配置的 `(channel, accountId, senderId)` 能执行命令，且 `/open` 的敏感链接只允许发私聊。未来若做 channel pairing，再单独引入一次性批准流程，不复用手机 pairing token。

#### D. 默认不把控制面裸露到公网

OpenClaw 默认 bind loopback，推荐 SSH/Tailscale Serve；其公网 Funnel 明确要求 password。CodeShell 当前 quick tunnel 也是由本机 `cloudflared` 主动出站建立，但用途不同：它暴露的是手机 Web host，而不是让 Telegram long polling 入站。

OpenClaw 的做法值得对齐为安全原则：控制平面保持本地、远程暴露必须显式且有认证。它不适合直接替换 CodeShell 当前手机入口，因为 CodeShell 已有 trycloudflare + passcode + pairing 的完整链路，MVP 应先复用。

#### E. 可运维性是 Gateway 的组成部分

OpenClaw 把 install/start/stop/restart/status/health 和系统 supervisor 当成正式能力，还区分“服务是否安装”“进程是否活着”“RPC 是否健康”“channel account 是否健康”。CodeShell `/status` 也不应只返回一个 Boolean；至少应区分 host、tunnel process、edge readiness、在线设备和 adapter 状态。

#### F. 消息重投、并发和输出限制在 core 处理

OpenClaw 的消息流水线在运行前做 dedupe/debounce/queue，输出端按 channel 切块。这个思路直接适用于有副作用的 `/open`、`/close`：

- 同一 `providerMessageId` 只执行一次；
- 生命周期命令串行化；
- 同时到来的 `/open` 共享一次 opening promise；
- adapter 只处理平台格式、长度、重试和 rate limit，不决定 tunnel 状态。

### 1.3 值得对齐与不应照搬

| OpenClaw 设计 | CodeShell 决策 |
|---|---|
| 单 Gateway 拥有所有 channel 和控制面 | **对齐逻辑所有权。** `GatewayCore` + `MobileRemoteLifecycle` 成为唯一命令入口。 |
| channel plugin：身份/平台能力在插件，通用 policy/dispatch 在 core | **对齐。** 先做源码内注册的 adapter；第三方动态 npm 插件延后。 |
| 规范化 inbound、receipt 化 outbound、去重/排队/重试 | **对齐。** 三命令也需要这些可靠性原语。 |
| DM pairing/allowlist，群策略独立 | **部分对齐。** MVP 只做稳定 sender allowlist + 私聊；不做 channel pairing UI。 |
| typed WS 控制平面，role/scope device token | **保留方向，不照搬协议。** MVP 仍在 main 内调用；若拆 daemon，再设计最小本地 RPC。 |
| SSH/Tailscale 暴露 Gateway | **不替换现有手机 quick tunnel。** 两者解决的问题不同；可作为生产级远程入口的后续选项。 |
| Gateway 同时运行 agent、memory、tools、session brain | **不适用。** CodeShell 本稿明确不做编排大脑，非三命令消息不进入一个新 agent runtime。 |
| 单独 daemon + 系统 supervisor | **目标形态，非第一个 PR。** 当前代码没有跨进程复用边界，直接拆会先造一套 RPC/启动器。 |
| 大量 channel actions、富卡片、流式 reasoning | **MVP 不做。** 三命令只需文本、链接、可选 QR 和 delivery receipt。 |

## 2. CodeShell 现有基建盘点

### 2.1 当前真实链路

```text
renderer Settings
  └─ ipcRenderer.invoke("mobileRemote:start", { mode: "tunnel" })
       └─ Electron main（当前唯一编排者）
          1. AccessPasscode.isSet()
          2. CloudflaredBinary.ensureBinary()
          3. RemoteHostManager.start(mode=tunnel, port=0, passcode)
          4. TunnelManager.start(localPort)
          5. RemoteHostManager.setPublicBaseUrl(trycloudflare URL)
          6. RemoteHostManager.createPairingUrl()
             => https://<random>.trycloudflare.com/mobile?pairing=<token>

手机打开 URL
  └─ passcode gate（HTTP + WS upgrade）
     └─ mobile web 从 query 读取 pairing token
        └─ 同源 /ws 发送 pair.complete(token, name, secretHash)
           └─ 一次性 consume token，TrustedDeviceStore 建立/复用设备
              └─ 手机再发 auth.device(deviceId, secretHash)
                 └─ 后续 chat/session/room/approval 进入 main 的既有分发路径
```

代码证据：

- 当前 main 的 tunnel 启动编排位于 `packages/desktop/src/main/index.ts:2717-2786`；成功结果已经包含 `url`、`pairingUrl`、`expiresAt`，因此“回推 IM”不需要重新实现 URL 生成。
- `RemoteHostManager.createPairingUrl()` 在 `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:282-290` 生成 `${publicBaseUrl}/mobile?pairing=${token}`；`setPublicBaseUrl()` 在 273-280 行把 loopback base 换成公网域名。
- token 是 32 字节随机数的 base64url，默认 TTL 10 分钟且消费即删除：`PairingTokenManager.createToken()/consume()`，`packages/desktop/src/main/mobile-remote/pairing.ts:4-23`。
- 手机端在 `packages/desktop/src/mobile/hooks/useRemoteSocket.ts:124-170` 用当前 origin 建 `/ws`，优先发送 `pair.complete`；收到 `pair.ok` 后在 177-205 行保存设备 ID、再发 `auth.device` 并清掉 URL query。
- 手机浏览器持久化 `cs.deviceId`、`cs.deviceSecret`、`cs.deviceName`：`packages/desktop/src/mobile/lib/storage.ts:9-55`。`secretHash` 名称具有误导性，实际是手机生成的 32 字节原始共享秘密，见 `packages/desktop/src/mobile/lib/deviceCredential.ts:1-21`。

### 2.2 可直接复用能力

| 能力 | 具体符号与锚点 | 可复用方式 |
|---|---|---|
| quick tunnel 进程所有权 | `TunnelManager`，`tunnel-manager.ts:67-76` | 原样复用 spawn、URL 捕获、ready 探测、健康监控和 teardown。Gateway 不直接 spawn `cloudflared`。 |
| 启动与 edge ready | `TunnelManager.start(port)`，`tunnel-manager.ts:118-240`；命令参数在 140-154 行，URL 后等待 `/ready` 在 174-195 行 | `/open` 只有在 promise resolve 后才回推链接，避免把 Cloudflare 1033 死地址发到 IM。 |
| 运行期健康 | `startHealthMonitor()/pollHealth()`，`tunnel-manager.ts:261-318` | 订阅 `status`，断线后回推“地址已失效，请重新 `/open`”；保持当前“不自动重启/不静默换 URL”策略（67-75 行）。 |
| 安全停止与重开 | `beginTeardown()/killAndWait()/stop()`，`tunnel-manager.ts:320-400` | `/close` await teardown，下一次 `/open` 不与旧 metrics port 竞争。 |
| tunnel 状态 | `isRunning()/isConnected()`，`tunnel-manager.ts:403-409` | `/status` 的 process/edge 两个维度。 |
| host HTTP/WS | `RemoteHostManager.start()`，`remote-host-manager.ts:136-270` | 原样复用静态 mobile app、upload route、WS transport 和 loopback bind。 |
| tunnel passcode gate | `RemoteHostManager.start()` 对 HTTP/upgrade 的 gate，`remote-host-manager.ts:138-205`；`AccessPasscode.gate()/allows()`，`access-passcode.ts:119-179` | 公网 host 仍要求已有 passcode；IM 授权不能旁路此层。 |
| pairing URL | `setPublicBaseUrl()/createPairingUrl()`，`remote-host-manager.ts:273-290` | `/open` 成功后直接 mint 新 token 和 URL；不自造第二套 pairing。 |
| pairing + trusted device | `handleClientEvent()`，`remote-host-manager.ts:293-317`；`TrustedDeviceStore.authenticate()`，`trusted-device-store.ts:52-64` | 手机照旧完成一次性 pairing 和长期设备认证。 |
| 在线设备 | `onlineDeviceIds()/markOnline()/markOffline()`，`remote-host-manager.ts:109-134` | `/status` 可返回在线设备数；默认不把设备名发到 IM。 |
| host 生命周期 | `stop()/status()`，`remote-host-manager.ts:369-401` | `/close` 停 host、WS 和 upload；`/status` 读取 host mode/port。 |
| cloudflared 安装 | `CloudflaredBinary.ensureBinary()`，`cloudflared-binary.ts:164-190`；固定版本和 SHA-256 在 19-51、69-85 行 | 继续复用下载、校验、原子安装；adapter 不关心二进制。 |
| main 退出清理 | `packages/desktop/src/main/index.ts:3831-3848` | Gateway main 内形态可继承现有退出时 tunnel/host 清理。 |

`mobile-remote/` 其余文件的边界也已核对：`types.ts:78-289` 定义手机 client/server events，`mobile-chat-turn.ts`、`mobile-run-dispatch.ts` 复用既有 worker/run，`room-manager.ts`/`resident-agent.ts`/`codex-room-agent.ts` 管理外部 agent room，`pending-approvals.ts` 管审批，`mobile-static.ts` 和 `mobile-upload-service.ts` 管 Web UI/上传。这些是手机控制面的下游能力，**三命令 Gateway 不应直接调用或复制**；只有未来 assistant 主体才可能消费通用聊天输入。

### 2.3 不能直接复用或必须补齐的缺口

1. **没有可给独立 daemon 调用的 API。** `TunnelManager`、`RemoteHostManager`、`AccessPasscode` 和 `TrustedDeviceStore` 都在 `index.ts:383-403,478-501` 实例化，公开入口是 Electron `ipcMain.handle()`（2717-2837 行），外部进程不能调用。草案所说“方案 A：gateway 通过受控 IPC/本地 RPC 唤起 main”目前尚未实现。
2. **现有 start mutex 没有覆盖 stop。** `mobileRemoteStartInFlight` 只合并并发 start（`index.ts:2717-2786`）；stop 在 2787-2790 行可与 opening 竞争。Gateway 需要覆盖 open/close/status 的统一状态机与串行化锁。
3. **`RemoteHostManager.start()` 只要已 started 就直接返回。** 见 `remote-host-manager.ts:136-140`。如果 LAN host 已运行，直接 `/open` tunnel 可能复用一个没有 passcode gate 的 LAN 实例。Gateway 必须检测 mode；遇到 LAN→tunnel 要么明确拒绝并提示先关闭，要么在统一锁内安全 stop 后按 tunnel mode 重启，不能“就地套 tunnel”。MVP 建议拒绝并给出明确状态，减少隐式断开。
4. **缺少可查询的公网 URL。** `TunnelManager.currentUrl` 是 private（`tunnel-manager.ts:88-95`），没有 getter；`mobileRemote:status` 返回的 `status?.url` 在 tunnel mode 是 loopback host URL，而非 trycloudflare URL（`index.ts:2798-2806`）。生命周期门面必须持有当前 `publicUrl`，并在 disconnect/close 时清空。
5. **pending pairing token 没有显式清空。** `PairingTokenManager` 只有 create/consume（`pairing.ts:4-23`）；`RemoteHostManager.stop()` 没有 rotate/clear pairing manager（`remote-host-manager.ts:369-397`）。建议 `/close` 使所有未消费 token 失效，避免短时间内的旧 token 跨 reopen 重用。
6. **现有 passcode 不能当 IM sender auth。** 它是一个全局共享口令、保护 HTTP/WS，并在成功后发 cookie（`access-passcode.ts:42-53,119-179`）；IM adapter 必须用平台身份做前置准入。
7. **access.json 未显式设置 0600。** `AccessPasscode.write()` 在 `access-passcode.ts:218-221` 没有 mode/chmod；相对地 `TrustedDeviceStore.writeAll()` 在 `trusted-device-store.ts:102-109` 显式 0600。本文只记录风险，不在 Gateway PR 顺手改安全存储；channel token/allowlist 的新存储必须从第一天使用 keychain 或显式 owner-only 权限。
8. **缺 provider 消息去重、outbound receipt、adapter health 和 owner notification route。** 现有 mobile WS 是面向浏览器的实时连接，不提供 IM 所需的这些语义。
9. **quick tunnel 不是生产 SLA。** Cloudflare 官方说明 TryCloudflare 只用于测试/开发、无 SLA/uptime 保证，并有 200 个 in-flight 请求限制：[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。因此它可作为 Gateway MVP 复用项，但不能被写成最终生产远程入口承诺。

## 3. Gateway Core MVP 设计

### 3.1 边界与进程模型

建议的 MVP 组件：

```text
                         Electron main（MVP 物理进程）
┌────────────────────────────────────────────────────────────────────┐
│ [Channel Adapter Registry]                                        │
│      │ normalized inbound                                         │
│      ▼                                                            │
│ [GatewayCore] ── auth/dedupe/parse/serialize/reply ───────────┐     │
│      │ GatewayCommand                                        │     │
│      ▼                                                       │     │
│ [MobileRemoteLifecycle]  ← 唯一 tunnel/host owner             │     │
│      ├─ AccessPasscode / TrustedDeviceStore                  │     │
│      ├─ RemoteHostManager                                    │     │
│      └─ TunnelManager / CloudflaredBinary                    │     │
│                                                              ▼     │
│                                             outbound envelope/receipt│
└────────────────────────────────────────────────────────────────────┘
```

- **逻辑独立：** 建议新目录 `packages/desktop/src/main/im-gateway/`，不得把 channel 分支继续堆入 `index.ts`。
- **物理同进程：** MVP 在 main 内常驻，随桌面端启动/退出；复用现有对象、事件和清理，不先发明跨进程协议。
- **单一生命周期门面：** 新的 `MobileRemoteLifecycle` 封装当前 `mobileRemote:start/stop/status/pairingUrl` 的编排。renderer IPC 与 Gateway Core 都调门面，不能各持一套锁。
- **向 daemon 演进：** 门面接口不引用 Electron 的 `IpcMainEvent`、`BrowserWindow` 或 adapter 类型。后续可在其上加 loopback Unix socket/named pipe RPC，让 daemon 先拉起桌面端再调用；这是独立阶段，不是 MVP 隐含工作。

为什么不是立即独立进程：独立 daemon 可以在桌面应用退出时收 IM，但它若自己拥有 `RemoteHostManager`，就没有 main 中的 Engine/room/approval 分发；若仍让 main 拥有 host/tunnel，则必须先做安全本地 RPC 和 app launcher。两条路线都比三命令本身大。**推测：** main 内形态能覆盖“电脑开着、CodeShell 常驻、用户不在桌前”的首要场景，是最小可验证闭环。

### 3.2 生命周期状态机

`MobileRemoteLifecycle` 维护单调 generation 和以下状态，所有变更在同一 async mutex 内：

| 状态 | 含义 | 允许操作 |
|---|---|---|
| `closed` | host/tunnel 都未运行 | `/open` → `opening`；`/close` 幂等成功；`/status` 只读 |
| `opening` | binary/host/tunnel 正在启动 | 并发 `/open` 共享 promise，完成后为每个请求 mint 独立 pairing URL；`/close` 标记 close-after-open 或安全取消并 teardown |
| `open` | host 运行且 tunnel edge ready | `/open` 不重启 tunnel，只 mint 新 pairing URL；`/close` → `closing` |
| `degraded` | child 可能仍在但 edge `/ready` 连续失败 | `/status` 报 degraded；不自动换地址；`/open` 在锁内 teardown 后重新启动 |
| `closing` | 先撤公网 tunnel，再停 host/WS/upload | 并发 `/close` 共享 promise；`/open` 等 closing 完成后再启动 |
| `error` | 最近一次操作失败且清理已完成 | 保存脱敏错误摘要；下一 `/open` 从 `closed` 语义重试 |

`TunnelManager.start()` 在发现 live child 时会先 teardown 再开（`tunnel-manager.ts:118-139`），所以“open 状态下重复 `/open`”必须在上层短路，否则每次命令都会更换域名。`TunnelManager` 不自动重启的既有决定也保留：地址变化需要新的 pairing URL，静默重启会让 IM 中旧链接看似仍有效。

### 3.3 三个命令的精确定义

#### `/open`

前置条件：

- sender/account/conversation 已通过 allowlist；
- 只接受 direct/private conversation；群里即使 sender 在 allowlist 也拒绝回传链接；
- desktop app 正在运行；
- 已设置 access passcode（复用 `AccessPasscode.isSet()`，`access-passcode.ts:69-71`）；
- 当前不是 LAN host；若是，MVP 返回“请先关闭局域网遥控再开公网”，不自动踢掉现有手机。

语义：

- `closed/error/degraded`：确保 cloudflared → 启动 tunnel-mode host → 启动 tunnel 并等 edge ready → 设置 public base → mint pairing URL；
- `opening`：合并到同一次启动，不重复 spawn；
- `open`：不重启、不换 public URL，仅 mint 一个新的 10 分钟一次性 pairing URL；
- 成功回包包含：状态、可点击 pairing URL、失效时间、提示“仍需输入桌面端访问口令”；不包含 passcode、设备 secret 或完整内部错误；
- 可选 QR 是同一个 pairing URL 的视觉形式，不是第二种 credential。

建议回复示例：

```text
手机遥控已开启。
入口：https://<random>.trycloudflare.com/mobile?pairing=<redacted-in-doc>
配对链接将在 10 分钟后失效且只能使用一次；打开后仍需输入访问口令。
```

#### `/close`

- 任意已授权私聊可调用；`closed` 时幂等返回“已关闭”；
- 先停止/等待 `TunnelManager.stop()`，阻断公网新流量，再 `RemoteHostManager.stop()`；
- 使所有 pending pairing token 失效，但**不撤销** trusted devices；设备撤销仍属于桌面设置中的显式管理操作；
- 关闭 live mobile WS 是预期行为；返回时必须确认 tunnel child 和 host 均完成 teardown；
- 不关闭 Gateway/adapter 本身，否则将无法再接收 `/open`。

#### `/status`

纯只读，不 mint token、不延长任何租约、不触发下载或重启。建议返回：

```ts
interface GatewayStatusView {
  gateway: "online";
  lifecycle: "closed" | "opening" | "open" | "degraded" | "closing" | "error";
  hostRunning: boolean;
  hostMode?: "lan" | "tunnel";
  tunnelProcessRunning: boolean;
  tunnelConnected: boolean;
  publicUrl?: string;       // 只在已授权私聊返回 base URL，不含 pairing token
  onlineDeviceCount: number;
  adapters: Array<{ id: string; accountId: string; status: string }>;
  lastErrorCode?: string;   // 稳定、脱敏 code，不含 token/path/stack
}
```

不要回设备名、项目路径、session 标题或 pairing URL。现有 `mobileRemote:status` 的 `running/mode/tunnelRunning/tunnelConnected`（`index.ts:2798-2806`）可作为起点，但需补 `publicUrl`、lifecycle phase 和 adapter health。

### 3.4 `/open` 到 IM 回推的完整时序

1. adapter 收到平台 event，提取 provider message ID、稳定 sender ID、conversation type/id/thread 和正文；保留 raw event 只用于 adapter 内诊断，不能进入日志。
2. Gateway Core 先按 `(channel, accountId, providerMessageId)` 去重，再做 account/sender allowlist 与 direct-conversation gate。顺序上先鉴权再返回任何状态细节。
3. parser 只接受严格的 `/open`、`/close`、`/status`，允许 Telegram 的 `/open@botname` 由 adapter 归一化；未知命令返回最小 help，普通聊天不进入 Engine。
4. `/open` 调 `MobileRemoteLifecycle.openTunnel()`。只有 `TunnelManager.start()` 已拿到 URL且 `/ready` 成功后，门面设置 `publicBaseUrl` 并调用 `createPairingUrl()`。
5. Gateway Core 生成 outbound envelope，target 固定为本条 inbound 的原始私聊 route；不可由消息正文指定任意 target。
6. adapter 发送文本链接；若能力声明支持 image，可附 QR。它返回 `DeliveryReceipt { providerMessageId, deliveredAt }`。
7. 若 tunnel 已成功但 outbound 失败，记录脱敏告警并有限重试；不要自动关闭 tunnel，因为用户可能从另一已授权 channel/status 恢复。回复失败与 tunnel 失败是两个不同错误域。
8. `TunnelManager` 后续发 `disconnected/error` 时，Gateway 向“最近成功 `/open` 的 route”和显式配置的 owner route 推送简短通知。route 只能在一次已鉴权 inbound 后登记，并按 channel/account 分区。

微信/IM 中看到的链接本身含一次性 bearer token，因此：

- 只发私聊，群聊禁止；
- 日志显示 origin/domain 和 expiresAt 即可，query 整体写成 `<redacted>`；
- adapter 的重试必须复用同一 outbound payload，不重复调用 `createPairingUrl()`；
- 用户转发该链接会转移一次性配对能力，回复中必须明确“请勿转发”；
- 进入手机页面后仍有 passcode gate，这是第二层防护，不是省略链接保密的理由。

### 3.5 鉴权、密钥和滥用防护

| 层 | MVP 规则 |
|---|---|
| Channel account | bot/app token 只从 OS keychain、secret store 或 owner-only 文件读取；永不通过命令设置、永不打印。 |
| Sender | allowlist key 为 `(channelId, accountId, stableSenderId)`；显示名、username、群昵称不能作为唯一身份。 |
| Conversation | `/open` 和含 URL 的回复仅 direct/private；群聊只可返回“不允许在群聊执行”。 |
| Replay | 20 分钟左右的 bounded LRU dedupe（时长可配置）；相同 provider message ID 返回缓存结果或 no-op，不再执行副作用。OpenClaw 也在消息入口做 bounded dedupe，见 [Messages](https://docs.openclaw.ai/concepts/messages)。 |
| Rate limit | 每 sender 和每 account 做 token bucket；连续未授权请求静默丢弃或统一短回复，避免泄露 allowlist。 |
| Mobile Web | 保持 passcode gate、一次性 pairing、trusted device 三层；不因 IM 已认证而降低。 |
| Output | 不发送 passcode、设备 secret、内部路径、stack；pairing query 全量脱敏。 |
| Audit | 记录 command、channel/account、哈希化 sender/route、结果 code、latency、generation；不记正文和 credential。 |

OpenClaw 的外部控制面还支持 token/password/trusted proxy、device role/scope（[Gateway protocol](https://docs.openclaw.ai/gateway/protocol)）。MVP 同进程没有新的网络控制面，不需要复制；若以后拆 daemon，本地 RPC 必须至少有随机 token、peer/文件权限校验、请求 schema、版本握手和 method allowlist，不能把 Electron IPC 端口直接公开。

### 3.6 错误与可观测性

建议稳定错误码：`NOT_AUTHORIZED`、`DIRECT_ONLY`、`PASSCODE_NOT_SET`、`LAN_MODE_ACTIVE`、`APP_NOT_READY`、`BINARY_INSTALL_FAILED`、`HOST_START_FAILED`、`TUNNEL_URL_TIMEOUT`、`TUNNEL_EDGE_NOT_READY`、`OUTBOUND_FAILED`、`ALREADY_CLOSED`。

- 用户文案短且可行动；内部 cause/stack 只进本地脱敏日志。
- health 至少拆为 adapter receive loop、Gateway Core、host、tunnel child、tunnel edge、outbound API。
- 指标建议：command count/latency/result、dedupe hits、unauthorized drops、tunnel open duration、outbound retry/failure、online device count；不以 sender ID、URL query 作 label。
- 不自动重启 quick tunnel。崩溃后发通知并要求 `/open`，与 `TunnelManager` 现有“不静默换 QR/地址”的设计一致（`tunnel-manager.ts:67-75`）。

## 4. Channel Adapter 抽象

### 4.1 最小接口草案

```ts
type ConversationKind = "direct" | "group" | "channel";

interface InboundMessage {
  channelId: string;
  accountId: string;
  providerMessageId: string;
  sender: { id: string; displayName?: string };
  conversation: {
    id: string;
    kind: ConversationKind;
    threadId?: string;
  };
  text: string;
  receivedAt: number;
}

interface OutboundTarget {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
}

interface OutboundMessage {
  text: string;
  replyToProviderMessageId?: string;
  links?: Array<{ label: string; url: string; sensitive?: boolean }>;
  qrCodeData?: string; // adapter capability 支持时才渲染/发送
}

interface DeliveryReceipt {
  providerMessageId: string;
  deliveredAt: number;
}

interface ChannelCapabilities {
  text: true;
  reply: boolean;
  image: boolean;
  threads: boolean;
  maxTextLength?: number;
}

interface ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  start(ctx: { onMessage(message: InboundMessage): Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
  status(): Promise<{ state: "stopped" | "starting" | "online" | "degraded"; detail?: string }>;
}

type GatewayCommand =
  | { type: "open" }
  | { type: "close" }
  | { type: "status" };

interface GatewayEngine {
  handleInbound(message: InboundMessage): Promise<void>; // auth → dedupe → parse → lifecycle → outbound
}
```

边界约束：

- adapter 负责 native event → `InboundMessage`、稳定 ID 归一化、receive loop/webhook 验签、平台 send/chunk/retry；
- Gateway Core 负责 allowlist、direct-only、去重、命令解析、生命周期和选择 outbound target；
- `MobileRemoteLifecycle` 负责 host/tunnel/passcode/pairing；
- 未来 assistant 接口若加入，应是另一个 `CommandHandler`，不是 adapter 的方法；
- adapter 不接触 `MobileClientEvent`/`MobileServerEvent`，也不把 IM 消息伪装成手机 WebSocket 事件。

### 4.2 如何做到可插拔

1. 每个 adapter 由 factory 注册：`registerChannelAdapter({ id, configSchema, create })`；config 以 `channels.<id>.accounts.<accountId>` 分区。
2. MVP 先做**编译期/源码内插件**，即 adapter 模块实现同一接口并由 registry 显式 allowlist。不要第一天就加载任意 npm 包；OpenClaw 自己也明确把插件视为 Gateway trusted computing base，见 [OpenClaw SECURITY.md](https://github.com/openclaw/openclaw/blob/main/SECURITY.md)。
3. config schema、secret references 和 adapter status 必须能在不启动 native receive loop 时读取；OpenClaw 的 channel plugin setup/runtime 分离值得借鉴，见 [Building channel plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)。
4. capability 必须真实声明。Gateway 只生成 text+link；QR、thread reply、markdown 由 adapter 按能力降级。
5. 一个坏 adapter 的启动/发送失败不得拖死其他 adapter 或 tunnel 生命周期；每 account 有独立 abort signal、重试预算和 health。
6. route key 使用 `(channelId, accountId, conversationId, threadId)`，sender policy 另用 stable sender ID，不能把“发到哪里”和“谁有权发”混成一个 `chat_id`。

### 4.3 Telegram Adapter

外部依据：Telegram 官方 Bot API 是 HTTPS API（[Bot API](https://core.telegram.org/bots/api)）；updates 只能二选一使用 `getUpdates` long polling 或 webhook，未取走的 update 最多保存 24 小时。OpenClaw 默认 long polling、webhook 可选（[OpenClaw Telegram](https://docs.openclaw.ai/channels/telegram)）。

推荐 MVP 接法：

- 使用 long polling，避免为 Telegram inbound 再开公网 webhook；trycloudflare 只服务手机入口；
- offset 在成功入队/处理后推进，并用 provider `update_id/message_id` 再做 core dedupe；
- BotFather 注册 `/open`、`/close`、`/status`，但服务端仍严格解析和鉴权；Telegram 官方也要求后端验证命令有效性和用户授权，见 [Bot Features — Commands](https://core.telegram.org/bots/features#commands)；
- 第一次由用户打开 bot 并 `/start`，adapter 记录已鉴权私聊 route，后续才能可靠推送 tunnel 断线；
- allowlist 用数值 `from.id`，不是可改 username；私聊 target 用 `chat.id`；群默认拒绝三命令或至少拒绝 `/open` 链接；
- 出站尊重平台 rate limit。Telegram FAQ 建议单 chat 不超过约 1 message/s、群不超过 20/min，并对 429 做 backoff：[Bots FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。

难点与限制：

- webhook 与 long polling 互斥，旧 webhook 未清理会让 polling 收不到消息；
- bot 的群消息可见范围受 privacy mode、管理员身份和 mention/command 规则影响，见 [Bots FAQ — What messages will my bot get?](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)；
- 网络受限地区访问 `api.telegram.org` 可能需要代理。**推测：** 这是部署运维问题而非 adapter API 设计，配置应允许 proxy 但默认关闭，并由用户自行确认当地网络与合规要求；
- 长文本/Markdown/链接预览、429、网络重投、bot 被 block 都要映射成明确 delivery failure；三命令 MVP 不需要富交互。

### 4.4 微信 Adapter

必须先区分三种“微信”：

| 路径 | 可行性 | 主要问题 | 建议 |
|---|---|---|---|
| 微信个人号，非官方 Web/Pad/Windows Hook | 技术上可由 Wechaty puppet 等接入 | 没有面向该用途的官方 Bot API；登录协议易失效、session/联系人 ID 可能变化；自动化可能违反协议并触发风控/封号 | **不作为默认发布 channel。** 仅研究开关、独立测试号、醒目风险告知，不承诺稳定性。 |
| 微信公众号官方接口 | 官方 API | 需要主体/账号配置；交互和客服消息窗口、消息类型、审核规则与个人聊天不同 | 若产品接受“公众号”身份，可作为微信方向首个合规 PoC。 |
| 企业微信自建应用/机器人 | 官方 API | 需要企业主体/管理员配置；外部联系人、群机器人、自建应用的收发能力不是同一套 API | 企业场景优先；单独定义 `wecom` adapter，不冒充个人微信。 |

证据：

- 腾讯当前《微信软件许可及服务协议》可从[微信官方协议页](https://weixin.qq.com/cgi-bin/readtemplate?head=true&lang=zh_CN&s=default&t=weixin_agreement)查阅。协议禁止通过非腾讯开发/授权的第三方软件、插件、外挂或系统登录/使用服务或进行自动化操作。因此个人号 adapter 存在明确条款风险，不只是“可能不稳定”。
- Wechaty 官方的 WeChat provider 文档列出：2017 年后注册账号可能无法登录 Web WeChat、UOS patch 已不可用、部分 room API 不可用、contact/room ID 会跨 session 变化：[Puppet Provider: WeChat](https://wechaty.js.org/docs/puppet-providers/wechat)。其 puppet 抽象本身很值得参考，但 provider 可用性不能当作微信官方支持。
- 微信公众号存在官方客服消息接口：[公众号客服消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html)；企业微信存在官方消息发送与回调体系：[企业微信消息发送](https://developer.work.weixin.qq.com/document/path/90236)。具体账号权限和时效必须在 PoC 时按当期官方文档再次核验，本文不把某个历史窗口数字写死为 CodeShell 承诺。

如果仍做个人号实验 adapter，额外要求：

- 用专门测试号，不使用主账号；用户显式确认协议/封号/数据风险；
- adapter process 与 Gateway Core 隔离，崩溃或登出不影响 tunnel；session credential owner-only 存储；
- sender stable ID 不可靠时 fail closed，不能退化到昵称 allowlist；
- 自动回复频率极低，只响应明确三命令；不拉群、不群发、不抓取历史、不做好友管理；
- 登录失效只上报 `degraded`，不无限扫码/重登；
- 这些措施只能降低技术和滥用风险，**不能消除平台协议风险**。

微信“隧道地址回推”的 adapter 行为与 Telegram 一致：仅对已鉴权私聊原路回复一个含 pairing token 的 URL，附有效期与“请勿转发”；若客户端将外链折叠或拦截，则追加 QR 图片作为能力降级。不要把 passcode 拼进 query，也不要用文件传输助手/群聊作为默认 target。

## 5. 分阶段落地

以下文件均为**计划影响**，不是本文已创建的代码。体量是含单元测试的粗估，属于“推测”。

### Phase 0：Gateway Core MVP（无真实 IM provider）

目标：建立独立能力边界并跑通三命令到现有 mobile remote 的生命周期，不引入 Telegram/微信 SDK。

计划影响：

| 文件 | 变化 |
|---|---|
| `packages/desktop/src/main/im-gateway/types.ts`（新） | normalized inbound/outbound、command、status、receipt 类型 |
| `packages/desktop/src/main/im-gateway/gateway-core.ts`（新） | allowlist、direct-only、dedupe、parser、命令 dispatch |
| `packages/desktop/src/main/im-gateway/gateway-core.test.ts`（新） | 三命令、并发、重投、未授权、群聊拒绝、脱敏测试 |
| `packages/desktop/src/main/mobile-remote/mobile-remote-lifecycle.ts`（新） | 统一 open/close/status 状态机，持有 `publicUrl`，封装现有四个对象 |
| `packages/desktop/src/main/mobile-remote/mobile-remote-lifecycle.test.ts`（新） | open coalesce、close race、degraded reopen、LAN 冲突、pairing invalidate |
| `packages/desktop/src/main/index.ts` | 现有 `mobileRemote:*` IPC 改调门面；不改变 renderer contract |
| `packages/desktop/src/main/mobile-remote/pairing.ts` / `remote-host-manager.ts` | 只补 clear/rotate pending pairing 的最小 API（若状态机测试证明需要） |

体量：约 2 个 PR、500-900 LOC（含测试）。风险：生命周期竞态最高；应先使用 fake host/tunnel 做确定性测试，再跑现有 mobile-remote tests。定义完成：不用真实 provider，通过 fake adapter/inbound fixture 可以验证 `/open` 返回现有 pairing URL、重复命令不换 tunnel、`/close` 清理、`/status` 纯只读。

### Phase 1：第一个真实 channel——Telegram

目标：交付“Telegram 私聊 `/open` → 手机 pairing URL 回 Telegram → 点击后使用现有手机 UI”的首个可用闭环。

计划影响：

| 文件 | 变化 |
|---|---|
| `packages/desktop/src/main/im-gateway/channel-registry.ts`（新） | 显式注册、account 生命周期、capability/status |
| `packages/desktop/src/main/im-gateway/channels/telegram/*`（新） | token config、long polling、event normalize、send/receipt、offset/429 |
| `packages/desktop/src/main/im-gateway/channels/telegram/*.test.ts`（新） | fake Bot API、offset、duplicate、privacy/DM、send failure |
| `packages/desktop/src/main/index.ts` | 启停 registry、向 renderer 推 adapter health（若 UI 需要） |
| `packages/desktop/src/preload/index.ts` 与设置页相关文件 | 最小配置/状态 UI；secret 不经普通日志或 renderer 明文回读 |

体量：约 2-3 个 PR、700-1,200 LOC。主要风险：bot token 存储、polling ownership、网络代理、outbound 失败、renderer/main secret 边界。灰度：默认关闭，只允许一个 account 和明确 sender ID；群聊关闭。

### Phase 2：微信合规 PoC / 第一个微信 channel

目标：先做接入路线决策，再写 adapter。优先顺序：企业微信自建应用或公众号官方 API；个人号只做隔离实验，不进入默认发行。

计划影响：

| 文件 | 变化 |
|---|---|
| `docs/todo/im-gateway-wechat-spike.md`（届时新） | 账号类型、官方权限、消息窗口、回调验签、主体/审核和数据合规结论 |
| `packages/desktop/src/main/im-gateway/channels/wecom/*` 或 `wechat-official/*`（新） | 选择一种官方产品后实现，不用一个 `wechat` adapter 混三种协议 |
| webhook ingress / exposure 配置 | 若官方 API 必须公网 callback，使用独立、稳定、验签的 webhook endpoint；不得复用含手机页面的随机 pairing URL 作为 webhook |
| 设置与 secret store | corp/app credentials、callback token/AES key 的安全配置 |

体量：官方路线约 3-5 个 PR、1,000-2,000 LOC；个人号实验体量无法可靠估计。主要风险：平台审核/主体资格、callback 稳定公网地址、消息时效、个人号协议与封号。Go/No-Go 条件：稳定 sender identity、官方允许的双向消息能力、可验签 inbound、可安全持久化 target，四项缺一则不产品化。

### Phase 3：多 channel 与独立 daemon 评估

目标：多个 account/channel 同时在线、统一 health/route/audit；评估是否让 Gateway 在桌面端退出时仍收命令并拉起应用。

计划影响：

- 把 `im-gateway` 提取到独立 package 或受控 child process（只有 Electron 依赖清零后）；
- 新增本地 Unix socket/named pipe RPC、随机 credential、schema/version handshake、single-instance lease；
- 新增 launchd/systemd/Task Scheduler installer 和 health/status；
- adapter crash isolation、per-account backoff、route store、secret rotation；
- 若采用稳定生产 tunnel/Tailscale，新增迁移策略，quick tunnel 继续保留为开发/MVP 模式。

体量：5 个以上 PR，2,000+ LOC。主要风险：两个进程争抢 tunnel/port、daemon 与 app 版本漂移、app 拉起体验、凭证迁移、系统服务安装权限。该阶段才真正对齐 OpenClaw 的物理 daemon 形态。

## 6. MVP 明确不做什么

与现有方向稿 `im-gateway-remote-orchestration.md:18-20,81-96,113-120` 一致：

- **不做编排大脑。** 除三命令外的消息返回 help/unsupported，不自行创建 session、选择项目、调 Engine 或跨 room 指挥。
- **不做 IM 内富交互审批。** approval 继续走现有手机 Web UI；不做按钮卡、逐工具 allow/deny、remember scope 映射。
- **不做多租户。** MVP 是单 CodeShell owner、少量显式 channel account/sender allowlist；没有 tenant 隔离、配额、计费或管理员层级。
- 不把所有 `MobileClientEvent` 暴露成 IM 命令，不在 adapter 中复制 room/session/chat 协议。
- 不在群聊返回 pairing URL，不做自然语言命令猜测，不允许消息正文指定 outbound target。
- 不把 access passcode 发进 IM，不做免 passcode deep link，不把 pairing token 改成长效 token。
- 不自动重启并静默更换 quick tunnel URL，不承诺 TryCloudflare 生产 SLA。
- 不在 MVP 加载任意第三方 adapter 包；源码内显式 registry 足够验证抽象。
- 不把微信个人号非官方协议包装成“官方支持”，不承诺不封号。
- 不在第一个 PR 安装 launchd/systemd daemon，不同时解决“应用退出后仍可用”。

## 7. 关键验收与待决策项

### 7.1 MVP 验收清单

- 100 个并发、provider message ID 各不相同的 `/open` 只 spawn 一个 tunnel，并可在共享启动完成后为各请求独立 mint pairing token；相同 provider message ID 则必须去重；
- `/close` 与 opening 竞争不会留下 cloudflared、metrics port、HTTP server 或 WS；
- open 状态重复 `/open` 不更换 public URL；
- `/status` 不创建 pairing token、不触发网络副作用；
- LAN host 存在时 `/open` fail closed，不暴露无 passcode host；
- tunnel edge 未 ready 时绝不回推链接；
- duplicate provider event 不重复执行命令；
- 未授权 sender、群聊、可变 username 冒充都不能获得状态或 URL；
- 日志/错误/metrics 中不存在 bot token、passcode、pairing query、device secret；
- outbound 重试不重新 mint pairing URL；
- tunnel crash 不自动换地址，并能向登记 owner route 推一条脱敏通知；
- 现有 LAN/tunnel 设置页和手机 pairing/auth/chat/room 流程保持兼容。

### 7.2 需要产品或后续 spike 决策

1. 电脑开着但 CodeShell 未启动时，第一版是否接受“不可用”，还是必须让 daemon 拉起 app？本文建议 MVP 接受，daemon 后置。
2. 微信目标究竟是个人微信、公众号还是企业微信？三者身份、权限和风险完全不同，不能共用一个模糊需求。
3. owner route 是只回复当前请求，还是允许配置多个异步通知目标？MVP 建议“当前已鉴权私聊 + 最多一个显式 owner target”。
4. quick tunnel 何时迁移到 named tunnel/Tailscale/其他稳定入口？Cloudflare 官方不为 Quick Tunnel 提供生产 SLA，真实发布前必须单独决策。
5. Gateway Core 是否最终进入 `packages/core`？当前不应进入：它依赖 desktop mobile host/tunnel，违反 Core First 的 UI/产品边界；只有 provider-neutral envelope/adapter type 被第二个产品复用时再提取。

## 一句话结论

**gateway MVP 的第一个可落地 PR 是：在 Electron main 内新增一个不依赖任何真实 IM SDK 的 `MobileRemoteLifecycle + GatewayCore`，把现有 `mobileRemote:start/stop/status/pairingUrl` 统一收口为可测试、串行化、会返回现有 pairing URL 的 `/open /close /status` 三命令处理器。**

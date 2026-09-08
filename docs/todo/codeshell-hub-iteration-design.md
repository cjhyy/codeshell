# CodeShell Hub 迭代设计：一套代码、双宿主（Electron + Server）

> 状态：I1 单管理员 Node.js/Docker 部署已实现；两种 Web 已共用 Workbench 和管理服务；协议统一、多用户及远程 Panel Host 待实施<br>
> 日期：2026-08-28  
> 修订：v6（2026-09-09）：增加独立 Link Server 双向 OAuth 需求与独立交付轨道，尚未实施。
> v5（2026-09-08）：Desktop Web / Hub 共享 Workbench、同一 Desktop Worker、配对 Cookie facade 与 Link 管理已接入，详见 §1.0。
> v4（2026-09-08）：补记模型/Skills/MCP 管理、历史/文件、流式恢复及 Linux 容器验证。
> v3（2026-09-08）：本轮部署目标明确为直接使用 Node.js，I1 改以原生启动验收。
> v2（2026-09-06，按 0.9.6 源码复核，当时 I0–I4 均未开工）；
> §1.2「两套浏览器协议」中 serve 侧的"原始 RPC 直通"表述已证伪，实为 3 方法白名单
> （见上游 v3 §2.1）；§1.2 桌面 mobile-remote 面被少算 2 文件 14 事件族（§1.3）；
> IPC 计数与全文 file:line 锚点重校（§1.4）<br>
> 上游文档：`codeshell-hub-remote-service-architecture.md`（方向稿，本文规划其 Phase 1–3）<br>
> 交叉文档：`multi-folder-local-project-plan.md`（多目录本地项目，实施中，见 §8）  
> 硬约束：① 兼容服务端部署；② 桌面端（Electron）零回归；③ 客户端与执行面尽量一套代码两种宿主

## 0. 结论

不需要"把桌面搬上服务器"，也不需要重写客户端。按源码核验，**执行面今天已经是一套代码**，
浏览器语义协议**已经存在且类型定义在 core**，共享客户端库**已经有先例和 lint 白名单机制**。
以下三项保留原始迭代目标，不代表实现必须沿用同一拆分顺序。当前已先让 Desktop Web 与
Hub 共用 `web/app/Workbench` 和服务端管理逻辑，保留两个 transport controller；未迁移
Electron 原生 renderer，也未把两种 WebSocket 协议强制合并。当前交付以 §1.0 为准：

1. **收敛协议**：淘汰 serve 的"原始 RPC 白名单直通"，把 desktop 内嵌 mobile remote 的
   语义协议（client event）提升为唯一浏览器协议，服务端 handler 下沉 `packages/server` 供
   Electron 与 Hub 两个宿主共用。
2. **收敛客户端**：共享代码统一放 `packages/web/src`（不建新包），桌面 renderer 用已有的
   "下沉 + re-export shim"模式渐进接入；传输层抽象成双 adapter
   （Electron IPC / WSS），UI、状态、语义 hooks 一套代码。
3. **serve → hub-lite**：登录替换 passcode、health/uploads/部署产品化、审批 lease，
   然后按用户维度实例化现有 `WorkerBridgeCore`（env 注入数据根的机制 serve 已有）。

桌面端在全过程中不改 preload/main 的既有 IPC 契约，每个迭代以桌面全量测试 + typecheck +
golden 不变作为验收门。

### 独立 Link 交付轨道（2026-09-09）

新增需求：独立 Node/Docker Link Server 向上游连接第三方 OAuth 服务，向下游让 CodeShell
与其他应用经 OAuth2 取数。它有独立 owner、client、connection 和 grant，不并入 Hub 的
Worker/项目管理，也不要求先完成多用户 Hub。

交付顺序为：独立存储/登录与上游 GitHub → 下游应用同意、令牌和只读 API → CodeShell
共享管理 UI 与 remote Link 执行适配器 → Docker 及真实 provider 验收。前两步共同构成
双向 OAuth 最小版本；目前都未实施，现有宿主 Link 管理不计作独立服务已完成。
完整设计见 [Link Server 架构](link-server-oauth-architecture.md)。

## 1. 现状盘点（已核验，这是设计的地基）

### 1.0 落地进度（2026-09-09）

本轮按直接使用 Node.js 的部署目标，先完成 **I1 单管理员远程闭环**。
运行方式及配置见 [`../deployment.md`](../deployment.md)。

| 迭代                             | 当前状态                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I0 共享客户端骨架                | 已有 `WorkbenchController`、Desktop controller 与 Hub controller；两个 Web 入口共用页面，`web/src/lib` 共用流式与历史投影；原方案的通用 RPC client 未提炼 |
| I1 个人远程闭环                  | 已实现 Node.js 与 Docker：一次性初始化、登录及设备撤销、HTTP/WS 认证、审批 lease、受限上传、PWA、有界运行恢复、持久化和部署说明                           |
| I2 语义协议与 Gateway 统一       | 两种浏览器协议保留；新增 Desktop 配对 Cookie facade，复用 Hub 管理 handler；多租户 Gateway 未实施                                                         |
| I3 多用户                        | 未实施；只有一个管理员、一个部署 Workspace、一个 Worker                                                                                                   |
| I4 桌面级 Web Shell / Panel Host | 两种 Web 共用工作台、消息、模型、Skills、MCP、历史、文件、Link 和面板；Web 面板支持安装、续租、进程、独立任务与工具回调，完整原生 SDK 适配仍未完成        |

落点：`packages/server/src/hub/`、`packages/server/src/serve/`、`packages/web/app/`、
`packages/server/src/desktop-web/`、`packages/server/src/links/`、`packages/server/src/panels/`、`packages/web/src/lib/`、
`packages/core/src/skills/{management,github}.ts`、
`deploy/`、`Dockerfile`、`compose.yaml`、`scripts/smoke-hub-server.mjs`。
CLI 默认 Hub 登录，既有库调用和显式 `--auth passcode` 保留旧口令形态。
服务器显式为 stdio Worker 选择本地凭证读取；桌面继续使用原有 IPC 凭证路径。

模型、Skills 开关和 MCP 设置经认证 HTTP API 写入 Workspace 本地层，忙时拒绝修改，
空闲时通过 Core 热更新用于下一次任务。Skill 文件管理与 GitHub 安装逻辑提取到 Core，
Desktop 与 Hub 共用；会话标题存储、历史消息投影也共用实现。Web 文件接口只读且限制在
宿主授权的 Workspace 内，用户级和插件 Skill 来源不会被当作项目可写目录。

Desktop 的 `mobile/main.tsx` 加载共享 `DesktopApp`，经原 `useRemoteApp` 驱动已有
`AgentBridge` 与 Worker；Web 不再另外维护一份工作台 UI，也不创建第二个 Worker。
配对设备换取短期 HttpOnly Cookie 后访问管理接口，宿主只接受桌面已知的项目或会话目录。
Hub 保留管理员认证和固定 Workspace。具体接口边界见 [共享 Web 工作台](shared-web-workbench.md)。

独立 Link 页面复用纯 Node 服务商目录、token 验证/保存、CLI 状态/绑定和设备授权服务；
Desktop 保存适配也使用该服务。新连接为宿主用户级凭证，Web 不启动交互式 CLI 登录，
OAuth 过期需重新授权。模型设置、MCP 连接和 Link 是三种不同配置，不能互相替代。

先完成原生启动，再按本地试用后部署其他机器的目标补齐镜像、Compose 和构建上下文白名单。
本机 Linux 容器已运行真实 Node 22/Core，并使用隔离模拟模型验证浏览器对话流程；
部署步骤见 [`../docker-deployment.md`](../docker-deployment.md)。
原方案的 `RemoteHostBridge` 与 `web/src/client` 仍未提炼；本轮共享落在 controller 和
业务 HTTP handler，不据此宣称协议统一或多用户已完成。浏览器/PWA 可连接远端 Hub；
Electron 原生窗口的远端执行目标仍未实现。

验证覆盖：真实 Node CLI 与 Core Worker，在隔离临时目录连接本地模拟模型，完成
初始化、流式对话、审批后写文件、停止、重启保留登录及历史、携带历史续聊。
浏览器验证还覆盖 Markdown、模型提供的实时思考、工具展示、运行中刷新、附件与草稿恢复，
以及部分流式失败后回退结果和历史的一致性。以上模拟模型验证未调用外部模型服务。
Linux systemd/Caddy 配置作为部署示例提供，尚未在目标服务器实际运行。

当前边界：单管理员多设备不等于多用户隔离；运行事件缓冲有容量上限，服务重启只恢复
已保存历史，不自动续跑中断任务；草稿仅保留在当前页面内。插件市场、完整原生 Panel SDK 适配和
Hub 多 Workspace 切换仍未交付。Web 面板以 `availableMethods` 为准，Cookie、音频、媒体、自动化、PDF 等仍未完整接入；见 [Web 面板](../web-panels.md)。Desktop Web 可切换桌面已知项目，不能据此推断 Hub 已有多用户目录注册。

本节描述源码完成范围，不代表运行中的旧构建已升级。Desktop 需重建主进程及 mobile
页面并重启应用。本机 8790 已升级到共享工作台与 Link，验收见 [打磨记录](hub-usability-polish.md)。

以下 §1.1a–§1.5 保留 2026-09-06 的源码复核记录，文件行号属于当时快照；§2 之后为
原始实施方案，尚未完成的退出标准不能覆盖本节的实际落地状态。

### 1.1a 锚点漂移（v1 → 0.9.6）

`headless-server.ts` 因 `cb94334e`/`fe7b48ef` 从约 440 行增至 573 行，
该文件所有锚点整体下移约 50 行。逐条更正：

| v1 引用                                    | 0.9.6 实际                                                   | 内容是否仍成立         |
| ------------------------------------------ | ------------------------------------------------------------ | ---------------------- |
| `agent-bridge.ts:110`（组合 core）         | `:206` 类声明 / `:208` 字段（`:110` 是 import）              | 是                     |
| `agent-bridge.ts:162`（worker 入口）       | `:163`                                                       | 是                     |
| `agent-bridge.ts:207`                      | `:208`                                                       | 是                     |
| `agent-bridge.ts:306`                      | `:307`                                                       | 是                     |
| `agent-bridge.ts:308-315`（能力包）        | `:313-316`（URL 解析 `:170-172`）                            | 是                     |
| `headless-server.ts:89-94`                 | `:90-100`                                                    | 是                     |
| `headless-server.ts:113-117`               | `:122-129`                                                   | 是                     |
| `headless-server.ts:163-169`（数据根注入） | `:219-229`（`CODE_SHELL_DATA_ROOT` 在 `:225`）               | 是                     |
| `headless-server.ts:273`                   | `:192-217`                                                   | 是                     |
| `headless-server.ts:286-289`               | `:302`、`:307`                                               | 是                     |
| **`headless-server.ts:307`（注入点）**     | **`:383-384`**                                               | **表述有误，见 §1.2a** |
| `headless-server.ts:364-440`               | `:465`/`:523`/`:529`                                         | 是                     |
| `worker-bridge-core.ts:177-179`            | `:177-181` spawn（`ensureWorker` `:167`）                    | 是                     |
| `mobile-remote-types.ts:97-325`            | client union `:97-207`；server union `:209`-约`:330`         | 区间超出 139 行        |
| `handle-client-event.ts:210-517`           | `:226-560`（`daed4836` 后 +23 行）                           | 是                     |
| `preload/index.ts:370-421`                 | `:395-428`                                                   | 是                     |
| `preload/index.ts:521`（`timeoutMs=0`）    | `:535`                                                       | 是                     |
| `web/package.json:18-24`                   | `exports` `:8-14`、`files` `:15-18`（`:18-24` 现为 scripts） | 是                     |
| `renderer/uiLanguage.ts:13`                | `:7-13`                                                      | 是                     |
| `web/app/App.tsx:14-20`                    | `:13-20`                                                     | 是                     |
| `useRemoteSocket.ts:155-193`               | `:150-195`                                                   | 是                     |

另：§1.1「数据根注入」一行的证据配错了——`CODE_SHELL_DATA_ROOT` 由
`headless-server.ts:225` 注入，`serve/cli.ts:62,72` 只是算出 `dataDir`。

### 1.2a 更正：serve 侧不是「原始 Core JSON-RPC 直通」

§1.2 表格把 serve SPA 描述为"原始 Core JSON-RPC 行 + 白名单"，并在多处以
"浏览器持有完整 Core RPC 直通"作为 I2 的紧迫性论据。**按源码这是高估。**

实际浏览器面 = **3 方法**（`headless-server.ts:523`
`agent/run`|`agent/approve`|`agent/cancel`，其余 `-32601`）+ **强制 `cwd` 改写**
（`:348-355`，覆写为部署 workspace）+ **宿主直答会话查询**（`:465`）+
**每 tab 64 在途上限**（`:359-368`，`cb94334e` 新增）。

对 I2 的影响：

- **仍要做**：两宿主一套 handler、两客户端一套 hooks 的收敛价值不变。
- **但紧迫性论据要换**：不是"关掉一个危险的完整直通"，而是"现有 3 方法面没有
  账号 ownership 维度，且 `cwd` 钉死单 workspace，多用户走不通"。
- **I2 第 3 条**"原始 RPC 直通白名单收敛为空"的描述可保留，但要知道它今天已经
  只有 3 项，不是全量协议。

### 1.3 更正：桌面 mobile-remote 面被少算

§1.2 只提 `handle-client-event.ts`，实际桌面侧是 **3 文件 26 个事件族**：

| 文件                                                           | 事件族数 | 例                                                                   |
| -------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `handle-client-event.ts`（`:226` 分发）                        | 12       | `chat.send` `:332`、`approval.respond` `:384`、`session.sync` `:471` |
| `handle-cc-room-event.ts`（`handle-client-event.ts:254` 委派） | 7        | `ccRoom.probe` `:35`、`ccRoom.openSession` `:61`                     |
| `handle-room-event.ts`（`:259` 委派）                          | 7        | `room.create` `:78`、`room.send` `:125`                              |

D4「desktop 内嵌 mobile host 改为消费下沉后的共享 handler」必须把这 3 个文件都算进去，
**I2 的工作量估计据此上调**。

有利的反向证据（D4 可行性）：`auth.device` / `pair.complete` 两族**已经在服务端**，
由 `packages/server/src/mobile-remote/remote-host-manager.ts` 处理
（validator 见 `mobile-client-event-validator.ts`，`remote-host-manager.ts:14` 引入）。
且 `packages/server/src/` 全目录**零 electron import**，已下沉模块共 20 个
（见 `packages/server/src/index.mobile-remote.ts:2-21`），远多于 §1.1 只提的两个。

### 1.4 更正：IPC 计数

| §1.2 原文                         | 实际（0.9.6）                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 347 个 `ipcMain.handle`           | **346** 个调用点（`packages/desktop/src/main`，排除 test）；含 test 347；**去重后 250 个频道名**                                                         |
| 约 298 个 `window.codeshell` 方法 | **偏低**。`CodeshellApi`（`preload/types.d.ts:1024-2394`）函数成员 343 个；另继承 `ProjectAuthorityApi`（`project-authority-types.ts:78-158`）再加 44 个 |
| 30+ 命名空间                      | **57** 个                                                                                                                                                |

D6「不承诺 347 个 IPC 全量对等」应改为 **346**（或按去重口径 250）。

### 1.5 v1 之后落地、本文未反映的改动

- `cb94334e`（2026-09-01）WS 在途请求上限 64 + TTL reaper（`headless-server.ts:104-111,359-368`）
- `fe7b48ef`（2026-09-01）per-tab send 隔离（`:130` `sendToTab`）
- `daed4836`（2026-09-02）**给 `agent/run` 换成 turn-scale 超时，直接改了
  `handle-client-event.ts`**。这条对 **D3 不利**：D3 论证"只有 Electron 的
  `agent:msg` 路径针对长回合调优过（`preload/index.ts:535` `timeoutMs=0`）"，
  但现在语义协议路径也有了 turn-scale 超时处理——**这反而是 D2/D4 的正面论据**，
  应在下一版 D3 里重新权衡。
- `9c396c42`/`43c0e116` 静态资源按 realpath 收敛——与 I4 的 Panel Asset Host 相关。
- 多目录方案已部分落地：`handle-client-event.ts:200-221`
  （`resolveMobileSessionCreateTarget`）已实现 `projectId`/`rootId` V2 身份 +
  legacy `cwd` 回退（对应 `mobile-remote-types.ts:119-129`）。**§8 称其"实施中"
  对 mobile session.create 这条路径已过时。**

### 1.1 已经是"一套代码"的部分（不动，只复用）

| 层                            | 事实                                                                                                                                                                                 | 证据                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Worker 入口                   | desktop 与 serve 共用 `@cjhyy/code-shell-core/bin/agent-server-stdio`                                                                                                                | `agent-bridge.ts:162`、`serve/cli.ts:78-81`（注释直言 "the same way desktop's AgentBridge does"） |
| Worker 监管                   | desktop 的 `AgentBridge` **组合**（非继承）`WorkerBridgeCore`（零 Electron import），spawn/respawn/行帧/id 关联全在后者                                                              | `agent-bridge.ts:110,207,306`、`worker-bridge-core.ts:177-179`                                    |
| 数据根注入                    | serve 已用 `CODE_SHELL_DATA_ROOT` 给 worker 注入独立数据根，且宿主强校验 session 目录一致                                                                                            | `headless-server.ts:163-169,89-94`、`serve/cli.ts:62,72`                                          |
| 浏览器语义协议类型            | `MobileClientEvent`/`MobileServerEvent` 定义在 **core**（transport-agnostic），含 auth/pairing、chat、审批、session 快照/流（`{seq, event}` + `nextSeq` 断线重放）、上传、goal、room | `packages/core/src/protocol/mobile-remote-types.ts:97-325`                                        |
| 语义协议的 host-agnostic 半边 | `mobile-run-dispatch.ts`、`mobile-chat-turn.ts` 已经在 `packages/server`，desktop 只留 Electron 绑定                                                                                 | `packages/server/src/mobile-remote/`                                                              |
| 共享客户端库                  | `packages/web` 双形态：`src/` 是 hooks/lib 库（desktop 手机 UI 全建在其上），`app/` 是独立 SPA（serve 托管其 `dist-app/`）                                                           | `web/package.json:6-7,18-24`、`serve/cli.ts:99-101`                                               |
| renderer 共享机制             | 桌面 renderer 运行时 import `@cjhyy/code-shell-web` 有 lint 白名单；"逻辑下沉 web、renderer 留 re-export shim"已有先例                                                               | `eslint.config.js:53-56`、`renderer/uiLanguage.ts:13`                                             |
| 流式状态纯函数                | `streamReducer`/`riskClassify` 在 `web/src`，同时被 mobile UI 与 serve SPA 消费                                                                                                      | `web/app/App.tsx:14-20`                                                                           |

### 1.2 分叉的部分（本设计要收敛的对象）

**两套浏览器协议**：

|         | serve SPA（`web/app`）                                                                                                                                         | mobile PWA（`desktop/src/mobile` + `web/src` hooks）                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 协议    | 原始 Core JSON-RPC 行，服务端投影：`agent/query` 的 sessions 由 host 直答，其余白名单 `run/approve/cancel`，`cwd` 强制改写，请求 id 翻译为 `serve-<tabId>-<n>` | 语义化 client event（`chat.send`/`approval.respond`/`session.sync`…），desktop Main 翻译成 RPC 后注入          |
| 证据    | `headless-server.ts:192-217,302,465/523/529,122-129,383-384`（锚点已按 0.9.6 重校，见 §1.1a）                                                                  | `handle-client-event.ts:226-560` + `handle-cc-room-event.ts` + `handle-room-event.ts`（3 文件 26 族，见 §1.3） |
| 认证    | passcode + remember-cookie（`access-passcode.ts`）                                                                                                             | pairing + device credential（`useRemoteSocket.ts:155-193`）                                                    |
| HTTP 面 | 仅静态 SPA + passcode 网关，无 `/health`、无上传                                                                                                               | `/health`（`remote-host-manager.ts:158`）、`PUT` 上传（`:163-170`）、静态 `/mobile/*`（`:180`）                |

**两套宿主服务面**：桌面 renderer 依赖 `window.codeshell` 上 343+44 个函数成员 / 346 个
`ipcMain.handle` 调用点（去重 250 个频道名，**57** 个命名空间：
sessions/projects/git/review/panel-apps/automation/pet/…）。计数口径与更正见 §1.4。
agent 流量不走 handle，走 `agent:msg` 通道上的**原始 JSON-RPC 行**（`preload/index.ts:6-9`），
统一封装 `rpc()` 在 preload（`:395`，`agent/run` 显式 `timeoutMs=0` 永不超时 `:521`）。

**能力包差异**：desktop worker 装 coding+arena+pet，serve 只装 coding
（`agent-bridge.ts:308-315`、`serve/cli.ts:88-90`）。

## 2. 目标形态与关键设计决策

```text
                    ┌─────────── 一套客户端代码（packages/web/src） ───────────┐
                    │  UI 组件 · streamReducer/transcripts 状态 · 语义 hooks    │
                    │            （useRemoteApp / useRemoteSocket / …）        │
                    └──────┬──────────────────────────────┬────────────────────┘
                    ClientTransport adapter          ClientTransport adapter
                     = Electron IPC (agent:msg             = WSS (语义协议 v1)
                       + window.codeshell)                        │
                           │                                      │
┌──────────────────────────┴───────────┐   ┌──────────────────────┴───────────────┐
│ 宿主 A：Electron Main                │   │ 宿主 B：CodeShell Hub（server 包）    │
│  AgentBridge（Electron 绑定）        │   │  hub auth · gateway · 审批 lease     │
│      └── 组合 ──┐                    │   │      └── 组合 ──┐                    │
└─────────────────┼────────────────────┘   └─────────────────┼────────────────────┘
                  ▼                                          ▼
        ┌──────── 一套服务端语义协议 handler（packages/server/src/mobile-remote）───────┐
        │        依赖 RemoteHostBridge 接口，由两个宿主分别注入实现                     │
        └──────────────────────────────┬──────────────────────────────────────────────┘
                                       ▼
              一套执行面（现状已统一）：WorkerBridgeCore → agent-server-stdio
                          （Hub 侧 per-user 多实例 + CODE_SHELL_DATA_ROOT）
```

### D1 共享客户端代码宿主 = `packages/web/src`，不建新包

理由：它已经是发布库 + 已在 renderer 运行时白名单 + 已被 mobile UI 和 serve SPA 双端消费。
桌面 renderer 接入一律走"逻辑下沉 web/src、renderer 留 re-export shim"
（先例 `renderer/uiLanguage.ts:13`），每次一个文件、由现有 renderer 测试守护。

### D2 唯一浏览器协议 = 语义 client-event 协议（现 mobile-remote 协议）演进为 v1

serve 的原始 RPC 直通被 Gateway 取代（上游文档 §7.1 已定为 Phase 2 硬前置）；与其新造一个
Application 协议，不如提升已有的语义协议——它已具备设备认证、审批、上传、`{seq,event}` 流 +
snapshot 重放，且类型就在 core。收敛后 serve SPA 与 mobile PWA 用**同一套客户端 hooks**。
命名中的 `Mobile*` 前缀后续统一更名 `Remote*`（additive alias，不破坏现有 import），
本设计各迭代内不做破坏性重命名。

### D3 桌面 renderer 保持原始 RPC over `agent:msg`，不强迁语义协议

Electron renderer 在信任边界内（就是"本人"），Gateway 原则不适用；`agent:msg` 直通零成本且
永不超时语义已针对长回合调优。"一套代码"指 **UI/状态/语义 hooks 层共享**，传输差异封在
adapter：`ElectronAgentTransport`（现 preload `rpc()` 语义）与 `HubSocketTransport`（语义协议）。
两个 adapter 汇入同一个 `StreamEvent` 流，进同一个 reducer。

### D4 语义协议服务端 handler 下沉 `packages/server`，宿主注入 `RemoteHostBridge`

`handle-client-event.ts`（现在 desktop/main）的 host-agnostic 部分继续沿
`mobile-run-dispatch.ts`/`mobile-chat-turn.ts` 已开的路下沉；定义 `RemoteHostBridge` 接口
（注入 worker 行、请求 worker、session 查询、上传存储、审批路由），Electron 由 `AgentBridge`
实现，Hub 由 worker 池实现。desktop 内嵌 mobile host 改为消费下沉后的共享 handler，
行为等价由现有 `handle-client-event.test.ts` 守护。

### D5 执行面不动；多用户 = `WorkerBridgeCore` 多实例池

`RuntimeSupervisor: Map<userId, WorkerBridgeCore>`，每实例 env 注入
`CODE_SHELL_DATA_ROOT=data/users/<userId>`（沿用 serve 已有机制），空闲逐出、崩溃只影响
所属用户。不改 worker 入口、不改 core 的单进程假设。

### D6 宿主服务面按 Tier 收敛，不承诺 346 个 IPC 全量对等（去重 250 个频道，见 §1.4）

- **Tier 0（Hub MVP 必须）**：会话列表/历史/同步、run/steer/stop、审批、上传、
  permission mode、model 选择——语义协议已全部覆盖。
- **Tier 1（Hub 增强）**：文件面板只读、git/review 只读、settings 只读投影。
- **Tier 2（Electron 专属，Hub 明确不做或远期）**：panel-app bridge 本机形态、pet、
  im-gateway、pty、browser-runtime、updater、externalRuntime 等。

Web Shell 的功能开关按 Tier 探测宿主能力（capability negotiation），缺失即隐藏入口，
不是报错。

### D7 桌面零回归护栏（每迭代验收门，缺一不可）

1. 不改 preload/main 既有 IPC 通道名与语义；共享化只以"下沉 + shim"进行。
2. lint 边界维持：renderer 运行时 import 白名单（`eslint.config.js:53-56`）按需逐条加，
   禁止放开整包通配。
3. 每迭代收尾统一执行：
   `bun run --filter '@cjhyy/code-shell-core' build`（desktop 测试吃 core dist）→
   `cd packages/desktop && bun run typecheck` → desktop 全量 `bun test` →
   golden fixture 与版本号零变化。
4. 只对改过的文件跑 prettier，不跑 `bun run format`。
5. 涉及跨进程写共享文件（auth store、lease store）一律复用 `acquireFileLock` 一套锁约束，
   不新写锁。

## 3. Iteration 0：共享客户端骨架（零行为变化）

**目标**：立好接口，不迁移任何存量代码，桌面与 serve 行为零变化。

改动落点（全部新增文件）：

1. `packages/web/src/client/transport.ts`：
   ```ts
   /** 一条 Core JSON-RPC 行的双向传输，Electron IPC 与 WSS 各自实现。 */
   export interface AgentLineTransport {
     send(line: string): void;
     onLine(cb: (line: string) => void): () => void;
     onDown(cb: (reason: "exit" | "disconnect") => void): () => void;
   }
   ```
2. `packages/web/src/client/rpc-client.ts`：从 preload `rpc()`（`preload/index.ts:370-421`）
   **提炼**（不是搬走）id 分配、pending 关联、`rpcResult` 解包、`agent/run` 永不超时语义；
   preload 本迭代不动，后续迭代再让 preload 委托它（shim 模式）。
3. `packages/web/src/client/host-services.ts`：Tier 0 接口定义 + capability 探测协议
   （`host.describe → { tiers, features }`）。
4. `packages/web/src/client/index.ts` 导出；`web/src/index.ts` 追加 re-export。

**测试**：`packages/web/src/client/rpc-client.test.ts`（id 关联、超时、永不超时路径、
传输中断时 pending 全部 reject）。

**验收**：

```bash
cd packages/web && bun test && bun run build
# D7 全套桌面门禁
```

**退出标准**：web 新增测试绿；desktop 无任何 diff。

## 4. Iteration 1：serve → hub-lite（单用户远程闭环，对应上游 Phase 1）

**目标**：原生 Node.js 启动，单管理员登录，手机 PWA 可用，重启可恢复。
2026-09-08 已按本轮目标实现；以下是原始计划清单，其中容器项由原生构建/启动命令及
systemd、Caddy 示例替代。浏览器保留 3 方法白名单与固定 Workspace，属于单用户已知边界。

改动落点：

1. `packages/server/src/hub/auth-store.ts`：管理员一次性初始化 token、登录、opaque session
   cookie（`HttpOnly/Secure/SameSite`）、设备列表与撤销。存储为文件 + `acquireFileLock`，
   复用 trust-store 的安全约束（0600、原子 rename、坏条目隔离、上限）；SQLite 留到 I3 再决策。
2. auth-store 的凭据形态同时支持 **cookie 与 bearer token**（同一 session 记录、两种载体）：
   浏览器用 `HttpOnly` cookie；未来原生手机 App（§10）用 token + 系统安全存储。
   这是一行接口预留，不是本迭代的功能。
3. `packages/server/src/hub/approval-lease.ts`：审批 lease——同一审批多 tab/多设备在线时，
   响应权按 lease 归一（先到先得 + TTL + 显式放弃），全 tab 广播 lease 状态。这是上游文档
   §5.2 要求随 Phase 1 一起定义的语义，落在 server 包使两宿主可共用。
4. `serve/headless-server.ts`：passcode 网关替换为 hub auth（登录页由 `web/app` 提供）；
   新增 `/health`；新增 `PUT /api/v1/uploads/:id`（语义对齐 desktop 的
   `mobile-upload-service`，实现先在 server 独立，I2 下沉合并）。
5. 部署产品化：`Dockerfile` + `docker-compose.yml` + 持久卷约定
   （`CODE_SHELL_HOME=/data`），启动输出一次性管理员初始化链接。
6. `web/app`：登录/初始化页、会话恢复（复用现有 `ProtocolClient`，本迭代不换协议）。

**测试**：`hub/auth-store.test.ts`（并发登录、cookie 轮换、撤销即断、跨进程锁）、
`hub/approval-lease.test.ts`（抢占/TTL/放弃/广播）、`serve/headless-server.test.ts` 扩
（未登录 401、登录后 WS 升级、`/health`、上传落盘路径 containment）。

**验收**：

```bash
bun test packages/server/src/hub packages/server/src/serve
docker compose up -d && curl -f http://localhost:<port>/health
# 手工：初始化链接 → 登录 → 手机 PWA 会话/流式/审批/停止 → 重启容器 → 会话恢复
# D7 全套桌面门禁（desktop 零文件重叠，跑门禁确认无意外耦合）
```

**退出标准**：上游文档 §10 Phase 1 全部勾选；desktop 无 diff。

## 5. Iteration 2：语义协议统一 + Gateway（退役原始 RPC 直通）

**目标**：两宿主同一套服务端 handler、两个浏览器客户端同一套 hooks；浏览器直通关闭。
这是"一套代码"的核心迭代。

改动落点（顺序即提交顺序）：

1. `packages/server/src/mobile-remote/remote-host-bridge.ts`：定义 `RemoteHostBridge`
   接口（`injectWorkerMessage(line, meta)`、`requestWorker(...)`、session 列表/历史读取、
   上传存储、审批路由回调）。类型对齐 `WorkerFrameMeta`（origin 透传已在 main）。
2. `handle-client-event.ts` 的 host-agnostic 逻辑按事件族逐个下沉
   `packages/server/src/mobile-remote/`（chat/approval/run 已下沉一半，补
   session.list/history/sync、permission、model、goal 族）；desktop 侧文件变成
   "Electron 绑定 + 委托"薄层。**每下沉一族跑一次
   `packages/desktop/src/main/mobile-remote/handle-client-event.test.ts`**，行为等价强制。
3. Hub 实现 `RemoteHostBridge`（单用户先绑定唯一 worker），serve WS 切换为语义协议入口；
   原始 RPC 直通白名单收敛为空（保留 `--dangerously-allow-raw-rpc` 调试 flag，默认关）。
4. `web/app` SPA 从 `ProtocolClient` 切换到 `useRemoteApp`/`useRemoteSocket`
   （即 mobile PWA 同款 hooks）；`ProtocolClient` 删除。认证 adapter 化：
   PWA 用 pairing/device credential，hub SPA 用 session cookie，socket 层同一套。
5. Gateway HTTP 面版本化：`/api/v1/auth|me|sessions|uploads|realtime`
   （上游文档 §7.1 清单的 Phase 2 子集）。

**测试**：`mobile-remote` 下沉各族的 server 侧单测（用 stub `RemoteHostBridge`）；
`handle-client-event.test.ts` 全量回归；web hooks 对 hub 认证 adapter 的新用例；
serve 集成测试断言 raw RPC 帧被拒（`-32601`）。

**验收**：

```bash
bun test packages/server/src/mobile-remote packages/server/src/serve packages/server/src/hub
bun test packages/desktop/src/main/mobile-remote
cd packages/web && bun test && bun run build && bun run build:app
# 手工：hub SPA 与手机 PWA 各自完成 会话/流式/审批/上传 全链路
# D7 全套桌面门禁（本迭代动了 desktop/main/mobile-remote，全量 desktop 测试必须绿）
```

**退出标准**：浏览器侧只剩语义协议;`web/app` 与 mobile UI 共享同一 socket/app hooks；
desktop 全量测试绿且 mobile PWA 行为无变化。

## 6. Iteration 3：多用户 + per-user Runtime（对应上游 Phase 2）

**目标**：User/Workspace Registry/Capability Profile 落地，一用户一 Worker，数据全隔离。

改动落点：

1. `packages/server/src/hub/runtime-supervisor.ts`：`Map<userId, WorkerBridgeCore>`，
   env 注入 `CODE_SHELL_DATA_ROOT=data/users/<userId>`（复用 `headless-server.ts:163-169`
   机制），懒启动、空闲逐出、崩溃重启只影响所属用户；`RemoteHostBridge` 实现改为按
   `userId` 路由到对应实例。
2. `hub/users.ts`、`hub/workspace-registry.ts`、`hub/capability-profile.ts`：
   上游文档 §4/§6 的数据模型（含 Workspace Overlay、ProfileBinding、revision）；
   存储决策点：仍文件+锁 或引入 SQLite（Personal 形态倾向前者，见开放问题 Q2）。
3. **core 路径入口参数化**：`sessionsRoot(home?)` 已参数化，补 credentials、settings、
   panel storage 等入口的可选 `home` 参数（默认行为不变 = 桌面不受影响），Hub 控制面
   以参数化数据根跨用户读索引，不靠进程 env 切换。
4. 上游文档 §4.4 落地：`projectTrusted` 由管理员策略决定；执行面按 Effective Profile
   过滤 workspace 内发现的 skills/hooks/MCP。
5. 能力包 Profile 化：worker 的 `CODE_SHELL_CAPABILITY_MODULES` 由 Profile 推导
   （现状 desktop=coding+arena+pet、serve=coding 的差异收编为 Profile 预设）。

**测试**：runtime-supervisor（隔离、逐出、崩溃恢复、并发两用户互不可见）、
users/registry/profile 的 store 测试（并发写、坏数据隔离、revision 单调——对齐
project-store 测试口径）、core 参数化入口的默认行为回归测试。

**验收**：

```bash
bun test packages/server/src/hub
bun run --filter '@cjhyy/code-shell-core' build && bun test packages/core/src/session packages/core/src/settings
# 上游文档 §11 验收场景 1-8、10（多用户部分）
# D7 全套桌面门禁（core 参数化默认值不变由 desktop 全量测试证明）
```

**退出标准**：上游 §11 场景 1–8、10 通过；desktop 全量绿。

## 7. Iteration 4：桌面级 Web Shell 与远程 Panel（对应上游 Phase 3）

**目标**：Web 长成桌面三栏体验；Panel 远程链路（上游 §5.4）落地；桌面 renderer 开始
按 shim 模式与 Web Shell 共享组件。

改动落点：

1. `web/app` 三栏布局（聊天/导航/Panel Dock），功能入口按 `host.describe` 的 Tier 探测。
2. Panel Catalog API、Panel Asset Host、Web Panel Host、Remote Panel Bridge——
   完全按上游文档 §5.4 的接口清单与能力分批（先 `context/storage/workspace/agent.submitPrompt`，
   `agent.task`/`process` 等后置）。
3. Desktop Panel Bridge 抽象为 host contract：`panel-app-bridge.ts` 的权限裁决/storage/
   agent-task 部分下沉可共享层，Electron 与 Hub 各自实现宿主端。
4. renderer 组件共享启动："新组件先写 `web/src`、renderer import"成为规约；存量组件
   仅在需要改动时顺势下沉（uiLanguage shim 模式），不做批量搬迁。

**验收**：上游 §5.4 最小验收场景 + D7 全套桌面门禁。
本迭代粒度较粗，开工前需按 I2/I3 的实际结果再出一版细化（Panel 部分单独成文）。

## 8. 与在途方案的关系

- **多目录本地项目方案**（**部分已落地，非"实施中"**——`handle-client-event.ts:200-221`
  的 `resolveMobileSessionCreateTarget` 已实现 `projectId`/`rootId` V2 身份 + legacy `cwd`
  回退，对应 `mobile-remote-types.ts:119-129`；见 §1.5）：本设计 I1–I2 与其零文件重叠原则——
  其改动集中在 desktop main / core engine / project-store，本设计集中在 server/hub、web、
  mobile-remote 下沉。唯一交叉点是 `WorkerFrameMeta`（origin 透传，已在 main）与
  `handle-client-event.ts`（其 Phase 2 会加测试用例）。**I2 的 handler 下沉必须在其
  Phase 2 的 mobile 改动合并后 rebase 进行**，避免双方同时改 `handle-client-event.ts`。
- Workspace 命名与映射按上游文档 §6.4 执行；I3 的 workspace-registry 落地时，
  多 root 项目 ↔ `workspaceId` 的映射决策与该方案作者共同定稿。
- serve 保持单 cwd 直到 I3（该方案 §3.2 非目标不被本设计提前打破）。

## 9. 风险与开放问题

| #   | 问题                                                    | 倾向                                                                                    | 决策时点   |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------- |
| Q1  | 语义协议 `event: unknown` 是否收紧为 `StreamEvent` 类型 | 收紧（additive，先加类型别名不改运行时）                                                | I2         |
| Q2  | Hub 元数据存储：文件+锁 vs SQLite                       | Personal 形态文件+锁（复用既有约束），Team 形态再上 Postgres（上游 §8.2）               | I3 开工    |
| Q3  | `Mobile*` 类型更名 `Remote*`                            | 只加 alias 不删旧名，I4 后统一清理                                                      | I2         |
| Q4  | preload `rpc()` 何时委托共享 `RpcClient`                | I2 之后、renderer 测试全绿时机会性进行；非任何迭代的退出条件                            | 机会性     |
| Q5  | pairing 与 cookie 两种认证长期是否统一                  | 不统一：PWA 配对适合局域网桌面伴生，cookie 适合 Hub；socket 层同码、auth adapter 双实现 | 已定（D2） |
| R1  | `handle-client-event` 下沉引入行为漂移                  | 逐族下沉 + 每族跑等价测试；desktop 侧保留薄委托层                                       | I2 全程    |
| R2  | core 路径参数化改默认行为                               | 每个入口"缺省 = 现状"并有回归测试；desktop 全量测试兜底                                 | I3 全程    |
| R3  | 多用户 worker 池资源失控                                | I3 带上限与逐出;上游 §9 的每用户配额条目在此落地                                        | I3         |

## 10. 原生手机 App 的接入路径（前瞻，不属于 I0–I4 交付）

D2 统一语义协议后，原生 App 只是**又一个协议客户端**，服务端除推送外零新增工作。
三条路径按投入递增：

1. **PWA（I1 即得，零额外投入）**：手机浏览器 + 添加到主屏。局限：iOS 推送/后台能力弱、
   无生物识别解锁、无系统分享接入。
2. **WebView 壳（推荐的第一个"上架"形态）**：Capacitor（或等价物）把 `web/app` 的
   `dist-app` 原样打包进原生壳，复用率 ~100%；原生桥只补四件事——
   推送（APNs/FCM，见下）、生物识别解锁（保护 bearer token）、系统分享/文件接入、
   角标与本地通知。壳内 SPA 与 Hub 之间仍是语义协议 + token，无私有通道。
3. **原生 UI（React Native，仅当体验瓶颈真实出现时）**：`web/src` 的协议与状态层
   大部分是 DOM 无关的纯 TS（`streamReducer`/`messageMappers`/`riskClassify` 直接复用；
   `useRemoteSocket` 只有 `location.origin` 等少量 DOM 触点，抽成注入参数即可在 RN 跑）。
   即：**只重写视图层，协议/状态/审批语义一行不重写**。这也是把共享代码放
   `packages/web/src` 且保持 hooks DOM 触点最小化的原因之一——I2 做 hooks 收敛时，
   DOM 依赖一律走注入，不直接引用 `window`/`location`。

服务端唯一的新增件是**推送网关**：审批到达/run 结束时经 APNs/FCM 唤醒 App
（Hub 存 device push token，挂在 auth-store 的设备记录上，I1 的 token 预留即为此铺路）；
App 被唤醒后仍走语义协议的 `session.snapshot`+`nextSeq` 补流，推送本身不携带内容
（避免 secret 过第三方通道，对齐上游文档 §9 脱敏要求）。

认证形态：原生 App 用 bearer token + 系统安全存储（Keychain/Keystore），
与浏览器 cookie 同源于一条 session 记录（I1 第 2 条预留）；desktop 伴生场景的
pairing/device credential 机制保持不变，两者不合并（Q5 已定）。

## 11. Definition of Done（整体）

- 一套 `packages/web/src` 客户端代码同时驱动：桌面 renderer（shim 渐进）、手机 PWA、
  Hub SPA；一套 `packages/server/src/mobile-remote` handler 同时服务 Electron 内嵌 host
  与 Hub。
- 执行面保持单一：`WorkerBridgeCore` + `agent-server-stdio`，Hub 侧仅是多实例化。
- 服务端部署满足上游文档 §11 十条验收；浏览器无原始 RPC 直通。
- 桌面端全程零回归：preload/main IPC 契约未变、desktop 全量测试与 typecheck 每迭代绿、
  golden 与版本号未变、mobile PWA 既有配对与功能不变。

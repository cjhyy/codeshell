# CodeShell Hub 迭代设计：一套代码、双宿主（Electron + Server）

> 状态：详细迭代设计稿（Draft for review）  
> 日期：2026-08-28  
> 上游文档：`codeshell-hub-remote-service-architecture.md`（方向稿 v2，本文实现其 Phase 1–3）  
> 交叉文档：`multi-folder-local-project-plan.md`（多目录本地项目，实施中，见 §8）  
> 硬约束：① 兼容服务端部署；② 桌面端（Electron）零回归；③ 客户端与执行面尽量一套代码两种宿主

## 0. 结论

不需要"把桌面搬上服务器"，也不需要重写客户端。按源码核验，**执行面今天已经是一套代码**，
浏览器语义协议**已经存在且类型定义在 core**，共享客户端库**已经有先例和 lint 白名单机制**。
本设计只做三件事：

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

## 1. 现状盘点（已核验，这是设计的地基）

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

|         | serve SPA（`web/app`）                                                                                                                                         | mobile PWA（`desktop/src/mobile` + `web/src` hooks）                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 协议    | 原始 Core JSON-RPC 行，服务端投影：`agent/query` 的 sessions 由 host 直答，其余白名单 `run/approve/cancel`，`cwd` 强制改写，请求 id 翻译为 `serve-<tabId>-<n>` | 语义化 client event（`chat.send`/`approval.respond`/`session.sync`…），desktop Main 翻译成 RPC 后注入      |
| 证据    | `headless-server.ts:273,286-289,364-440,113-117,307`                                                                                                           | `handle-client-event.ts:210-517`                                                                           |
| 认证    | passcode + remember-cookie（`access-passcode.ts`）                                                                                                             | pairing + device credential（`useRemoteSocket.ts:155-193`）                                                |
| HTTP 面 | 仅静态 SPA + passcode 网关，无 `/health`、无上传                                                                                                               | `/health`、`PUT /api/mobile/uploads/:id`、静态 `/mobile/*`（`remote-host-manager.ts:150-186,158,164-171`） |

**两套宿主服务面**：桌面 renderer 依赖 `window.codeshell` 上约 298 个方法 / 347 个
`ipcMain.handle`（30+ 命名空间：sessions/projects/git/review/panel-apps/automation/pet/…）。
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

### D6 宿主服务面按 Tier 收敛，不承诺 347 个 IPC 全量对等

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

**目标**：一台服务器一条命令部署，登录取代 passcode，手机 PWA 可用，重启可恢复。
本迭代**显式接受**原始 RPC 直通仍存在（单用户 = 部署者本人，上游文档 §10 已记录）。

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

- **多目录本地项目方案**（feature branch 实施中）：本设计 I1–I2 与其零文件重叠原则——
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

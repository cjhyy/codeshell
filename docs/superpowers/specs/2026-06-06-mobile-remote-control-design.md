# 设计:Mobile Web Remote 手机遥控与外部 Agent 编排

- 日期:2026-06-06
- 状态:Draft
- 范围:Electron 内置手机网页遥控入口;通过 CodeShell 驱动 Claude Code / Codex CLI 干活
- 非范围:公网中继、原生手机 App、手机端完整 IDE、手机端文件编辑器

---

## 1. 背景与目标

CodeShell 需要一个手机遥控入口:用户离开 Mac 或不想回到桌面时,仍能通过手机给当前 CodeShell 会话发任务、查看进度、处理权限审批,并让 CodeShell 调度 Claude Code / Codex 等外部 coding agent 干活。

本设计选择 **Electron 内置 Mobile Web Remote**:

- 用户打开 CodeShell Electron 后,默认不暴露任何远程控制服务。
- 用户手动点击“开启手机遥控”后,Electron 启动一个局域网 HTTP/WebSocket server。
- 桌面端显示二维码,手机浏览器扫码打开网页即可使用。
- 首次配对后,手机成为 trusted device,后续可长期记住。
- 可信手机既是遥控器,也是权限审批器;手机上的 approve/reject 与桌面审批等价。
- 低风险只读操作自动运行;中高风险操作推到手机审批;高风险操作使用醒目警告,但可信手机仍可批准。

---

## 2. 决策摘要

| 决策点 | 选择 | 理由 |
|---|---|---|
| 手机形态 | Web/PWA,不是原生 App | 扫码即用,无需安装/上架,最适合局域网遥控 v1 |
| 网络形态 | 局域网直连;可由用户自管 SSH/Tailscale/WireGuard | 不引入公网中继和服务器运维 |
| Electron 默认行为 | 默认关闭;用户手动开启后临时监听局域网 | 降低无意暴露风险 |
| 长期记住设备 | 支持 trusted device | 主力手机无需每次扫码 |
| 手机审批权限 | 等同桌面审批 | 真正实现离开电脑也能遥控干活 |
| 低风险策略 | 当前 workspace 内只读自动允许 | 降低审批噪音,保持安全边界 |
| Claude/Codex 集成 | v1 用 CLI adapter + managed job | 当前最可落地,不依赖私有协议 |
| 公网 relay | 不做 | 用户明确不需要,且会引入服务端、账号、安全、成本 |

---

## 3. 用户体验

### 3.1 开启遥控

1. 用户在 Electron 设置页或状态栏点击“开启手机遥控”。
2. Electron 选择一个可用端口,绑定本机局域网地址和/或 localhost。
3. Electron 生成短期 pairing token,默认 10 分钟过期。
4. 桌面端显示二维码和本地 URL:
   `http://<mac-lan-ip>:<port>/mobile?pairing=<token>`。
5. 手机浏览器扫码打开 Mobile Web Remote。

默认情况下,remote host 不随 Electron 启动自动打开。用户必须显式开启。

### 3.2 首次配对

1. 手机打开 pairing URL。
2. 手机生成 device key pair 或随机 device secret。
3. 手机把 pairing token、device public identity、设备名称提交给 Electron remote host。
4. Electron 验证 pairing token 未过期且未使用。
5. Electron 写入 trusted device store。
6. 手机保存 refresh credential 到 localStorage / IndexedDB。
7. 手机进入 remote chat UI。

### 3.3 后续连接

- 如果 Electron remote host 当前开启,可信手机可直接访问 remote URL 并用 device credential 建立 WebSocket。
- 如果 remote host 关闭,手机无法连接;用户需要回到 Mac 上开启遥控。
- Electron 设置页展示所有 trusted devices,支持重命名和 revoke。

### 3.4 手机端核心页面

v1 手机网页只做“遥控聊天控制台”,不做完整 IDE。核心区域:

1. **会话/任务入口**:选择当前 session、继续会话或新建任务。
2. **聊天输入**:直接给 CodeShell 发任务,体验向 OpenClaw 式“直接上聊天”靠拢。
3. **运行状态**:展示当前 run 是否 running / waiting approval / completed / failed。
4. **流式输出**:展示 assistant 文本、tool 摘要、外部 agent job 输出。
5. **审批卡片**:手机 approve/reject 权限请求。
6. **后台任务卡片**:查看 Claude Code / Codex job、后台 shell 状态、日志和停止按钮。

---

## 4. 架构

```text
Electron Main
  ├─ RemoteHostManager
  │   ├─ start/stop LAN HTTP server
  │   ├─ pairing token lifecycle
  │   ├─ trusted device store
  │   └─ WebSocket auth/session
  │
  ├─ CodeShell Core Bridge
  │   ├─ ChatSessionManager
  │   ├─ RunManager
  │   ├─ Permission approval bridge
  │   └─ BackgroundShellManager
  │
  ├─ External Agent Orchestrator
  │   ├─ ClaudeCodeAdapter
  │   └─ CodexAdapter
  │
  └─ Mobile Web UI
      ├─ /mobile static app
      ├─ chat stream
      ├─ approval cards
      ├─ job/log cards
      └─ device status
```

### 4.1 RemoteHostManager

RemoteHostManager 是 Electron main 里的新服务,负责手机网页入口的生命周期:

- 启动/关闭 HTTP server。
- 提供 `/mobile` 静态网页。
- 提供 WebSocket endpoint,承载聊天事件、运行事件、审批事件、job 事件。
- 生成和验证 pairing token。
- 读取/写入 trusted device store。
- 对每条 WebSocket 连接绑定 device identity 和 role。

RemoteHostManager 不直接执行工具,不绕过 core。它只是 authenticated transport + mobile UI host。

### 4.2 CodeShell Core Bridge

Core Bridge 把手机事件转发到现有 CodeShell core:

- `mobile.chat.send` → 当前或新建 ChatSession 的 user input。
- `mobile.run.stop` → RunManager cancel。
- `mobile.approval.respond` → 当前 pending approval 的 approve/reject。
- core transcript / run events → WebSocket stream 给手机。

这层必须复用现有 `ChatSessionManager`、`RunManager`、permission engine 和 background shell 基建,避免创建第二套执行路径。

### 4.3 External Agent Orchestrator

外部 agent 编排以 managed job 形式实现。v1 支持 Claude Code 和 Codex 的 CLI adapter:

```text
Mobile chat
  → CodeShell session
  → Orchestrator decides target
  → ClaudeCodeAdapter / CodexAdapter
  → managed process / background shell
  → stdout/stderr/status back to CodeShell
  → phone displays stream + result
```

每个 adapter 负责:

- 检测对应 CLI 是否可执行。
- 以当前 workspace cwd 启动。
- 将用户任务作为 prompt 传入。
- 记录 job id、agent type、cwd、status、startedAt、exitCode。
- 将 stdout/stderr 以增量事件返回。
- 支持 stop/kill。
- 将执行结果写回 CodeShell transcript。

v1 不反向工程 Claude Code / Codex 私有协议。如果未来存在稳定 SDK、MCP server 或官方 machine-readable API,adapter 底层可替换,上层 mobile/orchestrator 协议不变。

---

## 5. 协议草案

手机端使用 WebSocket。HTTP 只负责 `/mobile` 静态资源、pairing API 和 health check。

### 5.1 Pairing API

- `POST /api/mobile/pair/start` 仅 Electron UI 内部调用,创建 pairing token。
- `POST /api/mobile/pair/complete` 手机调用,提交 pairing token 和 device identity。
- `POST /api/mobile/device/refresh` 已配对手机刷新 session token。

pairing token 只可使用一次,默认 10 分钟过期。

### 5.2 WebSocket 事件

客户端到服务端:

- `auth.device`: 使用 device credential 建立连接。
- `chat.send`: 发送用户消息。
- `session.select`: 选择 session。
- `session.create`: 新建 session/task。
- `run.stop`: 停止当前 run。
- `approval.respond`: approve/reject 权限请求。
- `job.stop`: 停止 Claude/Codex job 或后台 shell。
- `logs.subscribe`: 订阅 job/shell 日志。

服务端到客户端:

- `auth.ok` / `auth.failed`。
- `session.list` / `session.updated`。
- `message.delta` / `message.completed`。
- `run.status`。
- `tool.summary`。
- `approval.request` / `approval.resolved`。
- `job.started` / `job.output` / `job.completed` / `job.failed`。
- `error`。

所有事件都带 `deviceId` 派生的 auth context 和 server-side session context,用于审计和权限判断。

---

## 6. 权限与安全

### 6.1 Trusted device role

v1 trusted device 只有一种强角色:`controller_approver`。

该角色允许:

- 连接 Mobile Web Remote。
- 发送聊天任务。
- 查看 session 状态、流式输出、工具摘要和 job 日志。
- 对 permission request 执行 approve/reject。

手机 approval 与桌面 approval 等价。所有 approval 仍必须进入 CodeShell 现有 permission engine,不能由 remote host 直接放行工具。

### 6.2 低风险自动允许

低风险自动允许只适用于当前 workspace 内只读操作:

- session 列表、状态、消息流。
- 普通聊天输入。
- 当前 workspace 内 `Read` / `Glob` / `Grep`。
- `ListShells` / `BashOutput`。
- 只读配置、feature、status 查询。

自动允许策略必须检查 workspace/cwd 边界。工作区外路径、敏感路径、隐藏凭据文件等仍走审批或拒绝。

### 6.3 需要手机审批

以下操作需要 approval request:

- `Edit` / `Write` / `ApplyPatch`。
- `Bash`。
- `Bash(run_in_background=true)`。
- `KillShell`。
- Claude Code / Codex adapter job。
- 创建、修改或删除自动化任务。
- 跨 workspace 或工作区外访问。

### 6.4 高风险显著警告

高风险操作仍可由可信手机批准,但 UI 必须显著提示风险:

- 删除文件或大范围修改。
- `rm -rf`、`git reset --hard`、`git push`、force push。
- 修改密钥、权限、CI/CD、发布配置。
- 访问敏感路径。
- 尝试绑定非局域网地址或公网地址。

高风险审批卡片必须展示命令/路径/目标 session/device,并要求明确点击确认。

### 6.5 网络安全默认值

- Remote host 默认关闭。
- 开启时只绑定局域网地址和 localhost。
- 不支持公网 relay。
- 不允许默认监听 `0.0.0.0` 暴露到公网。
- 如果用户通过 SSH/Tailscale/WireGuard 暴露,属于用户自管通道;CodeShell 仍保持 token 和 trusted device 校验。
- 所有 pairing token 和 device credentials 必须使用不可预测随机值。
- trusted device 可在 Electron 设置页 revoke。

### 6.6 审计

每次 remote 操作写审计记录:

- device id / device name。
- session id / project path。
- action type。
- approval decision。
- risk level。
- timestamp。
- tool name / command summary / path summary。

审计用于排查“手机上点了什么导致了本机变化”。

---

## 7. 为什么不直接暴露现有 TCP server

现有 `agent-server-tcp` 是有价值的参考,但不适合作为手机 v1 入口:

- 它是 NDJSON over TCP,浏览器不能直接连接 raw TCP。
- 现有注释明确 v1 无认证,只适合 localhost / SSH tunnel。
- 手机遥控需要 pairing、trusted devices、approval cards 和 mobile UI。
- 直接暴露 TCP 会绕开移动端需要的安全和产品语义。

因此 v1 应在 Electron 中新增 authenticated HTTP/WebSocket wrapper,内部复用 core 的 session/run/permission 能力。

---

## 8. Claude Code / Codex 编排细节

### 8.1 Job 模型

```ts
type ExternalAgentKind = "claude-code" | "codex";

type ExternalAgentJob = {
  id: string;
  kind: ExternalAgentKind;
  sessionId: string;
  cwd: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "killed";
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  signal?: string;
};
```

### 8.2 Adapter 行为

- CLI 不存在时,返回可理解错误和安装提示。
- job 默认继承当前 workspace cwd。
- job 输出进入 ring buffer,手机按需订阅。
- job 完成后写入 CodeShell transcript,并推送 `job.completed`。
- 用户点 stop 时执行进程组级 kill,避免只杀 wrapper 不杀子进程。

### 8.3 与 BackgroundShell 的关系

v1 可以复用 background shell 的关键能力:后台进程、日志读取、进程组 kill、状态查询。adapter 不应复制一套进程生命周期管理。若需要更结构化 job 元数据,在 BackgroundShell 之上加 `ExternalAgentJobManager`。

### 8.4 Claude Code dangerous mode policy

CodeShell 必须支持用户的真实工作流:在个人可信项目中,Claude Code 默认以 dangerous / skip-permissions 模式启动。

配置形态:

```json
{
  "externalAgents": {
    "claudeCode": {
      "command": "claude",
      "defaultMode": "dangerous",
      "dangerousArgs": ["--dangerously-skip-permissions"],
      "trustedWorkspaces": ["/Users/admin/Documents/个人学习/代码学习/codeshell"],
      "autoStartInTrustedWorkspaces": true
    }
  }
}
```

语义:

- `defaultMode: "safe" | "dangerous"` 控制 `/cc <prompt>` 的默认启动模式。
- `dangerousArgs` 不硬编码在 adapter 中,由配置提供,以兼容 Claude Code CLI flag 变化。
- `trustedWorkspaces` 限定项目默认 dangerous 的适用范围。
- `autoStartInTrustedWorkspaces` 为 true 时,可信手机在 allowlist workspace 内发 `/cc` 可直接启动 dangerous job。
- 非 allowlist workspace 即使 `defaultMode` 是 dangerous,也必须弹高风险审批。
- `/cc --safe <prompt>` 可以临时覆盖项目默认 dangerous。
- `/cc --dangerous <prompt>` 可以在非默认项目显式请求 dangerous,但仍需高风险审批。

UI 与审计要求:

- 手机端 job 卡片必须显示醒目的 `dangerous` 标识。
- dangerous job 审计记录必须包含 mode、args、cwd、device id、prompt 摘要。
- dangerous mode 只影响 Claude Code 自身的权限交互;CodeShell remote host、pairing、trusted device、workspace 边界和审计仍然生效。

该策略让个人项目保持高效率,同时避免 dangerous 默认扩散到未知目录或未信任 workspace。

---

## 9. Mobile Web UI 范围

### 9.1 v1 页面

1. **连接页**:pairing、trusted device 登录、连接错误说明。
2. **会话页**:当前 session 列表、新建任务。
3. **聊天页**:消息流、输入框、停止按钮。
4. **审批页/卡片**:待审批操作、风险说明、approve/reject。
5. **Job/日志页**:Claude/Codex job、后台 shell、增量输出、停止。
6. **设备状态页**:当前 device 名称、连接状态、退出登录。

### 9.2 不做

- 文件树。
- 手机端编辑文件。
- 完整 diff review。
- 多项目复杂管理。
- 系统级 push 通知。
- 原生 App。

---

## 10. 测试策略

### 10.1 Core / Electron service 测试

- pairing token 过期、一次性使用、错误 token 拒绝。
- trusted device 创建、刷新、撤销。
- WebSocket 未认证不可订阅或发送事件。
- revoked device 无法重新连接。
- 低风险只读操作自动允许且限制在 workspace 内。
- 中高风险操作产生 approval request。
- 手机 approval 能 resume 原 run,行为等同桌面 approval。
- 审计日志记录 device/action/decision。
- trusted workspace 内 `/cc` 可按配置默认启动 dangerous job。
- 非 trusted workspace 的 dangerous job 必须产生高风险审批。

### 10.2 Adapter 测试

- CLI 不存在时返回错误。
- job 启动、输出、完成事件。
- stop/kill 能杀进程组。
- job 输出不会无限灌入 context。
- job 结果写回 transcript。

### 10.3 UI smoke

- Electron 开启 remote 后显示二维码。
- 手机网页扫码配对成功。
- 手机发一条聊天消息并看到 assistant 流式输出。
- 手机收到 Bash/Edit approval 并批准。
- 手机拒绝 approval 后 run 正确失败/取消。
- 手机查看 Claude/Codex job 输出并停止。

---

## 11. 分阶段计划

### Phase 1: Mobile Remote 基础

- RemoteHostManager start/stop。
- Mobile static app shell。
- pairing token + trusted device store。
- WebSocket auth。
- session list + chat send + run stream。

### Phase 2: 权限审批闭环

- mobile approval backend。
- 低风险 auto-allow policy。
- approval cards。
- 审计日志。
- revoke trusted device UI。

### Phase 3: 外部 Agent 编排

- ExternalAgentJobManager。
- ClaudeCodeAdapter。
- CodexAdapter。
- job output stream。
- job stop/kill。

### Phase 4: OpenClaw 交互研究与打磨

- 只读研究 OpenClaw 的手机聊天/任务/审批体验。
- 优化 mobile chat layout、tool summary、approval card 和 job switching。
- 不改变 Phase 1-3 的安全边界。

---

## 12. 关键不变量

1. Remote host 默认关闭。
2. 不做公网 relay。
3. 手机端是 Web/PWA,不是原生 App。
4. 可信手机 approval 与桌面 approval 等价。
5. 所有工具执行仍走 CodeShell core permission engine。
6. 低风险自动允许只限 workspace 内只读。
7. Claude Code / Codex v1 通过 CLI adapter 编排。
8. 个人可信项目可配置 Claude Code 默认 dangerous mode,但必须限制在 trusted workspace 并保留审计。
9. RemoteHost 只是 transport/UI 层,不实现第二套 agent runtime。

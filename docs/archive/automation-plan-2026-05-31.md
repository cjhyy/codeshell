# Automation Plan — Headless / Background / Scheduling (2026-05-31)

补齐 codeshell 的无人值守能力。对标三家上游:Codex(`codex exec` 无状态 CLI)、
Claude Code(内置 cron + 后台 agent 通知)、opencode(server + HTTP/SSE API)。

> **路线修订(2026-05-31,解耦方案)**:本 plan 旧版曾采用「Codex 路线:不内置调度,
> 全外包 OS crontab」(旧 D1)。该决策的核心论据是「内置调度会陷入『关窗即停 vs 常驻 daemon』
> 的两难」。**此前提在源码事实下不成立**(见 §0),故推翻。新路线:**自动化拆成 core 的零环境
> 依赖模块,由不同宿主加载——v1 内置进 Electron 进程(开箱即用),未来同模块被一层薄服务端引用
> 做服务器部署。** 调度内置(日历式 cron + 时区),不外包 OS。

---

## §0 关键事实:server 与 transport 已解耦(推翻旧「两难」)

旧路线假设「常驻服务端」是昂贵的、要避开的。源码核实证明并非如此:

1. **core 已能起一个完整的多会话 server** —— `packages/core/src/cli/agent-server-stdio.ts`
   已 bootstrap 好 `EngineRuntime` + `ChatSessionManager` + `AgentServer`(`maxSessions:16`、
   idle 清理、优雅关闭),设计成长期存活。它现在只是被当作「Electron 子进程 worker」。
2. **`Transport` 接口只有 3 个方法**(`protocol/transport.ts:17`):`send` / `onMessage` / `close`。
   `AgentServer` 仅通过这 3 个方法与外界通信(`server.ts:89-92`),**完全不知道底层是 stdio 还是网络**。
   已有两个现成实现:`StdioTransport`、`createInProcessTransport`(内存管道,Electron 在用)。
3. **因此「薄服务端」确实薄**:加一个网络 transport(`TcpTransport`/`WebSocketTransport`,照
   `StdioTransport` 抄,数十行)+ 一个换传输的启动入口(复制 `agent-server-stdio.ts`、把最后一行
   `new StdioTransport(stdin,stdout)` 换成 `new TcpTransport(port)`),**178 行核心逻辑零改动**。

**结论**:常驻、可独立部署的服务端是廉价且解耦的。旧 D1 的「两难」前提作废 → **可以内置调度**,
并让同一份自动化逻辑跨「桌面进程内」与「未来服务端」两种宿主复用。

> ⚠️ 唯一不薄的部分是**生产级服务端的认证/TLS/访问控制**——一旦监听网络端口,等于把「能起 agent、
> 改代码、跑命令」暴露出去,必须鉴权。但这可 v1 不做(先只监听 localhost / 走 SSH 隧道),
> 真要暴露公网再加。传输层与启动入口本身是薄的。

---

## 决策(2026-05-31,已拍板)

### D1 — 自动化 = core 里的零环境依赖模块,由宿主加载
新增 `packages/core/src/automation/`,对外暴露一个干净入口 `startAutomation(deps) → { scheduler, stop() }`。
**铁律**(保证跨宿主复用、永不分叉):

- 零 Electron / 零 Ink import(否则服务端加载即崩)。
- 不假设有 GUI / TTY(不弹窗、不等终端交互)。
- 所有环境绑定依赖走**注入**(`startAutomation({ runManager, store, clock, ... })`),模块自己不 `new`
  环境相关实例 —— 桌面与服务端各传各的。
- 配置 / 数据走文件(`~/.code-shell/cron.json` + RunStore),两个宿主读同一套,语义一致。

### D2 — 两种宿主,同一模块
| 宿主 | 形态 | 何时 |
|---|---|---|
| **Electron main 进程内** | `import { startAutomation }` 直接在 main 启动,双击即用、零连接。cron 跟随 app 生命周期(关 app 即停——对桌面用户是符合预期的)。 | **v1** |
| **薄服务端(CLI daemon)** | 同一个 `startAutomation` 被一层薄服务端 CLI 引用(`code-shell automation serve`),headless 常驻(systemd/docker/pm2),7×24。依赖 §0 的网络 transport。 | **未来**(架构预留,v1 不实现;但模块铁律保证无需返工) |

> 「关窗即停」不再是缺陷:桌面用户本就不期望关了 app 还跑;真要 7×24 = 服务端部署,
> 由宿主 B 承担。同一逻辑两种宿主,不分叉。

### D3 — 内置调度:日历式 cron 表达式 + 时区,自己解析(轻依赖)
对齐截图里 Codex 的「下次运行 明天 08:01 / 频率 工作日 8:00」体验,需支持 `0 9 * * 1-5` 式日历调度 +
时区,而非仅间隔(`5m`/`1h`)。自己写一个小型 cron 表达式解析器 + 下次触发时间计算(含时区),
不引第三方库(core 依赖政策克制)。现有 `CronScheduler` 的间隔能力保留并扩展。

### D4 — 执行走 RunManager,落 RunStore(完整运行历史)
到点 → `RunManager.submit({ objective: job.prompt, cwd: job.cwd, ... })`。每次定时执行成为一个 Run,
落 `RunStore`,**复用现有 runs 详情页 / checkpoint / resume**。这同时满足截图里「运行历史记录」字段。
前置:扩 `CreateRunManagerOptions` / `EngineRunnerConfig` 透传 `approvalBackend`(见 §权限)。

### D5 — 任务配置(对齐截图)
核心字段:`name + prompt + schedule + cwd(绑定项目)` + **权限级别**。模型 / effort / 沙箱模式 v1 先用
全局默认(后续再加进表单)。每个 job 绑 cwd —— 这是「监控/改哪个项目」的锚点,现有 `CronJob` 缺此字段,需补。

### D6 — 写型任务(改代码 → 提 PR)= 核心目标,非仅监控
自动化不止「只读监控」。写型任务链(读外部输入 → 分析 → 改代码 → 提 PR)是核心目标。落地要素:

- **权限分级**:`read-only`(监控类)/ `workspace-write`(改代码跑测试)/ `full`(可 git push、提 PR)。
- **git worktree 隔离**:写型 job 在自己的 worktree 跑(复用现有 `createWorktree`/`listWorktrees` 能力),
  改完提 PR,不碰用户正在用的主工作区。
- **沙箱是放开写权限的前提**(见 Phase 3):无沙箱时写型默认拒绝。
- **prompt injection 防护**:读外部输入(评论/issue)的 prompt 可能含恶意指令,写型任务尤其要防——
  外部内容与指令分隔、限制可执行动作面。

### D7 — 桌面 UI:自动化栏目
Sidebar 加「自动化」项 → 列表页 + 详情页(含运行历史)+ 创建表单 + 「立即运行」。详情字段对齐截图:
name / prompt / 状态(enabled)/ 下次运行 / 上次运行 / 频率 / 运行环境(沙箱)/ 项目(cwd)/ 运行历史。
UI 通过现有 IPC 协议连到 main 进程内的 automation 模块(纯客户端,不自己持有调度逻辑)。

### D8 — session 模式
定时任务每次执行默认开**新 session**(幂等、无记忆,对齐 codex 默认);提供 `--resume <id>` /
`--continue-last` 让需累积上下文的任务延续(对齐 codex `exec resume <id>` / `--last`)。落地于 Phase 1。

---

## 现状核实(2026-05-31,基于源码 grep,非推测)

| 组件 | 文件 | 状态 | 在新路线下的去向 |
|---|---|---|---|
| `agent-server-stdio`(多会话 server) | `packages/core/src/cli/agent-server-stdio.ts` | ✅ 完整,仅 stdio transport | §0:加网络 transport 即可独立部署 |
| `Transport` 接口(send/onMessage/close) | `protocol/transport.ts:17`、`server.ts:89` | ✅ 已与 AgentServer 解耦 | 加 TcpTransport(薄) |
| `code-shell run` 一次性执行 | `packages/tui/src/cli/commands/run.ts` | ✅ 在(已补 stdin/last-message/drain) | CLI 自动化入口之一 |
| `CronScheduler`(间隔调度 + 重入守卫 + 持久化) | `packages/core/src/cron/scheduler.ts` | ✅ 已有(本会话补了执行器+持久化) | **保留,挪进 `automation/` 并扩日历式调度** |
| `CronStore` 持久化(`~/.code-shell/cron.json`) | `packages/core/src/cron/cron-store.ts` | ✅ 已有(本会话新增) | 复用,扩 cwd/权限字段 |
| `bindCronToEngine` 执行器接线 | `packages/core/src/cron/cron-runtime.ts` | ✅ 已有(本会话新增,直跑 Engine) | **改走 RunManager.submit()**(D4) |
| `RunManager`(队列/checkpoint/resume/attach) | `packages/core/src/run/RunManager.ts:65` | ✅ 完整 | 执行落地 + 运行历史 |
| `RunStore` / session 持久化 | `packages/core/src/run/FileRunStore.ts` | ✅ 完整 | 支撑 resume + 历史详情 |
| 后台 agent 完成通知 | `agent-notifications.ts`、`App.tsx:1360-1371` | ✅ TUI 通,headless 已补 | 复用 |
| git worktree 能力 | desktop preload `createWorktree`/`listWorktrees` | ✅ 已有 | 写型任务隔离(D6) |
| Sandbox(seatbelt/bwrap/off) | `tool-system/sandbox/` | 🔧 需核实深度 | 放开写权限前提(Phase 3) |
| `CreateRunManagerOptions`/`EngineRunnerConfig` 透传 approvalBackend | `run/factory.ts`、`run/EngineRunner.ts` | ❌ 未透传 | 需扩展(D4 前置) |
| `CronJob.cwd` / 权限级别字段 | `cron/scheduler.ts:8-18` | ❌ 缺 | 补字段(D5) |

---

## 范围与阶段

设计一次写全;实现分期。每阶段独立可交付、独立可测。

```
Phase 1  抽 automation 模块 + 内置 Electron(只读闭环)  ── P0:主路径
        │
Phase 2  日历式调度 + RunManager 执行 + 运行历史          ── P0:对齐截图体验
        │
Phase 3  桌面 UI(列表/详情/表单/立即运行)              ── P1:可见可控
        │
Phase 4  Sandbox 落地                                    ── P1:放开写权限前提
        │
Phase 5  写型任务(worktree + 权限分级 + 自动提 PR)      ── P1:核心目标②,依赖 Phase 4
        │
Phase 6  薄服务端(网络 transport + serve 入口)          ── P2:服务器部署,§0 已论证薄
```

**交付分期**:① 只读闭环(Phase 1-3)先跑通、界面可见;② 写型(Phase 4-5)需沙箱+worktree+权限;
③ 服务端(Phase 6)按需。

---

## Phase 1 — 抽 `automation/` 模块 + 内置 Electron【P0,主路径】

**目标**:把调度/执行/存储抽成 core 的零环境依赖模块,Electron main 进程内启动,只读任务能定时跑通。

### 改动
1. **新增 `packages/core/src/automation/`**:
   - `scheduler.ts` — 由现有 `cron/scheduler.ts` 挪入并扩展(保留间隔 + 重入守卫 + 持久化)。
   - `executor.ts` — 到点的执行逻辑(Phase 1 先直跑 Engine 只读,Phase 2 改走 RunManager)。
   - `store.ts` — 由现有 `cron/cron-store.ts` 挪入。
   - `index.ts` — 暴露 `startAutomation(deps) → { scheduler, stop() }`,遵守 D1 铁律(零 Electron/Ink、依赖注入)。
2. **Electron main 引入**:`desktop/src/main/index.ts` 在 `app.whenReady` 后 `startAutomation({...})`,
   像现有 `*-service` 一样进程内加载。**不 spawn 额外进程**。
3. **权限默认只读**:`permissionMode: "default"` + `HeadlessApprovalBackend("approve-read-only")`
   (注意 `approve-read-only` 非 permissionMode 枚举值,须显式传 approvalBackend)。

### 测试(先写)
- automation 模块**零 Electron/Ink import**(可写一条断言 / lint 规则扫描)。
- `startAutomation` 注入 fake runManager + fake store,到点触发 executor 收到正确 prompt + cwd + 只读后端。
- 只读后端:Read/Grep/Glob 批准,Write/Edit/Bash 拒绝。
- 持久化:create → 重启 → loadJobs 恢复 + 重建定时器 + 重算 nextRun(不补跑)。

### 验收
- Electron 启动后,一个间隔 job 到点真的起一次只读 Engine run;关 app 即停;重开恢复任务列表。

---

## Phase 2 — 日历式调度 + RunManager 执行 + 运行历史【P0】

**目标**:支持 `每天9点/每周一` + 时区;每次执行落 RunStore,可在 runs 详情查看历史。

### 改动
1. **日历式 cron 解析(D3)**:`automation/cron-expr.ts` — 解析 `分 时 日 月 周` 五段 + 时区,
   计算下次触发时间。`CronJob.schedule` 同时接受间隔(`5m`)与 cron 表达式(`0 9 * * 1-5`),
   `CronJob.timezone` 新增。调度器用 next-run 计算 + setTimeout(替代纯 setInterval),避免时钟漂移。
2. **执行走 RunManager(D4)**:executor 改为 `runManager.submit({ objective, cwd, ... })`。
   先扩 `CreateRunManagerOptions` / `EngineRunnerConfig` 透传 `approvalBackend`(现写死 `RunApprovalBackend`)。
3. **CronJob 扩字段(D5)**:`cwd`、`permissionLevel`、`lastRunId`(指向 RunStore)。

### 测试(先写)
- cron 表达式:`0 9 * * 1-5` 在不同时区算出正确下次时间;DST 边界;非法表达式报错不静默。
- 间隔与表达式两种 schedule 并存解析正确。
- executor 走 RunManager:job 触发 → RunStore 出现新 run,可 attach/resume。
- approvalBackend 透传:RunManager 起的 run 用注入的只读后端而非默认。

### 验收
- 建一个 `0 9 * * 1-5`(Asia/Shanghai)的 job,详情显示「下次运行 明天 09:00」;到点落一条 run,
  在 runs 详情看到结果。

---

## Phase 3 — 桌面 UI:自动化栏目【P1】

**目标**:对齐截图——列表 + 详情(含运行历史)+ 创建表单 + 立即运行。

### 改动
1. **main 服务 + IPC**:`main/automation-service.ts`(读 cron.json + 调 scheduler)+
   `automation:list/get/create/delete/pause/resume/runNow` 的 `ipcMain.handle`。
2. **preload 桥**:`index.ts` 加 `listAutomations/getAutomation/createAutomation/...`(挨着 `listRuns`)+
   `types.d.ts` 类型。
3. **renderer 页面**:`renderer/automation/`(仿 `renderer/runs/`)—— 列表页 + 详情页 + 创建表单;
   `SidebarNav.tsx` 加「自动化」项(有 badge 机制)。详情字段对齐截图(D7)。
4. **后台完成 → 桌面通知**:订阅 `agentNotificationBus`,job 跑完弹 `notify:show`(desktop 已有通道)。

### 测试(先写)
- automation-service 只读 cron.json 正确解析为列表 summary。
- create/delete 经 IPC 改动 scheduler 后持久化生效。
- renderer 列表/详情渲染快照。

### 验收
- 自动化栏目能看到任务列表;点进详情看到字段 + 运行历史;能创建、暂停、立即运行一个任务。

---

## Phase 4 — Sandbox 落地【P1,放开写权限前提】

**目标**:无人值守跑危险工具有隔离兜底。这是 Phase 5 写型任务放开写权限的前提。

### 改动
1. 先读 `sandbox/seatbelt.ts`(macOS)、`bwrap.ts`(Linux)、`off.ts`、`index.ts` 核实实现深度
   (本会话已知:并非骨架,seatbelt/bwrap 有真实 profile/spawn 实现,需确认可用度)。
2. 接到 Bash/危险工具执行路径;无人值守默认套 `workspace-write` 级沙箱(对齐 codex `SandboxMode::WorkspaceWrite`)。
3. 三级策略:`read-only` / `workspace-write` / `danger-full-access`,经 settings + 任务权限级别配置。

### 测试
- 沙箱内写工作目录外文件被拒、目录内允许。
- 平台缺沙箱工具时优雅降级 + 明确告警(不静默关闭隔离)。

### 验收
- `workspace-write` 下,`rm` 项目外文件失败、项目内成功。

> ⚠️ 涉及真实命令执行隔离,改动前先单独读 `sandbox/*.ts`,可能拆成独立 plan。

---

## Phase 5 — 写型任务:worktree + 权限分级 + 自动提 PR【P1,核心目标②】

**目标**:实现「读外部输入 → 分析 → 改代码 → 提 PR」的自主开发型自动化。

### 改动
1. **权限分级(D6)**:`CronJob.permissionLevel`(read-only/workspace-write/full)贯通到 approvalBackend
   与沙箱模式。无沙箱(Phase 4 未就绪)时写型默认拒绝。
2. **worktree 隔离**:写型 job 执行前为其建 git worktree(复用现有能力),run 在 worktree 内跑,
   `cwd` 指向 worktree;结束后留分支供提 PR。
3. **自动提 PR**:run 完成后,在 worktree 分支上 `gh pr create`(经 Bash,需 `full` 权限 + 沙箱网络放行)。
4. **prompt injection 防护**:读外部输入的内容与指令分隔(包进明确的「不可信内容」标记),
   限制写型任务可执行的动作面。

### 测试
- read-only job 试图 Write 被拒;workspace-write job 能改 worktree 内文件、改 worktree 外被拒。
- worktree 隔离:写型 job 不污染主工作区。
- 注入防护:外部输入里的「请删除所有文件」式指令不被当作命令执行(回归用例)。

### 验收
- 配一个「读 issue → 改代码 → 提 PR」的 job,触发后在隔离 worktree 改动并开出 PR,主工作区无变化。

---

## Phase 6 — 薄服务端:网络 transport + serve 入口【P2,服务器部署】

**目标**:同一份 `startAutomation` 模块由一层薄服务端引用,headless 常驻部署。§0 已论证其薄。

### 改动
1. **网络 transport**:`protocol/tcp-transport.ts`(或 ws),实现 `Transport` 三方法,照 `StdioTransport` 抄。
2. **serve 入口**:`code-shell automation serve` —— 复制 `agent-server-stdio.ts` 的 bootstrap,
   末行换 `new TcpTransport(port)`,并 `startAutomation({...})`。核心逻辑不动。
3. **v1 安全边界**:仅监听 localhost / 走 SSH 隧道;鉴权(token/TLS)留待真要暴露公网时。

### 测试
- TcpTransport send/onMessage/close 与 stdio 行为一致(共用协议测试)。
- serve 进程常驻,cron 7×24 触发不依赖任何 GUI。

### 验收
- 服务器(无 Electron)上 `automation serve` 起住,配置的 cron 任务按时跑;桌面端(未来)可连上查看。

---

## 清理 / 复用(撤销旧版「移除 cron」)

旧版 plan 因「不内置调度」决定**删除** `CronScheduler` + `CronCreate/Delete/List` 工具。新路线**内置调度**,
故**撤销该删除**:`CronScheduler`/`CronStore`/`bindCronToEngine`(本会话已实现)**保留并挪进 `automation/`**。
`CronCreate/Delete/List` 三个 LLM 工具保留(让 agent 也能登记自动化任务)。

---

## 不做(明确排除)

- **公网暴露的生产级服务端**(鉴权/TLS/多租户)—— Phase 6 仅 localhost/SSH,公网化单独立项。
- **桌面端关窗后台常驻**(D2:关窗即停;要 7×24 用 Phase 6 服务端)。
- **远程定时 agent**(CC 的 CCR Triggers)、`codex cloud-tasks` 云任务 —— 无对应后端,范围外。
- **补跑错过的 cron**(catch-up)—— 重启按 next-run 重算,不补跑(避免惊群);可选开关留后续。
- 桌面端连**远程服务器上的自动化** —— 能最好,但 v1 不做(需 transport 以外的认证/网络一整套)。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| automation 模块误引 Electron/Ink → 服务端加载崩 | D1 铁律 + lint/测试断言扫描 import;依赖注入 |
| 无人值守写型任务误删/越权/被注入劫持 | 权限分级 + 沙箱(Phase 4 前置)+ worktree 隔离 + 注入防护(D6) |
| 日历式调度时区/DST 算错 | cron-expr 单测覆盖时区 + DST 边界;非法表达式报错不静默 |
| RunManager 透传 approvalBackend 漏改 → 仍走默认后端 | 扩 `CreateRunManagerOptions`/`EngineRunnerConfig` + 透传回归测试 |
| 服务端监听端口被未授权访问 | v1 仅 localhost/SSH;公网前必须加鉴权(Phase 6 之外单独立项) |
| 后台 agent 结果在 headless 退出丢失 | 已实现的 drain 生命周期契约(本会话 Phase 1 尾巴)继续复用 |

## 三家自动化范式对比(决策依据,存档)

| 维度 | Codex | Claude Code | opencode | **codeshell(本 plan 新路线)** |
|---|---|---|---|---|
| 主路径 | 无状态 CLI `exec` | 内置 cron + 后台 agent | server + HTTP/SSE API | **core 内 automation 模块 + 多宿主** |
| 定时 | 外部 OS cron | 内置三层 cron | 外部编排 | **内置(日历式 cron + 时区)** |
| 常驻 | 无 | 桌面可后台 | server 常驻 | **桌面进程内(关窗停);服务端可常驻(Phase 6)** |
| 调度逻辑位置 | OS | 内置进程 | server | **core 零依赖模块,宿主加载** |
| session | rollout,resume by-id/last | 内部 db | SQLite,可 fork | **RunStore,`--resume`/`--continue-last`** |
| 写型(改码提PR) | 手动审批 | 手动 | 手动 | **核心目标:权限分级+worktree+自动PR(Phase 5)** |
| 服务端 | 无 | 无 | 一等公民 | **薄层(transport 已解耦,Phase 6)** |

## 参考(对标证据)

- Codex `exec`:主循环 `codex-rs/exec/src/lib.rs:820`、退出码 `:885-941`;resume `exec/src/cli.rs:207`、
  `lib.rs:1334`;approval `protocol/src/protocol.rs:764`;sandbox `config_types.rs:86`。
- Claude Code:本地 cron `cronScheduler.ts`;后台 agent webhook `AgentTool.tsx:87`;分类器 `yoloClassifier.ts`。
- opencode:server `cli/cmd/serve.ts:10`;SSE `groups/event.ts`;SDK `sdk/js/src/v2/`。
- codeshell 现状:`agent-server-stdio.ts`(多会话 server)、`protocol/transport.ts:17`(Transport 三方法)、
  `server.ts:89`(AgentServer 解耦 transport)、`run.ts`(已补 stdin/last-message/drain)、
  `cron/{scheduler,cron-store,cron-runtime}.ts`(本会话实现)、`RunManager.ts:65`、`App.tsx:1360-1371`、
  desktop `agent-bridge.ts:1-16`、preload `createWorktree`。
---

## 方向修正(2026-05-31，设计讨论，未动码)

### 起因：「关了 Electron，定时任务还跑吗？」

复盘当前实现，答案是**不跑**。三个宿主各自 `import startAutomation()`，调度器的 `setTimeout`/`setInterval` 活在各自进程的事件循环里：

| 宿主 | 调度器跑在哪 | 关了它会怎样 |
|---|---|---|
| Electron | `main/index.ts → automation-host.ts` 的 `startAutomation()`，Electron main 进程 | timer 随进程消失，不触发 |
| TUI | `repl.ts`，TUI 进程 | 同上 |
| server | `agent-server-tcp.ts`，TCP 服务进程 | 同上 |

三个进程各跑一个 `CronScheduler` 各读同一个 `cron.json` → ① 谁活着谁触发、谁死谁停；② 多进程同时开会抢跑同一 job（cron-store 是 v1 单进程，并发写 lost-update）。

### 关键澄清：Codex 也没有魔法（查证 OpenAI 官方文档）

误以为「Codex 关了还能跑」，实查 [developers.openai.com/codex/app/automations](https://developers.openai.com/codex/app/automations)，Codex 自己也分两类：

- **Standalone（独立任务）**：跑在 **OpenAI 云端**，每次起一个全新 session（`new-chat`），关本机不影响 —— 因为执行根本不在你机器上，云服务器 7×24 由 OpenAI 的基础设施守护。
- **Project-scoped（本地项目）**：官方原话 *"the app needs to be running, and the selected project needs to be available on disk"* —— **App 必须开着**，和我们现状一模一样。

截图实证：用户的「工作日晨间简报」任务，右侧「运行环境=本地」、目标本机目录、历史两条 `new-chat`。**它是 project-scoped，关了 App 明早 08:01 不会跑。** 「本地不跑也没问题」只对云端任务成立，对本地环境任务不成立。

OpenAI 文档还有句未兑现的承诺：*"building out... cloud-based triggers, so Codex can run continuously... not just when your computer is open"* —— 连 OpenAI 都把「关机还跑本地任务」列为「建设中」，印证：**没有「放进库就能自启」这种事，必须有一个常驻进程 + OS 守护。**

### 结论：核心认知 —— 「代码放 core」≠「能自己启动」

- `CronScheduler` **代码**已在 core（`automation/`），这是对的，不用动。
- 但 core 是**库**，库没有进程。`setTimeout` 在**哪个进程的事件循环**里转，才决定关了 Electron 还跑不跑。
- 「启动」必须由**进程入口 + OS 守护**完成，core 只提供 `startAutomation()` 函数。

目标架构（复刻 Codex standalone，常驻进程放本机）：

```
OS 守护（launchd / systemd）          ← 开机自启 + 崩溃重启
  └─ code-shell serve（headless 常驻，= agent-server-tcp）
        └─ startAutomation({store, runner})   ← 调度器只在这一个进程里转
              └─ 到点 → RunManager 跑一次 Engine（new-chat，每次新 session）
Electron / TUI ──TCP──► 连到常驻进程（纯客户端，关了不影响调度）
```

收敛点：「自动化调度」与「UI 连后端」用**同一套 Transport 解耦机制**（Phase 6 已有 `SocketTransport`/`listenTcp`）。`startAutomation` 将来**只在 server 调用一次**，Electron/TUI 删掉各自那份，改成下发 cron 增删查 + 订阅运行结果。

### 分阶段（本次决定：先不做常驻）

每次运行起一个全新 session（`new-chat` 模型）—— 已与 core 的 `bindCronToRunManager`（每次一次性 Engine）一致，方向对，保留。

| 阶段 | 内容 | 依赖常驻 | 本轮 |
|---|---|---|---|
| A | CronJob 加 `runtime` 字段（`electron`\|`server`，默认 electron）+ store 持久化 —— 数据模型先立住，将来接常驻零改动 | 否 | 待办（铺垫） |
| B | AutomationView 详情按截图展示：运行环境/下次运行/重复/模型/历史(new-chat) | 否 | 待办（铺垫） |
| C | 多进程互斥（防 Electron + 将来 server 抢同一 job） | 为常驻铺垫 | 暂缓 |
| D | 真·常驻进程 + launchd/systemd 守护（「关了 Electron 也能跑」的唯一真实来源） | —— | **本次明确先不做** |

**当下定调**：先把「运行环境」概念与 UI 铺好（A/B，不依赖常驻），常驻（D）留到以后。在 D 落地前，所有 cron 实际仍是「Electron/TUI 进程内、关窗即停」—— 这点须在 UI 如实呈现，不可让「运行环境=本地」读起来像「关了也跑」。
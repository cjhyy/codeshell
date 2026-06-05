# 设计:Session 级后台 Shell(Background Shell)

- 状态:Draft(待 review)
- 日期:2026-06-05
- 关联:`TODO-week.md` #15「Session 内后台命令支持与 UI 展示调研」
- 范围:让 agent 能在一个 session 里启动并保持长期后台进程(典型:`npm run dev`),
  随时拉取增量日志、列出、终止;退出时收到一行通知。**Session 级**生命周期。

---

## 1. 背景与动机

### 1.1 现状(问题)

当前 codeshell **不支持**在 session 里启动长期后台进程:

- `Bash` 工具(`packages/core/src/tool-system/builtin/bash.ts`)100% 同步执行:
  调用 `safeSpawnShell` 并 **await 到命令结束**,默认 **120s 超时**后 SIGTERM→SIGKILL。
- 一个永不退出的 `npm run dev` 在 Bash 工具里跑 → **阻塞到 120s 被杀**,server 起不来也留不住。
- desktop 有 `pty-service.ts`(node-pty),但它是**给 UI 终端面板用的交互式 shell**,
  通过 IPC 暴露给前端,**agent 工具系统从不调用它**,且只 desktop 可用。
- core 有 `asyncAgentRegistry`(后台 **agent**),但那是"后台跑另一个 LLM agent",
  不能用来启动任意进程。

### 1.2 Prior art(CC / Codex 怎么做)

**Claude Code —— 成熟的 fire-and-forget 后台 shell(本设计主要借鉴对象):**

- `Bash` 工具有 `run_in_background: boolean` 参数;为 true 时立即返回 `backgroundTaskId`,进程 detach 后台跑。
- 输出写文件(`~/.claude/task-output/{taskId}`),Ring Buffer + 尾部截断;轮询读取(~1s 读尾部 4KB)。
- 进程退出时通过通知队列(XML)告知模型,带 taskId/输出路径,**不带输出正文**。
- `ShellCommand` 状态机(running/backgrounded/completed/killed)+ `LocalShellTask` 注册表;**session 级**绑定。
- kill 用 `tree-kill` 杀整棵进程树。
- 触发:显式 `run_in_background`,外加超时/助理模式阻塞的自动转后台启发式。

**Codex —— PTY yield 会话,半成品且不可靠(反面教材):**

- `unified_exec`(feature flag):PTY 会话,命令在 ~10s yield 窗口后未退出就返回 `session_id`,
  跨 turn 存活在 `ProcessStore`(上限 64、LRU 剪枝),后续可 `write_stdin` 喂输入。
- 跑 `npm run dev` 现状很糟:PTY 永不 detach 挂死数小时(#5948),或 ~10min 被静默杀掉(#10957),
  轮询烧 token(#13733);真正的"后台终端 / `--bg` / `/ps` / `/stop`"都还是未实装 open issue(#3968)。
- 官方推荐做法仍是用户自己开 tmux/screen。

**结论:** 采用 **CC 式后台 shell 范式**(为日志型 server 而生、简单、稳),
并在 4 个 CC 也会踩的点上做得更扎实(见 §3 难点)。**不采用** Codex 的 PTY-yield 范式
(对纯 server 是杀鸡用牛刀,且交互能力对 server 用不上)。

### 1.3 用户真实用法(校准设计)

用户的实际流程:在长运行 terminal 里直接 `npm run dev` → 看日志确认起来了/看报错 → 临时预览页面 → 完事。
"更长期会改用 `nohup npm run dev > /tmp/x.log 2>&1 &` 或 pm2"。

→ 这是典型的**只看日志、不交互**场景(后台 shell 甜区,不需要 PTY 喂输入)。
→ "落盘日志 + 随时回看"正是后台 shell 内建提供的 —— **做了这个,用户就不用再手动 nohup**;
   `BashOutput` 比 `tail /tmp/x.log` 更顺手。设计会暴露落盘路径,兼容用户用外部工具 tail。

---

## 2. 已确定的决策(brainstorming 结论)

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| D1 | 核心范式 | **CC 式后台 shell**(进程 detach + 输出落盘 + handle) | 为 dev server 设计,简单稳;PTY 的交互能力对 server 多余 |
| D2 | 生命周期 | **Session 级**(session/宿主退出即清理) | 临时预览不需要跨 app 重启保活;匹配真实用法 |
| D3 | 触发方式 | **只靠显式参数** `run_in_background=true` | 简单可预测;靠工具描述+提示词引导模型对 dev server 主动传 |
| D4 | 管理器分层 | **core 层统一**(`BackgroundShellManager`) | 代码干净,三宿主一致;不绑 Electron |
| D5 | 输出进 context | **默认不进**;运行中靠主动 `BashOutput` 拉;退出时一行通知 | 避免 dev server 日志灌爆 context(Codex #13733 的坑) |
| D6 | 退出通知 | **要,一行通知**(尤其非 0 退出),不带输出正文 | agent 能感知 server 崩了;不烧 context |
| D7 | 工具集 | **Bash 加参数 + 3 新工具**(BashOutput / KillShell / ListShells) | 与 CC 一致;ListShells 让 agent 枚举自己起的后台进程 |
| D8 | 沙箱/权限 | **等同普通 Bash**(同一 sandbox + 启动时审批一次) | 一致、可预测,不引入新口子 |
| D9 | 范围 | **全都要**(含进程组杀净、不被 Engine 等待、端口探测、ANSI 清理、孤儿处理) | 一步到位,覆盖日常会踩的坑 |

---

## 3. 五个难点与对策(设计的核心)

后台 server 管理的成败不在"能不能 spawn",而在以下 5 个细节。每个都在架构里钉死。

### 难点 1 —— 进程归属 & 孤儿进程 🟢(D9 纳入)

**问题:** Bash 跑在 **agent worker 子进程**里;一个 worker 可能同时服务多个 session(多 window/tab)。

- session A 起的 server **不能**被 session B 的结束所杀 → 必须**按 sessionId 精确分组**。
- worker 崩溃 → 它 spawn 的 `npm run dev` 变孤儿(被 init 收养),继续占端口 → 下次重开 `EADDRINUSE`。

**对策:**
- 每个 `BgShell` 记录所属 `sessionId`;清理按 `killSession(sid)`,不靠"worker 退出才清"。
- 启动时写 **pidfile**:`~/.code-shell/bg-shells/<sessionId>/<shell_id>.json`
  记录 `{ shell_id, pgid, command, port?, startedAt, sessionId }`。
- worker 启动时 **扫描 pidfile 目录**:对每个记录探测 pgid 是否还活着 →
  - 活着且能确定归属 → 标记为"孤儿"列入 `ListShells`(状态 `orphaned`),允许 `KillShell` 清理;
  - 已死 → 删除 pidfile。
- "session 结束"的定义:**仅 app/worker 退出**触发 `killAll`;**关闭单个聊天 tab 不杀**
  (用户切走再回来 server 还在)。session 被显式删除(sessions:delete)时才 `killSession`。

### 难点 2 —— 进程树杀不净 🔴(必须)

**问题:** `npm run dev` 真实进程树是 `sh -c "npm run dev"` → `npm` → `node vite`。
只 `child.kill()` 杀最外层 `sh`/`npm`,真正占端口的 `vite` **往往不死**。

**对策:**
- 一律 `spawn(..., { detached: true })` 让子进程**自成进程组**(新 pgid = 子进程 pid)。
- kill 走**进程组级**:`process.kill(-pgid, 'SIGTERM')`,grace period(默认 3s)后 `process.kill(-pgid, 'SIGKILL')`。
- 这复用了 `safeSpawnShell` 已有的 SIGTERM→SIGKILL 级联思路,但作用于**整个进程组**而非单进程。

### 难点 3 —— 端口冲突探测 🟡(D9 纳入,高价值)

**问题:** 反复起 dev server 时最高频痛点是"上一个没杀净 → 这次 `EADDRINUSE: 5173`"。
agent 看到的只是 `BashOutput` 里一段报错,未必联想到是自己上次的残留。

**对策:**
- `BgShell` 维护一个 `detectedPort?: number`,从输出流里正则探测常见端口模式:
  `localhost:(\d+)` / `127\.0\.0\.1:(\d+)` / `:(\d{4,5})\b`(取首个稳定命中)。
- `ListShells` 在每行里带上 `port`(若探测到),让 agent 和用户一眼看到"bg_a3f 占着 5173"。
- 探测是 best-effort、非阻塞、不影响日志本身。

### 难点 4 —— ANSI 噪声 & 输出游标 🟡(D9 纳入)

**问题:**
- `npm run dev` 输出带大量 ANSI 颜色转义 + `\r` 进度刷新(`▕███░ 45%`),塞进 context 是垃圾。
- "增量读"的游标语义:多个读者(agent + desktop UI)若共享单游标会互相偷数据。

**对策:**
- **落盘存原始**(保真,用户外部 `tail` 时有颜色)。
- `BashOutput` 返回给 agent 时:**strip ANSI 转义 + 折叠 `\r` 进度行**(只保留每段进度的最后一帧),只给干净文本。
- **游标按读者隔离**:`BashOutput` 默认按"该 shell 上次返回给 agent 的字节 offset"做增量(per-shell-agent 单游标),
  desktop UI 读 ring buffer/落盘文件用**自己的 offset**,两者不共享。
- `BashOutput` 支持可选 `mode`:`"incremental"`(默认,自上次)/ `"all"`(从头,受 ring buffer 上限约束)。

### 难点 5 —— 不能被 Engine 的 wait-for-background 循环卡死 🔴(必须)

**问题:** `Engine.run()` 在收尾前会 **主动等待本 session 所有后台 agent 完成**
(`engine.ts:1665` `while (!aborted && asyncAgentRegistry.hasRunningForSession(sid))`)。
后台 **shell(dev server)永不结束** → 若也纳入该循环,turn **永远不收尾**,直接卡死
(复现"卡住"类 bug)。

**对策:**
- 后台 shell 用 **独立注册表** `BackgroundShellManager`,与 `asyncAgentRegistry` **完全分离**。
- 语义区分写进文档与代码注释:**后台 agent 会结束(等它合理);后台 shell 不会(绝不等)**。
- `Engine.run()` 的 wait-for-background 循环**只看 `asyncAgentRegistry`**,绝不查 `BackgroundShellManager`。
- 后台 shell 是纯 fire-and-forget:`Bash(run_in_background=true)` 返回后该 turn 正常收尾,进程继续后台跑。

---

## 4. 架构与分层

```
┌─────────────────────────────────────────────────────────────────────┐
│ 工具层(模型可见,core/tool-system/builtin/)                          │
│   Bash(command, run_in_background=true) → 返回 shell_id,不阻塞当前 turn │
│   BashOutput(shell_id, mode?)            → 拉增量(或全部)、干净文本     │
│   KillShell(shell_id)                    → 进程组级终止                  │
│   ListShells()                           → 本 session 后台 shell+状态+端口│
└───────────────────────────────┬─────────────────────────────────────┘
                                │ ctx(cwd / signal / sessionId / sandbox)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ BackgroundShellManager(core 单例,纯 Node,不依赖 Electron)            │
│   registry: Map<shell_id, BgShell>                                    │
│   ┌─ BgShell ──────────────────────────────────────────────────────┐ │
│   │  · sessionId / command / cwd / shell_id / pgid                  │ │
│   │  · child: ChildProcess(detached 进程组)                         │ │
│   │  · status: starting|running|exited|killed|orphaned 状态机        │ │
│   │  · ringBuffer(内存,N 行/字节上限)+ 落盘 fd(原始输出)          │ │
│   │  · agentReadOffset(agent 增量游标)                              │ │
│   │  · detectedPort?(端口探测)                                      │ │
│   │  · exit handler → notificationQueue.enqueue(一行,非0退出尤其)   │ │
│   └─────────────────────────────────────────────────────────────────┘ │
│   spawnBackground(opts) / readOutput(id, mode) / kill(id) /           │
│   listForSession(sid) / killSession(sid) / killAll() /                │
│   reapOrphansFromPidfiles()                                           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ 复用现有基建
                                ▼
   · 沙箱:ToolContext.sandbox(等同前台 Bash,D8)+ §4.3 流式 spawn
   · 通知:notificationQueue.enqueue(item, sessionId)(后台 agent 已在用)
   · 落盘:CODE_SHELL_HOME ?? HOME → ~/.code-shell/bg-shells/<sid>/
   · 进程:Node child_process(detached 进程组,§难点2)
```

### 4.1 为什么不直接复用 `safeSpawnShell`

`safeSpawnShell`(`runtime/safe-spawn.ts`)的契约是 **await 到命令结束、把 stdout/stderr 收集成字符串一次性返回**
—— 这是**收尾型**设计,与后台 shell 需要的"spawn 后立即返回 handle、输出流式落盘"**根本冲突**。

因此 `BackgroundShellManager` 内部走**一条独立的流式 spawn 路径**(`spawnBackground`),
但**抽取/共享** `safeSpawnShell` 里可复用的部分:
- 沙箱 `backend.wrap()` 包裹命令的逻辑;
- SIGTERM→SIGKILL 级联(改造成**进程组级**,§难点2);
- env 构建(`buildSandboxEnv` / off 全透传,与 bash.ts 一致)。

建议把这些公共逻辑抽到 `runtime/spawn-common.ts`,前台 `safeSpawnShell` 与后台 `spawnBackground` 共享,
避免两套沙箱/kill 逻辑漂移。**这是本设计唯一需要改动现有 runtime 代码的地方**,需在实现计划中谨慎处理(带测试)。

### 4.2 与现有 PTY 服务、asyncAgentRegistry 的关系

| 子系统 | 用途 | 与后台 shell 的关系 |
|--------|------|---------------------|
| `pty-service.ts`(desktop) | 人用的交互式终端面板(ANSI 渲染、喂 stdin) | **完全独立**,并存,互不调用 |
| `asyncAgentRegistry`(core) | 后台跑另一个 LLM agent | **完全独立**;Engine 等待循环只看它,不看后台 shell(§难点5) |
| `MCPManager`(core) | MCP 连接池 | 仅作为"core 单例管理器"的架构范本参照 |

### 4.3 流式 spawn 数据流

```
spawnBackground:
  1. (沙箱)backend.wrap(command, shell) → 实际 argv
  2. spawn(argv, { cwd, env, detached: true, stdio: ['ignore','pipe','pipe'] })
  3. 记录 pgid = child.pid;写 pidfile
  4. child.stdout/stderr 'data' →
       a. 追加写落盘 fd(原始字节)
       b. push 进 ringBuffer(内存,逐行,超上限丢最旧)
       c. 端口探测(best-effort 正则)
  5. child 'exit' →
       a. status = exited|killed;记录 exitCode/signal
       b. 删除 pidfile
       c. notificationQueue.enqueue(一行通知, sessionId)   ← §难点6/D6
  6. 立即返回 { shell_id }(不等 exit)
```

---

## 5. 工具集与签名(模型可见接口)

### 5.1 `Bash` 扩展(向后兼容,加可选参数)

```jsonc
// inputSchema.properties 新增:
"run_in_background": {
  "type": "boolean",
  "description": "Run the command as a long-lived background process (e.g. a dev server). Returns immediately with a shell_id instead of waiting. Use BashOutput(shell_id) to read its output, KillShell(shell_id) to stop it, ListShells() to enumerate. The process is killed when the session/app exits. Do NOT use for one-shot commands."
}
```

- `run_in_background` 缺省/false → 现有同步行为，**完全不变**。
- 为 true → 调 `BackgroundShellManager.spawnBackground`,返回:
  ```
  Started background shell.
  shell_id: bg_<short>
  command: npm run dev
  (Use BashOutput("bg_<short>") to read output; KillShell to stop.)
  ```
- 沙箱/审批与前台 Bash 完全一致(D8):同一个 `ctx.sandbox`,启动这条命令时走一次正常 Bash 审批。

### 5.2 `BashOutput`(新工具)

```jsonc
{
  "name": "BashOutput",
  "description": "Read output from a background shell started via Bash(run_in_background=true). Returns new output since your last read (incremental). ANSI colors and progress bars are stripped.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "shell_id": { "type": "string", "description": "The shell_id returned by Bash(run_in_background=true)." },
      "mode": { "type": "string", "enum": ["incremental", "all"], "description": "incremental (default): output since last read. all: full retained buffer." }
    },
    "required": ["shell_id"]
  }
}
```

返回:干净文本(strip ANSI + 折叠 `\r` 进度行)。头部带一行元信息:
`[bg_a3f status=running port=5173 exit=- ] <newline> <output...>`。
若 shell 已退出:`status=exited exit=0`(或 `signal=SIGTERM`)。
未知 shell_id / 不属于本 session → 明确错误(不泄露其他 session 的 shell)。

### 5.3 `KillShell`(新工具)

```jsonc
{
  "name": "KillShell",
  "description": "Terminate a background shell (and its whole process group) started via Bash(run_in_background=true).",
  "inputSchema": {
    "type": "object",
    "properties": { "shell_id": { "type": "string" } },
    "required": ["shell_id"]
  }
}
```

进程组级 SIGTERM → 3s grace → SIGKILL(§难点2)。返回最终状态。幂等:已退出的返回"already exited"。

### 5.4 `ListShells`(新工具)

```jsonc
{
  "name": "ListShells",
  "description": "List background shells for the current session, with status and detected port.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

返回每行:`bg_a3f  running  port=5173  npm run dev  (started 3m ago)`。
含 `orphaned` 状态的(来自上次 worker 残留的 pidfile,§难点1)以便清理。

### 5.5 工具可见性 / 宿主裁剪

- 三个新工具是普通 builtin,默认对交互式 session 可见。
- **automation / cron(无人值守)**:加入 `AUTOMATION_DISABLED_TOOLS`
  (`packages/desktop/src/main/automationToolset.ts`,与 MCPTool/AskUserQuestion 同款处理)——
  无人值守 run 不应起长期后台进程(没人收尾、违背 one-shot 语义)。`run_in_background` 参数在 automation 下也应被忽略/拒绝。

---

## 6. 生命周期与清理(汇总)

| 事件 | 行为 |
|------|------|
| `Bash(run_in_background=true)` | spawn detached 进程组,写 pidfile,立即返回 shell_id |
| 运行中 | 输出流式落盘 + ringBuffer + 端口探测;**不进 context**;**不纳入 Engine 等待循环** |
| 进程自然退出 | status→exited;删 pidfile;`notificationQueue.enqueue` 一行(非0退出尤其) |
| `KillShell` | 进程组 SIGTERM→SIGKILL;status→killed;删 pidfile |
| turn 结束 | 无操作,后台 shell 继续跑(fire-and-forget) |
| 关闭单个聊天 tab | **不杀**(用户切走再回来 server 还在) |
| session 被显式删除 | `killSession(sid)`:杀该 session 全部后台 shell |
| app/worker 正常退出 | `killAll()`:杀所有后台 shell(注册 cleanup hook) |
| worker 崩溃后重启 | `reapOrphansFromPidfiles()`:探测残留 pidfile,列为 orphaned 供清理 |

**输出上限(防失控):**
- ringBuffer:每 shell 内存上限(建议 1000 行 / 256KB,取先到者,丢最旧)。
- 落盘文件:单文件字节上限(建议 8MB,与 mcp_images 同量级)。**超过后环绕覆盖最旧内容**(ring-file 语义),进程继续写。
  dev server 的早期启动横幅丢了无所谓,用户/agent 关心的永远是"最近的日志";保留最新 8MB 足够,不停写、不无限增长。
  `BashOutput` 在曾发生环绕时于头部提示 `(older output discarded)`。
- `BashOutput` 单次返回上限(建议尾部 ~16KB,strip 后),避免一次拉爆 context。

---

## 7. 错误处理与边界

- **spawn 失败**(命令不存在等):`Bash(run_in_background)` 同步返回 spawn 错误(不创建 BgShell)。
- **未知 / 跨 session 的 shell_id**:`BashOutput`/`KillShell`/明确报错,**不跨 session 泄露**。
- **重复 KillShell / Kill 已退出**:幂等,返回当前状态。
- **落盘目录不可写**:降级为仅内存 ringBuffer,`BashOutput` 头部提示"disk buffer unavailable"。
- **端口探测误报**:best-effort,探测不到就不显示 port,绝不影响日志或 kill。
- **同名端口冲突(难点3 的实际触发)**:不主动阻止启动(用户/agent 自由),但 `ListShells` 暴露端口便于自查;
  可选增强:启动时若 detectedPort 与某存活 BgShell 重复,在返回里加一行提示(二期)。
- **大量后台 shell**:每 session 软上限(建议 16,超出拒绝并提示先 KillShell),防 fork 炸弹式滥用。

---

## 8. 跨宿主行为

| 宿主 | 工具可用 | 进程管理 | UI 展示 |
|------|---------|---------|---------|
| **Desktop** | ✅ Bash+3 工具 | core `BackgroundShellManager` | **二期**:可把 ListShells/日志/停止接到设置或侧边栏面板(本设计先不做 UI,仅工具层) |
| **TUI** | ✅ | 同上(core 共用) | 仅工具输出文本,无专门面板 |
| **Headless/cron** | ❌(禁用,§5.5) | — | — |

> 进程管理在 core(三宿主共用)是关键 —— 这正是相比"复用 desktop pty-service"的优势(那个只 desktop 能用)。

---

## 9. 测试策略

**core 单元测试(`BackgroundShellManager`):**
- spawn 一个短命令(`echo hi; sleep 0.2`)→ 立即返回 shell_id;`BashOutput` 能读到 "hi";exit 后 status=exited 且 enqueue 了通知。
- spawn `sleep 100` → `KillShell` 后进程组确实死亡(验证 pgid 下无存活子进程,用一条会 fork 子进程的命令验证进程组级杀净 —— 覆盖难点2)。
- 增量游标:两次 `BashOutput(incremental)` 不重复返回;`mode=all` 返回全量。
- ANSI:喂含 `\x1b[31m` 和 `\r进度` 的输出,`BashOutput` 返回已 strip/折叠。
- 端口探测:输出含 `localhost:5173`,`ListShells` 显示 port=5173。
- session 隔离:session A 的 shell 在 `listForSession(B)` 不可见;`BashOutput` 跨 session 报错。
- `killSession` / `killAll` 杀净对应集合。
- pidfile:spawn 写、exit/kill 删;`reapOrphansFromPidfiles` 对死 pid 删文件、对(模拟)活 pid 列 orphaned。
- 上限:超 ringBuffer 行数丢最旧;超落盘上限**环绕覆盖最旧**(进程继续写),`BashOutput` 头部提示 `(older output discarded)`;超 per-session shell 上限拒绝。

**关键回归(难点5):**
- 一个 session 内 `Bash(run_in_background=true)` 跑永不退出的命令,`Engine.run()` 的该 turn **正常收尾**
  (断言 wait-for-background 循环不被后台 shell 阻塞)。这是必须有的回归测试。

**工具层测试:** Bash 的 `run_in_background` 分支返回 shell_id;automation 下三个新工具被禁、参数被忽略。

**沙箱一致性:** 后台 shell 与前台 Bash 走同一 backend(off / seatbelt),env allowlist 一致。

---

## 10. 实现顺序建议(留给 writing-plans 细化)

1. 抽取 `runtime/spawn-common.ts`(沙箱 wrap + env + 进程组级 kill 级联),让 `safeSpawnShell` 复用(带测试,确保前台 Bash 行为不变)。
2. `BackgroundShellManager` + `BgShell`(spawn/ringBuffer/落盘/状态机/通知/端口探测),core 单元测试。
3. pidfile + orphan reap + killSession/killAll + cleanup hook 接线。
4. `Bash` 加 `run_in_background` 分支;新增 BashOutput/KillShell/ListShells 工具 + 注册。
5. Engine 收尾循环回归测试(难点5);automation 禁用接线(§5.5)。
6. (二期)desktop UI 面板;(二期)端口冲突主动提示;(二期)跨重启保活(若日后需要)。

---

## 11. 明确不做(YAGNI / 二期)

- **不做**喂 stdin / 交互(PTY 范式)—— server 用不上;交互需求走现有 PTY 面板。
- **不做**跨 session / 跨 app 重启保活(D2 = session 级)—— 需要时再上独立 daemon。
- **不做**自动转后台启发式(D3 = 仅显式)—— 靠工具描述引导模型。
- **不做** desktop UI 面板(本期仅工具层)—— 二期。
- **不做**端口冲突的主动拦截(仅暴露便于自查)—— 二期可选。

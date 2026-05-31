# Automation Plan — Headless / Background / Scheduling (2026-05-31)

对标 Codex (`codex exec`) 与 Claude Code (本地 cron + 远程 trigger + 后台 agent 通知) 的无人值守能力,
补齐 codeshell 的自动化链路。

> **核心发现**:codeshell 的组件大多已写好(`CronScheduler`、`NotificationQueue`、`RunManager`),
> 真正缺的不是「实现」而是「**接线**」—— 几个单例被造出来但没人把它们连到 Engine / 主 session。
> 本 plan 优先修这些断点,再补真缺失的能力。

> **复核修正(2026-05-31,逐行对源码 grep 复查)**:初版三个"断点"中 **B3 已过时**——
> `notificationQueue.drainAll` 的 TUI 消费端早已在 `App.tsx:1360-1371` 实现。Phase 3 的"退出码缺失/
> output-format 缺失"两条**硬阻塞也已不成立**(`run.ts:257/264` 有退出码,`renderer.ts:14` 有四种 format)。
> 据此:**P0 收敛为 B1+B2**(Phase 0+2),Phase 1 降为"仅补 headless 尾巴",Phase 3 降为"补 stdin + last-message"。
> 另把 Phase 0 的默认审批从 `bypassPermissions` 改为现成的 `approve-read-only`,在 Phase 4 沙箱前不放开写权限。下表已逐条标注复核结果。

## 现状核实(2026-05-31,基于源码 grep,非推测)

| 组件 | 文件 | 状态 |
|---|---|---|
| `CronScheduler` 类(create/delete/pause/resume、parseSchedule、重入守卫) | `packages/core/src/cron/scheduler.ts` | ✅ 完整 |
| Cron 工具 CronCreate/Delete/List(注册 + preset 白名单) | `packages/core/src/tool-system/builtin/cron.ts`、`builtin/index.ts:326`、`preset/index.ts:57-59` | ✅ 完整 |
| `NotificationQueue` + `agentNotificationBus` + `buildNotificationMessage` | `packages/core/src/tool-system/builtin/agent-notifications.ts` | ✅ 完整 |
| 后台 agent enqueue(完成/失败时入队) | `packages/core/src/tool-system/builtin/agent.ts:326,372` | ✅ 完整 |
| `RunManager`(队列/checkpoint/resume/attach) | `packages/core/src/run/RunManager.ts` | ✅ 完整 |
| Turn loop(maxTurns / stop hook / context recovery / 续写) | `packages/core/src/engine/turn-loop.ts` | ✅ 完整 |

### 真正的断点(grep 已证)

| # | 断点 | 证据 | 后果 |
|---|---|---|---|
| **B1** | `cronScheduler.setExecutor()` **无人调用** ✅复核属实 | `grep setExecutor` 生产代码仅命中 `RunManager.ts:99`(调自己的 RunQueue)与定义 `scheduler.ts:29`;cron 实例只在 `scheduler.test.ts:19` 被调。`scheduler.ts:27` `onExecute?` 可选,`:114` `this.onExecute?.(job)` 未设即 no-op | cron job 能创建、`setInterval` 会 tick,但**到点什么都不执行** |
| **B2** | cron **零持久化** | `grep "cron.json\|persistJobs\|loadJobs"` → 空;`scheduler.ts:21` jobs 只在内存 Map | 进程重启 → 所有定时任务丢失 |
| **B3** | ~~`notificationQueue.drainAll()` 无人调用~~ **已过时(2026-05-31 复核)** | `grep drainAll` 实际命中 `tui/src/ui/App.tsx:1367` —— **TUI 侧消费者已实现** | TUI 主会话已能自动注入;真正剩下的只有 headless 侧 drain |

> **复核修正**:B3 的 TUI 消费端已在 `App.tsx:1360-1371` 完整实现(`useSyncExternalStore` 订阅 + idle 守卫 + `drainAll`→`buildNotificationMessage`→`submitToEngine(asInjection)`),与下方 Phase 1「改动 1」描述一字不差。
> 因此 **P0 实为 B1 + B2 两件**(cron 不执行、cron 不持久化);Phase 1 仅剩 headless 侧的小尾巴(见 Phase 1 已更新范围)。

---

## 范围

P0~P2 全部,分阶段。每阶段独立可交付、独立可测,失败不影响前序阶段。

---

## Phase 0 — 接通 cron 执行器 (B1) 【P0,最高性价比】

**目标**:cron job 到点真的跑起来。

### 改动
1. **新增 `cron/cron-runtime.ts`** — 一个 `bindCronToEngine(scheduler, engineFactory)` 函数:
   - 调 `scheduler.setExecutor(async (job) => { ... })`
   - executor 内部:为每个 job 起一次 Engine run。Phase 0 先用最简单的直跑把链路打通;Phase 5 再替换为 `RunManager.submit()`。
   - 把 job.prompt 作为一次性 headless 任务执行。**审批策略(复核修正)**:不要直接 `bypassPermissions`(在 Phase 4 沙箱就绪前等于一把上膛的枪)。改用现成的 `HeadlessApprovalBackend("approve-read-only")`(`permission.ts:18`,已实现 approve-all / deny-all / approve-read-only 三模式)——只读工具自动批准,写操作默认拒绝。等 Phase 4 沙箱落地后再开放到 `approve-all` + 沙箱兜底。
   - **实现契约(避免误接)**:`approve-read-only` 当前不是 `permissionMode` 枚举值,不能通过 `permissionMode: "approve-read-only"` 表达。Phase 0 若直跑 Engine,必须显式传 `approvalBackend: new HeadlessApprovalBackend("approve-read-only")`;若提前走 `RunManager`,则必须先扩展 `CreateRunManagerOptions` / `EngineRunnerConfig` 透传 `approvalBackend`,再接 cron。
2. **在引擎/CLI 启动处调用 `bindCronToEngine`** — 找到 Engine 构造或 TUI 启动入口(`packages/tui/src/cli/main.ts`),在 assistant/daemon 模式下绑定。

### 测试(先写)
- `cron-runtime.test.ts`:fake scheduler + fake engine,断言 executor 被 setExecutor 注册,且 job 触发时 engine 收到正确 prompt 与显式 `approve-read-only` 审批后端。
- 审批回归:cron 默认允许 `Read/Grep/Glob` 等只读工具,拒绝 `Write/Edit/Bash` 等写入/命令工具;禁止用不存在的 `permissionMode: "approve-read-only"` 伪实现。
- executor 抛错时不崩溃(`scheduler.ts:115` 已 try/catch,但补一条断言保证不阻断后续 tick)。

### 验收
- 创建一个 `30s` 的 cron job,观察 30s 后真的有一次 Engine run 发生(日志或 RunStore 出现新 run)。

---

## Phase 1 — 接通后台完成通知 (B3) 【~~P0~~ → P1,仅剩 headless 尾巴】

**目标**:后台 agent / 后台 run 完成后,结果自动注入主 session,无需轮询。

### 改动
1. ~~**TUI 侧消费者**~~ **✅ 已实现(2026-05-31 复核)** —— `tui/src/ui/App.tsx:1360-1371` 已订阅 `notificationQueue.subscribe`(via `useSyncExternalStore`),并在 idle(`input.trim()===""`、非 `isQueryActive`、无 overlay)时 `drainAll` → `buildNotificationMessage` + `buildNotificationSummary` → `submitToEngine(…,{asInjection:true})`。这正是原计划描述的契约,无需再做。
2. **headless 侧消费者(本阶段唯一剩余项)**:`run` / `runs` 命令当前**不** drain notification(`grep drainAll packages/tui/src/cli/commands/run.ts` 为空)。需在主 turn loop 每轮结束 / 任务结束处 drain 一次。
   - 注意:headless 是一次性任务,turn 边界注入的意义有限;更主要的价值是把后台结果**汇总进最终输出 / `--output-last-message`**(见 Phase 3),而非"喂下一轮"。
   - **生命周期契约**:不能只在 `client.run()` 返回后立刻 `drainAll` 一次然后 `process.exit`。如果后台 agent 尚未完成,这一 drain 会拿不到结果,随后 close server/client 会让结果永久丢失。需在 `runCommand` 关闭 server/client 与 `process.exit` 前定义等待策略:默认短 timeout 等待当前 session 的后台 agent 完成,或提供 `--wait-background-agents` / `--no-wait-background-agents` 明确控制;超时必须输出明确状态而不是静默丢失。

### 测试(先写)
- headless:模拟后台 agent enqueue 一条 completed,断言 `run` 结束输出包含该通知。
- headless 生命周期:后台 agent 在主结果之后完成时仍能输出;超时未完成时输出明确状态;server/client shutdown 不会早于 drain/汇总。
- 多条 batch:断言 `drainAll` 原子清空,不重复注入。
- cancelled 不入队(已由 `agent.ts` 保证,补一条回归断言)。
- TUI 侧已实现,补一条回归测试锁住 `App.tsx` 的 idle-drain 行为即可,不重写。

### 验收
- headless `run` 启动一个 `run_in_background: true` 的子 agent,即使子 agent 晚于主任务完成,其完成结果也会在等待策略允许的窗口内出现在输出中。
- TUI 侧验收已天然满足(现状即可复现)。

---

## Phase 2 — cron 持久化 (B2) 【P0】

**目标**:cron job 跨重启存活。

### 改动
1. **`cron/cron-store.ts`** — 读写 `.code-shell/cron.json`(项目级)或 `~/.code-shell/cron.json`(全局),复用 `run/FileRunStore.ts` 的原子写思路,但不要把 JSONL append lock 直接当成 cron 快照事务。
   - **并发模型必须先选清楚**:如果采用单文件 `cron.json` 快照,两个进程同时 `CronCreate` 是读-改-写丢更新风险,仅 tmp+rename 不够,需要文件锁 / CAS / retry merge。若采用 JSONL event log,才适合 append-only + replay 的模式。v1 如只保证单进程,需在文档、测试与 CLI 行为中明确“不保证多进程同时写”。
2. **`CronScheduler` 增量改造**:`create/delete/pause/resume` 后调用 store 持久化;启动时 `loadJobs()` 恢复并重建定时器。
   - 注意 `nextRun`:重启后按 `parseSchedule` 重算下一次,不补跑错过的(对齐 Codex「无状态」哲学,避免重启惊群)。可选:记录 `lastRun`,提供 `--catch-up` 开关留待后续。
3. **持久化粒度**:复用 `CronJob` 现有字段(`scheduler.ts:8-18`),已含 `lastRun/runCount/createdAt`,直接序列化即可。

### 测试(先写)
- 写 job → 新建 scheduler 实例 loadJobs → 断言 job 与定时器恢复。
- 并发写:按选定模型测试。单文件快照需模拟两个 store 实例并发 create 不丢失;JSONL event log 需测试 append + replay;若 v1 限定单进程,则测试与文档都明确该限制,不虚假承诺跨进程安全。

### 验收
- 创建 job → 重启进程 → `CronList` 仍列出该 job 且继续触发。

---

## Phase 3 — Headless 对齐 `codex exec` 【P1】

**目标**:`code-shell run` 达到可挂 CI 的脚本化水平。

> **复核修正(2026-05-31)**:原计划列的两个"硬阻塞"其实已实现,本阶段范围大幅缩小。

### 改动(`packages/tui/src/cli/commands/run.ts`)
1. ~~**退出码语义**~~ **✅ 已实现** —— `run.ts:257` `exitCode = result.reason === "completed" ? 0 : 1`,`:264` `process.exit(exitCode)`。原"当前缺失,是硬阻塞"的判断已过时,仅需补测试锁定。
2. ~~**`--output-format`**~~ **✅ 基础设施已存在** —— `run.ts:242` 读 `options.output`,`output/renderer.ts:14` 的 `OutputFormat` 已含 `"text" | "json" | "jsonl" | "stream-json"` 全部四种,`createRenderer` 已接。仅需:校验各 format 实际输出符合 codex/CC 约定 + 补快照测试(不是从零做)。
   - **schema 验收**:当前 `jsonl` 与 `stream-json` 实现都近似为逐事件 `JSON.stringify(event)`,差异不明显。需明确两者是否应对齐不同上游语义,还是作为 alias;不能只因“有四个枚举值”就认定兼容。测试应锁定 `json` 单最终对象、`jsonl` 事件日志、`stream-json` 流式事件的字段与事件类型。
3. **stdin pipe pass-through(真缺失)**:`run.ts:91` `task: string` 为必填参数,无 stdin 读取路径。需:无 `<task>` 且 `!process.stdin.isTTY` 时从 stdin 读 prompt。对齐 codex `RequiredIfPiped`。
4. **`--output-last-message <file>`(真缺失)**:把最终消息写文件,对齐 codex `-o`。可与 Phase 1 headless drain 合流(把后台通知一并写入)。

### 测试(先写)
- 回归:成功任务 exit 0、失败 exit 1(锁定现状)。
- echo 管道喂 prompt,断言被读取(新功能)。
- 各 output-format 的 schema/快照测试(校验现有实现,并明确 `jsonl` 与 `stream-json` 是否不同或互为 alias)。
- `--output-last-message` 写入文件内容正确(新功能)。

### 验收
- `echo "list files" | code-shell run --output-format stream-json; echo "exit=$?"` 输出逐行 JSON 且退出码正确。

---

## Phase 4 — Sandbox 落地 【P1】

**目标**:无人值守 + `bypassPermissions` 时有隔离兜底(Phase 0 的安全前提)。

### 现状
`tool-system/sandbox/` 已有 `seatbelt.ts`(macOS)、`bwrap.ts`(Linux)、`off.ts`、`index.ts` —— 需核实是骨架还是可用,从骨架做成真隔离。

### 改动
1. 核实 seatbelt/bwrap 当前实现深度(读这四个文件)。
2. 接到 Bash/危险工具执行路径:`bypassPermissions` 或 cron executor 默认套 `workspace-write` 级沙箱(对齐 codex `SandboxMode::WorkspaceWrite`)。
3. 三级策略对齐 codex:`read-only` / `workspace-write` / `danger-full-access`,经 settings 与 CLI flag 配置。

### 测试
- 沙箱内写工作目录外文件被拒;工作目录内允许。
- 平台缺失沙箱工具时优雅降级 + 明确告警(不静默关闭隔离)。

### 验收
- 在 sandbox=workspace-write 下,`rm` 项目外文件失败;项目内成功。

> ⚠️ 本阶段涉及真实命令执行隔离,改动前先单独读 `sandbox/*.ts` 确认现状,可能需要拆成独立 plan。

---

## Phase 5 — RunManager × Cron 组合 + Guardian 【P2】

**目标**:做出 Codex/CC 都没有的能力——**定时的、可 checkpoint/resume 的后台任务**。

### 改动
1. **Cron executor 改走 RunManager**:把 Phase 0 的直跑替换为 `runManager.submit({ prompt: job.prompt, ... })`。
   - 收益:定时任务自动获得队列、checkpoint、resume、attach —— 复用 `RunManager` 现有全套能力(`RunManager.ts:65`)。
   - 这是 codeshell 的架构优势点:CC 的本地 cron 直接喂 prompt 队列,没有 checkpoint/resume;codex 干脆没有内置 cron。
2. **Guardian 子代理审批**(对齐 CC `auto` 模式的分类器,但用子 agent):
   - 无人值守下,危险工具调用先交给一个轻量 Guardian 子 agent 判 approve/deny/ask。
   - 接到 `tool-system/permission.ts` 的 backend 体系(已有 `HeadlessApprovalBackend` 3 种模式,加一个 `GuardianApprovalBackend`)。

### 测试
- 定时 job 触发 → 进 RunManager 队列 → 可 attach/resume。
- Guardian 对 `rm -rf` 判 deny,对只读命令判 approve。

### 验收
- 定时跑的任务中途 ctrl-c,可 `runs resume <id>` 续上。

---

## 执行顺序与依赖

```
Phase 0 (cron executor) ─┐
Phase 2 (cron persist)  ─┴─ P0:两个构成最小无人值守闭环(B1+B2)
        │
Phase 1 (headless drain)── P1:TUI 侧已实现,仅补 headless 尾巴,可与 Phase 3 合流
Phase 3 (headless exec) ── P1:exit码/output-format 已具备,仅补 stdin + last-message
Phase 4 (sandbox)       ── P1:Phase 0 的安全兜底(强烈建议在大规模无人值守前完成)
        │
Phase 5 (RunMgr×Cron + Guardian) ── P2:依赖 Phase 0 + Phase 4
```

**最小可用里程碑**:Phase 0 + 2 完成(B1+B2)→ 「定时触发 → 执行(默认 approve-read-only)→ 重启不丢」闭环成立。后台完成回报在 TUI 侧已可用;headless 回报随 Phase 1 尾巴补齐。

## 不做(明确排除)

- 远程定时 agent(CC 的 CCR Triggers / Anthropic 远程基础设施)—— codeshell 无对应后端,不在范围。
- 补跑错过的 cron(catch-up)—— 默认按 Codex 无状态哲学,重启不补跑;留作 Phase 2 可选开关。
- `codex cloud-tasks` 式企业云任务 —— 范围外。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Phase 0 直跑无沙箱即上线 → 无人值守误删 | **默认 `approve-read-only`**(写操作自动拒绝),不在 Phase 4 沙箱就绪前开放 `approve-all`/`bypassPermissions`;验收仅用安全 prompt |
| cron 定时器与 setInterval 漂移 | 现状 `setInterval` 已够;若需精确,后续可换成 next-run 计算 + setTimeout(留待) |
| notification 注入打断用户输入 | 严格在 idle / turn 边界 drain(Phase 1 设计已含),不在用户打字中插入 |

## 参考(对标证据)

- Codex `exec`:`codex-rs/exec/src/lib.rs:820`(主循环)、`:885-941`(退出码);approval `protocol/src/protocol.rs:764`;sandbox `config_types.rs:86`。
- Claude Code:本地 cron `cronScheduler.ts`(文件锁 + 1s 轮询);后台 agent webhook 回父会话 `AgentTool.tsx:87`;权限分类器 `yoloClassifier.ts`。
- 上游对比文档:`docs/comparison/`、`docs/subagent-design-comparison-2026-05-27.md`。

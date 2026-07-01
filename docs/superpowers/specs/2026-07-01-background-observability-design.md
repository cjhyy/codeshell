# 后台 / 外部工作可观测性 — 设计稿

> 日期：2026-07-01
> 来源：TODO.md「后台面板 / DriveAgent 可观测性」#2/#5/#6/#10（均标【需拍方案】）。
> 状态：设计已与用户逐条确认（见每节「决策」）。待写实现计划。

## 背景与范围

这是 4 个**互相独立**的可观测性缺口，被归为一类只因都属于「后台/外部工作对宿主 UI 不可见」。它们落在**不同 UI 位置**，不是同一个面板：

| # | 缺口 | 看的地方 |
|---|------|---------|
| #2/#5 | 后台 job 完成即从列表消失、无结果详情 | **BackgroundShellPanel**（后台面板本身） |
| #6 | 外部 agent(DriveAgent) 改的文件不进汇总 | **聊天流「已编辑文件」汇总卡** + 右侧文件/审查面板 |
| #10 | 浏览器新标签端口探测刷控制台报错 | **浏览器面板**地址栏端口建议 + DevTools 控制台 |

每节可独立实现、独立测试、独立合入。实现计划应把它们排成 3 个独立工作项。

---

## #2/#5 — 保留已完成的后台 job + 结果详情

**决策**：改标 status + 存 finalText，事件驱动清理为主 + 宽松封顶做内存兜底。

### 现状
`backgroundJobRegistry`（`packages/core/src/tool-system/builtin/background-jobs.ts`）是进程内 `Map<jobId, BackgroundJobEntry>`。`finish(jobId)` 直接 `jobs.delete` → job 一完成就从 `listForSession` 消失，`BackgroundJobEntry` 只有 `{jobId, sessionId, description}`，不存结果。面板（`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx`）因此看不到任何已完成 job。

### 设计
1. **`BackgroundJobEntry` 扩字段**（core）：
   - `status: "running" | "completed" | "failed"`（新增，默认 running）
   - `finalText?: string`（完成/失败时的结果或错误摘要）
   - `ccSessionId?: string`（外部 CLI 的 session id，供 #6 复用；见下）
   - `startedAt: number` / `finishedAt?: number`（排序 + 相对时间）
2. **`finish(jobId, outcome)` 不再 delete**：改标 `status` + 写 `finalText`/`finishedAt`，`notify()`。
   - `hasRunningForSession` 只数 `status === "running"` —— **不变** engine wait-loop 语义（只等 running）。
   - `listForSession` 返回 running + 终态（面板要都显示）；可加 `listRunningForSession` 给 judge 用（或让现有调用点自己 filter status==running）。
3. **清理（事件驱动为主）**：
   - **主**：session 被删除时连带清它的 job。接 `planSessionDeletion` 的删除路径 / core 的 session close —— 新增 `backgroundJobRegistry.dropForSession(sessionId)`，在 `handleCloseSession`（`server.ts`）或 delete 路径调用。
   - **兜底**：每 session **终态** job 宽松上限（`MAX_TERMINAL_JOBS_PER_SESSION = 50`），`finish` 后若超限，按 `finishedAt` 汰最早的终态 job（running 永不汰）。纯防内存无限增长，人不会察觉。
4. **面板**（desktop `BackgroundShellPanel.tsx` + `preload/types.d.ts`）：
   - job 列表项显示 status 徽标（running spinner / completed / failed）。
   - 点击展开看 `finalText`（+ 有 ccSessionId 时可跳外部 transcript，见 #6）。
   - preload 的 background-job 类型补 `status`/`finalText`/`finishedAt`。

### 测试
- core：`finish` 后 entry 仍在且 `status==completed`/`finalText` 存；`hasRunningForSession` 完成后转 false；超限汰最早终态、留 running；`dropForSession` 清指定 session。
- 纯函数优先（registry 是可直测单例，`reset()` 已有）。

---

## #6 — 外部 agent(DriveAgent) 改的文件回填汇总

**决策**：完成通知带 `ccSessionId`，宿主读外部 CLI transcript 解析改动文件回填。

### 现状
DriveAgent（`drive-claude-code.ts`）驱动外部 claude/codex，它们的 Edit/Write 落在**外部 transcript**（`~/.claude/projects/<cwd>/<sid>.jsonl` 等），宿主的 `fileChangeAggregator`（`packages/desktop/src/renderer/messages/fileChangeAggregator.ts`）只扫**本会话**的 tool 消息 → 外部改动无 diff/无计数/无文件名。

### 设计
1. **DriveAgent 完成结果带 `ccSessionId`**（core）：`drive-claude-code.ts` 完成时已知外部 CLI 的 session id（resume 用的那个），随后台 job 完成通知 / 工具结果一并带出（存进 #2/#5 的 `BackgroundJobEntry.ccSessionId`，同步 job 与外部 agent 复用一条路）。
2. **宿主解析外部 transcript**（desktop main）：
   - 新增 `external-agent-changes.ts`：给定 `ccSessionId` + cli 类型 + cwd，定位外部 transcript 文件，解析出该 run 的 Edit/Write/ApplyPatch 目标文件清单（去重、相对 cwd）。
   - claude 与 codex transcript 格式不同 → 两个 parser，一个 `detectFormat` 分派（复用 `parseCodexJsonLine` 已有基建，见记忆 `project_codex_driver`）。
3. **回填汇总卡**（desktop renderer）：`fileChangeAggregator` 收到带 `ccSessionId` 的完成事件时，把解析出的文件清单并入本轮 `files_changed`，标注来源「外部 agent」。**MVP 只回填文件名 + 计数**，diff 内容留后（外部 transcript 未必有完整 before/after）。

### 边界 / 风险
- transcript 格式随上游变 → parser 要容错（解析失败降级为「编辑了 N 个文件（无法解析明细）」而非崩）。
- 只读外部 transcript，不写。路径要 realpath containment 防越界读（复用 `path_containment_realpath` 惯例）。

### 测试
- parser 纯函数：喂 claude / codex transcript 样本 fixture，断言抽出的文件清单；坏行降级不抛。
- aggregator：带 ccSessionId 的完成事件 → 汇总卡出现外部文件计数。

---

## #10 — 浏览器端口探测下沉 main（真 TCP）

**决策**：端口发现下沉 main，`net.connect` 真 TCP 探测 + preload 暴露 + renderer 改调。

### 现状
`packages/desktop/src/renderer/browser/useLocalhostPorts.ts` 在 renderer 用 `fetch(http://localhost:PORT, {mode:"no-cors", ...})` 扫**硬编码** `CANDIDATE_PORTS`。失败请求在 catch 前已进 DevTools（刷红噪音）；`no-cors` opaque response 读不到状态码 → 403 误报；硬编码端口表既不全又浪费。

### 设计
1. **main 真 TCP 探测**（desktop main）：新增 `port-probe.ts`，对候选端口用 `net.connect({port, host:"127.0.0.1"})` + 短超时（~300ms）+ 立即 `destroy()`，connect 成功 = 端口有人监听。不发 HTTP，无 CORS，无控制台噪音。
2. **preload 暴露**：`window.codeshell.probeLocalhostPorts(ports: number[]): Promise<number[]>`（返回开着的端口）。
3. **renderer 改调**：`useLocalhostPorts` 改成调 preload，纯展示；删 renderer fetch。
4. **候选端口**：MVP 沿用现有硬编码表（本次只挪探测位置、消噪，不扩表）。「main 枚举系统监听端口（lsof）」留作后续增强，本稿不做（跨平台 lsof 解析成本高）。

### 测试
- `port-probe.ts` 纯逻辑：起一个 `net.createServer().listen(0)` 拿真端口，probe 该端口返回 open、probe 一个空端口返回 closed、超时端口不挂。
- desktop tsc 干净（改完 build core+cdp 再 typecheck，见记忆 `project_medium_security_batch_2026_07_01` 的坑）。

---

## 不做（YAGNI / 留后）

- #2/#5 job 历史落盘（选了内存+事件清理，不落盘）。
- #6 完整 diff（只回填文件名+计数）。
- #10 lsof 系统端口枚举（沿用硬编码候选表）。
- #10 renderer 侧临时消噪（直接下沉 main，不做过渡态）。

## 实现顺序建议

三项独立，各自 worktree → TDD → cherry-pick main。建议先 #10（最小、纯 desktop）、再 #2/#5（core+desktop，为 #6 铺 ccSessionId 字段）、最后 #6（依赖 #2/#5 的 ccSessionId 字段 + 最重）。

# 自动化：cron 触发接力修复 + 详情页整理 + 时区/权限对齐

日期：2026-07-01
状态：设计已定，待 review

## 背景与问题

用户在对话里让 AI「10 分钟后继续看看」，AI 调 `CronCreate` 建了定时任务，但**到点永不触发**，UI 里「下次运行」永远显示「你切到自动化 Tab 的那一刻 + 10 分钟」。

### 根因（跨进程接力缺一跳）

codeshell 的定时有两条创建路径，命运不同：

| 创建方式 | 走哪 | 是否触发 |
|---|---|---|
| UI 自动化 Tab 手动「新建」 | renderer → `automation:create` IPC → 直接建在 **main 的 armed scheduler** | ✅ 立即生效 |
| AI 对话里用 `CronCreate` | 工具跑在 **worker 进程** → 只写盘 | ❌ 永不触发 |

- **worker 进程**（`agent-server-stdio.ts:269-271`）：`cronScheduler.setExecutionEnabled(false)`——只负责把 job 写进 `~/.code-shell/cron.json`，从不 arm 定时器、从不执行。这是设计（防两进程重复跑）。
- **main 进程**（`startAutomation`，`automation/index.ts:44`）：唯一 arm 定时器 + 执行的进程。
- main 学到 worker 新建 job 的**唯一途径**是 `syncFromStore()` → `loadJobs()`（`automation-service.ts:78`），而它**只在 renderer 调自动化 IPC 时触发**（即用户打开/操作自动化 Tab 时）。
- main 里**没有任何周期性 reconcile**（`index.ts` 只有 worktree sweep 的 setInterval）。

所以 AI 建的 job 写盘成功、返回「10 分钟后」，但 main 永远不知道它存在，除非用户手动打开自动化 Tab。「永远 10 分钟后」是 `refreshNextRunForDisplay`（`scheduler.ts:225`）每次 `loadJobs` 都把 interval 型的 `nextRun` 重算成 `Date.now() + interval` 造成的观感。

### 关联但独立的问题（本次一并处理）

3. **绑定 session 型定时无 UI 区分**：`resumeSessionId` 是新加字段，renderer 里零引用（全仓 grep 无 `resumeSessionId`/`continueInSession`）。绑定型 job 续的是同一个对话 session，但详情页仍按「新 session 型」显示历史 session 列表，语义错误。
4. **详情页信息重复/混排**：FieldRow 列表里的 `状态`/`下次运行`/`上次运行`/`最近运行` 与上方 stat 卡、下方 session 区重复；可编辑下拉与只读文本混在一个列表。
5. **权限措辞与对话不对齐**：对话是 plan/default/accept_edits/bypass，自动化是 read-only/workspace-write/full，同一个「权限」概念两套说法。
6. **时区下拉贫瘠**：`BASE_TIMEZONES` 硬编码 6 个时区，别的地区无法选择；默认 UTC 而非本地。

## 非目标（YAGNI）

- **不**在 UI 自动化 Tab 加「手动建绑定型 job」的入口——绑定型只在对话里用 `CronCreate` 建（对话内才有「当前对话」这个自然上下文）。
- **不**把对话的 plan/default/accept_edits/bypass 四档搬进自动化——那些是「审批策略」，无人值守场景没意义（没人看计划、没人点审批）。自动化的三档「写权限范围」模型是对的。
- **不**加运行期周期轮询。

## 架构与改动

分六块（A–F），可独立实现、独立测试。

### A. 事件推送替代轮询（修 bug 核心）

**机制**：worker 的 `CronCreate`/`CronDelete` 工具成功后，通过现成的 worker→main stdout JSON-RPC 通道推一条通知；main 的 bridge 收到后调用 `reloadAutomationJobs()`（内部 `scheduler.loadJobs()`，幂等，只 arm 新 job、清理已删 job）。

**为什么零成本**：worker→main 已有 JSON-RPC 通道（`agent/automationSession`、`agent/streamEvent` 都走它，`agent-bridge.ts:517-529`）。新增一条 `agent/cronChanged` 通知复用同一管线。

**兜底（选项3：重启补 + 开 Tab 补，运行期不轮询）**：
- 正常运行期完全靠推送，即时生效。
- 万一推送消息丢失（worker 崩溃/通道抖动，极小概率）：(1) 重启 app 时 main 启动的 `loadJobs()`（现成）全量 reload+arm；(2) 用户下次在自动化 Tab 做任何操作也会 `loadJobs()` 补上（现有天然路径）。

**接口**：
- core `cron.ts`：`cronCreateTool`/`cronDeleteTool` 成功后，需要一个「通知宿主 cron 已变更」的回调/事件。core 不认识 Electron，所以走一个可注入的 sink（例如 `onCronChanged` 回调注册在 worker 启动处），或复用 worker 已有的 stdout 事件发射器发一个 `agent/cronChanged` notification。
- desktop `agent-bridge.ts`：解析 `agent/cronChanged` → 调 `reloadAutomationJobs()`（`automation-service.ts` 暴露）。

**验证要点**：worker 建 job → main 无需任何 UI 操作即 arm 了定时器（测试：mock bridge，断言 `loadJobs` 被调）。

### B. 绑定 session 详情页（方案 A：单卡 + 续接标识）

**数据层**：`AutomationSummary`（`automation-service.ts` + `preload/types.d.ts:1359`）新增 `resumeSessionId: string | null` 字段，`toSummary()` 透出。

**详情页 `AutomationView.tsx`**：按 `resumeSessionId` 有无分流。
- **有值（绑定型）**：
  - 卡片头下方加 `🔗 续接对话` badge（accent-link 蓝，`hsl(199 89% 55%)`）。
  - **隐藏**历史 session 列表区，改为一张「绑定的对话」单卡：绑定 session 的标题、runStatus 徽章（已完成/运行中/失败）、最近更新时间、「打开对话 →」按钮（跳转到该 session）。
- **无值（新 session 型）**：维持现有历史 session 列表不变。

### C. 相对时间 + 绑定型并发守卫

**相对时间**：`fmtTime`（`AutomationView.tsx:105`）当前只输出绝对 `toLocaleString()`。stat 卡的「下次运行」「上次运行」改为「约 X 后 / X 前」相对时间为主 + 小字绝对时间。加一个 `fmtRelative(ms)` helper。修掉「永远 10 分钟后」观感（A 修好后 nextRun 本就是真值，相对时间让它更直观）。

**并发守卫（排队，用户已定）**：绑定型 job 到点时，若原 session 正忙（`isBusy()`），**不并发跑**——把这条输入排队，等当前轮结束再喂。
- 复用现有「喂 turn」通道（`injectResumeTurn` → `agent/run` 带 sessionId → worker `enqueueTurn`）。
- `enqueueTurn` 本身对忙碌 session 的语义需要确认：若它已是「排队下一轮」则天然满足；若它会拒绝/并发，需在 inject 侧加排队逻辑。关联记忆 `send_input并发守卫缺口`（send_input resume 路径不查 `entry.status==running` 会两 Engine 交错写同一 transcript）。
- **不丢**：排队而非跳过（对齐用户选择）。

### D. 详情页信息架构整理

**删除**（FieldRow 列表里与别处重复的行）：
- `状态`（`AutomationView.tsx:622`）——头部开关已表达。
- `下次运行`（734）/`上次运行`（735）——上方 stat 卡已有。
- `运行次数`（736）——移到 stat 卡（替换掉「历史 session」那格，或与之并列，见下）。
- `最近运行`（753）——下方 session 区的「运行详情」按钮已有。

**保留 + 分组**：剩下的可编辑项（`频率`/`时区`/`权限`/`项目`）归到一个带「配置」小标题（uppercase label）的卡里，与只读 stat 卡视觉分离，让「哪些能改」一目了然。

**stat 卡三格**：下次运行（相对）、上次运行（相对）、运行次数。

### E. 权限措辞/视觉向对话对齐（三档不变）

保持 read-only/workspace-write/full 三档不动（底层 `resolveWritePolicy` 不改），只改**展示**：
- 措辞加说明，向对话语感靠拢：`只读（只看不改）` / `可写工作区（改本项目文件）` / `完全（改文件 + 提 PR）`。
- 加 tone 颜色，对齐对话 `PermissionPill` 的 ok/warn/err：read-only=ok（中性/绿）、workspace-write=warn、full=err（红），让高权限档视觉上更醒目。
- i18n：`auto.permission.*` 三个 key 的 zh/en 文案更新（现有 key 复用，见 `i18n/ns/automation.ts:51`）。

### F. 时区双下拉（城市为主 + UTC 联动过滤）

**两个独立下拉框**，联动但存的始终是 IANA 城市（自动处理夏令时）：

- **下拉1（城市/地区）**：选项来自 `Intl.supportedValuesOf('timeZone')`（引擎内置，非硬编码，随系统 tzdata 更新），全量 IANA 时区。每项显示 `城市名 + 小字 UTC±X`（偏移用现有 `offsetNote()` 算）。**这是权威值**，存进 `job.timezone`。
- **下拉2（UTC 偏移）**：`UTC-12 … UTC+14` 的快捷筛选器。选一个偏移 → 把下拉1 的城市列表**过滤**成当前该偏移的城市。不单独存值，只影响下拉1 的可见项。
- 因为全量时区有几百个，下拉1 **必须可搜索**。

**前置任务（复用优先，已核实无现成件）**：仓库现无可搜索下拉——`simple-select.tsx` 的 `searchable` 是「accepted but ignored」，各处搜索（LogsView/FilesPanel/SessionsView）都是手搓 input+filter 过滤列表，形态不对不可复用。按 shadcn 官方标准做法：**装 `cmdk` 依赖 + 拷 shadcn `command.tsx`/`popover.tsx` → 组一个通用 `components/ui/combobox.tsx`**。时区城市下拉用它；做成通用件供将来别处「可搜索下拉」复用（用户明确要求各处复用）。选此方案而非纯手搓 Radix Popover+Input，因为 cmdk 是 shadcn 生态标准件，键盘导航/无障碍开箱即好，与现有 shadcn+Radix 体系一致。

**默认值**：新建 job 默认用系统时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）而非 UTC。改在 `CronCreate` 默认值 + UI 新建默认值两处（保持一致）。

## 实现顺序建议

1. **A**（修 bug，最高优先，独立）
2. **F 前置**（可搜索 select 组件）→ **F**（时区双下拉）
3. **D**（详情页整理，为 B 腾结构）
4. **B**（绑定 session 单卡，依赖 D 的结构 + `resumeSessionId` 透出）
5. **C**（相对时间 + 并发守卫）
6. **E**（权限措辞，最独立、最小）

## 测试策略

- **A**：单元测试 mock bridge，worker `CronCreate` → 断言 main `loadJobs`/reload 被触发；不依赖打开 UI。
- **B**：renderer 组件测试，`resumeSessionId` 有/无 → 渲染单卡 / 历史列表。
- **C**：`fmtRelative` 纯函数单测；并发守卫——原 session busy 时 inject 走排队不并发（复用/扩展 `automation-host.resume.test.ts`）。
- **D**：组件测试断言重复 FieldRow 不再渲染。
- **E**：i18n key 存在性 + tone 映射单测。
- **F**：时区列表来自 `Intl.supportedValuesOf`（mock 断言非硬编码数组）；UTC 下拉过滤逻辑单测；可搜索组件自身单测。

## 涉及文件（预估）

- core：`tool-system/builtin/cron.ts`（A 通知、F 默认时区）、worker 启动处 `cli/agent-server-stdio.ts`（A sink 注入）
- desktop main：`agent-bridge.ts`（A 解析 cronChanged）、`automation-service.ts`（A reload 暴露、B `resumeSessionId` 透出）、`index.ts`（A 接线、C inject 排队）
- desktop renderer：`automation/AutomationView.tsx`（B/C/D/E/F）、`automation/scheduleModel.ts` 或新 helper（C 相对时间、F 时区）、`components/ui/`（F 新可搜索组件）、`i18n/ns/automation.ts`（E/F 文案）
- preload：`types.d.ts`（B `resumeSessionId` 字段）

## 关联

- 前序 spec：`2026-07-01-cron-resume-as-fed-input-and-fold-fix-design.md`（实现了 resumeSessionId 续接路径，本 spec 补齐其 UI 与触发）
- 记忆：`project_cron_resume_via_enqueue_input`、`project_cron_resume_session`、`send_input并发守卫缺口`、`project_automation_run_sidebar`

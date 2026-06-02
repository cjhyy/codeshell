# 自动化权限贯通 + InvestigationGuard 只读误伤 — 调研结论（未实现）

> 日期：2026-06-02
> 状态：**仅调研存档，两个问题本轮都暂缓，未改代码。**
> 方法：四路 Explore 核实，全部带 file:line。
> 关键交汇点：两个问题都认同一个信号 —— `approve-read-only`。权限接通后，read-only 自动化 job 会顺带获得 guard 静默。

---

## 问题一：自动化权限没接上（job.permissionLevel 是孤儿特性）

### 数据链路与断点
```
UI 选 permissionLevel  (AutomationView.tsx:475)
  → automation-service.ts:97  createAutomation
  → scheduler.ts:230          create() 写进 job.permissionLevel   ✅ 存下来
  → scheduler.ts:495          fire 时 onExecute?.(job)
  → runner.ts                 两个 executor 二选一
       ├─ bindCronToEngine()       runner.ts:54-64    ✗ 硬编码 approve-read-only
       └─ bindCronToRunManager()   runner.ts:90-103   ✗ 根本不读 permissionLevel（桌面走这条）
```

- `bindCronToEngine()` runner.ts:54-64：硬编码 `permissionMode:"default"` + `HeadlessApprovalBackend("approve-read-only")`。
- `bindCronToRunManager()` runner.ts:90-103：连权限参数都不构造，submit 只传 objective/cwd/metadata。
- `buildDesktopRunManager()` automation-host.ts:30-47：全局写死 `HeadlessApprovalBackend("approve-read-only")`，注释自承 "Read-only contract until sandbox + write tiers land"。

### 已经写好但没人用的零件
- `resolveWritePolicy(level)` write-policy.ts:67-85 —— 输入 `CronPermissionLevel|undefined`，输出 `WritePolicy {permissionMode, approvalBackend, sandboxMode}`。**未知/undefined → fail-closed 落 read-only**。有测试。
- `TierApprovalBackend(level)` write-policy.ts:41-58 —— 为自动化设计的三档 backend。有测试。
- 全仓库消费者：**仅** index.ts 导出 + 各自 .test.ts，无生产调用方。

### 类型与取值
- `CronPermissionLevel = "read-only" | "workspace-write" | "full"`（write-policy.ts:23 / scheduler.ts:12）。
- `job.permissionLevel?: CronPermissionLevel`（scheduler.ts:29）。
- `ApprovalBackend` 接口仅 `requestApproval()`（permission.ts）。实现类：HeadlessApprovalBackend(permission.ts:18)、AutoApprovalBackend(permission.ts:42)、InteractiveApprovalBackend(permission.ts:144)、RunApprovalBackend(RunApprovalBackend.ts:43)、TierApprovalBackend(write-policy.ts:41)。

### 关键障碍：RunManager 权限是“全局一次性”
- `SubmitRunInput`（types.ts:144-151）**无任何权限字段**。
- backend 只在 `createRunManager`（factory.ts:87,112）注入一次，存到 `EngineRunner.config.approvalBackend`（EngineRunner.ts:128）。
- 每个 run 都 new 一个 Engine（EngineRunner.ts:203），backend 选择在 EngineRunner.ts:150-151：`override ?? runApprovalBackend`。**per-run 隔离天然成立**。

### 两种改法（评估完，未选定）
**方案 A — SubmitRunInput 加 per-run override（改动小，曾推荐）**
- types.ts:144 加可选 `approvalBackend?/permissionMode?/sandboxMode?`。
- 顺链 submit → executeRun → RunExecutionContext → EngineRunner.execute。
- EngineRunner.ts:150 改 `const override = context.overrideApprovalBackend ?? this.config.approvalBackend;`。
- runner.ts 调 `resolveWritePolicy(job.permissionLevel)` 展开传入。
- 改动面：3-4 文件、~8-12 行、**零删除、向后兼容**，复用已有 override 模式。

**方案 B — 按 level 预建 3 个 RunManager**
- 不动 core/run 接口；automation-host 预建 read-only/workspace-write/full 三个，bind 时按 job 路由。
- 代价：资源 ×3、路由逻辑散在外面。A 既然这么轻，B 的“不侵入”不划算。

### fail-closed 要求
未知 level / 解析失败一律降级 read-only —— `resolveWritePolicy` 已是此行为，接线时别绕过。

---

## 问题二：InvestigationGuard 与“显式只读深度分析”冲突

### 现象
用户明确要求只读时，连续 Glob/Grep/Read 会被持续注入 “make a code change / run side effect / ask user” 提示，诱导违反只读约束。

### 机制（investigation-guard.ts，class，第42行）
三个独立计数器：
1. **dedupe 重复读取**：同一目标第2次 → 附 reminder（:100-104）；**第3次 → hard-block 真正拦截工具**（:84-99，交互式返回 error）。签名按文件路径+50行bucket（:156-176）。
2. **read-budget 连续只读**：`READ_BUDGET=3`（:24），>3 次连续只读工具且无动作 → 注入 reminder（:107-112）。
3. **silent-turns 安静回合**：`SILENT_TURN_BUDGET=3`（:25），≥3 回合只读且无文本输出 → 下一回合注入 reminder（:123-143）。
- 重置：任何可变工具（Bash/Edit/Write/NotebookEdit/AskUserQuestion）触发即清零（:145-151）。
- 接线：engine.ts:1150-1152 创建并 `setInvestigationGuard`；executor.ts:216-225 preToolCheck；executor.ts:333-335 prepend reminder；turn-loop.ts:618-626 回合末 silent 检查。

### 误伤判定：属实
- 只有 **dedupe 第3次是 hard-block**（交互式直接拒工具），其余两个是注入 system-reminder 文案 —— 即用户描述的“持续催促”。
- 唯一现有缓解 = headless soft-mode（engine.ts:1151，把 hard-block 降为 reminder），**交互式只读会话无任何 override**。
- guard 无条件运行；`AgentDefinition`（agent-definition.ts:4-26）**无 readOnly 字段**，只有 `tools` allowlist；subagent 各有独立 guard 实例，不共享父状态。

### 设计决定（已和用户敲定，待实现）
- override **复用 approve-read-only 信号**，不新增 readOnly 字段。
- override 打开后 guard **全关静默**：不 hard-block、不注入任何 reminder。
- 覆盖三场景：① 用户明确只读 → 走 read-only backend；② researcher/review subagent → 用 read-only backend；③ 自动化 read-only job。

### 待定（本轮未选）：read-only 探测方式
- 选项甲（倾向）：`ApprovalBackend` 加可选 `isReadOnly?(): boolean`，`HeadlessApprovalBackend("approve-read-only")` 与 `TierApprovalBackend("read-only")` 返 true；executor 据此决定是否启用 guard。干净、可扩展、不靠 instanceof。
- 选项乙：executor 用 instanceof + mode 探测那两个具体类。脆弱。

---

## 交汇收益
做完问题一后，read-only 自动化 job 的 backend 就是 `approve-read-only`，**自动获得问题二的 guard 静默** —— 正是“用户明确只读却被持续催促”的根因之一，一并解决。

## 关键文件速查
- runner 焊点：`automation/runner.ts:54-103`
- 桌面宿主焊点：`desktop/src/main/automation-host.ts:30-47`
- 写策略/TierBackend（已写未用）：`automation/write-policy.ts:41,67`
- RunManager 权限链：`run/types.ts:144` · `run/factory.ts:87,112` · `run/EngineRunner.ts:128,150-151,203`
- guard：`tool-system/investigation-guard.ts:24,25,42,84,107,123,145` · 接线 `engine.ts:1150` `executor.ts:216,333` `turn-loop.ts:618`
- agent 定义（无 readOnly 字段）：`tool-system/agent-definition.ts:4-26`
- backend 实现：`tool-system/permission.ts:18,42,144` · `run/RunApprovalBackend.ts:43` · `automation/write-policy.ts:41`

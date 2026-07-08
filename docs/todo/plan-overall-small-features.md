# 小 Feature 整体技术方案（TODO.md「小 feature / 主分支迭代」批次）

> 汇总自三份分组方案：
> - [plan-group-a-core.md](./plan-group-a-core.md)（core 层）
> - [plan-group-b-compaction-ui.md](./plan-group-b-compaction-ui.md)（压缩 / 上下文 UI）
> - [plan-group-c-worktree-panels.md](./plan-group-c-worktree-panels.md)（worktree / 面板 / 消息）
>
> 三份分组方案均已按当前 git HEAD 逐条核实行号锚点、当前实现、改动步骤、测试与风险。本文件是**执行总纲**：给出全局顺序、跨组依赖、风险分级和交付建议。行号会随代码演进偏移，实现时以分组文档 + 实时代码为准。

---

## 0. 全局结论

- 共 **11 个小 feature**，全部为 S / S-M 体量，无 L。
- 其中 **1 个是数据安全项**（C-5 worktree 自动清理静默强删），优先级最高（🔴）。
- **core 层（A 组）改动最小**：feature A-1（TodoWrite 测试）纯补测试 0 生产代码；A-3（skill scanner）约 3-8 行；A-2（压缩估算元数据）中等、可分两阶段且第二阶段可延后。
- **desktop 改动集中在两个热点文件**：`App.tsx`（B-1/B-2、C-2）与 `WorkspaceIndicator.tsx`（C-3/C-4）。同文件的 feature 必须**合并到同一批实现**，避免反复触碰同一段逻辑造成 merge 噪音。
- 全部改动**不改 core↔renderer 协议的破坏性语义**：新增字段一律 optional、向后兼容。

---

## 1. 依赖与冲突关系（决定执行顺序）

### 同文件耦合（必须同批做）
- **`App.tsx` compact 路径**：B-1（compacting 状态 + 输入禁用）与 B-2（ring 压缩后虚低）都改 `compactActiveSession()`（约 App.tsx:2443-2463）。→ **合并为一次实现**。
- **`WorkspaceIndicator.tsx`**：C-3（main 分支显示真实 HEAD）与 C-4（切换器分组/active 高亮）都改同一组件；C-4 的 main row 标题还**依赖 C-3 的 `mainBranch`**。→ **C-3 先落，C-4 紧接同批**。

### 跨组数据依赖
- C-4 复用 C-3 引入的 `mainBranch` state 和 `workspaceIndicatorText` 新签名。
- 其余 feature 相互独立，无共享状态。

### 与既有未提交工作的关系
- 记忆显示 steer / wakeup-fold 等多项修复未 push；本批全部为**新增/独立文件或独立函数**，与那些改动不重叠，可安全并行落地。

---

## 2. 推荐执行顺序（串行 codex，独立新 session，每个自带验证）

按「先 core 独立项 → 数据安全 → desktop 同文件聚合批」排：

| 序 | Feature | 组 | 体量 | 文件热点 | 说明 |
|----|---------|----|------|----------|------|
| 1 | 🔴 worktree 自动清理护栏 | C-5 | S-M | `desktop-services.ts` | 数据安全，最高优先，独立文件 |
| 2 | TodoWrite resume 测试 | A-1 | S(纯测试) | `task.test.ts`/`engine.todo-resume.test.ts` | 0 生产代码，先落防回归 |
| 3 | skill scanner 兼容 `.agents/skills/` | A-3 | S | `skills/scanner.ts` | 3-8 行 + 测试，独立 |
| 4 | 压缩 token 估算元数据（一阶段） | A-2 | S-M | `types.ts`/`manager.ts`/`engine.ts`/`turn-loop.ts` | 只加 source/confidence 元数据，第二阶段 tokenizer 延后 |
| 5 | compact 进行中 UI + ring 修正 | B-1 + B-2 | S-M | `App.tsx`/`ChatView.tsx`/`compactFeedback.ts` | 同 `compactActiveSession()`，一次做完 |
| 6 | 压缩完成横幅 UI | B-3 | S | `ContextBoundaryView.tsx`/`compactFeedback.ts`/`i18n` | 纯展示，解耦 |
| 7 | 后台面板「来源 session」徽标 | C-1 | S~S+ | `background-work.ts`/`BackgroundShellPanel.tsx`/preload | core+preload+renderer 贯通 |
| 8 | automation/mobile 乐观气泡 clientMessageId | C-2 | S | `App.tsx`/main automation-host/index.ts/preload | reducer 不动 |
| 9 | workspace 徽标 main 显示真实 HEAD | C-3 | S | `WorkspaceIndicator.tsx` | 引入 `mainBranch` |
| 10 | worktree 切换器分组/高亮 | C-4 | S | `WorkspaceIndicator.tsx` | 依赖 C-3，紧接同批 |

> 顺序 5、9-10 是「同文件聚合批」：给同一个 codex 实现 session 时应把配对项一起交，减少反复改同一文件。

---

## 3. 各 Feature 要点速查（详见分组文档）

### C-5 🔴 worktree 自动清理数据安全护栏（最高优先）
- **问题**：`cleanupStaleWorktrees()`（desktop-services.ts:318 起）只按目录 mtime + 托管前缀就 `git worktree remove --force` + `git branch -D`，失败还 `fs.rm(force)` 绕过 lock —— 静默丢未提交/未合并改动。
- **护栏三层**（删除前逐个候选）：
  1. `git -C <wt> status --porcelain=v1 --untracked-files=all` 非空 → skip `dirty`；
  2. base ref 确定（rootBranch，fallback main/master/origin/*）不可得 → skip `base_unknown`；
  3. `git -C <root> rev-list --count <base>..<branch>` > 0 → skip `unmerged_commits`；仅 count=0 才删。
- **删除 fallback `fs.rm(force)` 路径**；remove 失败记 `remove_failed` 保留。
- 新增 `git:worktreeCleanupSkipped` push event → preload 订阅 → renderer toast「已保留，需手动处理」（非普通错误文案）。
- 建议 `branch -d`（安全删）替代 `-D`；失败保留不升级。
- 测试矩阵见 C 文档：clean+merged 删除 / dirty 保留 / untracked 保留 / ahead 保留 / detached skip / external skip / base 缺失保留 / remove 失败不 fs.rm。

### A-1 TodoWrite resume 测试（0 生产代码）
- 新增 `task.test.ts`：`readLastTodoSnapshot` 恢复最新 pending/in_progress、忽略非 TodoWrite/无效项、全 completed 返回 `[]`、live 全 completed emit `[]`。
- 新增 `engine.todo-resume.test.ts`（fake provider，`enabledBuiltinTools:[]`）：resume 非空快照 emit 一次 `task_update`；全 completed 不 emit；多快照取最新。

### A-3 skill scanner 兼容 `.agents/skills/`
- `bases(cwd)` 顺序：`.code-shell/skills`(project) → `.agents/skills`(project) → `~/.code-shell/skills`(user)。`.code-shell` 优先，同名先到先得。
- `skillsDirsMtime()` 自动含新 base（已调用 `bases()`），热加载生效。source 保持 `"project"`，不改 listing 分组。
- 测试：发现 `.agents/skills` 项目 skill、`.code-shell` shadow `.agents`、`.agents` mtime 变化触发 memoize 失效。

### A-2 压缩 token 估算元数据（一阶段；tokenizer 二阶段延后）
- `StreamEvent` 的 `session_started`/`usage_update` 追加 **optional** `promptTokensSource` + `promptTokensConfidence`（向后兼容）。
- `ContextManager` 拆 `estimateTokensHybridInfo()` 带 `{tokens,source,confidence}`；`checkLimits()` 透出来源；**不改压缩阈值实际数值**。
- engine 首帧 seed 复用 context 估算（不再单独 char/4）；turn-loop 两类 emit 标 `provider_usage/high`、`heuristic_estimate/low`、有 overhead 后 `calibrated_estimate/medium`。
- **第二阶段**（provider/model-aware tokenizer，复用 `llm/token-counter.ts` 的 gpt-tokenizer）另起 PR，本批不做。

### B-1 + B-2 compact 进行中 UI + ring 修正（同 `compactActiveSession`）
- 新增 renderer-only `compactingBuckets: Set<string>`（放 App，不进 reducer/transcript）；`ChatView` 新增 `compacting?: boolean` prop。
- `busy` 仍是 agent turn；`compacting` 是 `/compact` RPC 飞行中——**不合并进 `busyKeys`**（否则误显 running + Stop 暗示可取消，但无 compact cancel API）。
- compacting 时 textarea `disabled`、send/model/permission/project 等控件禁用、composer 显示「正在压缩上下文…」；重复 `/compact` 只 toast in-progress 不发第二个 RPC；`.finally()` 必清 bucket。
- **ring 修正**：`compactActiveSession` 成功后不再直接写 `data.after`；改 `after + baseline`，`baseline = max(0, promptTokensBefore - data.before)`（补回 system/tools/memory 固定基线）。抽 `compactPromptTokensWithBaseline()` 到 `compactFeedback.ts` 便于单测。no-op（`after >= before`）不降 ring，只 toast。
- 新 i18n：`chat.composer.placeholderCompacting`、`chat.composer.compacting`、`chat.compact.inProgress`。

### B-3 压缩完成横幅 UI
- `ContextBoundaryView.tsx` 改正式居中系统事件条：左右细分隔线 + `Archive` 图标 chip + 标题「上下文已压缩」+ 结构化 `前 → 后 · 省 N% · 策略`。
- 修 `compactFeedback.ts` / i18n 文案标点空格（中文全角、英文用 `·`/正式 dash）。复用组件即覆盖 MessageStream 与 TurnProcessGroupCard 两处。

### C-1 后台面板「来源 session」徽标
- core UI entry 加 `sourceSession {sessionId, shortId, title?, current}`（**只加 UI entry，不动 goal judge 的 `listRunningBackgroundWork()`**）。
- `listBackgroundWorkForUI(current, {scope:"session"|"all"})`；新增 `BackgroundShellManager.list()`/`BackgroundJobRegistry.list()`。session 标题走轻量 `state.json` 只读 + 小缓存（不 `SessionManager.list()` 全量 tail）。
- protocol/preload 加 optional `scope`；renderer 用 `scope:"all"`，row 显示来源徽标，**shell output/kill 改用 row 的 owner sessionId**（否则 ownership 校验失败）；`selected` 改 composite key `sessionId:shellId`。
- 同步修 preload `index.ts` 与 `types.d.ts` 的 job 分支类型漂移。

### C-2 automation/mobile 乐观气泡 clientMessageId
- 同步 hash helper（FNV，不用 async WebCrypto 免影响 announce 时序）。
- automation：main runner 生成一次 `automation:${sid}:${hash(job.prompt)}`，announce 与 `engine.run` 同用；UI bubble 用原始 `job.prompt`（非 memory-prepended）。
- mobile：**必须 per-turn run id**（`mobile:${sessionId}:${runId}:${hash(text)}`），否则同 session 连发相同文本被误判重复。
- preload/renderer metadata 加 optional `clientMessageId`；App dispatch 透传；`transcriptsReducer` 无需改（现有 hydrate 保护自动生效）。

### C-3 workspace 徽标 main 显示真实 HEAD
- `WorkspaceIndicator` 加 `mainBranch` state，从已返回 `current` 的 `getGitBranches(repoPath)` 保存（`HEAD`/detached → null）。
- `workspaceIndicatorText` 加 `mainBranch` 选项：worktree 用 worktree branch，main 用真实 `mainBranch` 显示 `⑃ <branch>`，detached/读不到才回退 `"main"`。
- BranchPicker 切分支后派 `codeshell:git-branches-changed` 事件让徽标即时刷新；popover open / files-changed 时兜底 refresh。

### C-4 worktree 切换器分组/语义
- 分组渲染：main / managed worktrees / external；`WorkspaceRow` 显式算 `active`（path === current.root）与 `ownedByCurrentSession`（`occupiedBySessionIds.includes(sessionId)`，传 sessionId 进 row）。
- active row 高亮 + `aria-current` + `currentBadge`；owned 非 active 显 `thisSession` badge；当前项「selected」样式与 disabled opacity 拆开（不再看着像灰掉不可用）。
- main row 标题用 C-3 的 `⑃ <mainBranch>`。新增 i18n：`groupMain/groupWorktrees/groupExternal/currentBadge/thisSession`。

---

## 4. 风险分级

- **高（数据安全）**：C-5。护栏逻辑必须先写测试再改（TDD），删除 `fs.rm(force)` 尤其要覆盖 remove 失败分支。
- **中（token 数字语义）**：B-2 baseline 计算 + A-2 估算来源。B-2 helper 必须单测；注释标明依赖 `forceCompact()` 返回的是 `estimateTokens()`，若 core 语义变更需同步删 baseline。
- **中（跨 session 暴露）**：C-1 all-scope 会展示其他会话任务描述——本机 desktop 面板可接受，但默认只展示 live/retained，不展示完整 transcript。
- **低**：A-1/A-3/B-1/B-3/C-2/C-3/C-4，多为独立文件或纯 UI。

---

## 5. 交付建议

- 每个 feature（或同文件聚合批）由**独立新 codex session** 实现，实现完自跑该项验证命令（分组文档已列 `bun test ...`）。
- 提交前跑受影响测试确认无回归（符合仓库 pre-commit 规约）。
- 建议 commit 粒度：C-5 单独一提交（数据安全、便于审计）；A-1/A-3/A-2 各一提交；B-1+B-2 一提交、B-3 一提交；C-1/C-2 各一提交；C-3+C-4 一提交。
- 实现全部落地后，再由**独立新 codex session 做统一 review**（对照本方案 + 分组文档核实每项改动、测试与风险护栏是否到位）。

## 建议 conventional commit 前缀
- C-5：`fix(desktop): guard stale worktree cleanup against dirty/unmerged deletion`
- A-1：`test(core): cover TodoWrite resume snapshot restore`
- A-3：`feat(core): scan .agents/skills as project skill base`
- A-2：`feat(core): annotate prompt-token estimate source/confidence`
- B-1+B-2：`feat(desktop): compact in-flight UI + fix context ring baseline`
- B-3：`style(desktop): redesign context-compacted boundary banner`
- C-1：`feat(desktop): show source-session badge in background work panel`
- C-2：`fix(desktop): stable clientMessageId for automation/mobile announce bubbles`
- C-3+C-4：`feat(desktop): real HEAD branch label + grouped worktree switcher`

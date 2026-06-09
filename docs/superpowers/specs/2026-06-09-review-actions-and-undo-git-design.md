# 审查面板动作条 + undo/git 集成评估 — 设计稿

> 日期：2026-06-09 ｜ 状态：**已确认，待写实现计划**
> 范围：两件独立的事，合在一份稿里因为都涉及「git 写操作的风险边界」。
> - **① 审查面板动作条（TODO 2.3a Slice 3）** — 实现：commit / push / 创建 PR。
> - **② undo 与 git 集成（TODO 2.10）** — 仅评估，**本轮不写代码**，结论是「保持现状」。

---

## 背景 / 现状核实（2026-06-09）

**① ReviewPanel 现状**（`packages/desktop/src/renderer/panels/ReviewPanel.tsx`）：
- 「读」已完整：变更文件树 + 范围切换（turn / unstaged / staged / all / committed / branch）+ 增删行徽章 + diff 查看。
- git 数据全走 desktop main 的 `git:*` IPC（`desktop-services.ts` 的 `gitRun(cwd, args)` 用 `execFile` 跑真 git），**不经 agent worker / 权限系统**。已有的写操作 IPC：`git:switchBranch`、`git:stashAndSwitchBranch`、`git:createWorktree`。
- 还没有任何 commit / push / PR 动作条。

**② undo 现状**（`packages/core/src/session/`）：
- 单步 `/undo` 已做（commit `cc25b03`）。机制：AI 每次 Write/Edit/ApplyPatch **之前**，`file-history.ts:saveSnapshot` 存一份文件旧内容快照；`/undo` 用 `undo-target.ts:latestUndoTarget` 取最近快照，把文件还原成旧内容。
- 这套是「**零 git 污染**」的逐文件回退：只动工作区文件内容，不碰 git stage/commit。

---

## ② 评估结论（先讲，因为它决定本轮不动 ②的代码）

### 调研：Codex 怎么做的（事实，非记忆）

- Codex 至今**没有内建可靠的 undo/rewind**，官方文档明说「用平常的 git workflow 回滚」；社区在求 CC 式 checkpoint（[#11626](https://github.com/openai/codex/issues/11626)、[#16784](https://github.com/openai/codex/issues/16784)、[#12558](https://github.com/openai/codex/issues/12558)），仍在做。
- Codex 踩过的坑（[#5082](https://github.com/openai/codex/issues/5082)）：它的 Undo 会**偷偷把回退文件 stage 进 git**，用户强烈反对，共识是「**回退只动工作区文件内容，绝不擅动 git stage/commit 状态**」。
- 大家想要的 checkpoint 模型（CC 式）：每轮编辑前打 checkpoint，rewind 同时回退对话上下文 + AI 改的文件，**明确不回退 bash/外部改动、不动已提交历史**。

### 结论：保持现有快照机制，不引入 git stash / undo-commit

理由：
1. **方向本就对**：Codex 的教训是「别让 undo 碰 git 状态」。git stash 污染用户 stash 栈、auto-commit 污染提交历史，都是 #5082 反对的方向；现有 file-history 快照恰恰零 git 污染。
2. **用户约束天然满足**：用户明确「已提交的不回滚也行」。快照只在 AI 编辑前存、只还原工作区，已 commit 的不去动 —— 正好符合。
3. **真正差距是覆盖面而非引擎**：现有快照只覆盖 AI 的 Write/Edit/ApplyPatch，不覆盖 bash 生成的改动 —— 但 Codex 想要的 checkpoint **也不覆盖 bash**，所以这是合理边界，不是缺陷。

**因此 ②的「评估」产出 = 本文档这一节。不改造为 git stash/commit。** 可选小增量（不在本轮）：`/undo` 前若目标文件已有未提交改动，给一句「此文件有未保存改动，undo 将覆盖」的提示。

---

## ① 审查面板动作条 — 设计

### 决策汇总（已与用户确认）

| 维度 | 决策 |
|---|---|
| 执行边界 | **main 直接跑 git/gh**，复用 `desktop-services.ts:gitRun` 模式，新增 `git:*` IPC。不经 agent/权限系统。 |
| 范围 | **commit + push + 创建 PR 三个都做**。 |
| commit 信息 | **输入框（usePrompt）+ LLM「生成」按钮**（按钮调 auxModel 按 staged diff 生成一句建议填入）。 |
| 暂存 | **只提交已 staged，不自动 add**（遵循 Codex #5082 教训，不擅动用户 git 状态）。 |
| 反馈 | **复用 ToastProvider（useToast）+ 成功后 bump refreshKey 重拉文件树**；PR 成功额外给「打开链接」。 |

### 架构（自底向上）

**1. core（仅为 commit-msg「生成」按钮）**
- Engine 已有可复用的 `getAuxClient()`（`engine.ts:1964` 一带，按 `nKey` 取 aux 模型，缺失则回退主模型）。
- 新增 `Engine.generateCommitMessage(cwd): Promise<string>`：读 staged diff（`git diff --cached`，截断到合理 token 上限）→ 喂 aux client 出一句 conventional-commit 风格的中文/英文摘要 → 返回纯文本。失败/无 aux 时抛错，由 UI 兜底（用户照样能手填）。
- 走 core 是因为 LLM client 在 worker 侧，renderer 不直连 LLM（与 session 标题生成同源）。

**2. desktop main — git/gh 写操作服务**（`desktop-services.ts`，复用 `gitRun`）
- `commitStaged(cwd, message): Promise<void>` → `git commit -m <message>`（不带 `-a`，只提交已 staged）。
- `pushCurrent(cwd): Promise<{ pushed: boolean; setUpstream: boolean }>` → `git push`；若无 upstream 则 `git push -u origin <current-branch>`。
- `createPullRequest(cwd, { title, body }): Promise<{ url: string }>` → 经 `gh pr create`（`execFile("gh", …)`，与 gitRun 同模式但 cmd=gh）。`gh` 缺失/未登录时抛带可读信息的错误。
- 错误统一归一化为一个 Error 子类（沿用文件头部约定），renderer 用 toast 展示。

**3. IPC + preload**（`main/index.ts` 注册 `ipcMain.handle`，`preload/index.ts` 暴露 `window.codeshell.*`）
- `git:commit` → `commitStaged`
- `git:push` → `pushCurrent`
- `git:createPr` → `createPullRequest`
- `git:generateCommitMessage` → 转发到 worker 的 `Engine.generateCommitMessage`（走现有 engine 调用通道，非 `desktop-services`，因为它要 LLM）。
- preload 每个 handler 沿用现有 cwd 校验风格（`typeof cwd !== "string"` 抛错）。

**4. renderer — 动作条**（ReviewPanel.tsx 顶部新增一排）
- 用 `@/components/ui` 的 `Button`（**不手写 `<button>`** — 见 `packages/desktop/CLAUDE.md`；现有 ReviewPanel 里的裸 button 是遗留，不照抄）。
- 三个按钮：**提交** / **推送** / **创建 PR**。
- **按钮启用条件**（每次渲染据 `git:status` + 当前 scope 派生）：
  - 提交：有 staged 内容（status 中存在 index 态条目）。
  - 推送：本地有领先 commit（ahead）或当前分支有改动可推；无 upstream 时按钮文案变「推送并设置 upstream」。
  - 创建 PR：当前在非 base 分支上（branch scope 语义；在 main/master 上禁用并提示）。
- **commit 交互**：点提交 → `usePrompt` 弹输入框；输入框旁「生成」按钮调 `git:generateCommitMessage` 填入草稿（生成中转圈，失败 toast 但不阻塞手填）→ 确认后 `git:commit`。
- **PR 交互**：点创建 PR → `useConfirm`/`usePrompt` 收 title（默认取最近 commit subject）+ 可选 body → **二次确认**（外发不可逆）→ `git:createPr` → 成功 toast 带「打开」打开返回的 url（`window.codeshell.openExternal`）。
- **反馈**：成功/失败走 `useToast`；成功后 `setRefreshKey(k => k + 1)` 重拉文件树与状态。

### 错误处理
- 所有 git/gh 失败 → main 抛归一化 Error → renderer catch → toast 错误文案（保留 git/gh 的 stderr 摘要）。
- `gh` 未安装/未登录 → 创建 PR 按钮可点但失败时给明确指引文案（不预先探测，避免每次渲染跑 `gh auth status`）。
- commit-msg 生成失败 → 仅 toast，输入框照常可手填。

### 测试
- **core**：`generateCommitMessage` 用 stub aux client 测「读 staged diff → 出非空摘要」「无 staged → 合理兜底」「aux 缺失 → 抛错不崩」。
- **desktop main**：`commitStaged` / `pushCurrent` / `createPullRequest` 在临时 git repo 夹具上测真实行为（commit 只含 staged、push upstream 分支、gh 用 fake/PATH stub）。沿用现有 desktop-services 测试风格。
- **renderer**：按钮启用条件的纯函数（从 status+scope 派生 enabled 状态）抽出来单测；交互层最少化。

### 风险与边界
- **subagent 别乱动 git**（用户记忆约束）：本功能是**用户手动点击**触发的前台 UI 操作，**不**经 agent worker、**不**进任何 subagent 路径。实现计划里需把这条显式传给执行者：禁止让 subagent 跑 git commit/push。
- push/PR 是外发动作；PR 走二次确认。push 本身可逆性低（已推远程），但属用户主动点击，不加二次确认（与一般 git 客户端一致）；如需可后续加偏好。
- 不做：自动 stage、自动 amend、force push、分支管理（已有 switchBranch 等单独路径）。

---

## 交付物清单

- **②**：本文档 ②节即交付（评估结论：保持现状）。无代码。
- **①**：按上方架构实现，core + desktop main + preload + renderer 四层，配套测试。rebuild core（desktop 从 dist 导入 core）。

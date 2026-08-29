# Claude Code Repository Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Claude Code 本轮 7 日额度刷新前，串行完成尽可能多的高价值、证据驱动、可独立验收的 CodeShell 优化批次。

**Architecture:** 主工作区只保存规格与计划，所有实现位于一个独立 worktree/分支。Claude Code 先做只读审计，再一次只实施一个候选；每批遵循失败测试、最小修复、定向验证、全仓守门、独立复审和独立提交的闭环。额度刷新只阻止启动新批次，已经开始的批次必须完成或安全回退。

**Tech Stack:** Bun 1.3.11、TypeScript 5.7、React 19.2.6、Electron、Ink、Bun test、ESLint、Prettier、git worktree、Claude Code CLI。

## Global Constraints

- 遵循根 `CODESHELL.md`、`CLAUDE.md` 和 `AGENTS.md`。
- 包管理器只能使用 `bun`，不得使用 npm、yarn 或 pnpm。
- 主工作区 `packages/desktop/src/renderer/AppQuickChat.test.tsx` 与 `packages/desktop/src/renderer/cc-room/CCConversationView.test.tsx` 是用户未提交工作，禁止修改、暂存、覆盖、恢复或复制。
- 所有实现写操作必须位于独立 worktree；禁止直接改主工作区实现代码。
- 每批只处理一个有证据的事项，并生成一个 Conventional Commit。
- 禁止 push、自动合并、强推、`git reset --hard`、`git clean` 和绕过 hooks。
- 优先真实可靠性、安全、性能和产品化问题；禁止纯格式调整、无证据重构和依赖外部真 token/真机的项目。
- Claude Code 7 日额度刷新后停止启动新批次；已经开始的批次必须收口。

---

### Task 1: 建立隔离执行工作区

**Files:**
- Reference: `docs/superpowers/specs/2026-08-30-claude-code-repository-optimization-design.md`
- Reference: `docs/superpowers/plans/2026-08-30-claude-code-repository-optimization.md`
- Do not touch: `packages/desktop/src/renderer/AppQuickChat.test.tsx`
- Do not touch: `packages/desktop/src/renderer/cc-room/CCConversationView.test.tsx`

**Interfaces:**
- Consumes: 当前 `main` 的已提交 HEAD。
- Produces: 基于已提交 HEAD 的独立 worktree 和分支 `claude/repository-optimization-20260830`。

- [ ] **Step 1: 核对主工作区状态**

Run:

```bash
git status --short --branch
```

Expected: 输出两个已知未提交测试文件；若出现其他修改，只记录并继续隔离，不处理这些文件。

- [ ] **Step 2: 创建隔离 worktree**

使用 `superpowers:using-git-worktrees`；若仓库没有既定 worktree 目录，选择仓库外的 CodeShell 管理目录。分支名固定为：

```text
claude/repository-optimization-20260830
```

Expected: 新 worktree 基于当前已提交 HEAD，`git status --short` 为空。

- [ ] **Step 3: 验证隔离边界**

在新 worktree 运行：

```bash
git status --short --branch
git rev-parse --show-toplevel
git branch --show-current
```

Expected: 状态干净，根目录是新 worktree，当前分支为 `claude/repository-optimization-20260830`。

---

### Task 2: 用 Claude Code 生成证据化候选清单

**Files:**
- Reference: `TODO.md`
- Reference: `docs/architecture/`
- Reference: `docs/core-deep-dive/`
- Reference: `packages/`
- Create: `docs/todo/claude-repository-optimization-2026-08-30.md`

**Interfaces:**
- Consumes: 干净隔离 worktree、仓库指令、现有架构文档和测试配置。
- Produces: 按优先级排列的 3–5 个候选，每项包含证据、影响、最小范围、测试、风险和单 session 可行性。

- [ ] **Step 1: 启动单个 Claude Code 审计任务**

要求 Claude Code：

```text
只读审计整个 CodeShell monorepo，筛选 3–5 个有文件:行号、失败测试、日志或明确契约支撑的高价值候选。排除已完成事项、纯风格重构、外部真 token/真机验证和两个主工作区禁区文件。将结果写入 docs/todo/claude-repository-optimization-2026-08-30.md；除该审计文档外不改文件。最后推荐第一批并给出可判定验收标准。
```

- [ ] **Step 2: 校验候选清单完整性**

Run:

```bash
git diff --check -- docs/todo/claude-repository-optimization-2026-08-30.md
git diff -- docs/todo/claude-repository-optimization-2026-08-30.md
```

Expected: 文档没有空白错误；每个候选都有证据、用户影响、最小修改范围、测试命令、风险和推荐顺序，无 `TBD` 或待补信息。

- [ ] **Step 3: 提交审计清单**

```bash
git add -- docs/todo/claude-repository-optimization-2026-08-30.md
git commit -m "docs: audit repository optimization candidates"
```

Expected: 只提交审计文档。

---

### Task 3: 实施第一批高价值优化

**Files:**
- Reference: `docs/todo/claude-repository-optimization-2026-08-30.md`
- Modify/Test: 仅限审计清单第一候选明确列出的文件。

**Interfaces:**
- Consumes: 第一候选的问题证据与验收标准。
- Produces: 一个回归测试、最小修复、验证证据和一个独立 Conventional Commit。

- [ ] **Step 1: 复核准入条件**

确认第一候选同时满足：存在可核验问题证据；能写自动化回归测试；修改范围单一且不依赖未设计大功能；不碰两个禁区文件；不违反 public/extension/internal 与 capability/host 边界。任一条件不满足时，记录原因并选择清单中的下一候选。

- [ ] **Step 2: 调用 TDD 子技能并写失败测试**

Claude Code 必须先调用或遵循 `superpowers:test-driven-development`，只写能稳定表现目标契约的最小测试。不得先改生产实现。

- [ ] **Step 3: 运行最窄测试确认红灯**

使用候选文档给出的精确 Bun 测试命令。

Expected: 测试因目标问题失败，而不是导入、环境、fixture 或语法错误。若失败原因不符，修正测试后重新验证红灯。

- [ ] **Step 4: 实施最小修复**

只修改使该测试通过所需的生产代码。不得顺手重构相邻模块、升级依赖或改变无关 API。

- [ ] **Step 5: 运行定向验证**

依次运行候选文档列出的目标测试、受影响 package typecheck 和相关 lint。Expected: 全部退出码为 0。

- [ ] **Step 6: 审查本批 diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff
```

Expected: 只有本候选的测试和最小实现；无生成物、凭证、主工作区禁区文件或无关格式变化。

- [ ] **Step 7: 提交本批**

提交消息根据变更类型使用 `fix(scope): ...`、`perf(scope): ...`、`test(scope): ...` 或 `refactor(scope): ...`。禁止把多个候选揉进同一 commit。

---

### Task 4: 独立复审并修正本批

**Files:**
- Review: 上一批 commit 相对其 parent 的 diff。
- Modify/Test: 仅限复审确认的阻塞问题所涉及文件。

**Interfaces:**
- Consumes: 上一批独立 commit、候选验收标准和测试输出。
- Produces: Critical/Important 问题清零的复审结论；必要时生成同批修正 commit。

- [ ] **Step 1: 请求独立 Claude Code 代码复审**

复审范围固定为：

```bash
git diff HEAD^..HEAD
```

要求检查正确性、竞态、安全、兼容性、测试有效性、架构边界和是否越界。不得审查与该 commit 无关的历史代码。

- [ ] **Step 2: 处理复审结果**

Critical/Important 必须逐项验证并修复；Minor 只有在与本批同范围且无扩张时处理。对技术上不成立的建议写出证据后拒绝，不盲从。

- [ ] **Step 3: 重新运行定向验证并提交修正**

若有代码修正，重复 Task 3 的最窄测试、package typecheck、相关 lint 和 diff 审查，再使用同类型 Conventional Commit 提交。若无阻塞项，不创建空 commit。

---

### Task 5: 运行阶段性全仓守门

**Files:**
- No planned source changes.
- Evidence source: 命令输出。

**Interfaces:**
- Consumes: 已复审的优化 commit 序列。
- Produces: 全仓测试、类型、lint 和构建状态；区分本轮回归与既有失败。

- [ ] **Step 1: 运行全量测试**

```bash
bun test
```

Expected: 退出码 0。若失败，先用 `superpowers:systematic-debugging` 判断是否由本轮 commit 引入。

- [ ] **Step 2: 运行根类型检查**

```bash
bun run typecheck
```

Expected: 退出码 0；该命令也完成标准 build 顺序。

- [ ] **Step 3: 运行 lint 与引擎守卫**

```bash
bun run lint
bun run lint:engine-bypass
bun run lint:workflow-test-paths
bun run lint:baseline
```

Expected: 所有命令退出码 0。

- [ ] **Step 4: 记录既有失败**

若失败在干净基线可复现，记录命令、首个错误和基线复现证据，不通过跳过测试、放宽断言或 suppress lint 掩盖。若失败由本轮引入，返回 Task 3/4 修复后重跑全部守门。

---

### Task 6: 在额度边界前串行重复批次

**Files:**
- Update: `docs/todo/claude-repository-optimization-2026-08-30.md`
- Modify/Test: 每次仅限当前候选列出的文件。

**Interfaces:**
- Consumes: 剩余候选、上一批守门结果、Claude Code 7 日额度状态。
- Produces: 零个或多个额外独立优化 commit，以及候选状态更新。

- [ ] **Step 1: 每批开始前查询 Claude Code 额度**

若 7 日窗口尚未刷新且有满足准入条件的候选，选择优先级最高的下一项。若已经刷新，不再启动新批。

- [ ] **Step 2: 对当前候选重复完整闭环**

严格重复 Task 3（TDD 实施）、Task 4（独立复审）和 Task 5（阶段性守门）。写操作保持串行；确认上一 Claude Code job 已终止后才能 resume 或启动下一 job。

- [ ] **Step 3: 更新候选清单状态**

在每个候选下记录：`completed`、`skipped` 或 `blocked`；包含 commit、验证命令与结果。`skipped/blocked` 必须记录具体原因，不能用模糊描述。

- [ ] **Step 4: 提交清单更新**

```bash
git add -- docs/todo/claude-repository-optimization-2026-08-30.md
git commit -m "docs: update repository optimization results"
```

Expected: 只提交结果文档；若内容没有变化，不创建空 commit。

---

### Task 7: 额度刷新后收口并交付

**Files:**
- Final update: `docs/todo/claude-repository-optimization-2026-08-30.md`

**Interfaces:**
- Consumes: 所有优化 commits、最终守门输出和额度刷新状态。
- Produces: 可审阅分支、完整 commit 清单、测试证据、剩余候选和集成建议。

- [ ] **Step 1: 收口在途批次**

额度刷新时如果一批已开始，继续到测试、复审和 commit 完成；若无法正确完成，则只回退该批未提交改动，保留之前已完成 commits。不得留下脏 worktree。

- [ ] **Step 2: 运行最终验证**

调用 `superpowers:verification-before-completion`，重新运行：

```bash
bun test
bun run typecheck
bun run lint
bun run lint:engine-bypass
bun run lint:workflow-test-paths
bun run lint:baseline
git status --short
git log --oneline --decorate main..HEAD
```

Expected: 所有守门退出码 0，worktree 干净，commit 列表只包含本轮规格/计划之后的审计与优化成果。若存在已证明的基线失败，最终报告必须明确标注，不能声称全绿。

- [ ] **Step 3: 完成独立最终复审**

使用 `superpowers:requesting-code-review`，复审范围为：

```bash
git diff main...HEAD
```

Critical/Important 必须清零并重新运行受影响验证；不得把无关历史问题扩入本分支。

- [ ] **Step 4: 更新并提交最终报告**

最终文档必须包含：worktree 路径、分支、commit 清单、每批问题与用户影响、测试命令及结果、复审结论、剩余候选、已知基线失败和“不 push/不合并”的状态。

```bash
git add -- docs/todo/claude-repository-optimization-2026-08-30.md
git commit -m "docs: finalize repository optimization sweep"
```

- [ ] **Step 5: 提供集成选择**

调用 `superpowers:finishing-a-development-branch`，向用户提供审阅、合并、保留或丢弃 worktree 的选择。未经明确授权不得合并或 push。

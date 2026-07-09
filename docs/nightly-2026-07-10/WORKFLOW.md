# 今晚优化编排工作流（codex 三角色流水线）

> 本文档指引**编排 agent（本会话主 agent）**如何驱动 codex 把 `goal.md` 里的任务一项项做完。
> 单位是「一项任务 = 一条独立流水线」，严格串行推进：**做 → 审 → 合 → 清**，一项彻底收口再开下一项。

## 0. 角色与工具约定

- **编排 agent（我）**：读 `goal.md`、切 worktree、派 codex、审进度、合并、清扫、更新 `goal.md`。不亲自写业务代码。
- **codex-做（implementer）**：在**独立 worktree** 里实现一项任务，走 TDD，自测通过再交回。
- **codex-审（reviewer）**：**只读**审查该任务的 diff，产出 review 报告（SHIP / SHIP-with-nits / BLOCK）。
- **codex-合（integrator）**：把通过审查的分支合并到当前分支 `worktree/optimize-nightly-s-mrdrvs`，跑回归测试，然后清扫该任务的 worktree。

三个角色都用 `DriveAgent(cli:"codex")` 驱动，各自**独立 session**（不 resume 到别的任务上），派发时传 `permissionMode:"bypassPermissions"`（codex 沙箱默认断网，需要联网/写盘）。

## 0.5 核心原则：一切尽量交给 codex，保持主上下文清洁

- 编排 agent（我）**不亲自读大量代码、不亲自跑调研、不亲自写业务代码**。凡是"看很多文件才能得出结论"或"实现一块功能"的活，一律派给 codex 在它自己的上下文里做，只把**结论/产物路径**收回主线程。
- 调研类任务：codex 后台跑 → 产出 markdown 文档到 `docs/nightly-2026-07-10/` → 回报一段结论 + 文件指针。主上下文只留结论，不留过程。
- 实现类任务：codex 在独立 worktree 做 → 回报 commit + 一段总结。
- 编排 agent 只做：读 `goal.md`、切/清 worktree、派 codex、核实产物真实性（git log/status）、回写 `goal.md`、把候选清单交回卡密sama 圈定。

## 1. 铁律（违反会丢工作，务必遵守）

1. **绝不并发派两个 codex 改同一文件 / 同一 worktree**。同一时刻只有一条流水线在「做」阶段。
2. **DriveAgent 后台任务无法主动取消**，派出去只能等完成通知。所以派发前务必把 prompt 写成**完整自足、end-to-end、自带验收标准**的任务，别派「先看看 X」这种半吊子。
3. **一项任务一个 worktree**。worktree 路径统一放 `.worktrees/<task-slug>`（已在 .gitignore）。
4. **审查前先对齐 diff scope**：reviewer 必须只审该任务相对 merge-base 的 diff，不要顺带审无关历史代码。
5. **合并顺序**：只把**已通过审查（无 Blocker）**的分支合进 `worktree/optimize-nightly-s-mrdrvs`。有 Blocker 就打回 implementer 修，别硬合。
6. **提交前跑受影响测试**，即便失败看似是既有问题也要先查根因（见记忆 pre-commit-test-regression-check）。
7. 每完成一项，**立刻回写 `goal.md`**：勾掉该项、追加一行结果（commit、review 结论、回归结果）。

## 2. 单项任务的四步流水线

对 `goal.md` 里状态为 `[ ]` 的**下一项**任务 T，执行：

### Step A — 切 worktree（编排 agent 做）
- 起 slug：`task-<短名>`（如 `task-driveagent-inspect`）。
- 用 `git worktree add .worktrees/<slug> -b nightly/<slug>` 从当前分支 `worktree/optimize-nightly-s-mrdrvs` 切出。
  （或复用 native worktree 工具；不要让 codex 自己去 SwitchSessionWorkspace。）
- 记下绝对路径 `WT=<repo>/.worktrees/<slug>` 作为该项所有 codex 的 `cwd`。

### Step B — codex 做（DriveAgent cli:codex，background 默认）
派发 prompt 必须包含：
- **任务目标**：从 `goal.md` 该项的「目标 / 锚点 / 修法 / 验收」原样带过去。
- **工作目录**：`cwd = WT`。
- **纪律**：先 TDD 写测试再实现；只动本任务相关文件；完成前自行 `bun run typecheck`（容忍既有错误，只看新增）+ 跑受影响 `bun test`；把改动 commit 在 `nightly/<slug>` 上（conventional commit）。
- **定义完成**：功能实现 + 测试绿 + 已 commit + 用一段话总结「改了哪些文件、加了哪些测试、怎么验证的」。
- 传 `permissionMode:"bypassPermissions"`。
- 派出后 **end turn 等完成通知**，不 sleep/poll。

### Step C — codex 审（DriveAgent cli:codex，独立 session）
implementer 完成后：
- 先在 WT 里 `git log --oneline <base>..HEAD` 和 `git diff <base>...HEAD --stat` 确认 diff scope（base = `worktree/optimize-nightly-s-mrdrvs`）。
- 派 reviewer，prompt 含：`cwd=WT`、要审的 diff 范围、该任务验收标准、要求输出结论（SHIP / SHIP-with-nits / BLOCK）+ 每条 finding 的 severity + 代码锚点。报告写到 `docs/nightly-2026-07-10/review-<slug>.md`。
- **只读**：明确告诉 reviewer 不要改代码。
- 若 BLOCK：把 findings 交回 implementer（resume 其 session 或新派）修，修完重审。循环到无 Blocker。

### Step D — codex 合并 + 清扫（DriveAgent cli:codex，独立 session）
审查通过后：
- 派 integrator，`cwd = 当前主 worktree`（`worktree/optimize-nightly-s-mrdrvs` 的路径，**不是** WT），prompt：
  - `git merge --no-ff nightly/<slug>`。**冲突由 integrator（codex）自行解决**——它了解本分支改动意图，让它理解双方语义后正确合并，而不是报回来等编排 agent。仅当冲突涉及它无法判断的语义取舍（两边都改了同一业务逻辑且意图相悖）时才回报。
  - 合并后跑该任务受影响的回归测试 + `bun run typecheck` 看新增错误。
  - 回归绿后：`git worktree remove .worktrees/<slug>` 清扫；分支 `nightly/<slug>` 保留（合过了留着做痕迹，或按需删）。
- integrator 回报：merge commit hash、回归结果、worktree 是否已清。

### Step E — 收口（编排 agent 做）
- 回写 `goal.md`：该项 `[ ]` → `[x]`，追加结果行。
- 继续 Step A 处理下一项。

## 3. goal.md 驱动的持续工作

- 每开一项前**重读 `goal.md`**（它是唯一事实源，用户可能中途 update 了它）。
- 若用户在 `goal.md` 里加了新项 / 改了优先级 / 划掉了某项，以文件为准，不以我记忆为准。
- 所有小 feature 做完后，若「发版遗留（附加区）」还有勾选项，继续按同样流水线做。
- 全部 `[x]` 后，向用户汇报今晚总结（每项 commit + review 结论 + 回归），并询问是否把 `worktree/optimize-nightly-s-mrdrvs` 合回 main。

## 4. 出错处理

- codex 前台超时 / 静默返回：不轻信「已完成」，回 WT 用 `git log`/`git status` 核实真有 commit 再往下走。
- 合并冲突：**默认让 integrator（codex）自己理解语义后解决并继续合并**，不轻易报回。只有相悖的业务语义取舍才回报编排 agent，必要时问用户。任何角色都**不擅自 reset --hard / force**。
- 测试红且非本任务引入：先查根因，记进 `goal.md` 的「问题记录」区，不带病合并。

## 5. session 间上下文传递

- codex session 之间没有 thread 通信；`resumeSessionId` 只是续接**同一个** Codex thread，详见 `codex-session-communication.md`。
- 三角色默认各自新 session：implementer 产出 commit/finalText，reviewer 读 diff 并写 review 文件，integrator 读分支和 review 文件合并。
- 跨角色传上下文靠 prompt 明确携带 commit、diff 范围、review 报告路径、产物文件路径；不要指望 Codex 自动共享上下文。
- 只有 BLOCK 打回同一 implementer 继续修时才 resume implementer 自己的 session；不要并发 resume 同一个 session。

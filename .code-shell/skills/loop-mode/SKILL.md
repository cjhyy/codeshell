---
name: loop-mode
description: 处理 CodeShell 原生 /loop 命令，或用户明确要求 loop、内外循环、夜间无人循环时使用。不依赖 Goal 按钮或 Goal 状态；用主仓库 .loop 账本、短轮次执行、独立 worktree、候选分支和审查闸门实现可恢复的长时运行。
---

# Loop Mode

`/loop` 是独立的长时循环，不是 Goal 的别名。不得创建、更新、清除或借用 CodeShell Goal。循环靠“持久状态 + 有界轮次 + 下一次唤醒”续跑，不靠一个无限会话。

## 唯一入口

- `/loop <objective>`：启动或继续一个 loop，并执行一个有界轮次。objective 含“夜间、无人、unattended”时使用 unattended；否则 attended。无人目标未给截止时间或最大轮数时，启动前只问这一个必要问题。
- 裸 `/loop`：只读汇报当前 loop；没有 loop 时给出一句用法。
- loop 启动后，用户在同一 Session 直接说“暂停、继续、停止、看状态、审查结果”。将这些自然语言解析为对当前 loop 的控制，不要要求用户记子命令。
- 如果有多个非终态 loop 且指令对象不唯一，列出候选请用户选择，不要猜。

## 权威账本

先求主仓库绝对路径（`git rev-parse --show-toplevel`）。所有控制文件只在 `<main-root>/.loop/<slug>/`：

- `STATE.json`：当前快照，单写者是协调者。
- `RUNS.jsonl`：追加式事件。
- `ORCHESTRATION.md`：角色、阶段、权限、闸门。
- `PLAN.md`、`LESSONS.md`、`HANDOFF.md`：计划、精炼经验、收尾。
- `rounds/rNNN/`：本轮 `worker.md`、`review.md`、`validation.md` 回执。

优先用本 skill 的状态脚本，不要手改 JSON：

```bash
node .code-shell/skills/loop-mode/scripts/loop-state.mjs init --root <main-root> --slug <slug> --objective <objective> --attendance attended|unattended --max-rounds <N>
node .code-shell/skills/loop-mode/scripts/loop-state.mjs transition --root <main-root> --slug <slug> --status ready|running|paused|waiting_review|completed|stopped|blocked --reason <text>
node .code-shell/skills/loop-mode/scripts/loop-state.mjs event --root <main-root> --slug <slug> --type <type> --message <text>
node .code-shell/skills/loop-mode/scripts/loop-state.mjs status --root <main-root> --slug <slug>
```

## 启动

1. 从 objective 生成短 slug（小写英数加连字符），用脚本 `init`。
2. 已有 `ORCHESTRATION.md` 就校验后沿用；否则用 `loop-orchestration` 的默认模板直接生成。attended 的重大角色/范围分歧再问，unattended 取最保守可行值。
3. 建 `loop/<slug>/candidate` 候选分支，只将通过审查的提案合入它。永不自动 push 或合入 main。
4. 一次 `/loop` 只运行一个有界轮次。若要长时续跑，在轮次收尾创建或更新 heartbeat/automation，下次读 `STATE.json` 再续。

## 单轮状态机

`ready -> running -> validating -> reviewing -> ready|waiting_review|completed|blocked`。

1. 开始前检查 `status`、deadline、maxRounds 和用户待批项。`paused/stopped/completed/blocked` 不得派发。
2. 从 candidate 建本轮分支 `loop/<slug>/rNNN` 和独立 worktree。不复用上轮 worktree。
3. 派 executor 时给完整 objective、绝对账本路径、本轮验收、worktree 和分支。executor 只改代码并 commit，不写共享账本。
4. 协调者记 `worker.md`并跑定向验证，记 `validation.md`。
5. 派与 executor 不同的 reviewer 审 diff/测试，记 `review.md`。高风险变更不能 self-review。
6. 验证和审查都通过才可合入 candidate；否则保留提案分支并进入下轮修复或 `waiting_review`。
7. 协调者原子更新 `STATE.json`，追加事件，精炼 `LESSONS.md`，然后判断闸门。

## 夜间策略

- 默认最小权限；禁止远程写、凭证使用、仓库外写入、生产操作和不可逆发布，除非目标逐项明确授权。
- 分歧选最保守可逆路径，将决策写入待批清单；不因一个非关键分歧卡死整夜。
- 不要为了“一直跑”自循环占用一个会话。每轮到点停，用应用的 heartbeat/automation 续下一轮。
- 到 deadline/maxRounds/资源闸，或连续两轮无实质进展：停在安全点，写 `HANDOFF.md`，进入 `waiting_review` 或 `blocked`。

## 收尾回报

给用户：状态、轮数、candidate 分支和 main 的 diff、验证结果、待批项、下一动作。明确说明“未 push、未合入 main”。

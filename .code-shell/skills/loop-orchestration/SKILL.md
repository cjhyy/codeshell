---
name: loop-orchestration
description: 当用户想为一个 loop 任务定义/生成「编排逻辑」——谁做计划、谁执行、谁审查、分几阶段、怎么值守——时使用。产出 loop 目录下的 ORCHESTRATION.md,供 loop-mode 读取执行。触发词:编排逻辑、loop 编排、谁计划谁执行、配置 loop、orchestration。若用户已手写 ORCHESTRATION.md 则直接沿用不重复生成。
---

# Loop Orchestration（编排文档生成器）

产出一份 `.loop/<slug>/ORCHESTRATION.md`——定义一个 loop 里「**谁干什么**」。
它是 `loop-mode` 执行器的输入。本 skill 只**生成/校验编排文档**,不执行 loop。

## 什么时候用
- 用户要配置一个 loop 的角色分工 / 计划-执行流程时。
- `loop-mode` 找不到 ORCHESTRATION.md 时,回退到这里先生成。

## 两种来源
1. **用户已写死**:若 `.loop/<slug>/ORCHESTRATION.md` 已存在 → 读它、校验字段齐全即可,**不要重新生成**。
2. **访谈生成**:否则问下面几个问题(一次问一组,别轰炸),据答案写出文档。

## 访谈要点（用 AskUser,尽量给选项）
1. **slug / 任务名**:给这个 loop 起个短名(目录 `.loop/<slug>/`)。
2. **角色→执行者**:每个角色选 `codex` / `claude-code` / `self`(codeshell 自己直接干):
   - `planner` 出蓝图 / 拆 milestone（可选,纯打磨 loop 不需要）
   - `executor` 干活出提案（必填）
   - `reviewer` 审查提案（可选,默认 self）
3. **阶段**:`milestone`（照蓝图推进）/ `polish`（发散打磨）/ `milestone→polish`（先推进后打磨）。
4. **蓝图来源**（若含 milestone 阶段）:指一个现成文档路径 / 让 planner 现场拆。
5. **值守**:Attended（有人,高风险停等）/ Unattended（无人,高风险堆待批继续）。
6. **闸门**:额度/时间/轮数上限（你把关的停止条件）。

## 产出模板（写到 .loop/<slug>/ORCHESTRATION.md）

```markdown
# Orchestration: <slug>

## Goal
<一句话目标>

## Roles
- planner: <codex|claude-code|self|none>
- executor: <codex|claude-code|self>
- reviewer: <codex|claude-code|self>

## Phases
<milestone | polish | milestone→polish>

## Blueprint
- source: <文档路径 | "planner 现场生成" | none>

## Attendance
<attended | unattended>
- 切换点(milestone→polish): attended=问一次 / unattended=自动切

## Permissions（最小必要,按值守分级）
- 默认: acceptEdits
- 提权: 逐轮显式、有理由;unattended 禁网络写/远端写/凭证/仓库外写(除非 goal 显式授权)
- 不可逆交付永远留待批

## Gates
- <额度 / 时间 deadline / 最大轮数 / 单轮上限>
```

## 校验（生成或读取后都做一遍）
- `executor` 必填;`planner=none` 时 Phases 不得含 milestone。
- Phases 含 milestone 时 Blueprint.source 必须有值。
- 角色执行者只能是 `codex/claude-code/self`。
- 缺字段 → 补问用户,别猜。

## 候选分支与审查契约

文档还必须写明:
- candidate: `loop/<slug>/candidate`;通过验证和 reviewer 才合入 candidate。
- proposal: 每轮 `loop/<slug>/rNNN`,从 candidate 分出。
- delivery: 不自动 push,不自动合入 main。
- ledger writer: 只有协调者可写 `.loop/<slug>/STATE.json` 和 `RUNS.jsonl`;执行者/审查者只返回回执。
- review independence: reviewer 默认与 executor 不同;高风险轮次不得 self-review。

## 交接
文档就绪后告诉用户:「编排已写入 `.loop/<slug>/ORCHESTRATION.md`,用 `/loop <目标>` 启动;要无人运行就把‘夜间’写进目标，无需打开 Goal。」不要在本 skill 里直接开始跑 loop。

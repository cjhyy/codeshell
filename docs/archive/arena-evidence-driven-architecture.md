# Arena：Evidence-Driven 多模型协作架构与实现规格

---

## 目录

1. [文档目的](#1-文档目的)
2. [当前 Arena 的核心问题](#2-当前-arena-的核心问题)
3. [设计目标](#3-设计目标)
4. [设计原则](#4-设计原则)
5. [总体方案概览](#5-总体方案概览)
6. [为什么不建议继续做 domain x mode](#6-为什么不建议继续做-domain-x-mode)
7. [核心抽象](#7-核心抽象)
8. [新的执行链路](#8-新的执行链路)
9. [详细阶段设计](#9-详细阶段设计)
10. [数据模型草案](#10-数据模型草案)
11. [Prompt 与协作协议设计](#11-prompt-与协作协议设计)
12. [工具与取证设计](#12-工具与取证设计)
13. [Provider 设计](#13-provider-设计)
14. [Mode-Specific Execution Policy](#14-mode-specific-execution-policy)
15. [渲染与用户体验](#15-渲染与用户体验)
16. [与当前代码的映射关系](#16-与当前代码的映射关系)
17. [建议的模块拆分](#17-建议的模块拆分)
18. [分阶段实施计划](#18-分阶段实施计划)
19. [测试策略](#19-测试策略)
20. [MVP 范围建议](#20-mvp-范围建议)
21. [风险与开放问题](#21-风险与开放问题)
22. [结论](#22-结论)

---

## 1. 文档目的

这份文档不是愿景描述，而是一份面向实现的 Arena 架构规格。

它要回答 4 个问题：

1. 为什么当前 Arena 需要继续重构
2. 新 Arena 的核心抽象是什么
3. 不同 mode 尤其是 `planning` 应该怎么走不同执行链路
4. Claude Code 可以按什么顺序稳定落代码

本文默认读者已经了解当前 repo 中这些位置：

- `src/arena/arena.ts`
- `src/arena/planner.ts`
- `src/arena/providers/*`
- `src/arena/tools/selector.ts`
- `src/arena/phases/participant-research.ts`
- `src/arena/phases/claim-registry.ts`
- `src/arena/phases/cross-review.ts`
- `src/arena/phases/build-consensus.ts`
- `src/arena/ledger.ts`
- `src/arena/digest-builder.ts`
- `src/arena/transitions.ts`
- `src/arena/strategies/*.ts`
- `src/arena/render/*.ts`
- `src/arena/types.ts`

本文的核心更新点是：

- 保留 evidence-driven / claim-centric 主方向
- 明确 `planning` 不应简单复用 `review` 的重型 debate / adjudication
- 新增 `detail expansion` 阶段，专门把 roadmap 展开成可执行方案
- 明确 current code 到 target architecture 的映射与迁移顺序

---

## 2. 当前 Arena 的核心问题

当前 Arena 的问题不是一个，而是三组。

### 2.1 通用化方向已经对了，但支持还没有真正按场景分化

现在代码已经开始有：

- `planner.ts`
- `lenses/*`
- `providers/*`
- `ArenaPlan`

这意味着 Arena 已经不再只是“代码评审器”。

但现阶段仍然存在一个明显缺口：

- planner 能识别场景
- prompt 和 renderer 也开始吃到部分 `plan`
- 但 phase-level runtime 还没有完全按场景分流

结果是：

- 用户说“写 repo roadmap”
- planner 可能识别出 `planning + architecture + repo/docs`
- 但后续 review / consensus 还不够彻底地按 planning 的需求工作

### 2.2 可信性闭环仍未完整

当前研究结果已经不只是 `ParticipantReport`，还开始保留：

- `ResearchDossier`
- `EvidencePacket`
- `FindingEvidenceLink`
- `SharedResearchLedger`

这是正确方向。

但目前主链路里，`cross-review`、`digest`、`debate`、`adjudication` 仍未完全打通。

所以现在的状态更接近：

```text
plan
  -> evidence
  -> research
  -> claim registry
  -> light cross-review
  -> consensus
```

而不是：

```text
plan
  -> evidence
  -> research
  -> claim registry
  -> verification / merge review
  -> targeted checks
  -> debate / detail expansion
  -> adjudication or planning merge
  -> final output
```

### 2.3 Planning 模式与 Review 模式的冲突越来越明显

这是本文新增的重点。

`review` 的争议多数是“这个 claim 对不对”。

`planning` 的争议多数不是“对/错”，而是：

- 哪种 phase 划分更合理
- 顺序应不应该调整
- 这个阶段是否依赖前置抽象
- 哪些风险应该前置暴露
- 哪些细节现在还证据不足，只能留成 open question

因此如果把 planning 直接塞进：

```text
verification -> debate -> adjudication
```

会出现两个问题：

1. 流程过重
2. 结果反而不够可执行

Planning 模式真正缺的不是更重的裁决，而是：

1. merge-oriented review
2. roadmap-first consensus
3. detail expansion

### 2.4 当前 roadmap 输出仍然偏“提纲”

虽然现在已经给 `planning` 增加了：

- `roadmap[]`
- `goal / scope / deliverables / dependencies / risks / successCriteria`

但单次 consensus 依然倾向于输出宏观描述。

它往往缺少：

- 涉及哪些模块或文件
- 关键代码改动是什么
- 需要新增或调整哪些接口
- migration 怎么切
- 验证手段是什么
- 工作量大概多大

所以光有 roadmap schema 不够，还需要单独的 `detail expansion` phase。

---

## 3. 设计目标

### 3.1 通用化目标

用户应该自然表达需求，而不是手工指定场景。

理想交互：

- `/arena review 我这次改动`
- `/arena review 这个 PRD 是否完整`
- `/arena 讨论这个需求在现有 repo 上能不能落地`
- `/arena 给这个 repo 做 roadmap`

Arena 自己决定：

- `mode`
- `lenses`
- `sources`
- `subject`
- `output shape`

### 3.2 可信化目标

Arena 需要尽量回答：

- 结论依据了哪些证据
- reviewer 是否能复核
- 分歧是否经过再次验证
- 最终哪些是已验证结论，哪些只是未决问题

### 3.3 Planning 特化目标

Planning 模式的目标与 review 不完全相同。

它更强调：

- 路线拆分
- 阶段依赖
- 风险暴露
- 可执行性
- 对 repo 现状的贴合度

所以 planning 需要：

1. 更轻的争议处理
2. 更强的 roadmap 组织能力
3. 专门的 detail expansion 阶段

### 3.4 工程目标

新设计应满足：

1. 保持 `review / discussion / planning`
2. 支持增量迁移
3. 尽量复用当前已落地的 `planner / providers / ledger / digest-builder`
4. 让不同 mode 真正走不同执行策略
5. 优先先把 `planning` 做强，再继续补全 `review/discussion` 的重型争议链

---

## 4. 设计原则

### 4.1 Mode 负责流程，不负责领域

`review / discussion / planning` 描述的是协作方式，不是内容领域。

### 4.2 Lens 负责视角，不负责取证

“产品视角”“工程视角”“架构视角”是评估标准，不是证据来源。

### 4.3 Source / Provider 负责取证，不负责判断

Provider 只收集事实，不直接下结论。

### 4.4 Claim 是通用分析单元，但不是所有 mode 都要进入重型争议链

- `review / discussion` 适合 claim-centric verification / debate / adjudication
- `planning` 适合 claim-centric merge / reprioritize / detail expansion

### 4.5 Shared Ledger 是跨轮共享状态，但 prompt 必须按需裁剪

- 数据层全量共享
- prompt 层只注入 digest

### 4.6 昂贵能力只用于高价值问题

不是所有 finding 都值得多轮 debate。

### 4.7 Planning 模式优先解决“怎么做”，不是优先解决“谁对谁错”

Planning 的默认姿势应是：

- 合并
- 调序
- 补依赖
- 标 open question

而不是优先：

- 反复 contested
- 多轮辩论
- 最终裁决

### 4.8 高层 roadmap 与实施细节必须拆成两步

一个 prompt 很难同时稳定完成：

- phase-level roadmap
- repo-level implementation detail

因此应拆为：

1. roadmap consensus
2. detail expansion

---

## 5. 总体方案概览

新 Arena 建议统一成一个 evidence-driven collaboration engine，但在执行策略上按 mode 分叉。

总图如下：

```text
User Topic
  -> Planner
  -> Evidence Providers
  -> Independent Research
  -> Claim Registry
  -> Mode Policy Router

review / discussion:
  -> Verification Review
  -> Targeted Checks (optional)
  -> Debate Rounds (bounded)
  -> Adjudication
  -> Consensus Writer

planning:
  -> Merge-Oriented Review
  -> Roadmap Consensus
  -> Detail Expansion
  -> Final Render
```

这里最关键的变化是：

- `planning` 不再默认走重型 `debate -> adjudication`
- `planning` 专门增加 `detail expansion`
- `consensus` 不再承担所有工作，而只负责其 mode 下最合适的汇总任务

---

## 6. 为什么不建议继续做 domain x mode

不推荐：

```ts
domain: "code" | "product" | "general"
mode: "review" | "discussion" | "planning"
```

更推荐：

```ts
mode: "review" | "discussion" | "planning"
lens: "engineering" | "product" | "architecture" | "general"
sources: "git" | "repo" | "docs" | "web" | "none"
subject: "changes" | "files" | "docs" | "topic" | "mixed"
```

理由：

### 6.1 `domain` 会膨胀

后面很容易继续出现：

- `security`
- `performance`
- `ux`
- `ops`
- `research`

### 6.2 真实请求天然是混合的

例如：

- “review 这个 PRD 是否能落地，并参考当前实现”
- “规划 arena 重构路线，参考 repo 结构和现有文档”

### 6.3 mode、视角、取证来源本来就是三件事

例如：

| 用户请求 | mode | lenses | sources | subject |
|------|------|--------|---------|---------|
| review 我的最新改动 | review | engineering | git, repo | changes |
| review 这个需求文档 | review | product | docs | docs |
| 讨论需求在现有系统上是否可落地 | discussion | product, engineering | docs, repo | mixed |
| 给 repo 做 roadmap | planning | architecture, engineering | repo, docs | mixed |
| 讨论 arena 是否应该产品化 | discussion | product, general | none, docs | topic |

---

## 7. 核心抽象

### 7.1 ArenaMode

```ts
type ArenaMode = "review" | "discussion" | "planning";
```

### 7.2 ArenaLens

```ts
interface ArenaLens {
  name: string;
  participantRole: string;
  reviewerRole: string;
  moderatorRole: string;
  summaryLabel: string;
  criteria: string[];
  preferredFindingKinds: FindingKind[];
}
```

建议先内置：

- `engineering`
- `product`
- `architecture`
- `general`

### 7.3 ArenaSourceKind

```ts
type ArenaSourceKind = "git" | "repo" | "docs" | "web" | "none";
```

### 7.4 ArenaPlan

```ts
interface ArenaPlan {
  mode: ArenaMode;
  lenses: ArenaLensRef[];
  sources: ArenaSourceSpec[];
  subject: ArenaSubject;
  outputShape: ArenaOutputShape;
  confidence: "high" | "medium" | "low";
  followUpQuestion?: string;
}
```

### 7.5 ArenaOutputShape

```ts
interface ArenaOutputShape {
  overviewLabel: string;
  emphasize: Array<"strength" | "improvement" | "risk" | "question">;
}
```

这不是 UI 装饰字段，而是：

- prompt 优先级
- renderer 顺序
- mode-specific 输出风格

### 7.6 ResearchDossier

```ts
interface ResearchDossier {
  participant: string;
  contextSummary: string;
  findings: ArenaFinding[];
  toolTrace: ToolTrace[];
  evidencePackets: EvidencePacket[];
  findingEvidenceLinks: FindingEvidenceLink[];
}
```

### 7.7 SharedResearchLedger

`SharedResearchLedger` 是 source of truth，推荐采用 flat append-only log。

它保存：

- dossier
- evidence packet
- tool trace
- claims
- challenges
- debate rounds
- requested checks
- adjudications
- roadmap detail expansions

程序查询层再基于 ledger 聚合出 `ClaimRecord` 视图。

### 7.8 ClaimRecord

`ClaimRecord` 是 query model，不应再被实现为另一份 source of truth。

它表示：

- 这个 finding 对应的 claim 是什么
- 谁提出
- 当前状态是什么
- 有哪些 challenge / debate / adjudication

### 7.9 ArenaRoadmapPhase

```ts
interface ArenaRoadmapPhase {
  title: string;
  priority: "high" | "medium" | "low";
  goal: string;
  scope: string[];
  deliverables: string[];
  dependencies: string[];
  risks: string[];
  successCriteria: string[];
  relatedFindings: string[];
}
```

### 7.10 ArenaRoadmapPhaseDetail

这是本文新增的 planning 专用结构。

```ts
interface ArenaRoadmapPhaseDetail {
  phaseTitle: string;
  objective: string;
  targetFiles: string[];
  codeChanges: string[];
  interfaces: string[];
  migrationSteps: string[];
  validation: string[];
  effort: "small" | "medium" | "large";
  blockers: string[];
  evidenceRefs: string[];
}
```

它的职责是把高层 roadmap phase 展开成 repo 级实施方案。

---

## 8. 新的执行链路

### 8.1 通用前半段

所有 mode 前半段一致：

1. Plan
2. Collect Evidence
3. Independent Research
4. Claim Registry

### 8.2 Review / Discussion 路径

适用于：

- 代码 review
- 文档 review
- 可行性讨论
- topic discussion

链路：

```text
Plan
  -> Evidence
  -> Research
  -> Claim Registry
  -> Verification Review
  -> Targeted Checks (optional)
  -> Debate Rounds (bounded)
  -> Adjudication
  -> Consensus
```

### 8.3 Planning 路径

适用于：

- repo roadmap
- architecture migration planning
- 重构路线规划
- 需求落地路线规划

链路：

```text
Plan
  -> Evidence
  -> Research
  -> Claim Registry
  -> Merge-Oriented Review
  -> Roadmap Consensus
  -> Detail Expansion
  -> Final Render
```

### 8.4 为什么 planning 要单独分流

因为 planning 的目标不是裁判 claim 真伪，而是：

- 合并候选方案
- 调整阶段顺序
- 显式化依赖
- 暴露 blockers
- 输出可执行路线

冲突更适合转成：

- `openQuestions`
- `alternatives`
- `dependency risks`

而不是默认进入多轮争议裁决。

---

## 9. 详细阶段设计

### 9.1 Phase 0：Plan

输入：

- 用户 topic
- CLI/tool flags
- 当前工作目录

输出：

- `ArenaPlan`

要求：

- planner 先识别 `mode`
- 再识别 `lenses / sources / subject / outputShape`
- fallback 不能一律退化为 code review

### 9.2 Phase 1：Collect Evidence

输入：

- `ArenaPlan`

输出：

- `ArenaBaseContext { plan, artifacts, quickFacts }`

要求：

- provider 只给事实
- 不给结论
- preview 必须截断并高信号

### 9.3 Phase 2：Independent Research

输入：

- `ArenaBaseContext`
- participant
- research tool pack
- strategy + lens prompt

输出：

- `ParticipantReport`
- `ResearchDossier`

要求：

- 必须保留 evidence packet 与 tool trace
- 必须显式建立 `finding -> evidence packet` 关联
- 不要求保存 chain-of-thought
- 但必须保存可审计的取证轨迹

### 9.4 Phase 3：Claim Registry

输入：

- `ResearchDossier[]`

输出：

- ledger 中的 `claims`
- 查询层的 `ClaimRecord[]`

要求：

- claim id 在一次 run 内稳定
- 第一版可直接复用 finding 作为 claim
- claim registry 直接消费 `findingEvidenceLinks`

### 9.5 Phase 4：Mode Policy Router

这是本文新增的关键阶段。

输入：

- `ArenaPlan`
- `ClaimRecord[]`
- `SharedResearchLedger`

动作：

- 如果 `mode=planning`，走 planning 路径
- 否则走 review/discussion 路径

作用：

- 不同 mode 真正走不同 phase
- 避免“planning 只是 prompt 不同，但 runtime 还是 review”

### 9.6 Review / Discussion：Verification Review

输入：

- claim
- relevant digest
- review tool pack

输出：

- `ClaimChallenge[]`
- `RequestedCheck[]`

动作：

- reviewer 验证 claim 是否被证据支撑
- 必要时 spot check
- 必要时提出 `RequestedCheck`

要求：

- reviewer 默认职责是验证，不是重跑完整 research
- 补材料必须是 bounded 的 targeted check

### 9.7 Review / Discussion：Debate Rounds

只对高价值争议 claim 启用。

输入：

- contested claims
- claim-scoped digest
- `maxDiscussionRounds`

输出：

- `DebateRound[]`

要求：

- 只围绕具体 claim
- 每轮有明确争议点
- 每轮只读相关 digest
- 如仍有证据缺口，优先创建 `RequestedCheck`

### 9.8 Review / Discussion：Adjudication

输入：

- claim history
- challenges
- debate rounds
- requested checks / new evidence

输出：

- `ClaimAdjudication`

要求：

- 只做有限取证
- 允许 `unresolved`
- `accepted_with_revision` 很重要

### 9.9 Planning：Merge-Oriented Review

这是 planning 对 cross-review 的替代形态。

输入：

- candidate claims
- candidate phases
- relevant digest

输出：

- phase merge suggestions
- priority changes
- dependency corrections
- open questions
- alternatives

动作：

- 合并重复 phase
- 调整顺序
- 缩窄过宽 claim
- 标出证据不足处

要求：

- contested claim 不默认进入重型 debate
- planning review 的目标是“收敛成更好的 roadmap”，不是判对错
- 只有非常关键的 factual conflict 才允许轻量 spot-check，不进入完整 debate loop

### 9.10 Planning：Roadmap Consensus

输入：

- research findings
- merge review results
- unresolved alternatives / open questions

输出：

- `ArenaRoadmapPhase[]`
- `openQuestions`
- `nextActions`

要求：

- roadmap 是主输出
- 生成 3-6 个 phase
- 每个 phase 必须包含：
  - goal
  - scope
  - deliverables
  - dependencies
  - risks
  - success criteria
- `nextActions` 只表示近期动作，不再代表整个 roadmap

### 9.11 Planning：Detail Expansion

这是 planning 模式新增的核心阶段。

输入：

- `ArenaRoadmapPhase[]`
- planning digest
- relevant claims
- relevant evidence packets

输出：

- `ArenaRoadmapPhaseDetail[]`

动作：

- 对每个 phase 单独展开
- 把 phase 转换成 repo 级实施方案

Detail expansion 必须尽量回答：

- 涉及哪些模块 / 文件
- 关键代码改动是什么
- 需要新增或调整哪些接口
- migration steps 怎么切
- validation 怎么做
- effort 大概多大
- blockers 是什么

要求：

- 优先引用 repo evidence
- 不确定时允许写 likely targets，但要显式标低确定性
- 不允许空泛口号式展开

### 9.12 Final Consensus / Final Render

最终输出按 mode 组织：

- `review`：风险、改进、结论、下一步
- `discussion`：问题 framing、trade-offs、open questions
- `planning`：roadmap、implementation details、open questions、next actions

---

## 10. 数据模型草案

### 10.1 ArenaPlan

```ts
type ArenaMode = "review" | "discussion" | "planning";

type ArenaSourceKind = "git" | "repo" | "docs" | "web" | "none";

interface ArenaLensRef {
  name: string;
  weight?: number;
}

interface ArenaSourceSpec {
  kind: ArenaSourceKind;
  targets?: string[];
  toolPack?: string;
}

interface ArenaSubject {
  kind: "changes" | "files" | "docs" | "topic" | "mixed";
  label: string;
  targets?: string[];
}

interface ArenaOutputShape {
  overviewLabel: string;
  emphasize: Array<"strength" | "improvement" | "risk" | "question">;
}

interface ArenaPlan {
  mode: ArenaMode;
  lenses: ArenaLensRef[];
  sources: ArenaSourceSpec[];
  subject: ArenaSubject;
  outputShape: ArenaOutputShape;
  confidence: "high" | "medium" | "low";
  followUpQuestion?: string;
}
```

### 10.2 ArenaArtifact / ArenaBaseContext

```ts
interface ArenaArtifact {
  id: string;
  kind: "diff" | "file" | "tree" | "grep" | "doc" | "web";
  source: ArenaSourceKind;
  title: string;
  ref?: string;
  preview: string;
  metadata?: Record<string, unknown>;
}

interface ArenaBaseContext {
  plan: ArenaPlan;
  artifacts: ArenaArtifact[];
  quickFacts: Array<{ label: string; value: string }>;
}
```

### 10.3 EvidencePacket / ToolTrace / ResearchDossier

```ts
interface EvidencePacket {
  packetId: string;
  participant: string;
  source: ArenaSourceKind;
  title: string;
  refs: string[];
  summary: string;
  excerpts: Array<{
    ref: string;
    snippet: string;
    note: string;
  }>;
}

interface ToolTrace {
  round: number;
  toolName: string;
  args: Record<string, unknown>;
  resultRef?: string;
  keptAsEvidence?: boolean;
}

interface FindingEvidenceLink {
  findingId: string;
  evidencePacketIds: string[];
}

interface ResearchDossier {
  participant: string;
  contextSummary: string;
  findings: ArenaFinding[];
  toolTrace: ToolTrace[];
  evidencePackets: EvidencePacket[];
  findingEvidenceLinks: FindingEvidenceLink[];
}
```

### 10.4 SharedResearchLedger

推荐把 ledger 作为 flat append-only source of truth。

```ts
interface ClaimBase {
  claimId: string;
  owner: string;
  finding: ArenaFinding;
  evidenceRefs: string[];
  evidencePacketIds: string[];
  status: "proposed" | "under_review" | "contested" | "verified" | "rejected" | "unresolved";
}

interface SharedResearchLedger {
  dossiers: ResearchDossier[];
  evidencePackets: EvidencePacket[];
  toolTraces: ToolTrace[];
  claims: ClaimBase[];
  challenges: ClaimChallenge[];
  debateRounds: DebateRound[];
  requestedChecks: RequestedCheck[];
  adjudications: ClaimAdjudication[];
  roadmapDetails: ArenaRoadmapPhaseDetail[];
}
```

规则：

1. ledger 是 source of truth
2. `ClaimRecord` 是查询层聚合视图
3. 每轮只 append delta
4. prompt 只看 digest，不看全量 ledger

### 10.5 id 与 merge 规则

第一版建议简单，不做智能 dedup：

- `packetId = participant + round + ordinal`
- `requestId = claimId + requester + ordinal`
- `debateRoundId = claimId + round`

这样实现稳定，后续再做内容去重。

### 10.6 ClaimRecord 视图

```ts
interface ClaimRecord {
  claimId: string;
  owner: string;
  finding: ArenaFinding;
  evidenceRefs: string[];
  evidencePacketIds: string[];
  status: ClaimBase["status"];
  challenges: ClaimChallenge[];
  debateRounds: DebateRound[];
  adjudication?: ClaimAdjudication;
}
```

### 10.7 ClaimChallenge / RequestedCheck / TargetedCheckTask

```ts
interface RequestedCheck {
  requestId: string;
  claimId: string;
  requester: string;
  description: string;
  refs?: string[];
  priority?: "high" | "medium" | "low";
}

interface ClaimChallenge {
  reviewer: string;
  claimId: string;
  verdict: "agree" | "refine" | "disagree" | "needs_evidence";
  reason: string;
  supportingEvidenceRefs?: string[];
  requestedChecks?: RequestedCheck[];
}

interface TargetedCheckTask {
  request: RequestedCheck;
  assignee: string;
  status: "pending" | "running" | "done" | "skipped";
  producedPacketIds: string[];
}
```

默认建议：

- `TargetedCheckTask.assignee = requester`
- 工具预算严格限制为 1-2 轮

### 10.8 DebateRound / ClaimAdjudication

```ts
interface DebateTurn {
  participant: string;
  stance: "support" | "oppose" | "narrow" | "uncertain";
  summary: string;
  newEvidenceRefs?: string[];
}

interface DebateRound {
  round: number;
  claimId: string;
  participants: DebateTurn[];
  resolved: boolean;
  resolutionNote?: string;
}

interface ClaimAdjudication {
  claimId: string;
  outcome: "accepted" | "accepted_with_revision" | "rejected" | "unresolved";
  rationale: string;
  finalSummary: string;
  supportingEvidenceRefs: string[];
}
```

### 10.9 Planning 专用结构

```ts
interface ArenaRoadmapPhase {
  title: string;
  priority: "high" | "medium" | "low";
  goal: string;
  scope: string[];
  deliverables: string[];
  dependencies: string[];
  risks: string[];
  successCriteria: string[];
  relatedFindings: string[];
}

interface ArenaRoadmapPhaseDetail {
  phaseTitle: string;
  objective: string;
  targetFiles: string[];
  codeChanges: string[];
  interfaces: string[];
  migrationSteps: string[];
  validation: string[];
  effort: "small" | "medium" | "large";
  blockers: string[];
  evidenceRefs: string[];
}
```

### 10.10 ArenaConsensus

```ts
interface ArenaConsensus {
  summary: string;
  subjectSummary?: string;
  strengths: ArenaConsensusItem[];
  improvements: ArenaConsensusItem[];
  risks: ArenaConsensusItem[];
  openQuestions: ArenaConsensusItem[];
  roadmap: ArenaRoadmapPhase[];
  roadmapDetails?: ArenaRoadmapPhaseDetail[];
  nextActions: Array<{
    title: string;
    priority: "high" | "medium" | "low";
    rationale: string;
    relatedFindings: string[];
  }>;
}
```

语义：

- `roadmap` 是高层阶段规划
- `roadmapDetails` 是实施细节展开
- `nextActions` 只表示近期动作

### 10.11 RoundResearchDigest

```ts
interface RoundResearchDigest {
  round: number;
  relevantClaimIds: string[];
  evidencePackets: EvidencePacket[];
  toolTraceSummary: Array<{
    participant: string;
    toolName: string;
    ref?: string;
  }>;
  recentChallenges: ClaimChallenge[];
  requestedChecks: RequestedCheck[];
  priorAdjudications: ClaimAdjudication[];
}
```

digest 规则：

- 默认按 `claimId` 裁剪
- planning 的 detail expansion 可按 `phaseTitle + relatedFindingIds` 裁剪
- 不因“同一个 reviewer 一起看过”而扩散无关上下文

---

## 11. Prompt 与协作协议设计

### 11.1 Strategy 只负责 mode，LensWrapper 注入场景支持

推荐职责拆分：

- `ModeStrategy` 负责协作模式
- `LensWrapper` 注入角色、criteria、scene support
- `LanguageWrapper` 保证输出语言

Scene support 至少应把这些信息注入 prompt：

- `plan.subject`
- `plan.sources`
- `plan.outputShape`
- 当前 mode 的执行目标

### 11.2 Research Prompt

Research prompt 需要强调：

1. 当前主题是什么
2. 取证来源是什么
3. finding 应优先覆盖哪些 kind
4. 必须把 claim 与 evidence 对齐

### 11.3 Verification Review Prompt

Review / Discussion 下的 verification prompt 必须强调：

- 不是评价别人写得好不好
- 而是验证 claim 是否被证据支撑
- 允许提出 `RequestedCheck`
- 可以缩窄 claim，而不只是 agree/disagree

### 11.4 Planning Merge-Review Prompt

Planning 下的 review prompt 应改成：

- 合并重复 phase
- 调整顺序 / 优先级
- 暴露依赖 / blockers
- 把冲突转成 `openQuestions / alternatives / dependency risks`

不鼓励输出：

- 强烈对立 verdict
- 需要多轮裁决的攻击式辩论

### 11.5 Debate Prompt

只用于 `review / discussion`。

要求：

- 只围绕具体 claim
- 明确本轮争议点
- 明确新证据或维持原判断
- 不允许开放式发散

### 11.6 Adjudication Prompt

只用于 `review / discussion`。

要求：

- 忠于证据
- 不发明新 claim
- 允许 `unresolved`
- 对过强 claim 优先 `accepted_with_revision`

### 11.7 Roadmap Consensus Prompt

Planning 的 consensus prompt 必须明确：

- `roadmap` 是主输出
- 产出 3-6 个 phase
- 每个 phase 必须写清：
  - goal
  - scope
  - deliverables
  - dependencies
  - risks
  - success criteria
- `nextActions` 只表示 immediate actions

### 11.8 Detail Expansion Prompt

这是 planning 新增 prompt。

要求：

- 按 phase 逐个展开
- 优先引用 repo evidence
- 明确 target files / modules
- 说明关键代码变更
- 说明接口或配置变化
- 说明 migration / validation / effort / blockers

如果证据不足：

- 允许写 likely targets
- 但要显式说明不确定性

---

## 12. 工具与取证设计

### 12.1 原则

Arena 不维护私有工具协议，尽量复用统一 ToolRegistry。

### 12.2 推荐工具

第一阶段优先复用：

- `Read`
- `Grep`
- `Glob`
- `WebSearch`

### 12.3 Tool Pack

```ts
interface ArenaToolSelector {
  selectResearchTools(plan: ArenaPlan): ToolDefinition[];
  selectReviewTools(plan: ArenaPlan): ToolDefinition[];
  selectAdjudicationTools(plan: ArenaPlan): ToolDefinition[];
  selectPlanningExpansionTools(plan: ArenaPlan): ToolDefinition[];
}
```

### 12.4 阶段化预算

| 阶段 | 预算建议 |
|------|---------|
| Research | 3-5 轮 |
| Verification Review | 1-3 轮 |
| Debate | 每轮 1-2 次关键查询 |
| Adjudication | 0-2 次 spot check |
| Planning Merge Review | 1-2 轮 |
| Detail Expansion | 每个 phase 1-3 轮 |

### 12.5 全链路执行上限

```ts
interface ArenaExecutionLimits {
  maxClaimsForReview: number;
  maxContestedClaimsForDebate: number;
  maxRequestedChecksPerClaimPerRound: number;
  maxReviewersPerClaim: number;
  maxRoadmapPhases: number;
  maxExpandedPhasesPerRun: number;
}
```

推荐默认值：

- `maxClaimsForReview = 12`
- `maxContestedClaimsForDebate = 5`
- `maxRequestedChecksPerClaimPerRound = 2`
- `maxReviewersPerClaim = 2`
- `maxRoadmapPhases = 6`
- `maxExpandedPhasesPerRun = 6`

### 12.6 Shared Ledger 与 prompt 的关系

规则：

1. ledger 全量保存
2. 每轮 prompt 只看 digest
3. 跨 claim 扩查必须显式通过 `RequestedCheck`
4. planning detail expansion 只读 phase 相关 digest

---

## 13. Provider 设计

### 13.1 GitProvider

适合：

- code review
- branch compare
- change-focused analysis

输出：

- changed files
- diff stat
- truncated diff
- commit log

### 13.2 RepoProvider

适合：

- architecture planning
- feasibility analysis
- roadmap detail expansion

输出：

- repo tree
- key modules
- grep hits
- file previews

### 13.3 DocsProvider

适合：

- PRD review
- design doc review
- requirements feasibility
- roadmap planning with docs

### 13.4 WebProvider

适合：

- 需要最新事实
- 竞品/标准/外部资料对比

### 13.5 NullProvider

适合：

- 纯 topic discussion
- 不依赖外部材料的 brainstorm

### 13.6 Provider 输出要求

每个 provider 必须：

1. 输出统一 artifact 结构
2. 控制 preview 体积
3. 提供稳定 ref
4. 不做价值判断

---

## 14. Mode-Specific Execution Policy

这是本文最关键的新增部分。

### 14.1 Review 模式

默认策略：

```text
claim proposed
  -> verification review
  -> targeted checks (optional)
  -> debate (if contested)
  -> adjudication
  -> consensus
```

适用：

- 代码 review
- 文档 review
- 风险审查

### 14.2 Discussion 模式

默认策略：

```text
claim proposed
  -> verification review
  -> targeted checks (optional)
  -> light debate
  -> adjudication or unresolved
  -> consensus
```

说明：

- 比 review 更容忍保留 open questions
- 更强调保留 minority viewpoints

### 14.3 Planning 模式

默认策略：

```text
claim proposed
  -> merge-oriented review
  -> roadmap consensus
  -> detail expansion
  -> final render
```

### 14.4 Planning 不进入重型 debate / adjudication

默认规则：

1. contested claims 不默认进入 debate
2. conflicting findings 优先转成：
   - `openQuestions`
   - `alternatives`
   - `dependency risks`
3. 只有当出现高价值 factual conflict 时，才允许轻量 spot-check
4. planning 不做完整 adjudication loop

高价值 factual conflict 例子：

- 某 phase 明确依赖某模块边界，但 repo evidence 不一致
- 某 roadmap 假设某文件/模块存在，但 repo 中不存在
- 某阶段顺序依赖被代码事实直接否定

### 14.5 Planning Merge Review 的输出语义

建议不要直接复用：

- `agree`
- `disagree`
- `accepted`
- `rejected`

而是优先用这些语义：

- `merge`
- `reprioritize`
- `split_phase`
- `combine_phase`
- `dependency_risk`
- `needs_detail`
- `open_question`

第一版如果不想新增专门类型，也可以在 `ClaimChallenge.reason` 中带结构化标签，但目标语义应是上面这套。

### 14.6 Detail Expansion 的职责边界

Detail expansion 不是重新规划路线，而是：

- 接受高层 roadmap
- 把 phase 落到 repo 实施层
- 形成更接近工程执行单的内容

它不应重新推翻 phase 顺序，除非发现致命 blocker；若发现，则回写为：

- roadmap risk
- open question
- phase dependency correction

### 14.7 Planning 最终输出语义

Planning 的最终结果建议分四层：

1. `subjectSummary`
2. `roadmap`
3. `roadmapDetails`
4. `openQuestions + nextActions`

这比只给 `nextActions` 更符合 roadmap 场景。

---

## 15. 渲染与用户体验

### 15.1 通用要求

最终用户不需要看到所有内部机制，但需要看到足够的可信性信号：

- mode
- lenses
- sources
- subject summary
- accepted / unresolved 的区别

### 15.2 Review 模式推荐顺序

1. Subject Summary
2. Overall Assessment
3. Risks
4. Improvements
5. Strengths
6. Open Questions
7. Next Actions

### 15.3 Discussion 模式推荐顺序

1. Problem Framing
2. Overall Assessment
3. Risks / Trade-offs
4. Strengths / Opportunities
5. Open Questions
6. Next Actions

### 15.4 Planning 模式推荐顺序

1. Current Scope
2. Overall Assessment
3. Roadmap
4. Implementation Details
5. Risks
6. Open Questions
7. Immediate Next Actions

### 15.5 进度事件建议

最终建议包含：

```ts
type ArenaProgressEvent =
  | { type: "plan_resolved"; plan: ArenaPlan }
  | { type: "evidence_collected"; artifacts: ArenaArtifact[] }
  | { type: "research_start"; participant: string }
  | { type: "research_done"; participant: string; dossier: ResearchDossier }
  | { type: "claims_registered"; claimCount: number }
  | { type: "verification_start" }
  | { type: "verification_done"; challengeCount: number }
  | { type: "debate_round_start"; round: number; claims: string[] }
  | { type: "debate_round_done"; round: number; resolved: number }
  | { type: "adjudication_done"; accepted: number; unresolved: number }
  | { type: "roadmap_expansion_start"; phaseCount: number }
  | { type: "roadmap_expansion_done"; detailCount: number }
  | { type: "consensus_done"; consensus: ArenaConsensus };
```

---

## 16. 与当前代码的映射关系

当前代码已经有一部分新骨架，但还没有完全接到 runtime。

| 当前模块 | 当前状态 | 主要问题 | 目标演进 |
|------|------|---------|---------|
| `planner.ts` | 已存在 | fallback 仍需持续加强 | 继续承担统一 plan 入口 |
| `providers/*` | 已存在 | 需要继续补 artifact 策略 | 保持 provider 模型 |
| `tools/selector.ts` | 已存在 | 还需按 phase 细化 | 继续做 stage-aware tool selection |
| `participant-research.ts` | 已能产出 dossier | good | 继续保留 |
| `claim-registry.ts` | 已存在 | 仍需和 ledger/digest 更紧密结合 | 继续做 claim 聚合 |
| `ledger.ts` | 已存在 | 需要明确 source of truth 语义 | 推荐演进为 flat append-only ledger |
| `digest-builder.ts` | 已存在 | 需要继续细化 claim/phase 裁剪规则 | 继续保留 |
| `transitions.ts` | 已存在 | 目前更偏 review/discussion | planning 可弱化使用 |
| `cross-review.ts` | 已存在 | 仍偏旧式 blind review | 变成 mode router 或拆为 `verification-review.ts` + `planning-review.ts` |
| `build-consensus.ts` | 已存在 | 仍承担过多职责 | planning 下前置 `detail expansion` |
| `strategies/planning.ts` | 已加强 roadmap 输出 | 还缺 detail expansion prompt 配合 | 继续增强 planning-only flow |
| `render/session.ts` / `render/terminal.ts` | 已支持 roadmap | 还需支持 `roadmapDetails` | 继续增强 planning renderer |

文档结论：

- 当前代码不需要推倒重来
- 但必须把 `planning` 从统一争议链里分流出来

---

## 17. 建议的模块拆分

推荐目录：

```text
src/arena/
  arena.ts
  planner.ts
  types.ts
  ledger.ts
  digest-builder.ts
  transitions.ts
  providers/
    git.ts
    repo.ts
    docs.ts
    web.ts
    none.ts
    index.ts
  lenses/
    engineering.ts
    product.ts
    architecture.ts
    general.ts
    index.ts
  tools/
    selector.ts
  phases/
    participant-research.ts
    claim-registry.ts
    cross-review.ts
    verification-review.ts
    planning-review.ts
    targeted-checks.ts
    debate.ts
    adjudication.ts
    planning-detail-expansion.ts
    build-consensus.ts
  strategies/
    review.ts
    discussion.ts
    planning.ts
    lens-wrapper.ts
    language-wrapper.ts
```

### 17.1 `cross-review.ts`

建议保留，但职责变成 routing：

- `mode=planning` -> `planning-review.ts`
- 其他 mode -> `verification-review.ts`

这样改动最小。

### 17.2 `planning-review.ts`

职责：

- 合并 phase
- 调整顺序
- 输出 open questions / dependency risks

### 17.3 `planning-detail-expansion.ts`

职责：

- 消费 `roadmap`
- 输出 `roadmapDetails`

### 17.4 `build-consensus.ts`

职责应缩小为：

- review/discussion：基于 adjudicated claims 输出最终结果
- planning：基于 roadmap + roadmapDetails 输出最终结果

---

## 18. 分阶段实施计划

建议按 5 步走。

### Phase 1：文档与类型对齐

目标：

- 对齐 `ArenaConsensus.roadmap`
- 新增 `ArenaRoadmapPhaseDetail`
- 明确 planning override 语义

完成标志：

- 类型、文档、renderer 口径一致

### Phase 2：Planning 输出先做强

目标：

- planning consensus 输出稳定的 `roadmap[]`
- renderer 单独展示 roadmap

完成标志：

- Arena 产出的 roadmap 不再只是 next actions

### Phase 3：Planning Mode Router + Merge Review

目标：

- `cross-review` 按 mode 分流
- 新增 planning merge review

完成标志：

- planning 不再默认进入重型 debate / adjudication

### Phase 4：Detail Expansion

目标：

- 新增 `planning-detail-expansion.ts`
- 对每个 phase 展开 repo 级实施方案

完成标志：

- roadmap 输出包含 target files / code changes / interfaces / validation / effort

### Phase 5：继续补完 Review / Discussion 争议链

目标：

- verification review
- targeted checks
- debate
- adjudication

完成标志：

- review/discussion 的 claim-centric trust loop 真正闭环

---

## 19. 测试策略

### 19.1 Planner 测试

覆盖：

- code review
- docs review
- repo roadmap
- feasibility discussion
- pure topic discussion

断言：

- `mode`
- `sources`
- `subject`
- `outputShape`

### 19.2 Research / Ledger 测试

断言：

- dossier 产出完整
- evidence packet 可关联
- ledger append-only 生效

### 19.3 Planning 路由测试

断言：

- `mode=planning` 时不进入重型 debate / adjudication
- `cross-review` 正确路由到 `planning-review`

### 19.4 Roadmap Consensus 测试

断言：

- 产出 3-6 个 phase
- 每个 phase 具备必填字段
- `nextActions` 不再冒充 roadmap

### 19.5 Detail Expansion 测试

断言：

- 每个 phase 都能展开 detail
- detail 至少包含 target files / code changes / validation / effort
- 证据不足时会显式标注不确定性，而不是瞎编

### 19.6 Review / Discussion 争议链测试

断言：

- contested claim 可进入 debate
- maxDiscussionRounds 生效
- adjudication outcome 合法

### 19.7 End-to-End Golden Scenarios

建议最少准备：

1. 代码 review
2. PRD review
3. feasibility discussion
4. repo roadmap

---

## 20. MVP 范围建议

### 20.1 MVP 必做

1. planner / provider / dossier / ledger 主骨架保留
2. planning route 分流
3. roadmap schema 固化
4. detail expansion
5. renderer 支持 roadmap details

### 20.2 MVP 可延后

1. WebProvider
2. 更复杂的 claim clustering
3. packet dedup
4. discussion 模式的高级 debate

### 20.3 MVP 推荐优先级

推荐先做：

1. `planning` 变强
2. 再继续补 `review / discussion` 的重型争议链

原因：

- planning 当前最影响用户感知
- detail expansion 会立刻提升 roadmap 质量
- review/discussion 的重型争议链改动更大、成本更高

---

## 21. 风险与开放问题

### 21.1 Planning detail expansion 可能变得很贵

缓解：

- 限制 phase 数量
- 限制每个 phase expansion 的工具预算
- 必要时只展开高优先级 phase

### 21.2 repo-level 细节可能仍不足

缓解：

- 允许写 likely targets
- 显式标低确定性
- 保持 evidence refs

### 21.3 Shared Ledger 仍可能膨胀

缓解：

- 数据层全量，prompt 层裁剪
- default 按 claim / phase 裁剪 digest

### 21.4 mode 分流后实现复杂度上升

缓解：

- 保持共用前半段
- 只在 `cross-review` 之后分流
- 尽量复用现有模块而不是重写

### 21.5 文档与代码再次漂移

缓解：

- 优先按本文的 phase 顺序提交
- 每一阶段实现完后同步更新本文对应章节

---

## 22. 结论

Arena 的方向已经从“代码评审器”转向“evidence-driven collaboration engine”，这是对的。

下一步最关键的不是再继续抽象更多通用概念，而是把执行语义真正落下来：

1. `review / discussion` 继续走 claim-centric verification / debate / adjudication
2. `planning` 明确改成 merge-oriented review + roadmap consensus + detail expansion

一句话总结：

> Arena 不应把所有 mode 都塞进同一条争议链。`planning` 的核心不是重型裁决，而是把多模型意见收敛成可执行路线，并进一步展开成 repo 级实施方案。

建议实现优先级：

1. 先把 planning route 做强
2. 再继续补 review / discussion 的重型 trust loop

这会比“所有 mode 一起补全”更稳，也更快看到用户感知提升。

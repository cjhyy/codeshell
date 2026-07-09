# Memory Final Design

日期：2026-07-08

## 实施进度（2026-07-08 收尾）

- ✅ **P0 止血 + 最小可用**（已 landed main，commit `50b4a886` → merge `14ff7ee6`）：无向量；自动提取一律进 dream（project/global）；稳定 `id`；写入决策层 ADD/UPDATE/NOOP/DELETE（归一化文本兜底）；三道 origin 守卫；`useCount`/`updateCount` 字段。33 针对性测试 + core 全绿。
- ✅ **P1 可见 + 晋升 + 清理**（已 landed main，commit `8c6544f1` → merge `bc37da74`）：设置页显示 origin 三态徽标 + 「命中/更新」次数、详情 lifecycle；编辑 user 强制 origin:manual、pin 不增 updateCount；存量清理改分组 review + 用户批准软删。
- ✅ **审查修复**（已 landed main，commit `85abccca` → merge `aab21d08`）：修 2 个数据安全 🔴（frontmatter 注入用 JSON 序列化根治、id→文件名碰撞加冲突探测）+ 加固 dream 守卫（Save 同时按 id+name 查、命中 manual fail-closed）；**global dream 晋升从不可靠的 slug/evidenceCount 自动写改为 pending 审批流**——候选未审批前作为 project dream 正常使用，批准才进 global，拒绝标 `promotionStatus:rejected`。
- ⏸️ **P2（未做，按决策挂起）**：dream 背压 / rate-limit gate / 注入 cap。当前规模（~150 user + 个位数 dream，且 P0 已掐断重复源头）远未触发，等真出现 dream 过吵/token 上涨/后台烧配额时再做。
- 🟡 **遗留轻微改进**（codex 审查列出，不急）：intra-batch dedup（同一批第 2 个候选看不到刚 ADD 的）、canonical fallback 方向性/否定词（"use bun not npm" vs "use npm not bun"）、baseDir 透传、extract description 类型校验。

以下为原始设计正文（P0/P1 已按此实现）。

---

本文是记忆系统最终设计，不再重复评估。它收敛以下已确认材料：

- `docs/todo/memory-redesign-eval.md`：自动提取进 `dream` 可行，但必须补去重上下文、global dream 加载、fresh-entry 保护和背压。
- `docs/todo/memory-redesign-p0-plan.md`：P0 的止血范围和当前代码落点。
- `docs/todo/memory-mem0-memgpt-eval.md`：借 Mem0 旧算法的写入决策层；借 MemGPT/Letta 的 core/user 与 archival/dream 分层；不借向量库、图谱、ADD-only。
- `docs/todo/memory-simple-plan-eval.md`：用户简化方案成立；需要 `origin:dream` ownership、无向量去重、global dream 混合闸门。
- `docs/archive/todo/plan-todo-batch-2026-07.md` 项4：早期方向是 dream 提建议、用户批准；最终决策已收敛为 dream 可维护 `origin:dream`/`origin:auto`，但绝不碰 `origin:manual`。

## 最终原则

1. 不引入向量库、embedding、top-k、BM25 或图谱。CodeShell memory 的 source of truth 继续是 markdown 文件和 frontmatter。
2. 自动提取结果一律写入 `dream`：project 级写 project dream，global 级写 global dream；不再直写 user，也不再写 pending。
3. 写入前必须过轻量决策层：ADD / UPDATE / NOOP / DELETE。候选召回用全量/归一化文本/LLM 比对，不用向量。
4. `user` 是 curated/core 层：只接受显式 `MemorySave` 的 `origin:manual`，以及 dream 提升的 `origin:dream`。
5. `dream` 是 archival/workbench 层：承接自动提取、后台整理、短期/过程态信息和跨项目候选。
6. dream 只能改/删 `origin:dream` 或 `origin:auto`；`origin:manual` 永远只由用户或 permission-gated 普通会话修改。
7. 所有新记忆都有稳定 `id`。UPDATE 按 `id` 匹配，`name` 可以自由更新，不再靠日期戳命名制造新文件。
8. 记录 `useCount` 和 `updateCount`，设置页每条 memory 都要显示“命中几次 / 更新几次”。
9. global dream 晋升使用混合闸门：LLM 判定跨项目通用 + 出现在至少 2 个不同 project dream；用户直述全局偏好是例外。

## 总览架构图

```text
会话 transcript
  |
  | Engine 会话结束后异步触发 memory pipeline
  | 当前入口：packages/core/src/engine/engine.ts:2298
  | 当前 substantive session 阈值：packages/core/src/engine/engine.ts:2491
  v
Extractor
  |
  | 只提取候选事实，不直接决定落盘文件
  | 当前 schema 只有 scope/name/type/content：packages/core/src/services/extract-memories.ts:8
  | 当前 prompt 只说不要重复 existing：packages/core/src/services/extract-memories.ts:59
  v
写入决策层（新增）
  |
  | 读取候选相关的 project/user、project/dream、global/dream、可选 global/user 摘要
  | 无向量：LLM 判同主题 + 归一化文本兜底
  |
  | ADD    -> 新 id，写目标 dream，origin:auto
  | UPDATE -> 同 auto/dream 记忆，按 id 更新，name 可变，updateCount++
  | NOOP   -> 同 manual 记忆，或等价内容已存在，不碰 manual
  | DELETE -> 仅允许删除 auto/dream owned 条目；manual 永远拒绝
  |
  | Origin guard A：保存执行器拒绝自动改写 origin:manual
  v
Dream 区
  |
  | project scope -> project dream
  | global scope  -> global dream
  | 当前代码需从 pending/user 路由改到 dream：
  | packages/core/src/services/memory-orchestrator.ts:118
  v
Dream 整理
  |
  | 读取它自己已有 dream + 本轮/近期新内容，整块喂 LLM
  | 去重、合并、时效性判定、删除过程态
  | 当前 dream loop 和预算：packages/core/src/services/dream-consolidation.ts:34
  |
  | Origin guard B：
  | - dream scope 内也不能删 origin:manual
  | - user scope 只允许创建/更新/删除 origin:dream 或 origin:auto
  | - user scope 保存时强制 origin:dream，模型不能伪造 origin
  v
分流
  |
  | 耐用 user/project 结论 -> user 区，origin:dream，后续 dream 可按 id 迭代
  | 时效性/过程态信息 -> 留在 dream 或被 dream 合并/软删
  | 跨项目候选 -> 先留 project dream evidence
  | 达到 global gate -> 写/更新 global dream stable entry
  |
  | Origin guard C：
  | - 普通 MemorySave 到 user 仍需 permission
  | - 普通手动保存/编辑 user 强制 origin:manual
  | - UI 批量清理 legacy user/auto 走用户确认软删
```

实现时序上的保护：P0 可以把 due auto-dream 调度到本轮 extraction 保存之前，避免“刚提取进 dream 的 raw entry 在同一个 pipeline 里还没被注入就被删掉”。这不改变逻辑数据流；新提取内容仍是下一次 dream 的输入。当前顺序是 extraction 后才 `recordSession()` 和 auto-dream：`packages/core/src/services/memory-orchestrator.ts:214`。

## 当前代码事实

- `user/` 和 `dream/` 的权限语义已经在 `MemoryManager` 文件头写明：`user` 是用户拥有、permission-gated，`dream` 是 pipeline workspace，见 `packages/core/src/session/memory.ts:10`。
- 当前 `MemoryScope` 包含 `user | dream | pending`，pending 仍是旧 global 自动候选审批门，见 `packages/core/src/session/memory.ts:35`。
- 当前 `MemoryEntry` 已有 `name/description/type/content/fileName/scope/updatedAt/pinned/origin/usageCount/lastUsed/created/originProject`，见 `packages/core/src/session/memory.ts:46`。
- 当前 `origin` 只有 `auto | manual`，parser 也只接受这两个值，见 `packages/core/src/session/memory.ts:62` 和 `packages/core/src/session/memory.ts:268`。
- 当前 `save()` 用 `slugify(entry.name) + ".md"` 作为文件名；同名覆盖，异名 append，见 `packages/core/src/session/memory.ts:171`。这是日期戳重复的根因。
- 当前 `save()` 会保留 `created/usageCount/lastUsed/originProject`，但没有 `id/updateCount/useCount`，见 `packages/core/src/session/memory.ts:175`。
- 当前 `recordRecall()` 由 `MemoryRead` 命中后调用，递增 `usageCount` 并更新 `lastUsed`，见 `packages/core/src/session/memory.ts:328` 和 `packages/core/src/tool-system/builtin/memory.ts:146`。
- 当前注入索引已经合并 global/project 的 `user + dream`，见 `packages/core/src/session/memory.ts:533`，因此自动提取改进 dream 后下一轮 prompt 能看到摘要。
- 当前 `MemoryOrchestrator` 默认 manager 指向 project user，见 `packages/core/src/services/memory-orchestrator.ts:91`；existing list 只读该 manager 的 `loadAll()`，见 `packages/core/src/services/memory-orchestrator.ts:103`；global 写 pending、project 写 user，见 `packages/core/src/services/memory-orchestrator.ts:118`。
- 当前 `runDreamConsolidation()` 只加载 project user/dream，不稳定加载 global dream，见 `packages/core/src/services/dream-consolidation.ts:88`。
- 当前 dream dispatch 硬拒所有非 dream 写，见 `packages/core/src/services/dream-consolidation.ts:183`。最终设计要把它改成 user 写入的 origin guard，而不是简单放开。
- 当前 Engine 明确 allow `MemorySave/MemoryDelete scope=dream`，user scope 仍走 ask，见 `packages/core/src/engine/engine.ts:3000`。这个普通会话权限模型保留。
- 当前 `runDreamLoop()` 会丢弃 orchestrator 传入的 prompt，由 `runDreamConsolidation()` 重建，见 `packages/core/src/engine/engine.ts:2566`。所以 global dream 加载必须修在 consolidation 内部。
- 当前设置页已显示 `origin:auto` badge 和 `usageCount` badge，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:599` 和 `packages/desktop/src/renderer/settings/MemorySection.tsx:607`；但没有 `origin:dream`、`id`、`updateCount`。

## 数据模型

### 最终有效模型

`scope` 和 `location` 继续由路径/manager 决定，不重复写进 frontmatter，避免路径和 frontmatter 不一致：

- `scope`: `user | dream | pending`，当前存在于 `MemoryEntry.scope`，见 `packages/core/src/session/memory.ts:52`。
- `location`: `global | project`，由 `MemoryManager` 是否带 `projectDir` 推导；当前 constructor 中 global root 与 project root 分支在 `packages/core/src/session/memory.ts:148` 到 `packages/core/src/session/memory.ts:153`。

最终 frontmatter 字段：

| 字段 | 状态 | 说明 | 当前锚点 |
|---|---|---|---|
| `id` | 新增 | 稳定身份。所有新记忆必写。UPDATE 按 id，不按 name。 | 当前无；`save()` 需替换 name slug 逻辑：`packages/core/src/session/memory.ts:171` |
| `name` | 已有 | 可读标题，可在 UPDATE 中自由变化。 | `packages/core/src/session/memory.ts:191` |
| `description` | 已有 | index 摘要。 | `packages/core/src/session/memory.ts:192` |
| `type` | 已有 | `user | feedback | project | reference`。 | `packages/core/src/session/memory.ts:193` |
| `origin` | 扩展 | 从 `auto | manual` 扩展为 `auto | manual | dream`。缺失视作 manual。 | 类型：`packages/core/src/session/memory.ts:66`；parser：`packages/core/src/session/memory.ts:268` |
| `pinned` | 已有 | UI pin，免 maxAge 过滤，排序靠前。 | `packages/core/src/session/memory.ts:60` 和 `packages/core/src/session/memory.ts:194` |
| `createdAt` | 新增/重命名 | 替代当前 `created`。parser 兼容旧 `created`。 | 当前 `created`：`packages/core/src/session/memory.ts:77` 和 `packages/core/src/session/memory.ts:197` |
| `updatedAt` | 新增 frontmatter | 语义更新时间；不要只依赖文件 mtime。parser 兼容 mtime fallback。 | 当前 `updatedAt` 是 mtime 字段：`packages/core/src/session/memory.ts:53` 和 `packages/core/src/session/memory.ts:272` |
| `lastUsedAt` | 新增/重命名 | 替代当前 `lastUsed`，由 MemoryRead 命中更新。parser 兼容旧 `lastUsed`。 | 当前 `lastUsed`：`packages/core/src/session/memory.ts:76` 和 `packages/core/src/session/memory.ts:198` |
| `useCount` | 新增/重命名 | 用户要求的命中/复用次数。替代当前 `usageCount`，parser 兼容 `usageCount`。 | 当前 `usageCount`：`packages/core/src/session/memory.ts:75` 和 `packages/core/src/session/memory.ts:199` |
| `updateCount` | 新增 | 内容性 UPDATE 次数；新建为 0，按 id 更新时 +1。 | 当前无 |
| `originProject` | 保留/收窄 | legacy pending provenance；global dream 也可临时记录来源项目，但 P1 更推荐 `originProjects`。 | `packages/core/src/session/memory.ts:79` |
| `promotionKey` | P1 新增 | global dream 晋升去重 key。 | 当前无 |
| `originProjects` | P1 新增 | project dream evidence 来源集合。 | 当前只有单值 `originProject`：`packages/core/src/session/memory.ts:79` |
| `evidenceCount` | P1 新增 | `originProjects.length` 的缓存，便于 UI/LLM 判断。 | 当前无 |

示例：

```markdown
---
id: mem_01j2x7q8k7n6m4p3r2t1v0
name: codeshell-memory-origin-guard
description: Dream may iterate dream-owned user memories but must never touch manual entries.
type: project
origin: dream
pinned: false
createdAt: 2026-07-08T08:20:00.000Z
updatedAt: 2026-07-08T09:15:00.000Z
lastUsedAt: 2026-07-08T09:40:00.000Z
useCount: 3
updateCount: 2
---

Durable design note...
```

### 迁移和兼容

- 读取 legacy `usageCount` 时映射到 `useCount`；写回时只写 `useCount`。当前所有 `usageCount` 读取点在 `packages/core/src/session/memory.ts:284`。
- 读取 legacy `created` / `lastUsed` 时映射到 `createdAt` / `lastUsedAt`；写回时写新字段。
- legacy 文件没有 `id` 时，读取可生成临时 `legacy:<scope>:<fileName>` 作为 UI key；第一次内容性保存时写入真实 `id`。
- 不做盲目全量重写。P0 只保证新写入和被触达的旧文件补齐字段。
- `updateCount` 不因 `recordRecall()` 增加。当前 `recordRecall()` 会调用 `save()`，见 `packages/core/src/session/memory.ts:334`；实现时要拆出 lifecycle-only 写入或给 `save()` 增加 `incrementUpdateCount?: false`。

## 写入决策层

### 入口

落点在 `MemoryOrchestrator.run()` 中 `parseExtractionResponse()` 之后、保存循环之前。当前保存循环从 `packages/core/src/services/memory-orchestrator.ts:118` 开始。

当前：

```text
parseExtractionResponse()
  -> for each entry
       scope:global -> pending
       scope:project -> project user
```

最终：

```text
parseExtractionResponse()
  -> for each candidate
       recall candidate set
       decide ADD/UPDATE/NOOP/DELETE
       apply decision with origin guard
```

### 候选召回

不使用 embedding/top-k。第一版召回来源：

- project user：只读 awareness，用于避免自动重复 manual。
- project dream：自动 project 记忆的主要 UPDATE 目标。
- global dream：global 自动记忆的主要 UPDATE 目标。
- global user：只读 awareness，可选，用于避免自动重复 manual global。

当前 extraction existing list 只来自 `mm.loadAll()`，见 `packages/core/src/services/memory-orchestrator.ts:103`；`buildExtractionPrompt()` 只接收 `name/type/description`，见 `packages/core/src/services/extract-memories.ts:26`。P0 要扩展为包含：

```ts
interface ExistingMemorySummary {
  id?: string;
  name: string;
  type: string;
  description: string;
  location: "project" | "global";
  memoryScope: "user" | "dream";
  origin?: "manual" | "auto" | "dream";
  pinned?: boolean;
  useCount?: number;
  updateCount?: number;
  updatedAt?: string;
}
```

候选排序：

1. 同 `id`。
2. 同 canonical key。
3. 同 type + name/description token overlap。
4. `origin:auto` / `origin:dream` 优先作为可更新目标。
5. manual/pinned 只作为 NOOP/冲突意识，不自动改。
6. recent first。

候选 cap：P0 先 120 条摘要；决策 prompt 的 top related excerpt 20-40 条。规模超过 cap 时仍不引入向量，P2 再考虑背压/分页。

### 归一化兜底

canonical key 只作为兜底，不作为无提示自动删除依据：

- lower-case。
- 去日期：`YYYY-MM-DD`、`YYYYMMDD`、`today/yesterday/本轮/今天/昨天`。
- 去版本/批次：`v\d+`、`batch-\d+`、`fix-batch-\d+`。
- 去尾部 hash、连续数字、重复分隔符。
- name + description 分词，去停用词，算 token overlap。

规则：

- LLM 判 ADD，但 canonical key 与 `origin:auto|dream` 目标强一致 -> 降级为 UPDATE。
- LLM 判 ADD，但 canonical key 与 `origin:manual` 强一致 -> 降级为 NOOP。
- LLM 判 DELETE，但目标是 `origin:manual` -> 强制 NOOP 并记录 guard hit。
- LLM 判 UPDATE，但目标缺 id 且多条候选同分 -> NOOP，交给 dream 整理或 UI。

### 决策 schema

```json
{
  "action": "ADD | UPDATE | DELETE | NOOP",
  "target": {
    "id": "mem_...",
    "location": "project | global",
    "scope": "dream | user"
  },
  "memory": {
    "name": "string",
    "description": "string",
    "type": "user | feedback | project | reference",
    "content": "markdown"
  },
  "reason": "short reason",
  "confidence": "high | medium | low"
}
```

P0 executor 自动 apply 的范围：

- ADD to project/global dream: allowed, `origin:auto`。
- UPDATE dream entry whose origin is `auto` or `dream`: allowed, preserve id, `updateCount++`。
- NOOP: allowed。
- DELETE dream entry whose origin is `auto` or `dream`: allowed only when the candidate explicitly revokes/invalidates or duplicate is exact; otherwise leave to dream consolidation.
- Any target `origin:manual`: forced NOOP。

Dream consolidation apply 的范围：

- Save/Delete dream scope: allowed only for target absent or target `origin:auto|dream`。manual dream entries are protected.
- Save user scope: allowed only to create new `origin:dream` or update existing `origin:dream|auto` by id。Save must force `origin:dream` regardless of tool args.
- Delete user scope: allowed only for `origin:dream|auto` and must be soft delete. For legacy user `origin:auto`, default product flow is P1 user-approved cleanup; the guard permits it, but prompt/tests should keep automatic cleanup conservative.

### 按 id 更新的保存函数

当前 `save()` 以 name slug 决定文件，见 `packages/core/src/session/memory.ts:171`。最终改法：

- `MemoryEntry` 加 `id`。
- 新增 `findById(id)` / `loadById(id)`，跨当前 manager scope 线性扫描 markdown 文件即可。
- `save()` 支持 `id`：
  - 有 id 且找到现有文件：更新该文件；`name` 可改；文件名可保持不变。
  - 有 id 且不存在：新建 `${id}.md`。
  - 无 id：生成 id；新建 `${id}.md`。legacy/manual 旧文件只有被保存时才补 id。
- `save()` 增加选项区分内容性更新与 lifecycle 更新：
  - content/name/description/type 改变：`updateCount++`，`updatedAt=now`。
  - `recordRecall()`：只 `useCount++`、`lastUsedAt=now`，不改 `updateCount`。
  - pin/unpin：不改 `updateCount`，因为 pinning 不是内容更新。当前 pin 通过重新 save 完成，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:401`。

### Origin guard 落点

1. `packages/core/src/services/dream-consolidation.ts:183`  
   当前只检查 `scope !== "dream"`。改成按 tool、scope、target origin 判断。这里是 dream loop 的硬安全边界。

2. `packages/core/src/session/memory.ts:301`  
   `delete()` 当前不看 origin。底层可以继续无权限，但 dream dispatch 必须先查 target origin；也可以新增 `deleteIfOwned(name, allowedOrigins)` helper，减少复制查找逻辑。

3. `packages/core/src/session/memory.ts:171`  
   `save()` 当前不看 origin、不看 id。需要支持按 id 更新、强制 origin、`updateCount`。

4. `packages/core/src/tool-system/builtin/memory.ts:175`  
   `MemorySave` 描述要要求存前扫描注入 memory index：同主题更新已有记忆，不创建日期变体。普通 user save 仍 permission-gated，且保存为 `origin:manual`。

5. `packages/core/src/tool-system/builtin/memory.ts:240`  
   当前 tool save 不传 origin。普通会话保存 user 时强制 `origin:manual`；保存 dream 时可以强制 `origin:auto` 或保留 absent/manual 由交互语义决定。为了守卫清晰，建议普通 `MemorySave scope:dream` 默认 `origin:manual`，因为那是用户会话中主动要求写的草稿；自动 extractor 和 dream loop 由内部路径强制 `auto/dream`。

## Dream 整理与分流

### Prompt 与上下文

当前 `buildDreamSystemPrompt()` 明确只允许 dream scope 写，见 `packages/core/src/services/auto-dream.ts:111` 和 `packages/core/src/services/auto-dream.ts:118`。最终要更新为：

- dream 可整理 dream scope。
- dream 可把耐用结论写入 user scope，但只能写 `origin:dream`，并且只能覆盖 `origin:dream|auto`。
- user `origin:manual` 是 read-only。
- 保存到 user 前必须通过时效性判定；过程态留 dream 或删除。

当前 `buildDreamUserPrompt()` 已有第三个 `globalMemories` 参数，见 `packages/core/src/services/auto-dream.ts:133`，但 `runDreamConsolidation()` 没传。P0 必须在 `packages/core/src/services/dream-consolidation.ts:88` 加载 global dream 并传入，避免 Engine 丢 prompt 导致 global dream 不稳定整理。

### 时效性判定

升 user `origin:dream`：

- 用户偏好、长期协作规则。
- 项目长期约束、架构决策、非显然构建/测试陷阱。
- 根因型 lesson：以后怎么避免、怎么诊断。
- 稳定 reference：长期有效入口、文档、系统约束。
- 多次使用或跨会话反复出现的事实。

留 dream 或删除/合并：

- 带日期、今天/昨天/本轮、progress snapshot、completed fix log。
- TODO verification、review batch、一次性调研产物。
- “某文件刚改过/某测试刚失败/刚修好”等可从 git/test 复查的状态。
- 临时 plan、短期 workaround、一次性阻塞。

规则：带日期的 process/progress/completed-work 名称默认不升 user。若其中有耐用 lesson，另存为无日期 topic entry。

## Global Dream 晋升

### 闸门条件

自动写 global dream stable entry 必须满足：

1. LLM 判定跨项目通用：不是项目事实、不是日期过程、不是完成状态，且对多个 repo/task 都有价值。
2. 同一 `promotionKey` 出现在至少 2 个不同 project dream 中。
3. 或用户直述例外：用户在当前会话明确说“以后所有项目都...”“我偏好...”“全局记住...”，或通过 permission-gated `MemorySave location:global` 明确保存。

### 数据来源

- project dream entries：当前项目 `projects/<hash>/memory/dream`。
- cross-project evidence：P1 新增 helper 扫描 `~/.code-shell/projects/*/memory/dream`，或维护轻量 promotion index。当前 `MemoryManager` 只有当前/global root，没有跨项目枚举 API；constructor 路径在 `packages/core/src/session/memory.ts:148`。
- user direct statement：extractor prompt 标出 `userDirectGlobal`，或在 MemorySave tool prompt 中把用户直述 global save 作为显式例外。
- existing global dream：`new MemoryManager({ scope:"dream" }).loadScope("dream")`。当前 orchestrator 已构造过 global dream list，见 `packages/core/src/services/memory-orchestrator.ts:231`，但 consolidation 还需要自己加载。

### Metadata

P1 增加：

```yaml
promotionKey: memory-origin-guard
originProjects:
  - /path/to/project-a
  - /path/to/project-b
evidenceCount: 2
firstSeenAt: 2026-07-08T08:20:00.000Z
lastSeenAt: 2026-07-08T09:15:00.000Z
promotionReason: Applies to all CodeShell projects because it protects user-owned memory.
```

未达标候选不要直接写 global dream stable；否则当前 `buildInjectionIndex()` 会把所有 global dream 注入，见 `packages/core/src/session/memory.ts:540` 到 `packages/core/src/session/memory.ts:565`。未达标 evidence 留在 project dream。

## UI：计数与 provenance 展示

### 当前状态

- `MemorySection` 有 user/dream tabs，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:47`。
- list 数据来自 `window.codeshell.listMemory()`，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:178`。
- 当前 entry list 显示 type/name/description、auto badge、usageCount badge，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:597` 到 `packages/desktop/src/renderer/settings/MemorySection.tsx:613`。
- detail 只显示 auto badge，不显示 usage/update counts，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:701`。
- renderer 类型只支持 `origin?: "auto" | "manual"` 和 `usageCount`，见 `packages/desktop/src/preload/types.d.ts:195`。
- main memory service list 透传 `usageCount/lastUsed/created`，见 `packages/desktop/src/main/memory-service.ts:59`；但 readMemory detail 当前没有透传这些 lifecycle 字段，见 `packages/desktop/src/main/memory-service.ts:83`。

### 最终展示

列表每条：

- type badge。
- origin badge：
  - `manual`: 手动
  - `auto`: 自动
  - `dream`: Dream
  - 缺失 origin 视作 manual，可不显示或显示 Legacy/manual。
- pinned icon 保持。
- `useCount` badge：命中 X 次。
- `updateCount` badge：更新 Y 次。

详情页：

- 显示 id、origin、createdAt、updatedAt、lastUsedAt。
- 显示“命中 X 次 / 更新 Y 次”。
- 手动编辑 user entry 后强制保存为 `origin:manual`；当前 edit 会保留 selected.origin，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:259`，需要改。
- pin/unpin 保留 origin 且不增加 updateCount；当前 pin path 保留 origin，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:415`，这个行为保留。

### IPC/类型透传

需要改：

- `packages/desktop/src/main/memory-service.ts:29`：`RendererMemoryEntry` 增加 `id/origin:dream/useCount/updateCount/createdAt/updatedAt/lastUsedAt`。
- `packages/desktop/src/main/memory-service.ts:59`：list 映射新字段。
- `packages/desktop/src/main/memory-service.ts:83`：read 映射新字段，detail 不能丢 counts。
- `packages/desktop/src/main/memory-service.ts:96`：`SaveMemoryInput` 增加 id 和新 origin union；UI save user 时 origin manual。
- `packages/desktop/src/preload/types.d.ts:195`：renderer 类型同步。
- `packages/desktop/src/preload/index.ts:506` 和 `packages/desktop/src/main/index.ts:2876`：IPC 方法名可不变，只扩展 payload shape。
- `packages/desktop/src/renderer/settings/MemorySection.tsx:599`：origin badge 泛化为三态。
- `packages/desktop/src/renderer/settings/MemorySection.tsx:607`：`usageCount` badge 改为 `useCount`，新增 `updateCount` badge。
- `packages/desktop/src/renderer/i18n/ns/settings.ts:368` 和 `packages/desktop/src/renderer/i18n/ns/settings.ts:1123`：autoExtract 文案从“存入 User scope”改为“存入 Dream scope”。

## 分期实施计划

### P0：止血 + 最小可用

目标：

- 自动提取不再污染 user/pending。
- 新自动记忆有稳定 id。
- 写入前有 ADD/UPDATE/NOOP 决策，能阻止日期戳重复。
- dream/user origin guard 成立。
- 计数字段写入并可由 core 读取。

依赖：无，是第一期。

改文件：

- `packages/core/src/session/memory.ts`：S/M
  - 扩展 `origin` 为 `manual | auto | dream`。
  - 增加 `id/useCount/updateCount/createdAt/updatedAt/lastUsedAt`。
  - parser 兼容 legacy `usageCount/created/lastUsed`。
  - `save()` 支持按 id 更新；内容性 UPDATE 增 `updateCount`。
  - `recordRecall()` 改增 `useCount`，不增 `updateCount`。
  - 增加 `findById` / ownership helper。

- `packages/core/src/services/memory-orchestrator.ts`：M
  - project extraction -> project dream。
  - global extraction -> global dream。
  - 删除新写 pending path；pending API 保留 legacy。
  - existing list 改成 project user + project dream + global dream + optional global user。
  - 加写入决策层和归一化兜底。
  - telemetry 从 `pendingGlobalCount/projectCount` 改成 `globalDreamCount/projectDreamCount/add/update/noop/delete/guardedManualCount`。
  - due auto-dream 移到本轮 extraction persist 前，或加 fresh-entry grace。

- `packages/core/src/services/extract-memories.ts`：S/M
  - existing summary 类型扩展 location/scope/origin/id。
  - prompt 明确自动候选不直接进 user；只产候选。
  - parse 仍只决定 storage location `global|project`。

- `packages/core/src/services/dream-consolidation.ts`：M
  - 加载 global dream 并传给 prompt。
  - dispatch guard 改成 origin guard。
  - dream 保存 user 时强制 `origin:dream`。
  - 写预算继续保留。

- `packages/core/src/services/auto-dream.ts`：S
  - prompt 改成允许维护 `origin:dream` user entries，但禁止 manual。
  - global section 标清是 global dream workspace。
  - 增加时效性判定和 no-vector duplicate cluster 指令。

- `packages/core/src/tool-system/builtin/memory.ts`：S
  - `MemorySave` 描述要求保存前扫注入 index/MemoryList，同主题更新而不是新建日期变体。
  - 普通 user save 强制 `origin:manual`。
  - `MemoryList` 输出 origin/id/count 摘要，当前只输出 type/name/description，见 `packages/core/src/tool-system/builtin/memory.ts:83`。

测试点：

- 更新 `packages/core/src/services/memory-scope-routing.test.ts:27`：
  - global/project 自动提取均进 dream。
  - pending/global user/project user 不新增自动提取条目。
  - telemetry 字段改名。

- 更新 `packages/core/src/services/memory-orchestrator.test.ts:16`：
  - telemetry 包含 ADD/UPDATE/NOOP。
  - autoExtract=false 仍跳过 extraction，见现有测试 `packages/core/src/services/memory-orchestrator.test.ts:149`。
  - 同主题 auto dream 记忆二次提取走 UPDATE，不新增文件，updateCount++。
  - 同主题 manual user 记忆走 NOOP。

- 更新 `packages/core/src/session/memory.lifecycle.test.ts:18`：
  - `useCount` 替代/兼容 `usageCount`。
  - `updateCount` 内容性 update 才增加。
  - legacy 文件兼容读取。

- 新增 dream guard tests：
  - dream 不能改/删 `origin:manual` user。
  - dream 可创建 `origin:dream` user。
  - dream 可更新 `origin:dream` user by id 且 name 改变不新增文件。
  - dream scope 内 `origin:manual` 也受保护。

验收标准：

- 自动 extraction 新条目只出现在 dream。
- 日期戳变体不会因为 name 不同而新增同主题 auto memory。
- `MemoryRead` 后 `useCount` 增加；UPDATE 后 `updateCount` 增加。
- manual user memory 在 dream loop 中不可变更。
- pending 老 API 和 UI 仍能处理历史 pending。

### P1：UI 计数展示 + global dream 晋升 + 存量清理

目标：

- 设置页显示 origin、useCount、updateCount。
- global dream 自动晋升具备混合闸门。
- legacy user/auto 存量清理走用户批准软删。

依赖：P0 的 id/origin/count 字段和 guard。

改文件：

- `packages/desktop/src/main/memory-service.ts`：S
  - 透传 id/origin:dream/useCount/updateCount/createdAt/updatedAt/lastUsedAt。
  - readMemory detail 补 counts。

- `packages/desktop/src/preload/types.d.ts`、`packages/desktop/src/preload/index.ts`、`packages/desktop/src/main/index.ts`：S
  - 类型同步；IPC 方法可不变。

- `packages/desktop/src/renderer/settings/MemorySection.tsx`：M
  - list/detail 显示 origin badge、命中次数、更新次数。
  - user 内容编辑强制 origin manual。
  - legacy auto cleanup 从“全删 auto”升级为分组 review；当前全量 cleanup 在 `packages/desktop/src/renderer/settings/MemorySection.tsx:369`。

- `packages/core/src/services/auto-dream.ts` / 新 promotion helper：M
  - 生成 canonical duplicate clusters。
  - 生成 promotionKey/originProjects/evidenceCount。
  - 扫描不同 project dream evidence。

- `packages/core/src/session/memory.ts`：S/M
  - 如不想把跨项目扫描塞进 MemoryManager，可新增小 service；MemoryManager 仍负责单 root 文件读写。

- `packages/desktop/src/renderer/i18n/ns/settings.ts`：S
  - 新 badge/count/cleanup 文案。

测试点：

- memory-service list/read 都返回 id/useCount/updateCount/origin。
- MemorySection 渲染三种 origin badge 和两个 count badge。
- 编辑 user/origin:dream 后保存为 manual；pin/unpin 不改 origin。
- global promotion：
  - 单项目 project dream 且非用户直述 -> 不写 global dream。
  - 两个不同 project dream 同 promotionKey -> 写/更新 global dream。
  - 用户直述全局偏好 -> 可单项目直升 global dream。
- legacy cleanup：
  - 默认只选 `origin:auto && !pinned`。
  - 删除走 soft delete。
  - 用户取消不动文件。

验收标准：

- 用户在设置页能看到每条记忆更新几次、命中几次、来源是什么。
- global dream 不会因单项目过程态自动膨胀。
- 存量 user 自动噪声不会被盲目迁移或自动删除；所有清理都有用户确认。

### P2：Dream 背压 / rate-limit gate / working set

目标：

- 控制 dream backlog、注入体积和后台 LLM 成本。
- 不引入向量的前提下增强大列表整理能力。

依赖：P0 的 dream 路由和 P1 的 metadata。

改文件：

- `packages/core/src/services/memory-orchestrator.ts`：M
  - 增加 async `dreamBudgetGate` / `shouldRunDream`，不要塞进同步 `shouldAutoDream()`。当前 `shouldAutoDream()` 是同步 cadence，见 `packages/core/src/services/auto-dream.ts:58`。
  - gate 查询失败 fail-open 并 log；超过阈值不 `recordDreamComplete()`。

- `packages/core/src/services/auto-dream.ts`：M
  - cadence 可按 dream backlog 加速。
  - prompt 接收 duplicate clusters/backlog stats。

- `packages/core/src/session/memory.ts`：M
  - `buildInjectionIndex()` 对 dream entries 加 cap/sort，避免 raw backlog 全量注入。当前 collect 全量合并，见 `packages/core/src/session/memory.ts:533`。

- `packages/core/src/services/dream-consolidation.ts`：M
  - 根据 backlog 调整 write budget 或分批 pass，但仍有硬上限。
  - 记录 backlog/writes/guard hits telemetry。

- `packages/core/src/quota/*` 或 Engine 注入 gate：S/M
  - 如果复用 Codex quota，只作为可选 gate。早期评估已确认不能把它当所有 LLM provider 的真实配额。

测试点：

- backlog 超阈值时触发 dream 或提高批处理。
- quota 高水位时跳过 dream 且不记录 dream complete。
- 注入 index 对 dream raw entries cap 后仍优先 pinned/user/origin:dream。
- write budget 仍能阻止 runaway loop。

验收标准：

- dream raw backlog 不会无限吃 prompt。
- 后台 LLM 不在 quota 高水位时继续消耗。
- 无向量模式在 500 条以内仍可稳定去重/整理。

## 风险与回滚

- 风险：id 迁移不完整导致 legacy 文件重复。  
  缓解：legacy 读兼容；只在被保存时补 id；决策层对无 id 文件使用 canonical key 和 origin guard。

- 风险：dream 误改 manual user memory。  
  缓解：dispatch guard 硬拒 `origin:manual`；缺失 origin 视作 manual；测试覆盖 Save/Delete user 和 dream scope manual。

- 风险：LLM 决策误把 manual 同主题候选当 UPDATE。  
  缓解：executor 层二次检查 origin，manual 强制 NOOP。

- 风险：global dream 膨胀。  
  缓解：P1 hybrid gate；未达标候选留 project dream；global dream stable cap。

- 风险：UI 编辑 `origin:dream` 后 dream 仍可改用户刚编辑内容。  
  缓解：设置页内容编辑 user 条目强制转 `origin:manual`；pin/unpin 不算接管。

- 风险：`recordRecall()` 通过 `save()` 导致 updateCount 被误增。  
  缓解：拆 lifecycle-only save 或保存选项；专测。

- 风险：P0 dream 写入变多，dream 区短期增长。  
  缓解：P0 已做 UPDATE/NOOP 决策；P2 做 backlog/rate-limit gate。临时回滚可设置 `settings.memories.autoExtract=false`，当前 schema 已有该开关，见 `packages/core/src/settings/schema.ts:371`。

回滚策略：

1. 关闭 `memories.autoExtract`：停止新增自动 memory，session summary 和手动 memory 不受影响。
2. 保留 parser 对新字段的兼容：即使回滚路由，带 id/useCount/updateCount 的 markdown 仍能读。
3. pending legacy API 不删除：旧 pending 仍可 approve/demote/reject。
4. 所有 delete 仍是 soft delete：当前 delete 移到 `memory-trash`，见 `packages/core/src/session/memory.ts:301`。

## 明确不做

- 不引入向量库、embedding、semantic top-k、Qdrant、pgvector。
- 不引入图谱、Neo4j、entity linking 系统。
- 不采用 Mem0 v3 的 ADD-only 累积路线；CodeShell 当前问题正是 append-only 重复。
- 不把 markdown source of truth 替换成 SQLite/外部 DB。可以有可重建缓存，但不是近期目标。
- 不让自动 extractor 直接写 user。
- 不让自动 extractor 继续写 pending；pending 只保留 legacy 队列和可能的未来 proposal 入口。
- 不盲目迁移或删除存量 user memory；存量清理走用户批准软删。
- 不让普通 Engine 权限规则给 `scope:user` 开白名单；dream 的 user 写能力只存在于 dream loop 内部 guard。
- 不把 date/progress/completed-work 过程态提升到 user；只能提炼其中长期 lesson。

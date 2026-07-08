# Simplified Memory Architecture Evaluation

调研日期：2026-07-08。

结论先说：**这套简化方案可落地，但需要调整后落地**。我推荐接受用户的核心方向：不引入向量库/embedding/top-k，把自动产物先放进 dream，由 dream 批量归纳、去重、再把耐用结论写成 `user` 区的 dream-owned 记忆。它更符合 CodeShell 当前“小规模、文件式、透明可检查”的产品形态。

但不能按字面直接做。当前代码里没有 `origin:"dream"`，只有 `origin:"auto" | "manual"`；dream loop 对所有 user 写入硬拒；`MemoryManager.save/delete` 不做 ownership guard；desktop 编辑路径会保留原 origin 而不是把手动编辑转成 manual；project dream consolidation 也还没稳定加载 global dream。尤其是 global dream 晋升必须有明确闸门，否则只是把 user 重复堆转移成 global dream 重复堆。

本机当前磁盘状态作为规模参考：当前项目 project memory 约 150 个 user 文件、6 个 dream 文件，global pending 29 个，global dream 0 个；和背景文档里的“约 148 user + 9 dream”同量级。这个规模不需要向量库。

## 代码证据速览

- user/dream 的权限语义已经写在 `MemoryManager` 注释里：user 需要 permission-gated tool calls，dream 是 pipeline workspace，见 `packages/core/src/session/memory.ts:10` 到 `packages/core/src/session/memory.ts:15`。
- `MemoryScope` 仍包含 legacy `pending`，见 `packages/core/src/session/memory.ts:35` 到 `packages/core/src/session/memory.ts:44`。
- 当前 `origin` 类型只有 `auto | manual`，没有 `dream`，见 `packages/core/src/session/memory.ts:62` 到 `packages/core/src/session/memory.ts:66`；parser 也只接受这两个值，见 `packages/core/src/session/memory.ts:266` 到 `packages/core/src/session/memory.ts:270`。
- `MemoryManager.save()` 是同名覆盖/异名新增，并只按调用者传入的 `origin` 写 frontmatter，见 `packages/core/src/session/memory.ts:171` 到 `packages/core/src/session/memory.ts:203`。`delete()` 只按 name/fileName 软删，不检查 origin，见 `packages/core/src/session/memory.ts:301` 到 `packages/core/src/session/memory.ts:316`。
- dream loop 当前硬拒任何非 dream scope 写入，见 `packages/core/src/services/dream-consolidation.ts:183` 到 `packages/core/src/services/dream-consolidation.ts:190`。
- 普通 Engine 权限规则只自动 allow `MemorySave/MemoryDelete scope=dream`，user save/delete 继续走 ask，见 `packages/core/src/engine/engine.ts:3000` 到 `packages/core/src/engine/engine.ts:3015`；MemorySave/MemoryDelete 的工具默认权限也是 ask，见 `packages/core/src/tool-system/builtin/index.ts:642` 到 `packages/core/src/tool-system/builtin/index.ts:654`。
- `MemorySave` 工具 schema 和执行路径没有 origin 字段，保存时不传 origin，见 `packages/core/src/tool-system/builtin/memory.ts:175` 到 `packages/core/src/tool-system/builtin/memory.ts:218` 和 `packages/core/src/tool-system/builtin/memory.ts:239` 到 `packages/core/src/tool-system/builtin/memory.ts:248`。
- desktop memory-service 已经能把 origin 透传到 `MemoryManager.save()`，见 `packages/desktop/src/main/memory-service.ts:96` 到 `packages/desktop/src/main/memory-service.ts:116`；但设置页编辑旧条目时会保留 `selected.origin`，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:259` 到 `packages/desktop/src/renderer/settings/MemorySection.tsx:284`。
- dream consolidation 的初始 prompt 当前只传 project/global 当前 root 的 user+dream 两段；project consolidation 没把 global dream 作为第三段传进去，见 `packages/core/src/services/dream-consolidation.ts:88` 到 `packages/core/src/services/dream-consolidation.ts:95`。虽然 orchestrator 构造过 global dream prompt，见 `packages/core/src/services/memory-orchestrator.ts:229` 到 `packages/core/src/services/memory-orchestrator.ts:238`，但 Engine 后面会忽略这些 prompt 并让 consolidation 重建，见 `packages/core/src/engine/engine.ts:2566` 到 `packages/core/src/engine/engine.ts:2578`。

## 1. dream 写 user 区权限放开

**结论：可行，但必须做成“dream loop 内部特权 + origin guard”，不要在普通 Engine 权限规则里给 user scope 开白名单。**

当前 dream loop 的硬拒点很集中：`dispatchDreamTool()` 只允许 `MemorySave/MemoryDelete` 写 `scope === "dream"`，否则返回错误，见 `packages/core/src/services/dream-consolidation.ts:183` 到 `packages/core/src/services/dream-consolidation.ts:190`。Engine 的正常会话权限只 allow dream scope，见 `packages/core/src/engine/engine.ts:3000` 到 `packages/core/src/engine/engine.ts:3015`。这个边界是对的，不能简单改成 `scope:user && origin:dream` allow，否则普通会话里的 LLM 也可能通过伪造 `origin:dream` 绕过用户确认。

推荐改动点：

1. 扩展 `MemoryEntry.origin`：从 `auto | manual` 改为 `manual | auto | dream`，并让 parser 接受 `dream`。现状证据在 `packages/core/src/session/memory.ts:62` 到 `packages/core/src/session/memory.ts:66`、`packages/core/src/session/memory.ts:266` 到 `packages/core/src/session/memory.ts:270`。
2. 扩展 `MemorySave` 工具内部能力或 dream dispatch 入参：当前工具没有 origin 字段，也不向 `mm.save()` 传 origin，见 `packages/core/src/tool-system/builtin/memory.ts:175` 到 `packages/core/src/tool-system/builtin/memory.ts:248`。dream loop 若要写 user，需要强制保存为 `origin:"dream"`。
3. 在 `dispatchDreamTool()` 做强制 guard：
   - `MemorySave scope:user`：若同名/同文件已存在且 `origin !== "dream"`，拒绝；不存在则允许新建并强制 `origin:"dream"`；存在且 `origin:"dream"` 才允许覆盖。
   - `MemoryDelete scope:user`：只允许删除已存在且 `origin:"dream"` 的 user entry；`origin:"manual"`、缺失 origin、`origin:"auto"` 默认拒绝。
   - `MemorySave/MemoryDelete scope:dream` 保持现状自由写。
4. `MemoryManager.save/delete` 可以保持底层无权限逻辑，但更稳的是新增小 helper，例如 `loadByName()` 或 `canDreamOwnUserEntry()`，避免 guard 里复制 name/fileName 查找逻辑。当前 `delete()` 自己查找后直接删，见 `packages/core/src/session/memory.ts:301` 到 `packages/core/src/session/memory.ts:316`。

这不是大改。核心是新增一种 origin 值和 dream dispatch 里的 ownership 检查，量级 S/M。真正不能省的是 guard：靠 prompt 说“不要碰 manual”不够，因为 `MemoryManager` 当前不会替你挡。

## 2. origin 标记的自治闭环

**结论：用户手动编辑 `origin:dream` 的 user 记忆后，应该转成 `origin:manual`；现有路径不能完整做到，需要补。**

我建议语义定死：

- `origin:manual` 或缺失 origin：用户拥有，dream 永远不能覆盖/删除。
- `origin:dream`：dream 拥有的 user 区摘要，dream 后续可迭代。
- `origin:auto`：legacy extractor 产物。不要把它自动等同于 dream-owned；可通过存量清理或一次性迁移策略处理。

现有路径的行为不一致：

- 普通会话里的 `MemorySave` 不传 origin，见 `packages/core/src/tool-system/builtin/memory.ts:239` 到 `packages/core/src/tool-system/builtin/memory.ts:248`。如果它覆盖一个带 origin 的文件，`MemoryManager.save()` 不会保留原 origin，除非调用者显式传入，见 `packages/core/src/session/memory.ts:184` 到 `packages/core/src/session/memory.ts:196`。这会把 origin frontmatter 去掉；如果把“缺失 origin”视作 manual，普通交互保存可以近似完成 ownership 翻转，但它不是显式的。
- desktop 设置页 `startEdit()` 会把 `selected.origin` 塞回 draft，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:259` 到 `packages/desktop/src/renderer/settings/MemorySection.tsx:273`；`saveDraft()` 原样保存，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:276` 到 `packages/desktop/src/renderer/settings/MemorySection.tsx:284`。所以 UI 手动编辑一个 future `origin:dream` 条目时，会错误保留 dream ownership。
- pin/unpin 路径明确“keep provenance”，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:401` 到 `packages/desktop/src/renderer/settings/MemorySection.tsx:417`。这个行为应该保留，pinning 不是 authorship。

推荐闭环：

- MemorySave 工具的普通会话 user 写入一律强制 `origin:"manual"`，不要让模型选择 origin。
- desktop 新建 user memory 默认 `origin:"manual"`。
- desktop 编辑 user memory 内容/description/type/name 时强制 `origin:"manual"`；仅 pin/unpin、usageCount/recall 这类非作者行为保留原 origin。
- direct file edit 无法可靠检测。用户如果手改 markdown 并保留 `origin:dream`，系统无法知道这次编辑来自人；这是文件式系统的合理边界。可以在 UI 文案里说明“在 UI 编辑会接管为 manual”。

## 3. dream 整理无 top-k 是否够

**结论：对当前 CodeShell 规模，不引入向量是正确的；但建议加轻量去重辅助，不要只靠 LLM 在长列表里自行发现日期戳重复。**

现有 dream consolidation 不是向量召回。它在 `runDreamConsolidation()` 里直接加载 memory 列表，见 `packages/core/src/services/dream-consolidation.ts:88` 到 `packages/core/src/services/dream-consolidation.ts:95`；`buildDreamUserPrompt()` 把全部 entry 的 name/type/description 列出来，见 `packages/core/src/services/auto-dream.ts:133` 到 `packages/core/src/services/auto-dream.ts:151`；需要正文时再用 `MemoryRead`。工具层里 `MemoryList` 也只是线性列出 entries，见 `packages/core/src/tool-system/builtin/memory.ts:83` 到 `packages/core/src/tool-system/builtin/memory.ts:97`。代码里没有 memory 专用 embedding/vector/BM25/top-k 实现。

当前项目一百多条 user、个位数 dream，这种规模整块 summary 喂给 LLM 是可接受的。向量库会引入隐藏索引、provider 依赖、缓存一致性和迁移成本，不符合这个系统的透明性。

但“无 top-k”不等于“无去重辅助”。日期戳重复的根因是 `MemoryManager.save()` 只同名覆盖、异名新增，见 `packages/core/src/session/memory.ts:171` 到 `packages/core/src/session/memory.ts:203`。如果名字每天变，保存层不会知道它们是同一主题。LLM 批量整理通常能看出 `*-2026-07-08`、`*-2026-07-09` 的重复，但在 150+ 列表里不保证稳定。

推荐轻量辅助，仍然不引入向量：

- canonical name：保存/整理前生成一个 prompt-only canonical key，去掉日期、版本号、`v\d+`、`2026-07-08`、`today/yesterday`、尾部 hash。
- same-type + token overlap：对 name+description 做 token/Jaccard 粗分组，只作为提示，不自动删。
- cluster prompt：dream prompt 中额外列出“疑似重复组”，让 LLM 对组内做 merge/update/delete。
- hard rule：带日期的 process/progress/completed-work 名称默认留 dream，不升 user；若提炼出耐用 lesson，另存为无日期的 topic entry。

所以我支持“不引入向量”，但不支持“完全裸 LLM 列表去重”。P0 可先裸跑，P1 应加 no-vector dedup clusters。

## 4. global dream 晋升卡点设计

**结论：必须加双闸门。我推荐“跨项目证据阈值 + 明确通用性判定”的 hybrid gate。**

现有 global dream 的可靠性问题先要说明清楚：

- 正常 prompt 注入会合并 global user + global dream，因为 `buildInjectionIndex()` 对 global manager 调 `loadScope("user")` 和 `loadScope("dream")`，见 `packages/core/src/session/memory.ts:525` 到 `packages/core/src/session/memory.ts:541`，再统一输出到 Global memories，见 `packages/core/src/session/memory.ts:548` 到 `packages/core/src/session/memory.ts:565`。
- 但 project dream consolidation 初始上下文不稳定加载 global dream。`MemoryOrchestrator` 先构造了包含 global dream 的 prompt，见 `packages/core/src/services/memory-orchestrator.ts:229` 到 `packages/core/src/services/memory-orchestrator.ts:238`；Engine `runDreamLoop()` 随后丢弃 prompt，让 `runDreamConsolidation()` 重建，见 `packages/core/src/engine/engine.ts:2566` 到 `packages/core/src/engine/engine.ts:2578`；而 `runDreamConsolidation()` 当前只传 userMems/dreamMems，没有传 globalMemories，见 `packages/core/src/services/dream-consolidation.ts:88` 到 `packages/core/src/services/dream-consolidation.ts:95`。
- 因此，global dream 晋升前必须先修这个 bug，否则 global dream 写入后能被注入，但不能稳定被 project dream pass 看到和整理。

候选 gate：

1. **纯 LLM 通用性 gate**  
   条件：dream 整理时 LLM 判定“与具体项目无关、跨项目通用”，即可写 global dream。  
   优点：最简单，量级 S。  
   缺点：全靠模型自律，容易把“当前项目里看起来通用”的经验过早写进 global dream。用户已经明确担心 global dream 无限堆，这个 gate 不够。

2. **跨项目出现次数 gate**  
   条件：同一 canonical lesson 在至少 N 个不同 project dream 中出现过，才写 global dream。推荐 N=2 起步；同一 project 多次出现只算一次。  
   优点：最能防止 global dream 膨胀，符合“跨项目价值”的定义。  
   缺点：需要记录 `originProjects`/`evidenceCount` 或扫描所有 project dream；当前 `MemoryManager` 只面向当前 root/global root，没有现成跨项目枚举 API。

3. **hybrid gate：通用性 + 证据阈值 + 用户直述例外**  
   条件：先通过 LLM/规则判定“不是项目事实、不是日期过程、不是完成状态”；再满足以下任一条件才写 global dream：
   - 同一 canonical lesson 已在 `>=2` 个不同 project dream 中出现；
   - 用户在当前会话明确表达了全局偏好/工作原则，例如“以后所有项目都…”、“我偏好…”；
   - 用户手动点击 promote 或通过 permission-gated MemorySave 明确保存到 global。
   优点：既保守又不堵住真正的全局用户偏好。  
   缺点：需要一点结构化 metadata。

我推荐第 3 个。具体数据建议：

- `promotionKey`：从 type + canonical conclusion 生成，去日期/项目名/文件名。
- `originProjects`：去重后的 projectDir hash 或原始 projectDir 列表；当前单值 `originProject` 只服务 pending，见 `packages/core/src/session/memory.ts:79` 到 `packages/core/src/session/memory.ts:83`，不够表达跨项目证据。
- `evidenceCount`：`originProjects.length`。
- `firstSeenAt` / `lastSeenAt`。
- `promotionReason`：一句话说明为什么跨项目通用。
- `stage`：如果要把候选也持久化，至少需要 `candidate | stable`，并且 candidate 不能进入普通 global injection；当前 `buildInjectionIndex()` 会注入所有 global dream，见 `packages/core/src/session/memory.ts:533` 到 `packages/core/src/session/memory.ts:565`，所以不应把未达标 candidate 直接写进 global dream，除非同步加过滤。

推荐流程：

```text
project dream consolidation
  -> 产出/更新 project dream 的 globalCandidate metadata（不进 global dream）
  -> global promotion pass 扫描所有 project dream candidates
  -> same promotionKey 在 >=2 个 distinct projects 出现
  -> 写/更新 global dream stable entry，origin:"dream"，带 originProjects/evidenceCount
  -> global dream consolidation 定期合并 stable entries，超过 cap 前必须 merge/delete
```

为了保持 P0 简单，可以先不做自动晋升，只允许用户直述全局偏好和手动 promote 进 global dream。自动跨项目晋升放 P1。

## 5. 与之前 Mem0 方案的取舍

**结论：我更推荐当前简化方案作为主线，但保留 Mem0 的“写入决策”思想，不保留向量 top-k。**

之前 Mem0 方案的核心价值不是向量库本身，而是“写入前不要 append-only，要在候选和旧记忆之间做 ADD/UPDATE/DELETE/NOOP 决策”。当前简化方案把这个决策推迟到 dream 整理阶段：所有自动提取先入 dream，dream 批量看全局列表后合并、覆盖、删除，并把耐用结论写入 user `origin:dream`。对小规模文件式 memory，这样足够合理。

简化方案能解决的：

- user 区不再被 extractor 直接污染。
- date-stamped raw/process 内容可以在 dream 中被删除或合并。
- dream-owned user 记忆有明确 ownership，dream 可继续迭代，不碰 manual。
- 用户可以直接看 markdown 文件，系统没有隐藏向量索引。

简化方案牺牲的：

- 没有写入瞬间的 semantic recall，重复会先进入 dream，等整理时再消化。
- 如果 dream cadence 太慢，dream raw backlog 仍会短期变大。当前 auto-dream 默认 5 sessions / 24h，见 `packages/core/src/services/auto-dream.ts:21` 到 `packages/core/src/services/auto-dream.ts:24`；write budget 只有 10，见 `packages/core/src/services/dream-consolidation.ts:34` 到 `packages/core/src/services/dream-consolidation.ts:35`。
- 没有向量召回时，超大 memory 规模会漏掉近义重复。但当前不是这个规模。

我的取舍：

- 不上 embedding/vector/top-k。
- 保留 Mem0 的决策 schema：dream 整理时明确输出/执行 `ADD | UPDATE | DELETE | NOOP`，但候选来自全量列表 + canonical cluster，而不是向量 top-k。
- 如果未来单项目 memory 超过 500-1000 条，或者 no-vector cluster 漏判频繁，再把 embedding 做成可重建缓存，而不是 source of truth。

## 6. 时效性判定

**结论：用 type + 内容特征 + 命名特征做启发式，默认保守。**

升为 user `origin:dream` 的耐用结论：

- 用户偏好、工作方式、长期协作规则。
- 项目长期约束：架构决策、非显然约定、测试/构建陷阱、发布流程。
- 根因型 lesson：某类 bug 的真实根因、避免方式、长期适用的诊断顺序。
- 外部 reference：长期有效的文档、系统入口、稳定 API 约束。
- 已被多次使用或跨会话反复出现的事实。

留在 dream 或直接删除/合并的时效性内容：

- 带具体日期、今天/昨天/本轮/刚才、progress snapshot、completed fix log。
- TODO verification、review batch、一次性调研报告、一次性生成物。
- “某文件刚改过”“某测试刚失败/刚修好”这类可从 git/test 复查的状态。
- 具体计划步骤、临时阻塞、短期 workaround。
- 只有项目内一次性价值、没有根因/约定/偏好抽象的内容。

实操规则：

- name/description 含 `YYYY-MM-DD`、`done`、`completed`、`fixed`、`本轮`、`今天`：默认不升 user。
- type 为 `project` 且内容是过程状态：默认留 dream 或删除；只有提炼出长期项目约定才升 user。
- type 为 `feedback` / `user` 且来自用户明确偏好：可升 user；若含具体项目名则先留 project user，不升 global。
- content 中出现 repo path、文件名、测试名，不等于不能升 user；但必须把耐用结论抽象成“为什么/以后怎么做”，不要保存“今天改了哪个文件”。

## 可行性判定与卡点

总体判定：**需调整后可行**。

卡点：

1. **`origin:"dream"` 不存在**：当前 core/desktop 类型和 parser 只支持 `auto|manual`。必须扩展。
2. **dream user 写 guard 不存在**：`MemoryManager.save/delete` 不检查 origin。必须在 dream dispatch 或专用 helper 中硬拦 manual/legacy user entry。
3. **普通 Engine 权限不能开 user 白名单**：正常会话 user save/delete 应继续 ask；dream 特权只属于 `runDreamConsolidation()`。
4. **desktop 编辑不会自动接管 ownership**：现有编辑路径保留 origin；需要内容编辑强制 `manual`，pin/unpin 继续保留 origin。
5. **global dream consolidation 加载 bug**：project dream pass 初始 prompt 不稳定包含 global dream；必须先修。
6. **global promotion 需要结构化证据**：当前只有单值 `originProject`，没有 `originProjects/evidenceCount/promotionKey`。
7. **无 top-k 仍需轻量去重**：不需要向量，但建议 canonical cluster 辅助，否则日期戳重复仍可能靠 LLM 运气。

没有硬阻碍。都是局部数据模型、dispatch guard、prompt/build list 的改动。

## 推荐落地方案

### P0：dream-owned user 记忆闭环

量级：M。

- 新增 `origin:"dream"`，保留 `origin:"auto"` 作为 legacy extractor 标记，缺失 origin 视作 manual。
- dream consolidation 允许写 user，但只允许创建/覆盖/删除 `origin:"dream"` user entry；manual/legacy user entry 硬拒。
- dream 写 user 时强制 origin 为 dream，不能让 LLM 自己传。
- 普通 `MemorySave scope:user` 和 desktop 内容编辑强制 `origin:"manual"`；pin/unpin 保留 provenance。
- 修 `runDreamConsolidation()` 加载 global dream，把 `buildDreamUserPrompt(userMems, dreamMems, globalDreamMems)` 真正接上。
- 暂不做自动 global dream 晋升；只允许用户明确全局偏好或手动 promote。

### P1：no-vector 去重与 global dream 闸门

量级：M。

- dream prompt 增加 canonical duplicate clusters：去日期、版本号、完成状态后按 name/description 粗分组。
- dream 整理输出/内部执行遵循 `ADD/UPDATE/DELETE/NOOP`，但候选来自全量文件列表和 cluster，不来自 embedding top-k。
- 设计 `promotionKey/originProjects/evidenceCount` metadata。
- 自动 global dream 晋升采用 hybrid gate：通用性判定 + `>=2` distinct project evidence；用户直述全局偏好可单项目直升。
- global dream stable entries 加 cap，比如 50 条；超过 cap 前 dream 必须合并或拒绝新增。

### P2：只有规模逼近时再考虑检索层

量级：L，仅条件触发。

- 当单项目 memory 超过 500-1000 条、prompt cluster 失效、跨项目候选扫描太慢时，再引入可重建 embedding cache。
- markdown 仍是 source of truth，embedding 只做候选召回缓存。

## 最终建议

我建议落地这个简化方案，但要把它定义成：

```text
auto extraction -> project/global dream raw
dream consolidation -> batch dedup/merge/delete
durable conclusion -> user origin:dream
manual edit/save -> origin:manual, dream no longer owns it
global dream -> only through hybrid gate
```

不要保留“向量 top-k 召回”作为近期必做项。保留 Mem0 的写入决策思想，但用文件式、全量列表、canonical cluster 和 LLM 批量整理实现。对 CodeShell 当前规模，这是更透明、更小、更符合用户偏好的方案。

最重要的原则是：**user 区不再等于 manual-only，但 user 区必须有 owner。`origin:manual` 属于用户，`origin:dream` 属于 dream。没有 owner guard，这个方案就不成立。**

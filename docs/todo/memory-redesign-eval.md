# Memory Redesign Evaluation

结论先说：**方向正确，但方案需要调整后落地**。把自动提取从 `user` 改进 `dream` 能治住 user 区自动堆积，也符合现有权限模型；但不能只改路由。当前代码里至少有四个硬问题必须一起处理：提取去重上下文仍只看 user、Engine 丢弃了 orchestrator 构造的 global dream prompt、dream cadence/写预算不足以兜住高频提取、存量清理现在没有结构化建议审批流。

我的建议不是保守地在 extractor 上补一个去重规则，而是执行“自动提取进 dream”的主方向，同时做一个更窄的 P0 版本：先止住 user 污染，再补 dream 背压和清理 UX。

## 证据概览

- 当前自动提取链路确实写入 project user 或 global pending。`MemoryOrchestrator.run()` 构造默认 `MemoryManager`，未指定 `scope`，所以默认是 user；提取时 `mm.loadAll()` 只读该 manager 的当前 scope；保存时 global 走 `new MemoryManager({ scope: "pending" })`，project 走 `mm`。见 `packages/core/src/services/memory-orchestrator.ts:91`, `packages/core/src/services/memory-orchestrator.ts:103`, `packages/core/src/services/memory-orchestrator.ts:118`, `packages/core/src/services/memory-orchestrator.ts:126`, `packages/core/src/services/memory-orchestrator.ts:129`。
- `MemoryManager` 本身支持直接写 dream，不依赖 consolidation pass。`scope?: MemoryScope` 是构造参数，默认 user；构造器把 scope 变成 `<memoryRoot>/<scope>`；`save()` 写当前 scope 目录并更新索引。见 `packages/core/src/session/memory.ts:103`, `packages/core/src/session/memory.ts:145`, `packages/core/src/session/memory.ts:155`, `packages/core/src/session/memory.ts:171`。
- prompt 注入已经同时读 user 和 dream，而且同时读 global 和 project。`PromptComposer` 把 memory 放在 dynamic context；`buildInjectionIndex()` 的 `collect()` 合并 `loadScope("user")` 和 `loadScope("dream")`，再分别输出 global/project 段。见 `packages/core/src/prompt/composer.ts:156`, `packages/core/src/prompt/composer.ts:167`, `packages/core/src/prompt/composer.ts:296`, `packages/core/src/session/memory.ts:519`, `packages/core/src/session/memory.ts:533`, `packages/core/src/session/memory.ts:540`, `packages/core/src/session/memory.ts:560`。
- dream loop 硬拒 user 写，这是正确的边界。它只允许 `MemorySave`/`MemoryDelete` 写 `scope === "dream"`，否则返回错误；Engine 也为 dream scope 写加了 allow 规则。见 `packages/core/src/services/dream-consolidation.ts:183`, `packages/core/src/services/dream-consolidation.ts:186`, `packages/core/src/engine/engine.ts:2977`, `packages/core/src/engine/engine.ts:2982`, `packages/core/src/engine/engine.ts:2988`。
- 当前 repo 的真实磁盘状态也能复现问题：`/Users/admin/.code-shell/projects/Users-admin-Documents-个人学习-代码学习-codeshell/memory/user/MEMORY.md:99` 到 `:125` 是连续的 `codeshell-todo-verification-2026-07-*` 条目。调研时该项目 user 区有 160 个 memory 文件，其中 27 个匹配该 daily verification 模式，dream 区只有 8 个。

## 1. 提取改向的可行性

**结论：技术上可行，改动点集中，但必须同时改“existing memories”来源，否则 dream 会成为新的重复堆。**

现链路是：

1. `Engine` 在回合结束后的 memory pipeline 中创建 `MemoryOrchestrator`，传入 `projectDir: cwd` 和 `callLLM`。见 `packages/core/src/engine/engine.ts:2487`, `packages/core/src/engine/engine.ts:2503`, `packages/core/src/engine/engine.ts:2510`。
2. `MemoryOrchestrator` 默认构造 `new MemoryManager({ projectDir })`。因为没传 `scope`，它指向 project user。见 `packages/core/src/services/memory-orchestrator.ts:91` 和 `packages/core/src/session/memory.ts:108`。
3. 提取 prompt 的 existing list 来自 `mm.loadAll()`。这同样只看 project user。见 `packages/core/src/services/memory-orchestrator.ts:103`, `packages/core/src/services/extract-memories.ts:40`, `packages/core/src/services/extract-memories.ts:63`。
4. `parseExtractionResponse()` 只产出 `scope: "global" | "project"`，并把缺失/非法 scope 降级成 project。见 `packages/core/src/services/extract-memories.ts:8`, `packages/core/src/services/extract-memories.ts:17`, `packages/core/src/services/extract-memories.ts:114`。
5. 保存时 global 进 pending，project 进 `mm`。见 `packages/core/src/services/memory-orchestrator.ts:118`, `packages/core/src/services/memory-orchestrator.ts:126`, `packages/core/src/services/memory-orchestrator.ts:143`。

要改成 dream，核心代码应改在 `MemoryOrchestrator.run()` 的提取保存段：

- project 级：`new MemoryManager({ projectDir: this.options.projectDir, scope: "dream" })`
- global 级：`new MemoryManager({ scope: "dream" })`
- 保存仍可带 `origin: "auto"`，继续让 UI 区分自动来源。当前 frontmatter 已支持 `origin`，见 `packages/core/src/session/memory.ts:62`, `packages/core/src/session/memory.ts:195`。
- pending 相关 telemetry 要改名，不再叫 `pendingGlobalCount`。当前 log 字段在 `packages/core/src/services/memory-orchestrator.ts:151` 到 `:155`。

最大隐患是 `existing = mm.loadAll()`。如果只把保存目标换成 dream，下次 extractor 仍看不到上次写进 dream 的自动记忆，`extract-memories.ts` 里的“Do not duplicate existing memories”规则会失效。这个问题正好会复刻现在的 daily verification 重复，只是从 user 换到 dream。P0 必须把 existing list 改成至少包含 project user + project dream；若 global 自动写 global dream，也要包含 global dream 的索引摘要。相关入口在 `packages/core/src/services/memory-orchestrator.ts:103` 到 `:106`。

对 consolidation 假设的影响：不会破坏硬权限假设，因为 dream 本来就是 LLM 可自由写/删的 workspace。见 `packages/core/src/session/memory.ts:14` 和 `packages/core/src/services/dream-consolidation.ts:16`。但会改变语义假设：UI 和 prompt 文案现在把 dream 描述成 “auto-consolidated workspace”，不是“raw extractor inbox + consolidated notes”。见 `packages/core/src/session/memory.ts:492` 和 `packages/desktop/src/renderer/settings/MemorySection.tsx:47`。

## 2. 注入是否受影响

**结论：模型下一轮仍能看到；当前轮已经结束，不会回灌到本轮。主要风险是同一 end-of-session pipeline 内 dream 可能马上清掉刚提取的内容。**

注入链路已经兼容 dream：

- `PromptComposer.buildDynamicContextMessage()` 每轮追加 dynamic context，包含 memory context。见 `packages/core/src/prompt/composer.ts:156`, `packages/core/src/prompt/composer.ts:167`, `packages/core/src/prompt/composer.ts:173`。
- `getMemoryContext()` 调用 `MemoryManager.buildInjectionIndex({ projectDir: cwd })`。见 `packages/core/src/prompt/composer.ts:296` 到 `:305`。
- `buildInjectionIndex()` 对 global store 和 project store 都调用 `collect()`，`collect()` 合并 user + dream。见 `packages/core/src/session/memory.ts:525`, `packages/core/src/session/memory.ts:526`, `packages/core/src/session/memory.ts:533`, `packages/core/src/session/memory.ts:535`。
- 注入文本明确要求模型需要正文时用 `MemoryRead(scope = user or dream; location = global or project)`。见 `packages/core/src/session/memory.ts:560` 到 `:563`。
- `MemoryRead` 工具确实支持 `scope: "user" | "dream"` 和 `location: "global" | "project"`。见 `packages/core/src/tool-system/builtin/memory.ts:105`, `packages/core/src/tool-system/builtin/memory.ts:113`, `packages/core/src/tool-system/builtin/memory.ts:118`, `packages/core/src/tool-system/builtin/memory.ts:141`。

两个需要明确的时序问题：

- memory pipeline 在主回合结束后跑。Engine 只有非 system 的 user/assistant 消息达到 8 条才进入 pipeline。见 `packages/core/src/engine/engine.ts:2462` 到 `:2471`。因此新提取的记忆最早影响下一次 prompt，不影响刚结束的那次模型输出。
- 当前 pipeline 顺序是提取先跑，之后 record session，再按 cadence 跑 dream。见 `packages/core/src/services/memory-orchestrator.ts:95`, `packages/core/src/services/memory-orchestrator.ts:214`, `packages/core/src/services/memory-orchestrator.ts:217`。如果 P0 把提取结果写进 dream，而刚好 `shouldAutoDream()` 为 true，dream 会在同一次 pipeline 看见刚写入的 raw entries。dream prompt 又明确要求删除/归档 completed work。见 `packages/core/src/services/auto-dream.ts:117`, `packages/core/src/services/auto-dream.ts:123`。这意味着“刚提取的信息还没注入过就被删掉”不是理论风险。

建议 P0 加一个保护：要么把 dream consolidation 移到本轮 extraction 保存之前，要么在 dream prompt/dispatch 层对本轮新建的 `origin:auto` entry 设一个 grace window。前者简单，代价是新 raw entry 要等下次 dream 才整理；我更倾向前者，因为它保证新记忆至少经历一次注入机会。

## 3. pending 队列何去何从

**结论：新的自动提取链路可以不再写 pending，但 pending 不应在 P0 删除。它现在只服务 memory approval UI 和 legacy backlog，保留兼容成本低。**

pending 当前用途很集中：

- `MemoryScope` 包含 `"pending"`，注释明确它是 global 自动候选审批门。见 `packages/core/src/session/memory.ts:35` 到 `:44`。
- `approvePending()`、`demotePending()`、`rejectPending()` 的核心在 `MemoryManager`，approve 进 global user，demote 进来源 project user 或 fallback global user。见 `packages/core/src/session/memory.ts:374`, `packages/core/src/session/memory.ts:383`, `packages/core/src/session/memory.ts:391`, `packages/core/src/session/memory.ts:396`, `packages/core/src/session/memory.ts:402`。
- 桌面 main 暴露 pending IPC。见 `packages/desktop/src/main/memory-service.ts:128` 到 `:165`，以及 `packages/desktop/src/main/index.ts:2908` 到 `:2920`。
- 设置页 global memory view 拉取 pending 并渲染 approve/demote/reject banner。见 `packages/desktop/src/renderer/settings/MemorySection.tsx:161`, `packages/desktop/src/renderer/settings/MemorySection.tsx:165`, `packages/desktop/src/renderer/settings/MemorySection.tsx:196`, `packages/desktop/src/renderer/settings/MemorySection.tsx:509` 到 `:563`。
- Memory tools 不暴露 pending，`VALID_SCOPES` 只有 user/dream。见 `packages/core/src/tool-system/builtin/memory.ts:22`。

如果 global 自动提取改进 global dream，pending 的“新写入来源”消失，但已有 pending 条目仍可能存在。P0 应该保留 pending API/UI，让用户处理旧队列；同时把文案改成 legacy global candidates。P1 再决定是否删除 pending，或者把 pending 改造成“promotion suggestions”，用于 dream 建议把某条 dream 记忆提升到 user/global user。

一个产品取舍要讲清楚：现方案取消了“自动发现 global 候选后请用户批准”的路径。以后 global user 只来自交互会话中的 `MemorySave scope:user location:global`，或者手动从 project user 提升。现有 project user 手动提升路径在 `packages/core/src/session/memory.ts:422` 到 `:445` 和 `packages/desktop/src/renderer/settings/MemorySection.tsx:632` 到 `:644`。如果仍想保留“自动候选但需批准”的 UX，不应把 pending 完全下线，而应让 dream 生成结构化 promotion suggestions。

## 4. dream 区会不会爆

**结论：会有新堆积风险。当前 cadence 和写预算只能处理低速噪音，不能保证高频 extractor 输入不会积压。**

相关事实：

- 默认 auto-dream 配置是每 5 个 session 且至少 24 小时一次。见 `packages/core/src/services/auto-dream.ts:21` 到 `:24`。
- `shouldAutoDream()` 只有同步的 enabled/session/time 检查。见 `packages/core/src/services/auto-dream.ts:58` 到 `:72`。
- `recordSession()` 状态文件在 memory base dir 下，但不是按 project 分文件。见 `packages/core/src/services/auto-dream.ts:35`, `packages/core/src/services/auto-dream.ts:78`。
- extractor prompt 要求最多 2 条，代码也 cap。见 `packages/core/src/services/extract-memories.ts:60`, `packages/core/src/services/extract-memories.ts:75`, `packages/core/src/services/extract-memories.ts:88`, `packages/core/src/services/extract-memories.ts:135`。
- dream loop 最多 8 轮、10 次写。见 `packages/core/src/services/dream-consolidation.ts:34`, `packages/core/src/services/dream-consolidation.ts:35`, `packages/core/src/services/dream-consolidation.ts:112`, `packages/core/src/services/dream-consolidation.ts:192`。
- 注入索引没有条数上限，只做可选 maxAge 过滤。见 `packages/core/src/session/memory.ts:533` 到 `:541`，`packages/core/src/session/memory.ts:548` 到 `:565`。

低频时没问题：5 个 substantive sessions 最多约 10 条 raw entries，dream 一次 10 writes 大致够用。高频时不够：24 小时门槛意味着一天 30 次长会话可产生最多 60 条 raw entries，但只跑一次 dream，写预算仍是 10。再加上 cadence state 是全局的，一个项目触发并 reset 后，另一个项目的 dream backlog 可能被延后。

P0 至少应加背压和观测：

- log dream backlog count，超过阈值时加速触发或在注入时截断。
- buildInjectionIndex 对 dream entries 加数量 cap 或优先排序，避免 prompt 被 raw backlog 吃掉。
- dream 每次运行前按 count 决定是否提高 MAX_WRITES，或分批执行多 pass。不要无限放开，后台 LLM loop 仍要有硬上限。

## 5. 语义漂移风险

**结论：存在。P0 不必新增物理 raw/consolidated 双目录，但必须让 prompt、MemoryList、UI 能识别 raw auto entries。**

当前语义是：

- `user/`：用户拥有，写入需权限。见 `packages/core/src/session/memory.ts:10` 到 `:13`。
- `dream/`：dream pipeline workspace，可 add/merge/delete。见 `packages/core/src/session/memory.ts:14` 到 `:15`。
- prompt 中 dream 是 “auto-consolidated workspace”。见 `packages/core/src/session/memory.ts:492`。
- dream prompt 的目标是清理 `dream` scope，偏好 fewer higher-quality merged entries。见 `packages/core/src/services/auto-dream.ts:106`, `packages/core/src/services/auto-dream.ts:120`。

把 raw extractor 输出也放进 dream 后，dream 会同时包含：

- raw auto 提取片段
- dream 合并后的精华
- 可能由正常会话 `MemorySave scope:dream` 写入的草稿

现有 frontmatter 已有 `origin:auto|manual`，但 dream prompt 和 `MemoryList` 都没有把 origin 暴露给模型。`buildDreamUserPrompt()` 只格式化 type/name/description，见 `packages/core/src/services/auto-dream.ts:138` 到 `:139`；`MemoryList` 也只输出 type/name/description，见 `packages/core/src/tool-system/builtin/memory.ts:95` 到 `:97`。因此单靠已有 origin 字段，consolidator 目前看不见 raw/consolidated 区别。

建议：

- P0 不新增 `raw/` 子 scope，避免扩大迁移和工具 schema 改动。
- P0 必须把 origin 暴露到 dream prompt 和 MemoryList，至少显示 `[auto]` 或 `[manual]`。
- P1 再评估是否加 `stage: raw | consolidated` frontmatter。只有当 single dream scope 加 origin 后仍无法整理，才需要物理分层。直接上双目录会让 MemoryRead/MemorySave schema、UI tabs、注入、迁移都变复杂，当前收益不够。

## 6. 存量迁移

**结论：不要做盲目一次性迁移。应先止血，再做用户批准的定向软删/摘要迁移。**

理由：

- 从 user 移到 dream 等于把删除权交给 dream loop。对真正由用户或助手显式保存的耐用事实，这是权限语义变化。
- 现有 UI 已有“删除本 scope 下所有自动提取且未 pinned 条目”的批量清理，但它是按 `origin:auto` 全删，不是 dream 生成的定向建议。见 `packages/desktop/src/renderer/settings/MemorySection.tsx:369` 到 `:389`。这可以救急，但太粗。
- dream 当前只能把 user-scope stale entries 写进最终 summary 文本，不能产出结构化删除建议。prompt 只说 “surface them in your final summary text”，见 `packages/core/src/services/auto-dream.ts:119`；设置页只展示 `result.summary`，见 `packages/desktop/src/renderer/settings/MemorySection.tsx:311` 到 `:324`。这不是“一键批准删”的实现。
- `MemoryManager.delete()` 是软删，会移到 `memory-trash`，适合做用户批准后的批量清理。见 `packages/core/src/session/memory.ts:296` 到 `:316`。

推荐迁移策略：

- P0：不迁移，先把新 extractor 输出从 user 切走。
- P0.5：设置页加一个针对当前项目 user scope 的“review auto clutter”视图，默认筛选 `origin:auto && !pinned`，按相似 name/description 分组，用户确认后软删。现有 cleanupAuto 可以作为底层 delete 循环，但不要继续做全量不分组删除。
- P1：dream 生成结构化 cleanup suggestions，例如 `{ location, scope:"user", names, reason }`，UI 展示 diff，用户批准后调用现有 delete。不要让 dream 直接删 user。
- 对 `codeshell-todo-verification-*` 这类明显过程态重复，可以让 cleanup suggestion 默认选中；不要把它们批量迁移到 dream，因为它们多数没有未来价值，迁移只是换个地方堆。

## 7. 更简单替代方案对比

### A. 只在 extractor 加去重/合并，仍写 user

优点：改动最小，主要改 `buildExtractionPrompt()` 和 `MemoryOrchestrator` 保存前查重。

缺点：治标不治本。自动写入仍污染用户拥有区，dream 仍不能自动整理 user。现有 prompt 已有 “Do not duplicate existing memories”，见 `packages/core/src/services/extract-memories.ts:63`，真实数据说明仅靠 prompt 不够。保存层按 slug/name 覆盖只能处理同名，daily verification 这种日期变体会绕过。见 `packages/core/src/session/memory.ts:171` 到 `:173`。

判定：不推荐作为主方案。可作为 P0 的辅助去重，但不能替代改向。

### B. 在 user 区加 `tier:auto|curated`

优点：保留现有 user 注入路径和 pending 思路，迁移成本比新 scope 小。

缺点：会把权限语义搞复杂。要么 dream 仍不能删 user auto tier，堆积问题还在；要么给 background 特权删 user auto tier，又打破“user 区用户拥有”的简单模型。现有 permission 和 dream dispatch 都是按 scope 判断，不按 tier。见 `packages/core/src/services/dream-consolidation.ts:183` 到 `:191` 和 `packages/core/src/engine/engine.ts:2977` 到 `:2993`。

判定：不推荐。它比改向更难解释，也更容易留下例外路径。

### C. 关闭 autoExtract

优点：已经有设置项和 UI 开关。`autoExtract:false` 会跳过 extractor，且测试覆盖。见 `packages/core/src/services/memory-orchestrator.ts:99`, `packages/core/src/settings/schema.ts:371`, `packages/desktop/src/renderer/settings/MemorySection.tsx:342`, `packages/core/src/services/memory-orchestrator.test.ts:149`。

缺点：这是用户级逃生阀，不是系统设计。它会失去自动记忆能力。

判定：可作为临时止血开关，不是最终方案。

### D. 自动提取全部进 dream，保留 user 仅显式保存

优点：匹配现有 permission boundary，dream 可以自动整理自动产物，user 回归 curated。prompt 注入已经兼容 user + dream。

缺点：需要补去重上下文、global dream consolidation、dream 背压、存量 cleanup UX。

判定：推荐，但必须按下方调整落地。

## Global dream consolidation 的额外阻碍

这是我调研中发现的一个独立 bug/设计缝隙：代码注释说 auto-dream 会清 project dream + global dream，但当前 Engine 路径不可靠。

- `MemoryOrchestrator` 在触发 dream 前确实加载了 `globalDreamMems`，并把它传给 `buildDreamUserPrompt()`。见 `packages/core/src/services/memory-orchestrator.ts:227` 到 `:237`。
- 但 Engine 的 `runDreamLoop()` 收到 `systemPrompt`/`userPrompt` 后没有使用它们，而是调用 `runDreamConsolidation()` 让后者重新构造 prompt。见 `packages/core/src/engine/engine.ts:2501` 到 `:2502`，`packages/core/src/engine/engine.ts:2536` 到 `:2555`。
- `runDreamConsolidation()` 当前只加载 `new MemoryManager({ projectDir })` 的 user 和 dream，没有加载 global dream 作为 prompt 初始列表。见 `packages/core/src/services/dream-consolidation.ts:88` 到 `:95`。
- system prompt 虽然要求模型 consolidate BOTH project dream and global dream。见 `packages/core/src/services/auto-dream.ts:114`。但没有初始 global 列表时，模型是否主动 `MemoryList({scope:"dream", location:"global"})` 取决于听话程度，不是结构保证。

如果新设计把 global 自动提取改进 global dream，这个问题必须进 P0。修法二选一：

- 让 `runDreamConsolidation()` 自己加载 global dream 并传给 `buildDreamUserPrompt(userMems, dreamMems, globalDreamMems)`。
- 或让 Engine 尊重 orchestrator 传入的 prompts，不要重建。

我推荐第一种，因为 manual dream 也会受益，且 consolidator 的数据加载逻辑集中在一个地方。

## Rate-limit 跳过

**结论：应加在 async orchestrator/Engine 层，不能塞进 `shouldAutoDream()`；并且不能盲目复用现有 CheckQuota 当作所有 dream LLM 的配额判断。**

证据：

- `shouldAutoDream()` 是同步函数，只读本地 cadence state。见 `packages/core/src/services/auto-dream.ts:58` 到 `:72`。
- 现有 quota 模块是 async，且查的是外部 coding-agent CLI 的 Claude Code/Codex subscription quota。见 `packages/core/src/quota/index.ts:1` 到 `:14`，`packages/core/src/quota/index.ts:154` 到 `:167`。
- `CheckQuota` tool 的描述也定位在 DriveAgent orchestration，而不是通用 LLM provider quota。见 `packages/core/src/tool-system/builtin/check-quota.ts:4` 到 `:6`，`packages/core/src/tool-system/builtin/check-quota.ts:20` 到 `:26`。
- 桌面 main 的 `quota:get` 也通过 IPC 查这些 provider，失败不会 throw，而是 provider error。见 `packages/desktop/src/main/index.ts:2400` 到 `:2411`。

建议：给 `MemoryOrchestratorOptions` 增加可选 async gate，例如 `shouldRunDream?: () => Promise<boolean>` 或 `dreamBudgetGate?: () => Promise<{run:boolean; reason?:string}>`。调用顺序是 `shouldAutoDream()` 通过后再查 gate；gate 查询失败 fail-open 并打 log。不要改 `auto-dream.ts` 的同步 cadence API。

还要确认 dream 使用的 LLM provider。Engine 当前用 `resolveExtractionClient(primaryClient)` 得到 llmClient，再传给 dream。见 `packages/core/src/engine/engine.ts:2461`, `packages/core/src/engine/engine.ts:2501`。如果这个 client 是 OpenAI/OpenRouter/Anthropic API，CC/Codex CLI quota 并不能代表它。

## 可行性判定

总体判定：**需调整后可行**。

必须调整的隐患：

1. **去重上下文必须包含 dream**。否则 redirect 后只会把重复堆从 user 搬到 dream。
2. **global dream 必须被真实加载进 consolidation prompt**。否则 global 自动提取进 global dream 后，清理不稳定。
3. **刚提取 entry 要避免同 pipeline 被 dream 清掉**。建议 dream 先于 extraction，或加 fresh grace。
4. **dream backlog 需要背压/注入 cap**。当前 24h cadence + 10 writes 不足以保证高频清理。
5. **pending 保留 legacy，不做 P0 删除**。否则已有 pending 用户无法处理，也会制造 UI/API churn。
6. **存量 cleanup 需要结构化建议或分组 UI**。现有 `cleanupAuto` 是全删自动条目，不等价于“dream 建议后一键批准”。
7. **dream raw/consolidated 语义需要暴露 metadata**。不必新 scope，但至少 prompt/MemoryList/UI 要显示 origin。

## 推荐落地方案

### P0 先止血：自动提取改进 dream，但带最小安全护栏

量级：M

内容：

- 改 `MemoryOrchestrator` 提取保存路由：project -> project dream，global -> global dream。
- existing memories 改为 project user + project dream + global dream 的摘要集合，必要时加 cap，避免 extraction prompt 过大。
- 保持 `origin:"auto"`，更新 telemetry 字段和 tests。现有 routing test 在 `packages/core/src/services/memory-scope-routing.test.ts:27` 到 `:78` 要改成断言 global/project 都进 dream。
- 修 `runDreamConsolidation()` 加载 global dream，让自动和手动 dream 都能稳定整理 global dream。
- 防止刚提取内容同 pipeline 被删：我建议调整顺序，让 due dream 在保存本轮 extraction 前运行；或者实现 created grace。二选一必须有。
- pending API/UI 保留，只是不再由 extractor 写新条目。
- 加注入/路由回归测试：dream entries 进入 `buildInjectionIndex()`；global dream 能被 prompt 初始列出；extractor existing list 包含 dream，避免重复。

风险：

- dream 区短期会增长，因为 P0 先保证 user 不再污染，清理能力仍有限。
- 如果不做 prompt 文案更新，用户会看到 dream tab 里出现 raw 自动条目，语义略乱。
- global 自动候选不再进入 pending，用户少了一个“批准升 global user”的自动发现入口。需要在 release note/设置页文案说清楚。

### P0.5 存量清理：用户批准的定向软删

量级：S/M

内容：

- 在设置页当前 scope 下增加 auto clutter review，默认筛 `origin:auto && !pinned`，按 name 前缀/描述相似度分组。
- 对 `codeshell-todo-verification-*` 这类 repeated completed-state 记忆提供默认选中删除建议。
- 调用现有 `deleteMemory()` 软删，不做硬删。
- 不做全量迁移到 dream。

风险：

- 相似度/分组可能误选。必须让用户可取消单条。
- legacy entries 可能缺 `origin:auto`，需要按 name pattern 辅助识别，但 pattern 删除必须更保守。

### P1 治本：dream inbox 语义和背压

量级：M/L

内容：

- 在 dream prompt 和 MemoryList 输出中显示 origin；可选增加 `stage: raw|consolidated` frontmatter。
- 给 dream backlog 加 metrics 和阈值策略：超过 N 条加速 dream、分批 pass、或注入只取 top K。
- 设计 structured cleanup/promotion suggestions：dream 不能写 user，但可产出建议；设置页展示后用户批准执行 delete/promote/save。
- 重新审视 pending：如果 structured promotion suggestions 覆盖它，P1 末尾可以迁移旧 pending 后隐藏或删除 pending UI。
- quota gate 用 host-injected async policy，fail-open；不要把 provider-specific quota 写死进 `auto-dream.ts`。

风险：

- 增加 frontmatter 字段需要兼容旧文件和 UI 类型。
- structured suggestions 会引入新状态文件或新 memory-adjacent store，需要避免又制造一个无人清理的队列。
- 注入 cap 如果排序不对，可能隐藏重要 dream 记忆。需要 pinned/usage/recent/origin 的明确排序规则。

## 最终建议

我建议走“自动提取全部进 dream”的方向，但不要按原方案原样执行。原方案低估了三点：extractor 去重上下文仍只看 user、global dream consolidation 当前不是真正结构化加载、dream 的 24h/10 writes 清理能力不足。

最务实的落地路径是：

1. P0 先改路由并补去重上下文、global dream 加载、fresh-entry 保护。这样立刻停止 user 区继续堆自动过程记忆。
2. P0.5 做用户批准的存量清理，不做盲迁移。
3. P1 再把 dream 从“一个含糊 workspace”打磨成“raw inbox + consolidated notes”的可观察系统，先用 metadata，不急着拆物理 scope。

不推荐只给 extractor 打补丁继续写 user，也不推荐在 user 区加 tier 让 background 特权删除。那两个方案看起来小，实际是在权限模型里留下例外，后续更难维护。

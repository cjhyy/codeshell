# Mem0 / MemGPT-Letta Memory Architecture Evaluation

调研日期：2026-07-08。

结论先说：**CodeShell 应该借鉴 Mem0 论文/旧算法的“写入前更新决策层”，也应该借鉴 MemGPT/Letta 的 core vs archival 分层语义；不应该在当前阶段引入完整向量库、外部图谱或 Mem0 当前 OSS 的 ADD-only 路线。**

对 CodeShell 现有痛点来说，真正的病根不是“自动提取写进了哪个目录”，而是“提取结果在落盘前没有经过同主题召回和 add/update/delete/noop 决策”。把自动提取改进 `dream` 是必要的权限隔离和止血，但它只是把污染从 user 区移出；要根治 `codeshell-todo-verification-2026-07-XX` 这种日期戳重复，必须在保存前加一层“候选召回 -> LLM 决策 -> 再落盘”的写入决策循环。

## Sources

- Mem0 repo README：`https://github.com/mem0ai/mem0`
- Mem0 OSS docs overview：`https://docs.mem0.ai/open-source/overview`
- Mem0 migration guide, new memory algorithm：`https://docs.mem0.ai/migration/oss-v2-to-v3`
- Mem0 graph memory docs：`https://docs.mem0.ai/open-source/features/graph-memory`
- Mem0 paper：`https://arxiv.org/pdf/2504.19413`
- Mem0 current prompts/source：`https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/configs/prompts.py` and `https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/memory/main.py`
- Letta repo README：`https://github.com/letta-ai/letta`
- Letta Agent memory docs：`https://docs.letta.com/letta-agent/memory`
- Letta memory blocks docs：`https://docs.letta.com/guides/core-concepts/memory/memory-blocks`
- Letta archival memory docs：`https://docs.letta.com/guides/core-concepts/memory/archival-memory`
- Letta context hierarchy docs：`https://docs.letta.com/guides/core-concepts/memory/context-hierarchy`
- Letta compaction docs：`https://docs.letta.com/guides/core-concepts/messages/compaction`
- MemGPT paper：`https://arxiv.org/abs/2310.08560`

## 1. Mem0 架构提炼

### 1.1 两个版本要分清

Mem0 有一个容易误读的点：**论文/旧算法和当前 OSS 新算法已经不同**。

Mem0 论文描述的核心链路是：

1. 对新一轮消息做 memory extraction，得到候选事实。
2. 对每条候选事实，用 embedding 从 memory database 里取 top-k 语义相似旧记忆。
3. 把候选事实和相似旧记忆交给 LLM/tool-call 更新器。
4. LLM 选择 `ADD`、`UPDATE`、`DELETE`、`NOOP`。
5. 系统执行对应写入、覆盖、删除或跳过。

论文在 Section 2.1 明确说 update phase 会先检索 top-s semantically similar memories，再让 LLM 直接选择四类操作；实验设置里 `m=10` recent messages、`s=10` similar memories，向量库用 dense embeddings 做 similarity search。这个是本次对 CodeShell 最有价值的部分。

但 Mem0 当前 OSS 文档和 README 已经改成 v3 / new algorithm：

- migration guide 写明 extraction 是 “single-pass ADD-only”，一个 LLM call，不再返回 UPDATE/DELETE。
- add 调用从旧版 `ADD/UPDATE/DELETE` 改成只返回 `ADD`。
- 新算法的定位是“memories accumulate over time”，当信息变化时新事实和旧事实并存，靠检索排序把当前信息排上来。
- 当前 README 也写了 “Single-pass ADD-only extraction -- one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten.”

所以：**Mem0 当前 OSS 的路线并不是 CodeShell 应该照搬的路线**。CodeShell 的真实问题正是 append-only 已经导致重复堆积；再学 ADD-only 只会把堆积合理化。CodeShell 应该借鉴 Mem0 论文/旧算法里已经被 Mem0 v3 放弃的“写入决策层”，而不是借它当前的 ADD-only 存储策略。

### 1.2 ADD / UPDATE / DELETE / NOOP 决策层怎么工作

Mem0 旧算法的决策循环可以抽象成：

```text
new messages
  -> LLM extracts candidate facts
  -> for each candidate fact:
       embedding search top-k related existing memories
       LLM compares candidate + old memories
       emits operation:
         ADD    no equivalent memory exists
         UPDATE same topic/entity exists, new fact is richer or supersedes it
         DELETE new fact contradicts old memory or user explicitly revoked it
         NOOP   equivalent/irrelevant/already covered
  -> executor applies mutations
```

Mem0 的旧 prompt 仍保留在当前源码 `mem0/configs/prompts.py`，名称是 `DEFAULT_UPDATE_MEMORY_PROMPT`。它的规则是：

- ADD：新事实不在旧记忆中。
- UPDATE：新事实和旧记忆是同一事项，但更完整、更新或替代旧内容；更新时保留旧 ID。
- DELETE：新事实和旧记忆冲突，或明确要求删除。
- NONE/NOOP：新事实已存在或无需修改。

这个机制的关键不是 prompt 文案，而是**写入前先召回相似旧记忆**。没有召回，LLM 不知道该和谁比较；只靠“不要重复 existing memories”的泛泛指令，遇到日期戳/标题变体很容易失效。

### 1.3 存储角色：向量库、图谱、KV/历史库

Mem0 的存储不是单一 markdown 文件，而是多层：

- **向量库**：主 memory store。每条 memory 有文本、metadata、embedding，支持 `search(top_k)`，用于写入阶段找相似旧记忆，也用于读取阶段语义检索。当前 OSS 默认本地 Qdrant，self-hosted server 默认 Postgres + pgvector；docs overview 也列出 default embeddings 是 OpenAI `text-embedding-3-small`。

- **图谱/实体链接**：Mem0 论文的 Mem0g 用 Neo4j，把实体建成节点、关系建成边，适合多跳、时间和人物关系问题。官方 Graph Memory docs 描述的是“vectors narrow candidates, graph returns related context”；但 current migration guide 又说明外部 `graph_store` 已从新 OSS SDK 移除，改成内置 entity linking：每次 add 时提取实体，写入 `{collection}_entities` 并在 search 阶段做 entity boost。也就是说，**新 OSS 的 graph 更像实体索引/检索增强，不是外部可遍历知识图谱**。

- **KV/历史库**：Mem0 源码里有 `SQLiteManager`，保存 history 和 recent messages；memory payload 自身也以 ID + metadata 存在 vector store 中。它不是主要检索引擎，而是保存写入历史、最近消息、事件审计和 session scope。对 CodeShell 来说，最接近的等价物是 markdown frontmatter + `MEMORY.md` index + soft-delete trash。

### 1.4 语义去重机制

Mem0 论文/旧算法的语义去重是：

1. 为候选事实 embedding。
2. 从向量库按相似度取 top-k 候选旧记忆。
3. 将候选事实和旧记忆交给 LLM。
4. LLM 决定 merge/replace/delete/noop，而不是让相似度阈值直接决定覆盖。

当前 OSS v3 变成了另一个方向：

- extraction prompt 会接收 top-10 existing memories 作为 dedup/linking context。
- 对 exact duplicate 做 hash 去重。
- 通过 BM25、semantic、entity 三路检索做 search ranking。
- 不覆盖旧事实，新增事实继续累积。

对 CodeShell，值得借的不是 full stack，而是旧算法的决策循环：**“召回相似旧记忆 -> LLM 判断 add/update/delete/noop”**。

## 2. MemGPT / Letta 架构提炼

### 2.1 MemGPT 的核心思想：虚拟上下文

MemGPT 论文把 LLM context window 类比成 OS 的 main memory/RAM，把外部存储类比成 disk。核心目标不是“把所有历史塞进上下文”，而是让模型通过工具在有限 context 和外部存储之间调度信息。

论文里的分层：

- **Main context**：当前 LLM 可见的有限上下文。
- **System instructions**：只读、常驻。
- **Conversational context**：最近事件队列，满了会 truncate 或 summarize。
- **Working context / core memory**：模型可写的工作记忆 scratchpad。
- **External context**：context 外存储，需要工具调用显式取回。
- **Recall storage**：完整事件历史。
- **Archival storage**：长期事实、经验、偏好等通用外部 datastore。

### 2.2 Core memory vs archival/recall memory

Letta 当前文档把 MemGPT 的思想产品化成 memory blocks / archival memory / files / external RAG：

- **Memory blocks / core memory**：结构化块，持久存在于 agent context window 中；总是可见，不需要检索。Letta docs 说 memory blocks 是 prepended 到 prompt 的 XML-like 结构，有 `label`、`description`、`value`、`limit`，常见块是 `human` 和 `persona`。agent 可通过内置 memory tools 自主管理。

- **Archival memory**：语义可搜索的长期数据库，不能 pin 到 context window；必须用 `archival_memory_insert` / `archival_memory_search` 按需访问。适合事实、知识、信息的长期检索，容量可近似无限。

- **Recall memory**：完整消息/事件历史，用于按时间或语义找过去对话。

Letta context hierarchy docs 给出的判断原则很适合 CodeShell：小而重要的信息放进 memory blocks；大规模数据放到外部并检索。也列出了推荐规模：memory blocks 推荐小于 50k chars、少于 20 blocks；archival memory 单条约 300 tokens、数量不限。

### 2.3 自编辑机制

MemGPT/Letta 的自编辑重点是：模型不是被动等后台 extractor 写记忆，而是能通过工具主动维护自己的 core memory。

Letta 文档明确说 agent 可以 self-edit memory；memory blocks 是 read-write by default，也可设成 read-only；agent 根据 block label/description 判断怎么写。旧 V1 docs 的 context hierarchy 中列出 memory block 可用工具包括 `memory_rethink`、`memory_replace`、`memory_insert`；archival memory 用 `archival_memory_insert`、`archival_memory_search`。

这点对 CodeShell 的启发是：**不要只依赖会后自动 extractor**。用户显式要求“记住”或模型在正常任务中发现稳定规则时，应该走 permission-gated user save；后台自动产物应该先在 dream/workbench 中沉淀，经过整理/审批再进入 user/core。

### 2.4 Memory pressure / 分页

MemGPT 的 memory pressure 概念是：当 main context 接近上限，系统给模型 token limitation warning，模型可以把内容写到外部、检索外部、分页读取，避免一次 retrieval 溢出 context。

Letta 当前 docs 的 compaction 也体现了这一点：当 conversation history 太长，Letta 自动 compact older messages，默认 sliding window 保留较新消息、总结旧消息，必要时逐步增加总结比例以满足 token budget。

CodeShell 已经有 context compaction，但 memory 系统本身还没有“working set”概念：`buildInjectionIndex()` 目前把 global/project 的 user+dream index 全量注入，只有 maxAge 过滤，没有按当前问题语义召回。

## 3. CodeShell 现状证据

### 3.1 自动提取没有更新决策层

`MemoryOrchestrator.run()` 默认构造 `new MemoryManager({ projectDir })`，而 `MemoryManager` 默认 scope 是 `"user"`：`packages/core/src/services/memory-orchestrator.ts:91`、`packages/core/src/services/memory-orchestrator.ts:92`、`packages/core/src/session/memory.ts:145`、`packages/core/src/session/memory.ts:146`。

提取前的 existing list 只来自这个 manager 的 `loadAll()`：`packages/core/src/services/memory-orchestrator.ts:103`。也就是说，它只看当前 project user scope，不看 project dream、global dream，也不做语义召回。

`buildExtractionPrompt()` 的 existing memory schema 只有 `{ name, type, description }`，prompt 只是要求 “Do not duplicate existing memories”：`packages/core/src/services/extract-memories.ts:26` 到 `:36`、`packages/core/src/services/extract-memories.ts:59` 到 `:67`。这不是 add/update/delete 决策层。

`parseExtractionResponse()` 只解析数组，规范化 `scope: "global" | "project"`，然后 cap 数量；没有任何 update/delete/noop action：`packages/core/src/services/extract-memories.ts:88` 到 `:135`。

### 3.2 保存层是同名覆盖、异名 append

`MemoryManager.save()` 用 `slugify(entry.name) + ".md"` 作为文件名，同名时读 existing 并覆盖，异名时创建新文件：`packages/core/src/session/memory.ts:171` 到 `:183`、`packages/core/src/session/memory.ts:203` 到 `:211`。

这解释了为什么 `codeshell-todo-verification-2026-07-06`、`codeshell-todo-verification-2026-07-07`、`codeshell-todo-verification-2026-07-08` 这类重复会堆积：它们语义近似，但 name 不同，保存层只能 append。

当前项目真实 user memory 目录里：

- `/Users/admin/.code-shell/projects/Users-admin-Documents-个人学习-代码学习-codeshell/memory/user` 有 175 个 markdown 文件。
- 其中 29 个匹配 `codeshell-todo-verification-2026-07-*.md`。
- dream 区只有 9 个 markdown 文件。
- `MEMORY.md` 中 `:111` 到 `:135` 连续列出 `codeshell-todo-verification-2026-07-06` 到 `codeshell-todo-verification-2026-07-20` 的多条日期戳变体；以本调研日期 2026-07-08 看，其中还包含未来日期命名的重复项，进一步说明这是自动记忆污染，不是稳定事实。

### 3.3 注入是全量索引，不是语义召回

`MemoryManager.buildInjectionIndex()` 构造 global manager 和 project manager，然后 `collect()` 合并 `loadScope("user")` 与 `loadScope("dream")`：`packages/core/src/session/memory.ts:519` 到 `:538`。

之后它把 globalEntries 和 projectEntries 全部格式化成一行 index：`packages/core/src/session/memory.ts:540` 到 `:565`。这里没有 embedding、BM25、query-time ranking、semantic top-k。实际只是“全量摘要索引 + 需要时 MemoryRead”。

用 `rg` 检查 memory 相关文件，`packages/core/src/session/memory.ts`、`memory-orchestrator.ts`、`extract-memories.ts`、`tool-system/builtin/memory.ts` 中没有 `embedding/vector/semantic/bm25` 实现。

### 3.4 user / dream 权限边界是清楚的

`session/memory.ts` 文件头定义：

- `user/` 是用户拥有，LLM 只能通过 permission-gated tool call 修改。
- `dream/` 是 dream pipeline workspace，LLM 可 add/merge/delete。

见 `packages/core/src/session/memory.ts:10` 到 `:15`。

Memory tools 只暴露 `user` 和 `dream`，不暴露 `pending`：`packages/core/src/tool-system/builtin/memory.ts:22`。`MemorySave` 文案也说 user save 需要权限、dream save 自动：`packages/core/src/tool-system/builtin/memory.ts:175` 到 `:188`。

Engine 直接 allow dream scope 的 `MemorySave` / `MemoryDelete`，user scope 走默认 ask：`packages/core/src/engine/engine.ts:2978` 到 `:2994`。

Dream consolidation 也硬拒非 dream 写入：`packages/core/src/services/dream-consolidation.ts:183` 到 `:194`。

### 3.5 现有 P0 方案已经接近 MemGPT 分层，但缺 Mem0 写入决策

现有相关文档已经提出“自动提取进 dream，user 保持 curated”：

- `docs/todo/memory-redesign-eval.md:3` 到 `:5`：方向正确，但不能只改路由。
- `docs/todo/memory-redesign-p0-plan.md:7` 到 `:12`：自动 extractor 写 project/global dream，existing context 包含 user/dream/global dream。
- `docs/archive/todo/plan-todo-batch-2026-07.md:168` 到 `:183`：user/dream 不对称和自动提取写 user 的问题已有记录。

这个方向和 MemGPT/Letta 的分层非常一致；但它仍缺 Mem0 旧算法里最关键的写入决策层。

## 4. 对照表

| 机制 | Mem0 / MemGPT 怎么做 | CodeShell 现状 | 是否值得借鉴 | 落地难度 |
|---|---|---|---|---|
| 写入前相似记忆召回 | Mem0 论文：每条候选事实先向量召回 top-s 相似旧记忆，再交给 LLM/tool-call 判断操作 | extractor 只读当前 project user 的 `loadAll()`，没有语义召回，见 `memory-orchestrator.ts:103` | **强烈值得**。这是根治日期戳重复的核心 | M。无需先上向量，可用文件式候选召回 + LLM 比对 |
| ADD / UPDATE / DELETE / NOOP | Mem0 旧算法由 LLM 在候选事实和相似旧记忆之间决策 | `parseExtractionResponse()` 只产出新 entry，没有 action，见 `extract-memories.ts:88` 到 `:135` | **强烈值得**，但应限制自动权限 | M。先只允许自动修改 dream；对 user 只生成建议或 NOOP |
| ADD-only 累积 | Mem0 当前 OSS v3：single-pass ADD-only，靠检索排序处理新旧事实 | CodeShell 现在事实上的 project user append-only 已经失败 | **不值得照搬** | S，但方向错误 |
| exact hash dedup | Mem0 v3 对 exact duplicate 做 MD5 去重 | CodeShell 同名覆盖，异名近似重复无法处理 | 可借一小部分 | S。可加 normalized content hash，但只能兜 exact/near-exact |
| 向量库 | Mem0 用 vector store 做主检索和写入候选召回 | CodeShell 无向量库，markdown 文件 + index | **暂不引入**。规模小，透明性优先 | L。新增依赖、索引同步、迁移和隐性状态 |
| BM25 / hybrid search | Mem0 v3 search 融合 semantic、BM25、entity boost | CodeShell 注入全量 index | 当前不做 | M/L。除非 memory 数量明显超过 prompt 可控范围 |
| 图谱 / entity linking | Mem0g 用实体节点/关系边；当前 OSS 改为 entity collection boost | CodeShell 无图谱 | 不做 | L。CodeShell 记忆主要是工程决策/偏好，不需要多跳图谱 |
| SQLite/history/KV | Mem0 用 SQLite 管 history/recent messages；vector payload 有 ID/metadata | CodeShell frontmatter 管 metadata，trash 软删 | 不需要单独引入 KV | M。除非要审计所有 memory update history |
| core memory 常驻 | MemGPT/Letta memory blocks 总是在 context 中，模型可 self-edit | CodeShell user/dream 只注入摘要 index，不注入全文 | 语义值得借，不必完全照搬 | S/M。先定义 `user = curated core index`，pinned user 可优先 |
| archival/recall memory | MemGPT external context：recall 保存完整事件，archival 长期事实按需检索 | CodeShell dream 像 workspace/archival，但也被全量 index 注入 | **值得借**。`dream` 应明确是 archival/workbench | S。主要是语义、prompt、UI 文案和后续召回 |
| memory pressure / paging | MemGPT 在 context 压力下 evict/page/search；Letta 自动 compaction | CodeShell memory index 目前全量注入，无 query-time working set | 中期值得，不是当前 P0 | M/L。先 cap/sort index，再考虑检索 |
| 模型自编辑 core | Letta agent 用 memory tools 更新 memory blocks | CodeShell MemorySave user 已 permission-gated，dream 自动 | 已有基础，应保留 | S。重点是把自动 extractor 和显式 user save 分清 |
| 后台 dreaming | Letta sleep-time/dream subagents review recent conversations and write lessons | CodeShell 有 auto-dream consolidation，且 dream write 自动 | 已经在做，值得继续 | M。需补 backlog、global dream、origin/stage 可见性 |

## 5. 独立建议

### 5.1 要不要引入“记忆更新决策层”？

**要，而且这是优先级最高的架构改动。**

理由：

1. 当前重复不是“提取 prompt 不够严”的单点问题，而是保存层没有语义 identity。`MemoryManager.save()` 只能同名覆盖，日期戳变体必然 append。
2. “提取进 dream + 去重上下文”只能降低 user 污染和部分重复，但它仍然依赖 extractor 在一个 prompt 里自行决定不提取。真实 evidence 已经说明“Do not duplicate existing memories”不够。
3. Mem0 论文/旧算法的关键 insight 正好对应这里：**不要无脑 append；先找相似旧记忆，再让 LLM 做 add/update/delete/noop**。

这比“单纯提取进 dream + 去重上下文”更根治。两者关系应该是：

- `extract -> dream`：解决权限和隔离，让自动产物不直接污染 user/core。
- `similar recall -> update decision`：解决写入正确性，让 dream 也不会变成新的重复堆。
- `dream consolidation`：解决后处理和压缩，把 raw/重复/完成态整理成少量高质量条目。

也就是说，P0 的 “extract to dream” 仍应先做，但不应被视为最终解。我的建议是：**P0 可以先按现有 plan 止血；P0.5 必须加写入决策层。若本轮目标就是根治日期戳重复，应该把轻量决策层并入 P0。**

### 5.2 要不要引入向量/embedding？

**现在不要。**

CodeShell 的约束和 Mem0 不同：

- CodeShell 记忆规模小，当前项目 175 个 user 文件、9 个 dream 文件；即使全量候选给 LLM，也还在可控范围，尤其保存前只需要比对 name/description/content excerpt。
- 文件式 markdown、可直接检查、可 git/手工恢复，是 CodeShell 当前设计的重要优点。
- 引入 embedding 会带来索引持久化、模型配置、跨 provider、离线可用性、隐性状态不同步、测试夹具等成本。
- Mem0 的向量库是产品级多用户长期 memory platform 的合理选择；CodeShell 不是那个规模。

建议的轻量候选召回：

```text
candidate extracted memory
  -> collect project user + project dream + global dream summaries
  -> candidate selector:
       exact slug/name match
       normalized title/prefix match
       same type
       token/Jaccard overlap on name + description
       recent auto entries
       if total <= 150, include all summaries
  -> include top N summaries + content excerpts where necessary
  -> LLM decides ADD/UPDATE/DELETE/NOOP
```

如果未来出现以下信号，再考虑 embedding：

- 单项目 memory 超过 500-1000 条，prompt candidate cap 明显丢召回。
- 全量/lexical 候选导致 dedup 漏判频繁。
- 需要跨项目全局检索，而不是只维护当前项目 memory。

即使将来加 embedding，也应该作为可重建的缓存索引，而不是取代 markdown source of truth。

### 5.3 MemGPT 的 core/archival 分层是否应该重新诠释 user/dream？

**应该。**

建议语义：

- `user` = **core / curated memory**：高置信、长期、用户认可或显式保存；修改必须 permission-gated；目标是少而准。它不一定全文常驻，但应该总是在 index 中优先出现，pinned entries 可作为更接近 Letta memory block 的“真 core”。

- `dream` = **archival/workbench memory**：自动提取、低/中置信、过程观察、后台合并产物、候选 lessons；LLM 可自动 merge/delete；目标是给后台整理和按需读取，而不是永久堆积。

- `pending` = legacy approval queue / future proposals：不要再作为 extractor 的正常写入目标。未来可以承载“promote to user”或“cleanup user”建议，但不要混淆成 memory 本体。

这比现在的“user=用户拥有 + legacy auto-extracted entries，dream=auto-consolidated workspace”更清楚，也和 Letta 的 `system/` 常驻核心 vs 其他文件/archival 按需读取更接近。

### 5.4 借鉴后的 CodeShell 记忆架构草案

推荐架构：

```text
Turn transcript
  -> Extractor
       outputs candidate facts only; max 2; no direct disk write

  -> Candidate recall
       loads summaries from:
         project/user
         project/dream
         global/dream
         optionally global/user for conflict awareness
       selects lexical/recent/type candidates; no embedding initially

  -> Memory update decision LLM
       input: candidate + selected existing memories (+ excerpts)
       output:
         action: ADD | UPDATE | DELETE | NOOP | PROPOSE_USER_CHANGE
         target: { location, scope, name }
         replacement: { name, description, content } when needed
         reason, confidence

  -> Executor
       ADD/UPDATE/DELETE in dream: apply automatically
       duplicate of user: NOOP or write cleanup/promotion proposal, never auto-delete user
       global durable candidate: write global dream first, not global user

  -> Dream consolidation
       periodically merges raw dream entries, deletes completed-state clutter,
       creates small consolidated dream notes,
       optionally proposes promotion/cleanup for user scope

  -> User/core promotion
       only explicit user action or permission-gated MemorySave to user
```

关键执行规则：

- 自动 extractor **永不直接写 user**。
- 自动 extractor **也不直接 append dream**，必须先过 update decision。
- dream 中同主题自动条目默认 UPDATE/NOOP，不允许日期戳 append。
- 对 user scope 的冲突，不自动 update/delete；后台只能提出建议，或在当前会话通过 permission-gated MemorySave/MemoryDelete 让用户批准。
- markdown 文件仍是 source of truth；decision 的 reason 可写入 log，不必先持久化完整 history。

### 5.5 与已有 P0 方案的关系

不是替代，而是叠加。

已有 P0 方案仍应先做：

- 自动提取从 user/pending 改写 dream。
- extraction existing context 包含 project user + project dream + global dream。
- 修 global dream consolidation 加载。
- 调整 dream 顺序，避免刚写入就被同 pipeline 清掉。
- 保留 pending legacy。

但 P0 方案只完成“分层和隔离”，不完成“写入正确性”。因此我建议：

1. **P0 保持现计划**：这是必要止血，能立即阻止 user 区继续污染。
2. **P0.5 加 lightweight update decision**：这是根治重复的核心，范围集中在 extractor 保存前。
3. **P1 做 proposal UI 和 dream 背压**：包括 user cleanup suggestions、promotion suggestions、dream backlog cap、origin/stage 可见性。
4. **P2 再评估 semantic retrieval/embedding**：只有数据规模证明需要时再做。

如果只能选一个对“日期戳重复”最有效的改动，我选 **写入更新决策层**，不是“提取进 dream”。如果只能选一个对“权限语义”最有效的改动，我选 **提取进 dream**。这两个问题不同，应该都做。

## 6. 推荐落地点

### 6.1 新增一个保存前 decision step

落点：`packages/core/src/services/memory-orchestrator.ts` 中 `parseExtractionResponse()` 之后、`target.save()` 之前。

当前保存循环在 `packages/core/src/services/memory-orchestrator.ts:118` 到 `:148`。这里应改成：

```text
entries = parseExtractionResponse(...)
for each entry:
  candidates = recallSimilarMemoryCandidates(entry)
  decision = decideMemoryUpdate(entry, candidates)
  applyMemoryDecision(decision)
```

### 6.2 prompt/schema 建议

决策输出可以是 JSON：

```json
{
  "action": "ADD | UPDATE | DELETE | NOOP",
  "target": {
    "location": "project | global",
    "scope": "dream",
    "name": "existing-or-new-name"
  },
  "memory": {
    "name": "string",
    "description": "string",
    "content": "markdown",
    "type": "user | feedback | project | reference"
  },
  "reason": "short explanation",
  "confidence": "high | medium | low"
}
```

第一版建议只自动 apply `scope:"dream"`。如果 LLM 想改 user，返回 `NOOP` 或 `PROPOSE_USER_CHANGE`，进入后续 proposal 机制；不要让后台 LLM 自动删 user。

### 6.3 candidate recall 不需要新数据库

第一版候选来源：

- `new MemoryManager({ projectDir, scope: "user" }).loadAll()`
- `new MemoryManager({ projectDir, scope: "dream" }).loadAll()`
- `new MemoryManager({ scope: "dream" }).loadAll()` for global dream
- 可选 global user 只作为 conflict awareness，不自动修改

排序：

1. same slug / same normalized prefix
2. same type
3. high token overlap in name + description
4. `origin:"auto"` first when target is dream dedup
5. recent first
6. pinned user first for read-only awareness

候选内容：

- 默认给 name/type/description/location/scope/origin。
- 对 top 5 再给 content excerpt，例如前 800 chars。
- 总候选 cap 20-40；总 prompt cap 可控。

### 6.4 不要立即做的事

- 不要引入 Neo4j / graph store。
- 不要引入 Qdrant / pgvector 作为 P0/P0.5 依赖。
- 不要把 `user` 变成后台可删。
- 不要把 `pending` 复用成任意 JSON action 垃圾桶；proposal 需要时应有独立结构。
- 不要学 Mem0 当前 OSS 的 ADD-only 累积策略。

## 7. 最终判断

CodeShell 的设计优势是透明、文件式、用户可检查。Mem0 的完整生产栈不适合照搬；MemGPT/Letta 的产品形态也不适合逐字移植。但两者各有一个非常适合 CodeShell 的机制：

- 从 Mem0 借：**写入前更新决策层**。这是当前重复污染的直接解法。
- 从 MemGPT/Letta 借：**core vs archival 分层**。这能把 `user`/`dream` 的语义讲清楚，并约束权限。

我的明确建议：

1. `user` 只保留 curated/core memory。
2. `dream` 承接自动提取和后台整理，是 archival/workbench。
3. extractor 结果必须先召回候选并做 add/update/delete/noop 决策，再写 dream。
4. 暂不引入 embedding/vector DB；用 markdown summaries + lexical candidate recall + LLM 比对足够。
5. 现有 P0 仍先做，但 P0 后必须马上补 decision layer，否则 dream 会成为新的重复堆。

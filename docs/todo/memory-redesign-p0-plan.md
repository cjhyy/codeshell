# Memory Redesign P0 Implementation Plan

本文档只覆盖 P0：把自动提取器写出的记忆从 `user` 区改到 `dream` 区，并同时补齐去重上下文、global dream 加载、同 pipeline fresh-entry 保护、pending legacy 保留。P0 不做存量清理 UI、dream raw/consolidated 分层、rate-limit gate。

依据：`docs/todo/memory-redesign-eval.md:3` 到 `:5` 已确认方向可行但不能只改路由；`docs/todo/memory-redesign-eval.md:224` 到 `:230` 明确 P0 内容；`docs/archive/todo/plan-todo-batch-2026-07.md:179` 到 `:182` 是记忆项的原始现状记录。下面所有行号均为当前代码的预修改锚点。

## P0 决策

- 自动 extractor 的 `scope:"project"` 结果写 project dream，`scope:"global"` 结果写 global dream；两者都保留 `origin:"auto"`。
- 去重上下文必须在 extraction prompt 中包含 project user、project dream、global dream 的摘要，并加硬 cap，避免把重复从 user 搬到 dream。
- 选择 fresh-entry 保护方案：把 due 的 auto-dream 移到本轮 extraction prompt/save 之前执行，而不是给新 entry 加 grace window。理由是改动集中，不引入时间窗口字段，也能保证本轮新写入的 dream entry 至少经历下一轮注入机会。
- pending API/UI 保留给旧队列，不再接收 extractor 新写入；用户可继续 approve/demote/reject 历史 pending。

## 改动清单

### `packages/core/src/services/memory-orchestrator.ts`

函数：`MemoryOrchestrator.run()`。

现状证据：
- `:91` 到 `:92` 默认构造未指定 scope 的 `MemoryManager`，因此指向 project user。
- `:103` 到 `:106` extraction existing list 只来自 `mm.loadAll()`。
- `:118` 到 `:128` global 结果写 `scope:"pending"`，project 结果写 `mm`。
- `:151` 到 `:155` telemetry 仍叫 `pendingGlobalCount`。
- `:214` 到 `:237` 当前顺序是 extraction/save 后才 `recordSession()` 和 auto-dream。

改法：

1. 把顶部 `mm` 改名为明确的 project user manager，不改变 recall TTL 对 user 区的语义。

```ts
const projectUserMm =
  this.options.memoryManager ??
  new MemoryManager({ projectDir: this.options.projectDir, scope: "user" });
const projectDreamMm = new MemoryManager({
  projectDir: this.options.projectDir,
  scope: "dream",
});
const globalDreamMm = this.options.projectDir
  ? new MemoryManager({ scope: "dream" })
  : projectDreamMm;
```

2. 抽出 `runAutoDreamIfDue()` 局部 helper，把原 `:217` 到 `:248` 的 auto-dream 逻辑搬到 extraction 前。新顺序应是：

```ts
let dreamTriggered = false;

recordSession();
await runAutoDreamIfDue(); // due dream runs before this run's extracted entries are saved

// then run extraction, session summary, TTL sweep
```

helper 内加载 `projectUserMm.loadScope("user")`、`projectDreamMm.loadScope("dream")`；仅当 `this.options.projectDir` 存在时再加载 `globalDreamMm.loadScope("dream")` 作为第三段，避免无项目目录时把同一个 global dream 重复传入 prompt。`runDream` 的签名先不改；仍传 `buildDreamSystemPrompt()` 和 `buildDreamUserPrompt(...)`，但真正的 global dream bug 在 `runDreamConsolidation()` 内修。

3. 把 `existing = mm.loadAll()` 改为摘要集合 helper，例如：

```ts
const existing = collectExtractionExistingMemories({
  projectUserMm,
  projectDreamMm,
  globalDreamMm,
  includeGlobalDream: !!this.options.projectDir,
});
```

helper 放在本文件底部即可，返回 `buildExtractionPrompt()` 需要的摘要。建议 cap 常量：

```ts
const MAX_EXISTING_FOR_EXTRACTION_PROMPT = 120;
```

排序建议：pinned first、recent first，然后 slice cap。telemetry 同时记录 `existingCount` 和 `existingTotalBeforeCap`。

4. 保存路由从 pending/user 改为 dream：

```ts
let globalDreamCount = 0;
for (const entry of entries) {
  const isGlobal = entry.scope === "global";
  const target = isGlobal ? globalDreamMm : projectDreamMm;
  target.save({
    type: entry.type,
    name: entry.name,
    description: redactSecrets(entry.description),
    content: redactSecrets(entry.content),
    origin: "auto",
    ...(isGlobal && this.options.projectDir
      ? { originProject: this.options.projectDir }
      : {}),
  });
  if (isGlobal) globalDreamCount++;
}
```

删除 `pendingMm` 变量和“审批门”注释；`originProject` 可保留为 global dream 的来源项目元数据，但注释要改成 provenance，不再说 demote。

5. telemetry 改名：

```ts
logger.info("memory.extraction_done", {
  sessionId,
  extracted,
  globalDreamCount,
  projectDreamCount: extracted - globalDreamCount,
  targetScope: "dream",
  // timings...
});
```

不要再输出 `pendingGlobalCount`。

6. TTL sweep 仍只扫 user 区。`projectUserMm.pruneByRecall(ttl)` 和 `new MemoryManager({ scope:"user" }).pruneByRecall(ttl)` 保持当前行为；P0 不让 background 自动删 user。

### `packages/core/src/services/extract-memories.ts`

函数：`buildExtractionPrompt()`。

现状证据：
- `:26` 到 `:29` 参数只有 `name/type/description`。
- `:34` 到 `:36` Existing Memories 输出没有 location/scope 来源。
- `:63` 要求不要重复 existing memories，因此 P0 的去重效果依赖这里能看到 dream。

改法：增加一个 prompt-only 摘要类型，不改 `ExtractedMemory.scope` 语义。

```ts
export interface ExistingMemorySummary {
  name: string;
  type: string;
  description: string;
  location?: "project" | "global";
  memoryScope?: "user" | "dream";
  origin?: "auto" | "manual";
  pinned?: boolean;
  updatedAt?: number;
}

export function buildExtractionPrompt(
  transcript: Array<{ role: string; content: string }>,
  existingMemories: ExistingMemorySummary[],
): string {
  const existingList = existingMemories.length > 0
    ? existingMemories
        .map((m) => {
          const source = m.location && m.memoryScope ? `${m.location}/${m.memoryScope}` : "memory";
          const origin = m.origin ? `/${m.origin}` : "";
          return `  - [${source}/${m.type}${origin}] ${m.name}: ${m.description}`;
        })
        .join("\n")
    : "  (none)";
  // rest unchanged
}
```

`parseExtractionResponse()` at `:88` 到 `:135` 不改；它仍只决定 storage location：`global` 或 `project`。

### `packages/core/src/services/dream-consolidation.ts`

函数：`runDreamConsolidation()`。

现状证据：
- `:88` 到 `:95` 只加载 `new MemoryManager({ projectDir })` 的 user/dream，并只把两组传给 `buildDreamUserPrompt()`。
- `docs/todo/memory-redesign-eval.md:177` 到 `:182` 已确认这是 global dream 加载 bug，推荐让 consolidation 自己加载。

改法：

```ts
const mm = new MemoryManager({ projectDir });
const userMems = mm.loadScope("user");
const dreamMems = mm.loadScope("dream");
const globalDreamMems = projectDir
  ? new MemoryManager({ scope: "dream" }).loadScope("dream")
  : [];

const systemPrompt = buildDreamSystemPrompt();
const userPrompt = buildDreamUserPrompt(userMems, dreamMems, globalDreamMems);
```

不改 `Engine.runDreamLoop()` 去消费 orchestrator 传入的 prompt。`packages/core/src/engine/engine.ts:2537` 到 `:2556` 继续只把 `llmClient/toolRegistry/toolContext/projectDir/sessionId` 交给 `runDreamConsolidation()`；注释 `:2546` 到 `:2549` 可同步改成“prompts are rebuilt in consolidation because it owns memory loading”。

### `packages/core/src/services/auto-dream.ts`

函数：`buildDreamUserPrompt()`。

现状证据：
- `:133` 到 `:137` 已有第三个 `globalMemories` 参数。
- `:150` 文案叫 `Global memories`，但这里实际应为 global dream workspace。

改法：签名不必变，只把 global section label 改成更精确：

```ts
sections.push(
  `Global dream-scope memories (YOUR WORKSPACE, location:'global', ${globalMemories.length} entries):`,
);
```

P0 不在这里做 raw/consolidated 分层，也不新增 `stage` frontmatter。

### `packages/core/src/session/memory.ts`

函数：`MemoryManager.buildInjectionIndex()`。

现状证据：
- `:533` 到 `:538` 的 `collect()` 已合并 `loadScope("user")` 和 `loadScope("dream")`。
- `:540` 到 `:556` 已分别输出 global/project index。

P0 不需要改注入实现，但要补回归测试证明 dream entries 被注入索引包含。不要改 pending API：`MemoryScope` at `:35` 到 `:44`、`approvePending/demotePending/movePending` at `:374` 到 `:419` 均保留。

### pending legacy 文案和不改范围

功能不动：
- `packages/core/src/session/memory.ts:35` 到 `:44` 的 `"pending"` scope 保留。
- `packages/core/src/session/memory.ts:374` 到 `:419` 的 pending approve/demote/reject 保留。
- `packages/desktop/src/main/memory-service.ts:128` 到 `:165` 的 pending wrapper 保留。
- `packages/desktop/src/main/index.ts:2908` 到 `:2920` 的 pending IPC 保留。
- `packages/desktop/src/preload/index.ts:514` 到 `:521` 和 `packages/desktop/src/preload/types.d.ts:765` 到 `:775` 保留。

要改文案：
- `packages/desktop/src/renderer/i18n/ns/settings.ts:368` 到 `:370`、`:1123` 到 `:1125`：`autoExtractTitle` 从“存入 User scope”改成“存入 Dream scope”。
- `packages/desktop/src/renderer/i18n/ns/settings.ts:389` 到 `:392`、`:1144` 到 `:1147`：pending header/actions 标为 legacy，例如“旧版待审批的全局记忆”；说明新自动提取不再进入 pending。
- `packages/desktop/src/renderer/settings/MemorySection.tsx:161` 到 `:163`、`:509` 到 `:510`：注释从“extractor flagged as global wait here”改成“legacy pending global candidates from older extractor versions”。

可顺手改但不是功能要求：
- `packages/desktop/src/renderer/i18n/ns/settings.ts:359`、`:1114` 的 dream help 可从“Auto-organized workspace”改成“Auto-extracted and auto-organized workspace”，避免用户看到 raw auto entries 时误解。

## 执行顺序

1. 先修 global dream 加载 bug。
   - 改 `dream-consolidation.ts`，新增测试捕获初始 user prompt 包含 global dream entry。
   - 独立可测，不依赖 extractor 路由。

2. 扩展 extraction existing list。
   - 改 `extract-memories.ts` 的 existing summary 类型/格式。
   - 在 `memory-orchestrator.ts` 加 `collectExtractionExistingMemories()` 和 cap。
   - 独立可测：仍可先不改保存路由，只断言 extraction prompt 含 project user、project dream、global dream。

3. 调整 auto-dream 顺序，提供 fresh-entry 保护。
   - 在 `MemoryOrchestrator.run()` 开头 record session，并在 extraction LLM/persist 前执行 due dream。
   - 独立可测：构造 due cadence，`runDream` 捕获 prompt/当前 dream 列表，不应看到本轮即将保存的 extraction entry；run 结束后该 entry 存在于 dream。

4. 改 extractor 保存路由和 telemetry。
   - project/global 都写 dream；删除 pending save path；保留 `origin:"auto"`。
   - 更新 `memory-scope-routing.test.ts` 的断言和 telemetry 字段。

5. 改 pending/autoExtract 文案。
   - 只改 UI 文案和注释，不删 API，不删测试。
   - 独立可测：既有 pending lifecycle tests 仍应通过。

6. 最后跑目标测试，再视时间跑 `bun test`。

## 测试计划

更新既有测试：
- `packages/core/src/services/memory-scope-routing.test.ts:27` 到 `:78`
  - 用例改名为 `routes scope:global to global dream and scope:project to project dream`.
  - 断言 `global-lesson` 在 `new MemoryManager({ baseDir: base, scope:"dream" })`。
  - 断言 `project-fact` 在 `new MemoryManager({ baseDir: base, projectDir, scope:"dream" })`。
  - 断言 pending、global user、project user 都没有这两个自动提取新条目。
  - telemetry 断言改为 `globalDreamCount === 1`、`projectDreamCount === 1`、不存在 `pendingGlobalCount`。

- `packages/core/src/services/memory-orchestrator.test.ts:16` 到 `:53`
  - telemetry 用例增加 `targetScope:"dream"`、`globalDreamCount/projectDreamCount`。
  - 由于保存不再走 injected fake `memoryManager.save()`，涉及 save 计数的用例要改成 isolated `CODE_SHELL_HOME` + real `MemoryManager`，或把 fake 扩展成工厂注入。优先使用真实临时目录，避免为测试引入生产 factory。

- `packages/core/src/services/memory-orchestrator.test.ts:149` 到 `:222`
  - `autoExtract:false` 仍断言不调用 extraction LLM、不保存新 memory。
  - “default-on” 用例改为检查 dream store 增加，而不是 fake `save()` 次数。

新增测试：
- `packages/core/src/services/memory-orchestrator.test.ts`
  - `includes project user, project dream, and global dream in extraction existing context`
    - seed 三个位置，捕获 extraction `userMsg`，断言三者 name 都在 `## Existing Memories`。
  - `caps extraction existing context before building the prompt`
    - seed 超过 cap 的 dream entries，断言 prompt 中条数不超过 `MAX_EXISTING_FOR_EXTRACTION_PROMPT`；若常量不导出，则断言 telemetry `existingTotalBeforeCap > existingCount`。
  - `runs due dream before persisting this run's extraction`
    - seed auto-dream state 到 due，`runDream` 捕获 prompt 或执行时 dream names；extraction LLM 返回 `fresh-auto`; 断言 `runDream` 当下看不到 `fresh-auto`，run 后 project dream 看得到。

- `packages/core/src/services/dream-consolidation.test.ts`（新建）
  - `includes global dream memories in the initial project consolidation prompt`
    - 用 `CODE_SHELL_HOME` 临时目录 seed project dream + global dream。
    - 用 `ToolRegistry({ builtinTools:["MemoryList","MemoryRead","MemorySave","MemoryDelete"] })` 和 fake `llmClient.createMessage()` 捕获 `messages[0].content`，返回 `{ text:"done", toolCalls:[] }`。
    - 断言 prompt 包含 global dream entry。

- `packages/core/src/session/memory.lifecycle.test.ts:194` describe block
  - `buildInjectionIndex includes dream entries from global and project stores`
    - seed global dream 和 project dream，断言 index 包含二者，并仍不包含 body。

- `packages/core/src/services/extract-memories.test.ts:81` describe block
  - `existing memory list labels location and memory scope`
    - 调 `buildExtractionPrompt()`，传入 `{ location:"global", memoryScope:"dream", origin:"auto" }`，断言 prompt 含 `global/dream` 和 entry name。

保留测试：
- `packages/core/src/session/memory.lifecycle.test.ts:136` 到 `:192` 的 pending 三态测试继续保留，证明 legacy pending 仍可处理。
- `tests/memory-service.test.ts:84` 到 `:105` 继续证明 dream scope 与 user scope 分离。

建议命令：

```bash
bun test packages/core/src/services/memory-scope-routing.test.ts
bun test packages/core/src/services/memory-orchestrator.test.ts
bun test packages/core/src/services/dream-consolidation.test.ts
bun test packages/core/src/services/extract-memories.test.ts
bun test packages/core/src/session/memory.lifecycle.test.ts
bun test tests/memory-service.test.ts
```

最后可跑：

```bash
bun test
```

`bun run typecheck` 在本仓库有已知存量错误，见 `CODESHELL.md`，P0 可跑但不把存量错误当作本任务 blocker。

## 风险与回滚

- dream 区短期增长：P0 先止住 user 污染，不解决 dream 背压。现有 auto-dream cadence 是 `packages/core/src/services/auto-dream.ts:21` 到 `:24` 的 5 sessions/24h，写预算在 `dream-consolidation.ts:34` 到 `:35`；增长问题留到 P1。
- 产品影响：global 自动候选不再进入 pending，用户少了“批准升 global user”的自动发现入口。P0 通过 legacy 文案说明旧 pending 仍可处理；后续 promotion suggestions 属于 P1。
- 误删风险：P0 选择 dream-before-extraction，避免同 pipeline 删除 fresh entries。dream 删除仍只允许 `scope:"dream"`，`dream-consolidation.ts:183` 到 `:191` 会拒绝 user 写；Engine 也 allow dream save/delete only at `engine.ts:2978` 到 `:2993`。
- 回滚：无需数据迁移。若上线后发现问题，可先用 settings `memories.autoExtract=false` 暂停 extractor（schema 在 `packages/core/src/settings/schema.ts:371` 到 `:374`，UI 开关在 `MemorySection.tsx:342` 到 `:362`），再 revert P0 单个 commit。已经写入的 dream entries 仍是普通 dream 记忆，可用 UI 或 dream pass 清理。

## DoD

P0 完成必须同时满足：

- 自动 extraction 的 project 结果只进入 project dream，不进入 project user。
- 自动 extraction 的 global 结果只进入 global dream，不进入 pending 或 global user。
- 自动保存仍写 `origin:"auto"`，并继续 secret redaction。
- extraction prompt 的 existing list 包含 project user、project dream、global dream，并有 cap/telemetry，避免 dream 重复堆。
- project dream consolidation 初始 prompt 稳定列出 global dream entries。
- due auto-dream 在本轮 extraction 保存之前运行；同一次 pipeline 看不到也删不到本轮 fresh extraction entries。
- `MemoryManager.buildInjectionIndex()` 的回归测试证明 global/project dream entries 会被下一轮 prompt index 注入。
- pending approve/demote/reject API/UI 仍能处理旧队列；用户可见文案标为 legacy。
- 目标测试通过，且没有修改 P0 范围外的数据模型或 UI。

## 不在 P0 范围

- P0.5：存量清理 UI，只做用户批准的定向软删/分组 review，不在本次实现。
- P1：dream raw/consolidated 分层、backpressure/注入 cap 策略、structured cleanup/promotion suggestions，不在本次实现。
- P1：rate-limit/quota gate，不塞进当前同步 `shouldAutoDream()`。

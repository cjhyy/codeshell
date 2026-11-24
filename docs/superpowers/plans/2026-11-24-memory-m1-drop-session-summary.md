# 记忆流水线 M1：删除会话摘要调用、整合只数有变更的运行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台记忆流水线不再每轮生成没有读取方的会话摘要；自动整合的计数只在记忆库真的变了的时候加一。与已实现的外部会话防抖（M0）同一个 PR。

**Architecture:** 改动都在 `MemoryOrchestrator.run()` 内部。触发点、提取提示词、存储布局都不动。`services/session-memory.ts` 是公开导出，本期保留，只是不再有生产调用方。

**Tech Stack:** TypeScript，Bun test（用仓库的隔离运行器 `node scripts/run-bun-test-shard.mjs`）。

设计依据：`docs/todo/memory-segment-closure-design-20261124.md` 第 5.2 节。

---

## 文件结构

| 文件                                                                | 改动                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/core/src/services/memory-orchestrator.ts`                 | 删第 2 步（会话摘要）；`recordSession` 改为有变更才调用；结果增加 `changed` |
| `packages/core/src/services/memory-orchestrator.test.ts`            | 摘要健壮性用例换成「不再请求摘要」；新增整合计数用例                        |
| `packages/core/src/services/memory-orchestrator.custody.test.ts`    | 去掉摘要相关断言和用例                                                      |
| `packages/core/src/services/memory-storage-context.test.ts`         | 两个用例去掉摘要断言，计数种子从 4 改为 5                                   |
| `packages/core/src/engine/auxiliary-pipeline.prompt-cache.test.ts`  | 每次运行的请求数从 2 变 1                                                   |
| `packages/core/src/engine/auxiliary-pipeline.memory-output.test.ts` | 截断用例改为只针对提取                                                      |
| `packages/core/src/engine/run-finalize.ts` 等 5 处注释              | 不再提「保存会话摘要」                                                      |
| `CHANGELOG.md`                                                      | Unreleased 加一条                                                           |

不新增测试文件（desktop / core 的测试分片已到上限）。

---

### Task 1: 流水线不再请求会话摘要

**Files:**

- Modify: `packages/core/src/services/memory-orchestrator.ts`
- Test: `packages/core/src/services/memory-orchestrator.test.ts`

- [ ] **Step 1: 写失败的测试**

把 `describe("MemoryOrchestrator session-summary JSON robustness", …)` 整段换成下面这段，并在文件顶部的 `node:fs` 导入里加上 `existsSync`：

```ts
describe("MemoryOrchestrator makes no session-summary request", () => {
  it("asks the model once for a run that extracts nothing and writes no summary file", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const prompts: string[] = [];
        const orchestrator = new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          callLLM: async (_system, prompt) => {
            prompts.push(prompt);
            return "[]";
          },
        });
        const result = await orchestrator.run(
          [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
          ],
          "s-no-summary",
        );
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("memory extraction assistant");
        expect(result.changed).toBe(false);
        expect(existsSync(join(base, "session-memories"))).toBe(false);
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/services/memory-orchestrator.test.ts`
Expected: FAIL，`expect(prompts).toHaveLength(1)` 收到 2。

- [ ] **Step 3: 实现**

`memory-orchestrator.ts`：

1. 删除 `import { saveSessionMemory, buildSessionMemoryPromptSegments } from "./session-memory.js";`。
2. `MemoryOrchestratorResult` 增加字段：

```ts
/** Whether this run added, updated or deleted a memory. */
changed: boolean;
```

3. `run()` 里在 `let extracted = 0;` 下面加 `let changed = false;`；提取循环末尾 `refreshDecisionContext = memoryChanged;` 之后加 `changed ||= memoryChanged;`。
4. 删除整个 `// --------------- 2. Session summary ---------------` 的 `try/catch` 块。
5. 返回值改为 `return { extracted, changed, dreamTriggered, pruned };`。
6. 提取调用上方的注释改为：

```ts
// The transcript is sent as a stable prefix under its own cache scope,
// so the next run for this session can read this call's cached prefix.
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 新用例 PASS。

### Task 2: 整合计数只数有变更的运行

**Files:**

- Modify: `packages/core/src/services/memory-orchestrator.ts`
- Test: `packages/core/src/services/memory-orchestrator.test.ts`

- [ ] **Step 1: 写失败的测试**

文件顶部加 `import { recordSession, sessionsSinceLastDream } from "./auto-dream.js";`，文件末尾追加：

```ts
describe("MemoryOrchestrator auto-dream cadence counts only runs that changed the store", () => {
  const conversation = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  };

  it("leaves the counter alone when extraction yields nothing", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        const result = await new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          callLLM: async () => "[]",
        }).run(conversation, "s-empty");
        expect(result.changed).toBe(false);
        expect(sessionsSinceLastDream(base)).toBe(0);
      }),
    ));

  it("counts a run that added a memory", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        const result = await new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          callLLM: async () =>
            JSON.stringify([{ type: "project", name: "n", description: "d", content: "c" }]),
        }).run(conversation, "s-added");
        expect(result.changed).toBe(true);
        expect(sessionsSinceLastDream(base)).toBe(1);
      }),
    ));

  it("does not count a run with extraction turned off", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        let calls = 0;
        await new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          autoExtract: false,
          callLLM: async () => {
            calls++;
            return "[]";
          },
        }).run(conversation, "s-off");
        expect(calls).toBe(0);
        expect(sessionsSinceLastDream(base)).toBe(0);
      }),
    ));

  it("still runs a consolidation that was already due", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        const manager = new MemoryManager({ baseDir: base });
        manager.save({ type: "project", name: "kept", description: "d", content: "c" });
        for (let index = 0; index < 5; index++) recordSession(base);
        let dreams = 0;
        const result = await new MemoryOrchestrator({
          memoryManager: manager,
          callLLM: async () => "[]",
          runDream: async () => {
            dreams++;
            return true;
          },
        }).run(conversation, "s-due");
        expect(dreams).toBe(1);
        expect(result.dreamTriggered).toBe(true);
        expect(sessionsSinceLastDream(base)).toBe(0);
      }),
    ));
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/services/memory-orchestrator.test.ts`
Expected: 前三条里 `sessionsSinceLastDream(base)` 收到 1（现在每次运行都加一）；「counts a run that added a memory」已经是 1，本来就过。

- [ ] **Step 3: 实现**

把第 3 步改成：

```ts
// --------------- 2. Record a store change for auto-dream tracking ---------------
// The cadence counts runs that changed the store, not runs: an unchanged
// store has nothing new to consolidate.
this.assertCurrent();
if (changed) recordSession(storage.baseDir);
```

后面两步的编号注释顺延为 3（Auto-dream consolidation）和 4（Recall-based TTL sweep）。`run()` 的文档注释改为：

```ts
/**
 * Run the end-of-session memory pipeline.
 *
 *  1. Extract durable memories from the transcript (extract-memories)
 *  2. Count the run toward auto-dream when it changed the store
 *  3. Conditionally trigger auto-dream consolidation
 *  4. Recall-TTL sweep
 */
```

`autoExtract` 选项的注释改为：

```ts
/**
 * From settings.memories.autoExtract. `false` skips step 1 (LLM memory
 * extraction) entirely — the user-curated store stops accumulating
 * extractor noise. Such a run changes nothing, so it does not count toward
 * the auto-dream cadence; a consolidation that is already due still runs.
 * Absent/true = extract (default behavior).
 */
```

文件头注释里的 `Runs memory extraction and session summarisation via lightweight LLM calls` 改为 `Runs memory extraction via a lightweight LLM call`，`ties extract-memories, session-memory, and auto-dream` 改为 `ties extract-memories and auto-dream`。

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 整个文件 PASS。

### Task 3: 更新依赖摘要步骤的现有测试

**Files:**

- Modify: `packages/core/src/services/memory-orchestrator.custody.test.ts`
- Modify: `packages/core/src/services/memory-storage-context.test.ts`
- Modify: `packages/core/src/engine/auxiliary-pipeline.prompt-cache.test.ts`
- Modify: `packages/core/src/engine/auxiliary-pipeline.memory-output.test.ts`

- [ ] **Step 1: `memory-orchestrator.custody.test.ts`**

- 删除 `session-memory.js` 的导入；`const summary = {…}` 换成 `const sessionId = "guarded-session";`，所有 `summary.sessionId` 换成 `sessionId`。
- 删除所有 `saveSessionMemory(summary, baseDir);` 和 `expect(loadSessionMemory(…))…` 行。
- 用例「a late valid extraction cannot persist facts, replace a summary, or advance dream state」改名为「a late valid extraction cannot persist facts or advance dream state」。
- 删除整个 `test.each([false, true])("a late session-summary outcome cannot replace prior data …")`。

- [ ] **Step 2: `memory-storage-context.test.ts`**

- 删除 `loadSessionMemory` 导入。
- 「summary, dream cadence, callback and TTL share explicit storage」改名为「dream cadence, callback and TTL share explicit storage」；种子 `sessionsSinceLastDream: baseDir === custom ? 4 : 99` 改为 `? 5 : 99`（这次运行不提取，不再加一，整合必须本来就到期）；`callLLM` 改为 `async () => { throw new Error("No auxiliary model request expected"); }`；删除 `loadSessionMemory(…)` 和 `session-memories` 两条断言；解构里去掉不再使用的 `home`。
- 「default routing retains env memories/cadence and HOME session summaries」改名为「default routing retains env memories and cadence」；`callLLM` 改为 `async () => JSON.stringify([candidate])`；删除两条 `loadSessionMemory` 断言；解构里去掉 `home`。

- [ ] **Step 3: `auxiliary-pipeline.prompt-cache.test.ts`**

- `setup()` 里客户端的应答去掉 `session summariser` 分支：

```ts
        text: system.includes("write decision")
          ? JSON.stringify({ action: "NOOP" })
          : JSON.stringify(extracted),
```

- 第一个用例改名为「extraction sends the transcript as a stable prefix under the session-transcript scope」，只断言一次调用：

```ts
expect(fixture.calls).toHaveLength(1);
const extraction = fixture.calls[0]!;
expect(extraction.systemPrompt).toBe(SESSION_TRANSCRIPT_SYSTEM_PROMPT);
expect(extraction.messages.length).toBeGreaterThan(2);
expect(extraction.messages.every((message) => message.role === "user")).toBe(true);
// The breakpoint lands on the last stable message; only the final
// message, the task, is outside the settled prefix.
expect(extraction.promptCache?.stablePrefixMessageCount).toBe(extraction.messages.length - 1);
expect(extraction.promptCache?.scopeId).toBe(sharedScope);
expect(extraction.promptCache?.scopeKind).toBe("auxiliary");
// The run ended on an assistant answer, so the whole transcript is stable.
const stableCount = extraction.promptCache!.stablePrefixMessageCount!;
const stable = text(extraction).slice(0, stableCount).join("");
expect(stable).toContain("TURN_0 ");
expect(stable).toEndWith(`TURN_13 ${"x".repeat(900)}`);
expect(stable).not.toContain("## Task");
expect(text(extraction).at(-1)).toStartWith("\n\n## Task: memory extraction");
expect(text(extraction).at(-1)).toContain("## Existing Memories");
expect(sharedScope).not.toBe(sessionId);
expect(auxPromptCacheScope("other-session", "session-transcript")).not.toBe(sharedScope);
```

- 第二个用例（两种策略）改名为「a %s route keeps one user message per call under the same scope」：`toHaveLength(1)`，去掉与 summary 的比较，保留对 `extraction` 的顺序断言。
- 第三个用例：`toHaveLength(4)` 改 `2`，`fixture.calls[1]` 改 `fixture.calls[0]`，`fixture.calls.slice(2)` 改 `slice(1)`，末尾两处 `fixture.calls[2]` 改 `fixture.calls[1]`。
- 第四个用例：`toHaveLength(3)` 改 `2`。

- [ ] **Step 4: `auxiliary-pipeline.memory-output.test.ts`**

- 删除 `session-memory.js` 导入和 `priorSummary`。
- 前两个用例合并成一个：

```ts
test.each(["length", "max_tokens"])(
  "discards an extraction the provider reports as %s, without retrying",
  async (stopReason) => {
    const manager = new MemoryManager({ projectDir: root, scope: "dream" });
    manager.save({
      type: "project",
      name: "verified-memory",
      description: "verified",
      content: "keep this",
    });
    const before = manager.loadAll();
    const fixture = setup(true, () => ({
      text: JSON.stringify([
        {
          type: "project",
          scope: "project",
          name: "partial-new-memory",
          description: "partial",
          content: "discard this",
        },
      ]),
      toolCalls: [],
      stopReason,
      usage,
    }));

    await fixture.run();

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.maxTokens).toBe(3072);
    expect(fixture.billed).toEqual([usage]);
    expect(manager.loadAll()).toEqual(before);
  },
);
```

- 第三个用例改为：

```ts
test("uses a bounded memory budget and persists complete output", async () => {
  const fixture = setup(true, () => ({
    text: JSON.stringify([
      {
        type: "project",
        scope: "project",
        name: "complete-memory",
        description: "complete",
        content: "keep this",
      },
    ]),
    toolCalls: [],
    stopReason: "stop",
    usage,
  }));

  await fixture.run();

  expect(fixture.calls.map((call) => call.maxTokens)).toEqual([3072]);
  expect(
    new MemoryManager({ projectDir: root, scope: "dream" }).loadAll().map((m) => m.name),
  ).toEqual(["complete-memory"]);
});
```

`promptText` 如果不再使用就删掉。

- [ ] **Step 5: 运行这四个文件加两个 orchestrator 测试文件**

Run:

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/core/src/services/memory-orchestrator.test.ts \
  packages/core/src/services/memory-orchestrator.custody.test.ts \
  packages/core/src/services/memory-storage-context.test.ts \
  packages/core/src/engine/auxiliary-pipeline.prompt-cache.test.ts \
  packages/core/src/engine/auxiliary-pipeline.memory-output.test.ts
```

Expected: 全部 PASS，0 失败。

### Task 4: 注释、变更日志

**Files:**

- Modify: `packages/core/src/engine/run-finalize.ts`（记忆流水线调用上方的注释）
- Modify: `packages/core/src/services/extract-memories.ts`、`memory-prompt-segments.ts`、`session-transcript-prompt.ts`、`packages/core/src/llm/aux-prompt-cache.ts`（提到「与会话摘要共享前缀」的注释）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 改注释**

`run-finalize.ts`：

```ts
// Fire-and-forget memory pipeline: extract durable memories from the
// transcript and conditionally trigger auto-dream consolidation.
// Doesn't block the Engine result.
```

其余四处把「memory extraction and session summary share …」这类表述改成只说记忆提取；`session-memory.ts` 的摘要提示词构建函数仍然存在，凡是描述「这两个提示词构建函数共享前缀」的注释保留，描述「流水线会调用摘要」的改掉。

- [ ] **Step 2: `CHANGELOG.md` 的 `## [Unreleased]` 下加**

```markdown
### Changed

- Background memory maintenance makes fewer model requests. It no longer
  writes a session summary after every turn, and in Claude Code and Codex
  sessions it waits until the session has been quiet for five minutes.
```

- [ ] **Step 3: 只对改过的文件跑 prettier**

Run: `npx prettier --check <改过的文件>`，不通过的用 `--write` 修。不要跑 `bun run format`。

### Task 5: 整体验证

- [ ] **Step 1: core 记忆与引擎相关测试**

Run:

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/core/src/services/memory-orchestrator.test.ts \
  packages/core/src/services/memory-orchestrator.custody.test.ts \
  packages/core/src/services/memory-orchestrator.canonical.test.ts \
  packages/core/src/services/memory-orchestrator.write-context.test.ts \
  packages/core/src/services/memory-scope-routing.test.ts \
  packages/core/src/services/memory-storage-context.test.ts \
  packages/core/src/services/memory-write-decision-prompt.test.ts \
  packages/core/src/services/auto-dream-cadence.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/core/src/engine/auxiliary-pipeline.test.ts \
  packages/core/src/engine/auxiliary-pipeline.prompt-cache.test.ts \
  packages/core/src/engine/auxiliary-pipeline.memory-output.test.ts \
  packages/core/src/engine/aux-prompt-cache.test.ts \
  packages/core/src/engine/engine.quick-chat-ephemeral-memory.test.ts
```

Expected: 0 失败。

- [ ] **Step 2: 重建 core，跑 desktop 外部记忆测试**

Run:

```bash
bun run --filter @cjhyy/code-shell-core build
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/desktop/src/main/external-runtime-memory.test.ts \
  packages/desktop/src/main/external-runtime-state.test.ts
```

Expected: 0 失败。

- [ ] **Step 3: 类型检查与 lint**

Run: `bun run typecheck:workspaces` 和 `npx eslint <改过的 .ts 文件>`
Expected: 没有新增错误。

- [ ] **Step 4: 全仓契约测试**

Run: `node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/index.exports.test.ts`
Expected: PASS（没有改导出）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/services/memory-orchestrator.ts \
  packages/core/src/services/memory-orchestrator.test.ts \
  packages/core/src/services/memory-orchestrator.custody.test.ts \
  packages/core/src/services/memory-storage-context.test.ts \
  packages/core/src/engine/auxiliary-pipeline.prompt-cache.test.ts \
  packages/core/src/engine/auxiliary-pipeline.memory-output.test.ts \
  packages/core/src/engine/run-finalize.ts \
  packages/core/src/services/extract-memories.ts \
  packages/core/src/services/memory-prompt-segments.ts \
  packages/core/src/services/session-transcript-prompt.ts \
  packages/core/src/llm/aux-prompt-cache.ts \
  packages/desktop/src/main/external-runtime-memory.ts \
  packages/desktop/src/main/external-runtime-memory.test.ts \
  packages/desktop/src/main/external-runtime-state.test.ts \
  CHANGELOG.md docs/todo/memory-segment-closure-design-20261124.md \
  docs/superpowers/plans/2026-11-24-memory-m1-drop-session-summary.md
git commit -m "fix(memory): stop per-turn session summaries and debounce external maintenance"
```

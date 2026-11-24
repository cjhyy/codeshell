# 记忆流水线 M2b：外部会话并入按段收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code / Codex 外部会话的记忆提取用和原生会话同一套规则：一个工作段收尾一次、只看游标之后的新消息、有人输入才跑；只用用户选定的提取模型或辅助模型，没选就不跑并在设置页说明。

**Architecture:** 取窗、门槛、游标复用 M2a 在 core 里的纯函数，对宿主只暴露一个入口 `planMemoryClosure(events, cursor)`：返回要提取的消息列表，或者跳过的原因。`ExternalRuntimeMemory` 保留自己的计时、归属校验和模型调用。快照从「回放出来的消息」改为「transcript 事件」。功能开关 `memory_segment_closure` 关掉时走 M0 的旧路径。

**Tech Stack:** TypeScript，Bun test（`node scripts/run-bun-test-shard.mjs`），React（设置页一行说明）。

设计依据：`docs/todo/memory-segment-closure-design-20261124.md` 第 5.5 节；前置计划 `2026-11-24-memory-m2a-segment-closure-native.md`。

---

## 定下的行为

| 项     | 开关开（默认）                                                              | 开关关                                       |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------- |
| 何时跑 | 最后一轮结束后安静 30 分钟                                                  | 安静 5 分钟，且比上次多 8 条消息（M0）       |
| 读什么 | 游标之后的消息，前面带最多 4 条已读消息作上下文                             | 整个窗口                                     |
| 门槛   | 新消息里有人输入的（没有 `injected` 标记的 user 轮次）；第一次收尾至少 8 条 | 至少 8 条                                    |
| 模型   | 只用 `memories.extractionModel`，其次辅助模型；都没有就跳过，不报错         | Claude Code 回退到会话模型经 CLI；Codex 报错 |
| 游标   | 成功后写入会话 `state.json` 的 `memoryCursor`                               | 不用                                         |

不做「恢复时补」：外部会话的计时器丢了（应用重启）也不丢内容，游标没动，下一次收尾会连同之前那段一起读。

---

## 文件结构

| 文件                                                                              | 改动                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/services/memory-closure.ts`                                    | 新增 `closureTranscript(window)`（把窗口整理成记忆提示词用的消息列表，原来在 `auxiliary-pipeline.ts` 里）和 `planMemoryClosure(events, cursor)`（取窗、门槛、整理三步合一） |
| `packages/core/src/index.internal.ts`                                             | 导出 `planMemoryClosure`、`MEMORY_CLOSURE_IDLE_MS`（一条导出语句；入口预算加一，理由写在 `tests/architecture-budgets.test.ts`）                                             |
| `packages/desktop/src/main/external-runtime-state.ts`                             | 快照增加 `events`                                                                                                                                                           |
| `packages/desktop/src/main/external-runtime-memory.ts`                            | 按段收尾路径；没选模型时跳过                                                                                                                                                |
| `packages/desktop/src/main/external-runtime-module.ts`（或构造处）                | 把功能开关读取传给 `ExternalRuntimeMemory`                                                                                                                                  |
| `packages/desktop/src/renderer/settings/MemorySection.tsx`、`i18n/ns/settings.ts` | 没选提取模型和辅助模型时，在自动提取开关下显示一行说明                                                                                                                      |
| 对应测试                                                                          | 并进 `external-runtime-memory.test.ts`、`external-runtime-state.test.ts`（desktop 分片已到上限，不新开文件）                                                                |

---

### Task 1: core 导出与共用的消息整理

- [ ] `closureTranscript(window)` 测试：没有上下文时与逐条整理的结果相同；有上下文时第一条是角色 `context` 的条目。
- [ ] 把 `auxiliary-pipeline.ts` 里的整理逻辑搬到 `memory-closure.ts`；加 `planMemoryClosure` 及测试（值得读时带消息列表，不值得读时带原因）；`runMemoryClosure` 改用它。
- [ ] `index.internal.ts` 加导出；`index.exports` 契约测试按需更新。

### Task 2: 快照带事件

- [ ] `ExternalMemorySnapshot.events: ReadonlyArray<TranscriptEvent>`；`memorySnapshot()` 取 `this.transcript.getEvents()` 的冻结副本。
- [ ] 测试：快照的事件包含 user 轮次的 `injected` 标记；后续追加的事件不进已取的快照。

### Task 3: 按段收尾路径

- [ ] `ExternalRuntimeMemory` 新增依赖 `featureFlags?: () => FeatureFlagOverrides | undefined` 和 `closureIdleMs?: number`（默认 `MEMORY_CLOSURE_IDLE_MS`）。
- [ ] `schedule()`：开关开时不看「多 8 条」，只按安静时长计时；开关关时保持 M0 行为。
- [ ] `run()`：开关开时——没选模型就记一条 `memory.closure` 日志（`skipped: "no-model"`）返回；读游标 → `planMemoryClosure` → 跳过或提取 → `completed` 时在归属校验通过后写游标。
- [ ] 测试：没选模型时不调用模型、不报错、不写游标（Claude Code 和 Codex 各一条）；没有人输入的新消息时不调用模型；通过时只发新消息并写入游标；第二次只读增量；模型报错时游标不动；开关关时 M0 的用例照旧通过。

### Task 4: 设置页说明

- [ ] `MemorySection.tsx`：读到 `memories.extractionModel` 和 `defaults.auxText` 都为空时，在自动提取开关下显示一行说明（中英文各一条文案）。
- [ ] 文案（中文，沿用设置页对 `defaults.auxText` 的叫法「后台任务模型」）：「Claude Code 和 Codex 会话用后台任务模型提取记忆。当前没有选择后台任务模型，这些会话不会提取。」

### Task 5: 验证

- [ ] 重建 core；`external-runtime-memory.test.ts`、`external-runtime-state.test.ts`、`external-runtime-service*.test.ts` 通过；`bun run typecheck:workspaces` 0 错误；eslint、prettier 只查改过的文件；desktop 分片文件数不变。
- [ ] `CHANGELOG.md` 的 Unreleased 条目补上外部会话的变化。
- [ ] 提交：`feat(desktop): close external sessions' memory segments with the shared rules`

# Group A Core 小 Feature 技术方案

调研范围：只读核实 `packages/core` 相关实现与现有测试风格；本方案只规划实现和测试，不改生产代码。行号基于当前工作区代码确认，后续代码变动后可能自然偏移。

## 1. TodoWrite resume 恢复补 core 测试

### 涉及文件与真实行号锚点

- `packages/core/src/tool-system/builtin/task.ts:90`：`todoWriteTool()` 解析 `todos` 并在全 completed 时把 `effective` 置为 `[]`。
- `packages/core/src/tool-system/builtin/task.ts:105`：live 工具路径的 `allDone` 判断。
- `packages/core/src/tool-system/builtin/task.ts:115`：`parseTodos()` 过滤无效项，缺失 `activeForm` 时退回 `content`。
- `packages/core/src/tool-system/builtin/task.ts:129`：`toTaskInfos()` 生成 position-based `TaskInfo.id`。
- `packages/core/src/tool-system/builtin/task.ts:139`：`emitTaskUpdate()` 通过 `ctx.streamCallback` 发 `task_update`。
- `packages/core/src/tool-system/builtin/task.ts:154`：`readLastTodoSnapshot(events)` 从 transcript 最新 `TodoWrite` tool_use 读取快照。
- `packages/core/src/tool-system/builtin/task.ts:167`：resume 读取路径同样遵守“全 completed -> []”。
- `packages/core/src/engine/engine.ts:993`：`wrappedOnStream` 截获 live `task_update` 并维护 `latestTodos`。
- `packages/core/src/engine/engine.ts:1302`：`ToolContext.streamCallback` 注入给工具。
- `packages/core/src/engine/engine.ts:1415`：`options.sessionId` 已存在时走 `SessionManager.resume()`。
- `packages/core/src/engine/engine.ts:1623`：resume 时 replay 最新 TodoWrite 快照。
- `packages/core/src/engine/engine.ts:1631`：只有 `snap && snap.length > 0` 才 emit `task_update`。
- `packages/core/src/session/transcript.ts:81`：测试可用 `appendToolUse("TodoWrite", id, args)` 构造 transcript。
- `packages/core/src/session/transcript.ts:214`：`getEvents()` 返回 `readLastTodoSnapshot()` 扫描的事件流。
- `packages/core/src/session/session-manager.ts:467`：`resume()` 从 `transcript.jsonl` 加载事件。

### 当前实现分析

功能实现已经具备：

- live `TodoWrite` 每次替换完整 snapshot，并在“最后所有 todo 都 completed”时 emit 空数组以清空 UI。
- `readLastTodoSnapshot()` 从 transcript 末尾向前找最新 `tool_use` 且 `toolName === "TodoWrite"` 的事件，返回同 live 路径一致的 `TaskInfo[]`，全 completed 返回 `[]`，无有效 TodoWrite 返回 `null`。
- engine resume 时只在 `options.sessionId` 存在且快照非空时 emit `task_update`。因此“末次全 completed”恢复得到 `[]`，但不会 emit，这符合“不重开 pinned panel”的目标。

缺口在测试：当前只看到 `tests/protocol/in-process-client-drift.test.ts:53` 覆盖 live `TodoWrite` 事件能从协议层冒泡，没有直接覆盖 `readLastTodoSnapshot()` 的 pending 恢复、最新快照优先、全 completed 清空，也没有 engine 层 resume replay 的正/负用例。

### 具体改动步骤

1. 新增 `packages/core/src/tool-system/builtin/task.test.ts`，直接测试 task helper。

关键用例伪代码：

```ts
import { describe, expect, it } from "bun:test";
import { readLastTodoSnapshot, todoWriteTool } from "./task.js";
import type { TranscriptEvent, StreamEvent } from "../../types.js";

function toolUse(args: Record<string, unknown>, i = 1): TranscriptEvent {
  return {
    id: `e-${i}`,
    type: "tool_use",
    timestamp: i,
    turnNumber: i,
    data: { toolName: "TodoWrite", toolCallId: `t-${i}`, args },
  };
}

it("restores the latest non-completed TodoWrite snapshot", () => {
  const snap = readLastTodoSnapshot([
    toolUse({ todos: [{ content: "old", status: "pending", activeForm: "olding" }] }, 1),
    toolUse({
      todos: [
        { content: "implement", status: "in_progress", activeForm: "implementing" },
        { content: "test", status: "pending", activeForm: "testing" },
      ],
    }, 2),
  ]);

  expect(snap).toEqual([
    { id: "1", subject: "implement", activeForm: "implementing", status: "in_progress" },
    { id: "2", subject: "test", activeForm: "testing", status: "pending" },
  ]);
});

it("returns [] when the latest TodoWrite snapshot is all completed", () => {
  expect(readLastTodoSnapshot([
    toolUse({ todos: [{ content: "done", status: "completed", activeForm: "finishing" }] }),
  ])).toEqual([]);
});

it("live TodoWrite emits [] for all completed", async () => {
  const events: StreamEvent[] = [];
  await todoWriteTool(
    { todos: [{ content: "done", status: "completed", activeForm: "finishing" }] },
    { streamCallback: (event) => events.push(event) } as never,
  );
  expect(events).toEqual([{ type: "task_update", tasks: [] }]);
});
```

2. 新增 `packages/core/src/engine/engine.todo-resume.test.ts`，沿用 `engine.context-anchor.test.ts` 的 fake provider 模式。

关键结构：

```ts
class TodoResumeClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const usage = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}

function makeEngine(dir: string, model: string): Engine {
  const engine = new Engine({
    llm: { provider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  return engine;
}
```

pending 恢复用例：

```ts
const session = engine.getSessionManager().create(dir, model, provider, "todo-resume-pending");
session.transcript.appendToolUse("TodoWrite", "todo-1", {
  todos: [
    { content: "plan", status: "completed", activeForm: "planning" },
    { content: "implement", status: "in_progress", activeForm: "implementing" },
    { content: "test", status: "pending", activeForm: "testing" },
  ],
});

await engine.run("continue", {
  sessionId: "todo-resume-pending",
  cwd: dir,
  onStream: (event) => events.push(event),
});

const updates = events.filter((e) => e.type === "task_update");
expect(updates).toHaveLength(1);
expect(updates[0]!.tasks.map((t) => t.status)).toEqual([
  "completed",
  "in_progress",
  "pending",
]);
```

全 completed 不 emit 用例同样创建 session，但最后一个 `TodoWrite` 全是 `completed`，断言 `events.filter((e) => e.type === "task_update")` 为空。

3. 可选增强：在 engine 测试里加一个“最后一条 TodoWrite 覆盖早先 pending”的用例，避免未来改成首条匹配或合并历史。

### 需要新增/修改的测试文件与用例清单

- 新增 `packages/core/src/tool-system/builtin/task.test.ts`
  - `readLastTodoSnapshot restores latest pending/in_progress snapshot`
  - `readLastTodoSnapshot ignores non-TodoWrite and invalid todos`
  - `readLastTodoSnapshot returns [] for latest all-completed snapshot`
  - `todoWriteTool emits [] when live snapshot is all completed`
- 新增 `packages/core/src/engine/engine.todo-resume.test.ts`
  - `resume emits task_update for a non-empty latest TodoWrite snapshot`
  - `resume does not emit task_update when latest TodoWrite snapshot is all completed`
  - `resume uses the latest TodoWrite snapshot when multiple exist`

建议验证命令：

```bash
bun test packages/core/src/tool-system/builtin/task.test.ts packages/core/src/engine/engine.todo-resume.test.ts
```

### 风险与边界情况

- `Transcript.loadFromFile()` 会修复孤儿 tool_use 并追加合成 tool_result；`readLastTodoSnapshot()` 只关心 `tool_use`，不受影响。
- engine 测试应使用 fake provider 且 `enabledBuiltinTools: []`，避免真实工具或外部网络参与。
- `readLastTodoSnapshot()` 当前只支持新 `TodoWrite`，engine 注释提到 legacy TaskCreate/Update 容忍，但 task helper 实际没有 legacy 解析。测试应覆盖当前真实行为，不把注释扩展成隐含需求。
- 全 completed 的 live 行为是 emit 空数组；resume 行为是不 emit。两个路径目标不同，测试名称要明确。

### 体量估计

- 代码实现：0 行生产代码。
- 测试：约 120-180 行。
- 复杂度：低。主要是构造 transcript 和 fake engine provider。

## 2. 压缩 token 初始估算无真实 anchor 时仍偏启发式

### 涉及文件与真实行号锚点

- `packages/core/src/context/compaction.ts:15`：当前导入 `estimateMessagesTokens()`。
- `packages/core/src/context/compaction.ts:21`：`estimateTokens(messages)` 对 message 估算乘 `4 / 3` overhead。
- `packages/core/src/context/token-counter.ts:25`：`estimateStringTokens()` 用字符比例、CJK、代码/JSON 启发式。
- `packages/core/src/context/token-counter.ts:53`：`estimateMessagesTokens()` 叠加每 message/block 的估算。
- `packages/core/src/context/manager.ts:148`：`recordActualUsage()` 用 provider usage 建立 anchor。
- `packages/core/src/context/manager.ts:166`：`seedActualUsage()` 注入 resume 持久化 anchor。
- `packages/core/src/context/manager.ts:210`：`estimateTokensHybrid()` 无 anchor 时回退 `estimateTokens()`。
- `packages/core/src/context/manager.ts:216`：有 anchor 且追加消息时用 `actual + estimate(newMessages)`。
- `packages/core/src/context/manager.ts:222`：有 anchorEstimate 时按比例重标定 compacted array。
- `packages/core/src/context/manager.ts:729`：`checkLimits()` 只返回 tokens/ratio/compact flags，没有估算来源信息。
- `packages/core/src/engine/engine.ts:367`：`ctxSeedSent` 注释说明首帧是 rough char/4 seed。
- `packages/core/src/engine/engine.ts:1581`：读取 `session.state.contextUsageAnchor`。
- `packages/core/src/engine/engine.ts:1590`：兼容 anchor 时 `contextManager.seedActualUsage()`。
- `packages/core/src/engine/engine.ts:1604`：`roughPromptTokens` 首帧估算分支。
- `packages/core/src/engine/engine.ts:1607`：无 anchor 时逐 message `text.length / 4`。
- `packages/core/src/engine/engine.ts:1617`：`session_started` 只发 `promptTokens`。
- `packages/core/src/engine/turn-loop.ts:438`：message mutate 后 `emitCtxFromMessages()` 用 `estimateTokens(messages) + overhead`。
- `packages/core/src/engine/turn-loop.ts:465`：provider usage 回来后 `emitCtxFromUsage()` 校准 overhead。
- `packages/core/src/engine/turn-loop.ts:744`：首个真实 `usage.promptTokens` 回写 `ContextManager.recordActualUsage()`。
- `packages/core/src/llm/token-counter.ts:44`：已有 `gpt-tokenizer` 的 `countTokens(text)`，目前用于 live output counter，不参与 context compaction。
- `packages/core/src/types.ts:202`：`ContextUsageAnchor` 已持久化 provider/model/promptTokens/messageCount/estimateAtAnchor。
- `packages/core/src/types.ts:419`：`StreamEvent` union。
- `packages/core/src/types.ts:423`：`session_started` 事件目前只有 `sessionId` 和 `promptTokens`。
- `packages/core/src/types.ts:527`：`usage_update` 事件目前没有估算来源/置信度字段。

### 当前实现分析

真实 usage anchor 的主问题已修：

- provider 返回 `usage.promptTokens` 后，`TurnLoop` 在 `turn-loop.ts:744` 调用 `ContextManager.recordActualUsage()`。
- engine 在 `engine.ts:2088` 将 anchor 持久化到 `session.state.contextUsageAnchor`，并写入 provider/model。
- resume 时 `engine.ts:1581` 校验 provider/model/messageCount 后 seed 回 `ContextManager`。
- 有 anchor 后，`estimateTokensHybrid()` 能走 `actual + delta` 或按 `estimateAtAnchor` 比例缩放 compacted messages。

剩余问题集中在“第一个真实 usage 之前”：

- compaction 决策无 anchor 时仍只能用 `estimateTokens()`，其核心是字符比例启发式再乘 `4/3`。
- engine 首帧 `session_started.promptTokens` 无 anchor 时更粗，是逐 message `char / 4`，还不包含 system prompt/tool defs。
- `session_started` 和 estimate-path `usage_update` 都没有标识“这是估算/低置信度”，UI 或上层 SDK 只能把数字当成真实值处理。
- repo 已有 `packages/core/src/llm/token-counter.ts` 的 `gpt-tokenizer`，但它是 cl100k 近似且同步首调用可能 fallback，不是 provider/model-aware 的完整 prompt tokenizer；直接替换 compaction 估算会扩大行为面。

推荐第一阶段采用“显式标注估算来源/置信度 + 首个真实 usage 校准”的方案，避免把启发式数字伪装成真实值。provider/model-aware tokenizer 可作为第二阶段增强，复用现有 `gpt-tokenizer` 而不是新增第三套计数器。

### 具体改动步骤

1. 在 `packages/core/src/types.ts` 增加估算元数据类型，并给事件添加可选字段，保持向后兼容。

建议字段不要包对象，减少 reducer 和日志使用成本：

```ts
export type PromptTokenSource =
  | "provider_usage"
  | "anchor_delta"
  | "anchor_rescale"
  | "calibrated_estimate"
  | "heuristic_estimate"
  | "session_cumulative";

export type PromptTokenConfidence = "high" | "medium" | "low";
```

事件扩展：

```ts
| {
    type: "session_started";
    sessionId: string;
    promptTokens: number;
    promptTokensSource?: PromptTokenSource;
    promptTokensConfidence?: PromptTokenConfidence;
  }
```

`usage_update` 同样追加两个 optional 字段。老调用方不需要立刻改。

2. 在 `ContextManager` 内部拆出带元数据的估算函数，保留旧私有 wrapper。

关键伪代码：

```ts
type TokenEstimate = {
  tokens: number;
  source: PromptTokenSource;
  confidence: PromptTokenConfidence;
};

private estimateTokensHybridInfo(messages: Message[]): TokenEstimate {
  const currentEstimate = estimateTokens(messages);

  if (this.lastActualTokens !== undefined && this.lastActualAtMessageCount !== undefined) {
    if (this.lastActualAtMessageCount < messages.length) {
      const newMessages = messages.slice(this.lastActualAtMessageCount);
      return {
        tokens: this.lastActualTokens + estimateTokens(newMessages),
        source: "anchor_delta",
        confidence: "medium",
      };
    }

    if (this.lastActualAnchorEstimate !== undefined && this.lastActualAnchorEstimate > 0) {
      return {
        tokens: Math.round(this.lastActualTokens * (currentEstimate / this.lastActualAnchorEstimate)),
        source: "anchor_rescale",
        confidence: "medium",
      };
    }
  }

  return { tokens: currentEstimate, source: "heuristic_estimate", confidence: "low" };
}

private estimateTokensHybrid(messages: Message[]): number {
  return this.estimateTokensHybridInfo(messages).tokens;
}
```

`checkLimits()` 返回值追加：

```ts
const estimate = this.estimateTokensHybridInfo(messages);
return {
  tokens: estimate.tokens,
  ratio: estimate.tokens / this.config.maxTokens,
  needsCompact: ratio >= this.config.compactAtRatio,
  needsEmergency: ratio >= this.config.summarizeAtRatio,
  promptTokensSource: estimate.source,
  promptTokensConfidence: estimate.confidence,
};
```

3. engine 首帧 seed 改为复用 context 估算，不再单独 `char / 4`。

`engine.ts:1604` 附近建议改成结构化 seed：

```ts
const ctxSeed = needsCtxSeed
  ? (() => {
      const checked = contextManager.checkLimits(messages);
      return {
        tokens: checked.tokens,
        source: checked.promptTokensSource,
        confidence: checked.promptTokensConfidence,
      };
    })()
  : { tokens: 0, source: "heuristic_estimate" as const, confidence: "low" as const };

options?.onStream?.({
  type: "session_started",
  sessionId: sid,
  promptTokens: ctxSeed.tokens,
  promptTokensSource: ctxSeed.source,
  promptTokensConfidence: ctxSeed.confidence,
});
```

这样无 anchor 时至少使用 `context/compaction.ts:21` 的统一估算；有 persisted anchor 时自然带 `anchor_delta`/`anchor_rescale`。

4. `TurnLoop` 的两类 ctx emit 带上来源。

`emitCtxFromMessages()`：

```ts
const source = overhead > 0 ? "calibrated_estimate" : "heuristic_estimate";
this.config.onStream({
  type: "usage_update",
  promptTokens: ctx,
  promptTokensSource: source,
  promptTokensConfidence: overhead > 0 ? "medium" : "low",
});
```

`emitCtxFromUsage()`：

```ts
this.config.onStream({
  type: "usage_update",
  promptTokens,
  promptTokensSource: "provider_usage",
  promptTokensConfidence: "high",
  ...
});
```

engine turn-boundary cumulative heartbeat 建议标为 `session_cumulative/high`，但 renderer 已通过 cumulative-only 判断避免 clobber live context。

5. 第二阶段可选：provider/model-aware tokenizer。

如果后续仍要降低无 anchor 误差，可在不改变事件协议的前提下扩展 `context/token-counter.ts`：

- 新增 `estimateMessagesTokensWithProfile(messages, { provider, providerKind, model })`。
- OpenAI/GPT 系走现有 `llm/token-counter.ts:44` 的 `countTokens()` 作为 string token counter。
- Anthropic/OpenRouter anthropic slug 仍标 `heuristic_estimate` 或 `tokenizer_approx`，避免宣称精确。
- `ContextManager` 构造函数可接收 optional `llm?: Pick<LLMConfig, "provider" | "providerKind" | "model">`，由 engine 创建时传入。

这一阶段不建议先做，因为 `countTokens()` 是同步懒加载，冷进程第一次调用仍可能 fallback；并且 provider prompt 包装、tool schema、system prompt overhead 才是首帧误差大头。

### 需要新增/修改的测试文件与用例清单

- 修改 `packages/core/src/context/manager-hybrid.test.ts`
  - 无 anchor 时 `checkLimits()` 返回 `promptTokensSource: "heuristic_estimate"`、`promptTokensConfidence: "low"`。
  - `seedActualUsage()` 后新增消息走 `anchor_delta/medium`。
  - compacted message count 小于 anchor 且有 `estimateAtAnchor` 时走 `anchor_rescale/medium`。
- 修改 `packages/core/src/engine/engine.context-anchor.test.ts`
  - 现有“compatible persisted anchor”用例追加断言 `session_started.promptTokensSource` 不是 `heuristic_estimate`，置信度为 `medium`。
  - 新增无 persisted anchor 的 cold/resume seed 用例，断言 `session_started` 带 `heuristic_estimate/low`。
  - 保留现有 `promptTokens` 数值断言，避免回归。
- 修改或新增 `packages/core/src/engine/turn-loop-usage-cache.test.ts`
  - provider usage emit 带 `provider_usage/high`。
  - estimate-path `emitCtxFromMessages()` 带 `heuristic_estimate/low` 或有 overhead 后 `calibrated_estimate/medium`。
- 若第二阶段 tokenizer 落地，再新增 `packages/core/src/context/token-counter-profile.test.ts`。

建议验证命令：

```bash
bun test packages/core/src/context/manager-hybrid.test.ts packages/core/src/engine/engine.context-anchor.test.ts packages/core/src/engine/turn-loop-usage-cache.test.ts
```

### 风险与边界情况

- 给 `StreamEvent` 增加 optional 字段是兼容的，但 desktop/tui 若要展示“估算”标签，需要另做 UI 变更；core 层先保证事件语义不再混淆。
- `session_started.promptTokens` 当前 desktop reducer 明确忽略，TUI 会采用非零值。加置信度不会自动改变 UI 行为，但为后续“低置信度不强提醒”提供依据。
- `estimateTokensHybridInfo()` 不应改变 compaction 阈值计算的实际数值，否则会扩大测试和行为面；第一阶段只统一 engine 首帧估算来源并标注元数据。
- `provider_usage/high` 仅代表 provider 回传的 prompt tokens 权威，不代表 whole-session cumulative heartbeat 是 live context。`session_cumulative` source 能帮助上层区分。
- 第二阶段 tokenizer 不能承诺 Anthropic 精确 tokenization；模型 prompt 包装和 tool schema serialization 仍由 provider 决定，真实 usage 仍是唯一 high-confidence anchor。

### 体量估计

- 第一阶段生产代码：约 80-130 行，涉及 `types.ts`、`manager.ts`、`engine.ts`、`turn-loop.ts`。
- 第一阶段测试：约 80-140 行。
- 复杂度：中。重点是保持事件兼容、避免 cumulative heartbeat 被 UI 当 live context。
- 第二阶段 tokenizer：额外约 120-220 行，复杂度中高，建议另起 PR。

## 3. skill scanner 兼容 `.agents/skills/`

### 涉及文件与真实行号锚点

- `packages/core/src/skills/scanner.ts:28`：`ScanBase` 只有 `dir` 和 `source`。
- `packages/core/src/skills/scanner.ts:41`：`bases(cwd)` 当前只返回 project `.code-shell/skills` 和 user `.code-shell/skills`。
- `packages/core/src/skills/scanner.ts:94`：`scanDirBases()` 按 bases 顺序扫描。
- `packages/core/src/skills/scanner.ts:103`：对 base dir 取 `realpathSync()`。
- `packages/core/src/skills/scanner.ts:109`：`seenBaseDirs` 防止同一真实目录被重复处理。
- `packages/core/src/skills/scanner.ts:124`：支持普通目录和 symlink 目录。
- `packages/core/src/skills/scanner.ts:126`：`seen` 按 skill name 去重，先到先得。
- `packages/core/src/skills/scanner.ts:132`：local skill 用 `buildSkillFromFile()`，source 可为 `"project"`。
- `packages/core/src/skills/scanner.ts:184`：`scanOnce()` 先扫 local bases，再扫 installed plugins。
- `packages/core/src/skills/scanner.ts:213`：`skillsDirsMtime(cwd)` 使用 `bases(cwd)` 计算 cache key。
- `packages/core/src/skills/scanner.ts:225`：memoize key 包含 `skillsDirsMtime(cwd)`。
- `packages/core/src/skills/scanner.ts:296`：`invalidateSkillCache()` 供测试和安装流程清缓存。
- `tests/skills-scanner.test.ts:113`：scanner directory layout 测试组。
- `tests/skills-scanner.test.ts:232`：scanner memoization 测试组。
- `packages/core/src/tool-system/builtin/skill-prompt.ts:28`：普通 user/project skill 统一展示在“用户 / 项目”组。

### 当前实现分析

scanner 已经具备需要的基础能力：

- local bases 顺序决定同名优先级，`seen` 确保先扫描到的技能胜出。
- symlink skill dir 已支持；整个 base dir 指向同一真实路径时，`seenBaseDirs` 会跳过重复扫描。
- cache key 使用 `bases(cwd)` 的各 base dir mtime；只要 `.agents/skills` 加进 `bases()`，新增/删除子目录就能自然触发热加载。
- plugin skill 使用 `<plugin>:<skill>` namespace，与 local plain name 不冲突。

缺口只是没有把 project `.agents/skills` 加入 bases。

### 具体改动步骤

1. 修改 `packages/core/src/skills/scanner.ts:41` 的 `bases(cwd)`，推荐顺序如下：

```ts
function bases(cwd: string): ScanBase[] {
  return [
    { dir: join(cwd, ".code-shell", "skills"), source: "project" },
    { dir: join(cwd, ".agents", "skills"), source: "project" },
    { dir: join(userHome(), ".code-shell", "skills"), source: "user" },
  ];
}
```

这个顺序满足：

- `.code-shell/skills` 优先于 `.agents/skills`。
- 两者都属于 project source。
- 项目级目录整体优先于用户级目录，避免用户全局 skill shadow 项目声明。
- `skillsDirsMtime()` 不需要单独改，因为它已调用 `bases(cwd)`。

2. 更新 scanner 顶部注释和 `skillsDirsMtime()` 注释，把 `.agents/skills` 纳入描述。

建议把 `scanner.ts:2` 附近改成“discovers project `.code-shell/skills`, project `.agents/skills`, user `.code-shell/skills`, and installed plugin skills”。

3. 不需要改 `SkillDefinition.source`：`.agents/skills` 应继续标记为 `"project"`。

4. 不需要改 `buildSkillListing()`：plain local skills 仍进“用户 / 项目”组。

### 需要新增/修改的测试文件与用例清单

修改 `tests/skills-scanner.test.ts`：

- 在 `scanSkills - directory layout` 增加：
  - `discovers <project>/.agents/skills/<name>/SKILL.md as project source`
  - `.code-shell project skill shadows .agents project skill of the same name`
  - `.agents project skill shadows user skill of the same name`（若团队确认项目级应整体优先于 user；按推荐顺序应覆盖）
- 在 `scanSkills - memoization` 增加：
  - `memoize invalidates when .agents/skills directory mtime changes`

mtime 用例可参考 plugin mtime 测试 `tests/skills-scanner.test.ts:416` 的 `setTimeout(15)`，流程：

```ts
const first = scanSkills(projectRoot);
expect(first.find((s) => s.name === "late-agent")).toBeUndefined();

await new Promise((resolve) => setTimeout(resolve, 15));
makeSkillDir(join(projectRoot, ".agents", "skills"), "late-agent", "description: a", "body");

const second = scanSkills(projectRoot);
expect(second.find((s) => s.name === "late-agent")).toBeDefined();
```

建议验证命令：

```bash
bun test tests/skills-scanner.test.ts packages/core/src/skills/scanner.allowlist.test.ts packages/core/src/tool-system/builtin/skill.allowlist.test.ts
```

### 风险与边界情况

- 新目录是跨工具中立目录，可能让项目中已有 `.agents/skills` 立即暴露给 CodeShell。风险可控，因为只扫描显式 `SKILL.md` 子目录，不读取平铺 md。
- 同名 dedup 是目录名级别，不看 frontmatter `name`；`.agents/skills/foo/SKILL.md` 与 `.code-shell/skills/foo/SKILL.md` 会按 base 顺序去重。
- 如果 `.code-shell/skills` 和 `.agents/skills` 是同一个真实目录或互为 symlink，`seenBaseDirs` 会跳过第二个 base；因为 `.code-shell` 在前，source 仍为 `"project"`。
- `skillsDirsMtime()` 只捕获 base 目录 child add/remove，不捕获已有 `SKILL.md` 内容编辑；这是现有设计，安装流程依赖 `invalidateSkillCache()` 补足。
- disabledSkills/allowlist 名称不变，仍使用 plain skill name；不会因为来源目录不同产生 namespace。

### 体量估计

- 生产代码：约 3-8 行实际逻辑，少量注释。
- 测试：约 40-80 行。
- 复杂度：低。主要确认 base 顺序和 cache invalidation。

## 改动文件清单

预计实现这些 feature 时会改动或新增：

- `packages/core/src/tool-system/builtin/task.test.ts`（新增）
- `packages/core/src/engine/engine.todo-resume.test.ts`（新增）
- `packages/core/src/types.ts`（feature 2 optional event metadata）
- `packages/core/src/context/manager.ts`（feature 2 估算来源/置信度）
- `packages/core/src/engine/engine.ts`（feature 2 session_started seed metadata）
- `packages/core/src/engine/turn-loop.ts`（feature 2 usage_update metadata）
- `packages/core/src/context/manager-hybrid.test.ts`（feature 2 测试）
- `packages/core/src/engine/engine.context-anchor.test.ts`（feature 2 测试）
- `packages/core/src/engine/turn-loop-usage-cache.test.ts`（feature 2 测试）
- `packages/core/src/skills/scanner.ts`（feature 3）
- `tests/skills-scanner.test.ts`（feature 3 测试）

本次调研和方案编写实际只写入：

- `docs/archive/todo/plan-group-a-core.md`

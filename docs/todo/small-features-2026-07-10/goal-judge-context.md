# Goal judge 使用最近 N 个完整 API round

> 体量：S  
> 范围：只调整 Goal judge 的私有运行时上下文；不扩展公共 Hook API。  
> 基线说明：本文按 2026-07-10 当前工作树核查。TODO 提到的 `GoalJudgeRuntimeContext`、`toolResults + progress`、12 条/1600 字符/head-tail 截断属于尚未合并的 `feat/goal-judge-context` V1；当前工作树中尚不存在这些符号。因此实施时若 V1 已先合并，按本文删除/替换 V1 采集器；若未合并，则直接按本文新增完整对话通道，不必先落单抽工具结果的过渡实现。

## 1. 问题与现状

### 1.1 当前 judge 实际只看到最后一段文本

- 公共 `HookContext` 仍是通用信封，仅有 `eventName`、开放的 `data`、`sessionId` 和 `turnNumber`（`packages/core/src/hooks/events.ts:110-115`）。`on_stop` 的文档约定 `ctx.data` 携带 `goal`、`finalText`、`turnCount`（`packages/core/src/hooks/events.ts:27-41`）。
- `TurnLoop` 在模型无工具调用时先把最终 assistant 消息追加到工作 `messages`（`packages/core/src/engine/turn-loop.ts:983-996`），然后发出 `on_stop`，但只传 `goal`、`finalText`、`turnCount`（`packages/core/src/engine/turn-loop.ts:1000-1010`）。此时完整工作对话明明仍在局部变量 `messages` 中，却没有接到内置 judge。
- `createGoalStopHook()` 从 `ctx.data.finalText` 读取单段文本（`packages/core/src/hooks/goal-stop-hook.ts:220-221`），judge prompt 也只写入“agent 最近的输出”（`packages/core/src/hooks/goal-stop-hook.ts:254-267`）。因此“模型口头说已完成，但此前工具结果实际失败”“关键证据只存在于前一轮工具结果”等场景仍可能盲判。
- 当前工作树中 `packages/core/src/hooks/goal-stop-hook.ts:80` 是 `now?: () => Date` 的结尾，不是 TODO 所写的 `GoalJudgeRuntimeContext`。全仓也没有名为 `GoalJudgeRuntimeContext` 的符号。这是未合并分支与当前主线之间的锚点漂移，实施前不能按旧行号机械修改。

### 1.2 完整上下文已经存在，不需要另建工具结果采集管线

- `TurnLoopDeps` 已持有 `Transcript`（`packages/core/src/engine/turn-loop.ts:115-126`），TurnLoop 的每次运行又持有当前经过 compaction、steer、hook 注入和工具执行后的工作 `messages`。
- `ModelFacade.recordResponse()` 会把 assistant 文本、reasoning 和 `tool_use` 作为一个 assistant message 写入 Transcript（`packages/core/src/engine/model-facade.ts:236-267`）；TurnLoop 随后把每个 tool result 写入 Transcript（`packages/core/src/engine/turn-loop.ts:1133-1151`）。
- `Transcript.toMessages()` 可以从事件日志重建 `Message[]`，包括 assistant message、`tool_use`、`tool_result` 和 summary（`packages/core/src/session/transcript.ts:149-211`）。它适合 resume/fallback；对于正在运行的 stop 点，当前工作 `messages` 更接近“主模型刚刚实际看到的上下文”，还包含尚未落成独立 transcript 事件的运行时提醒。
- `groupMessagesByApiRound()` 已按 assistant 响应边界分组，并保持 assistant + tool result 的完整组（`packages/core/src/context/compaction.ts:931-953`）。无需再次发明“逐条收集工具结果”的状态机。
- 敏感结果已经有统一机制：敏感 ToolResult 会以 transcript/display 替代文本落盘（`packages/core/src/tool-system/tool-result-redaction.ts:3-27`），TurnLoop 还维护 `sensitiveToolResultRedactions` 并能在 `Message[]` 上替换对应 `tool_result`（`packages/core/src/engine/turn-loop.ts:240`、`:460-465`；实现见 `packages/core/src/tool-system/tool-result-redaction.ts:29-50`）。
- 图片/base64 可复用日志侧的纯函数清洗器 `sanitizeMessages()`（`packages/core/src/logging/sanitize-messages.ts:127-182`），避免 judge 子调用再次携带大体积图片字节。

### 1.3 不能直接把完整 messages 塞进公共 HookContext

公共 hooks 包括插件 hook、shell hook 和 SDK 注册的 handler。若把完整对话放进 `ctx.data`，所有 `on_stop` handler 都能读取工具结果、用户输入和潜在凭证，改变了公开安全面。现有 `TurnLoop.emitHook()` 会把传入 data 原样交给 HookRegistry（`packages/core/src/engine/turn-loop.ts:483-495`），所以本项必须使用内置 Goal hook 与 TurnLoop 之间的私有闭包通道，而不是扩展 `HookContext`。

## 2. 目标

1. Goal judge 每次判定都读取最近 N 个完整 API round，保留 user/assistant、`tool_use`、`tool_result` 的先后关系和关联 id。
2. 取消 V1 的 `toolResults + progress` 单独采集、单条 head-tail 截断及其状态同步；同一份对话切片同时承载进展与工具证据。
3. 继续限制 judge 输入成本：默认最多 6 个 API round、约 3,000 tokens、12,000 字符；超限时优先整轮丢弃最老 round。
4. judge 永远看不到敏感 ToolResult 的模型侧明文，也不携带 base64 图片；日志只记录计数、长度、digest，不记录对话正文。
5. 不修改 `HookContext`、`HookResult`、HookRegistry 聚合规则或第三方 hook 行为。
6. 保留现有三态 verdict、后台任务判断、时间截止、abort、失败时 fail-closed、`maxStopBlocks` 和目标持久化语义。

## 3. 详细修改方案

### 3.1 `packages/core/src/hooks/goal-stop-hook.ts`

#### 数据结构

把 V1 的私有上下文替换成下列内部结构。类型可以从模块导出供 engine 内部 `import type` 使用，但不要从 `packages/core/src/index.ts` 导出，因此不形成公共 SDK API。

```ts
export interface GoalJudgeRuntimeContext {
  conversation: Message[];
  renderedConversation: string;
  digest: string;
  selectedRoundCount: number;
  sourceRoundCount: number;
  estimatedTokens: number;
  chars: number;
  truncated: boolean;
}
```

`GoalStopHookOptions` 增加必需的私有 getter；如果 V1 已有 `runtimeContext`/`getRuntimeContext`，直接改其返回类型并删除 `toolResults`、`progress` 字段。

```ts
export interface GoalStopHookOptions {
  // existing fields...
  getRuntimeContext: () => GoalJudgeRuntimeContext | undefined;
}
```

使用 getter 而不是构造时传值，因为 hook 在 `Engine.run()` 内先注册，最近对话要到每一次 `on_stop` 前才生成；getter 也避免 hook 闭包长期持有旧 `Message[]`。

#### prompt 与 cache key

- 把 `JUDGE_SYSTEM` 中“agent 最近的输出”改为“agent 最近若干个完整 API round 的对话”。明确要求：工具返回的失败/缺失证据优先于 assistant 自述，不能仅凭最后一句“完成了”判定 `met:true`。
- 主 user prompt 保留目标、目标设定时间、当前时间、后台任务清单；把单独的 `finalText` 段替换成：

```text
最近的完整对话（已按 API round 截取并脱敏）:
<conversation>
...
</conversation>
```

- `GoalJudgeLLM` 仍接收一个普通 string user message，不直接发送原生 `tool_use/tool_result` wire blocks。原因是 judge 子调用不携带 tool definitions，而不同 provider 对“历史中有 tool_use、当前请求无 tools”及首条 assistant message的约束不同。`renderedConversation` 必须完整表达角色、tool 名、tool id、参数、结果和错误标志即可。
- verdict cache key 从 `${goal} ${finalText} ...` 改为 `${goal} ${runtime.digest} ${backgroundTasks} ${minuteBucket}`。这样即使最后文本相同，只要此前工具结果变化就会重新判定；现有分钟桶继续保证时间截止不会被永久缓存（当前逻辑在 `packages/core/src/hooks/goal-stop-hook.ts:234-245`）。
- 若 `getRuntimeContext()` 返回 `undefined`，记录 `goal_stop.context_missing`，并按现有 judge 失败策略返回 `continueSession:true`，不要退回仅用 `finalText` 的盲判。这样接线回归会显性暴露且不会静默放过未完成目标。
- `ctx.data.finalText` 仍由 TurnLoop 提供，供其他公共 stop hooks 使用；内置 judge 不再读取它。

#### 删除项

若 V1 已合并，删除以下整套过渡机制：

- `toolResults`/`progress` 字段及其 append/update API；
- “最多 12 条工具结果”的队列；
- 单结果 1,600 字符 head-tail 截断；
- 对工具结果和 progress 分段渲染的 prompt helper；
- 只以 finalText/toolResults/progress 组成的 verdict cache key 和对应测试。

### 3.2 新增 `packages/core/src/engine/goal-judge-context.ts`

该文件只做纯数据变换，不依赖 HookRegistry、Engine、ToolExecutor 或 provider，便于精确单测。建议接口：

```ts
export interface BuildGoalJudgeContextOptions {
  maxRounds?: number;       // default 6
  maxEstimatedTokens?: number; // default 3_000
  maxChars?: number;        // default 12_000
  sensitiveToolResultRedactions?: ReadonlyMap<string, string>;
}

export function buildGoalJudgeRuntimeContext(
  messages: readonly Message[],
  options?: BuildGoalJudgeContextOptions,
): GoalJudgeRuntimeContext;
```

实现顺序固定如下：

1. 浅复制输入，调用 `sanitizeMessages(messages, { sensitiveToolResultRedactions })` 处理顶层图片并再次替换敏感 tool result。当前 sanitizer 只遍历 message 顶层 blocks（`packages/core/src/logging/sanitize-messages.ts:131-159`），所以 builder 还必须递归清洗 `tool_result.content` 内嵌的 image；可在本模块包一层纯递归 walker，或先把 sanitizer 扩成递归实现并补其回归测试。即使 Transcript 已存替代文本，也保留这道防线。
2. 过滤 `reasoning` block 的正文，只保留 `[reasoning omitted]` 标记。Goal 完成判断不应把隐藏推理再次发给另一个模型，也避免 DeepSeek reasoning payload 放大上下文。
3. 调用 `groupMessagesByApiRound()`；取最后 `maxRounds` 组。数组顺序不变，不拆 `tool_use/tool_result` 对。
4. 用既有 `estimateTokens()`（`packages/core/src/context/compaction.ts:18-23`）估算。超过 token/字符上限时，从最老的完整 round 开始逐组删除，至少保留最新一组。
5. 如果单个最新 round 本身超过上限，才启用“单轮应急裁剪”：保留每条消息、每个 tool_use/tool_result 的结构和 id，仅缩短 text、tool input JSON 或 tool result content，并写入 `[truncated for goal judge; originalChars=N]`。这不是恢复 V1 的逐条采集器，只是总预算的最后保险。
6. 以确定性文本格式渲染。例如：

```text
[round 1]
USER:
...
ASSISTANT TOOL_USE id=t1 name=Read input={...}
TOOL_RESULT tool_use_id=t1 error=false:
...
ASSISTANT:
...
```

7. digest 使用 SHA-256（只保留日志展示所需的前 16 个 hex 字符即可），输入是完整 `renderedConversation`；不要使用 `JSON.stringify` 的对象键自然顺序作为长期协议。

注意：工作 `messages` 中的 `role:"user"` 可能承载 tool result，这是 core 的正常内部形状（`packages/core/src/types.ts:29-34`）；renderer 必须按 content block 类型标注，不能只按 role 把 tool result 误写成普通用户话语。

### 3.3 `packages/core/src/engine/turn-loop.ts`

在 `TurnLoopDeps` 增加私有发布回调：

```ts
publishGoalJudgeContext?: (context: GoalJudgeRuntimeContext) => void;
```

只使用 `import type` 引用 `GoalJudgeRuntimeContext`；builder 来自 `./goal-judge-context.js`。在 `messages.push({ role: "assistant", content: finalText })` 后、`emitHook("on_stop", ...)` 前（当前 `packages/core/src/engine/turn-loop.ts:995-1006`）生成快照：

```ts
const judgeMessages = this.stripVolatileContextMessages(
  this.redactConsumedSensitiveToolResults(messages),
);
this.deps.publishGoalJudgeContext?.(
  buildGoalJudgeRuntimeContext(judgeMessages, {
    sensitiveToolResultRedactions: this.sensitiveToolResultRedactions,
  }),
);
```

关键约束：

- 必须在最终 assistant message 已入数组之后生成，确保当前 stop 输出属于最新 round。
- 必须调用现有 `stripVolatileContextMessages()`（`packages/core/src/engine/turn-loop.ts:429-443`），避免 skills/git status/memory/goal guidance 伪装成“对话证据”。
- 不调用 `Transcript.toMessages()` 作为主源：正在运行的工作数组已经包含当前 compaction 结果、steer 和 hook 注入，更接近主模型实际上下文。Transcript 仅作为以后脱离 TurnLoop 判定时的 fallback 数据源。
- `emitHook("on_stop", { goal, finalText, turnCount })` 的公开 data 形状保持原样。
- 不在每个工具执行点累积 context；只在真正触发 stop judge 时构建一次，避免正常工具轮的额外复制/序列化成本。

### 3.4 `packages/core/src/engine/engine.ts`

在单次 `run()` 的闭包内增加：

```ts
let latestGoalJudgeContext: GoalJudgeRuntimeContext | undefined;
```

接线点：

- `createGoalStopHook()`（当前 `packages/core/src/engine/engine.ts:1937-1964`）增加 `getRuntimeContext: () => latestGoalJudgeContext`。
- `new TurnLoop()` deps（当前 `packages/core/src/engine/engine.ts:1980-2057`）增加 `publishGoalJudgeContext: context => { latestGoalJudgeContext = context; }`。
- 变量必须是 run-scoped，而不是 Engine 字段，防止同一 Engine 的下一次 run 误用上一次 stop 的快照，也避免 sid 间串线。
- finally 中无需显式清理闭包；若实现时为了诊断提升为 Engine 字段，则必须按 sid map 且在 finally 删除，本方案不推荐该复杂度。

### 3.5 `packages/core/src/hooks/events.ts`

不改任何接口。只更新 `on_stop` 注释：公共 context 仍只携带 `goal/finalText/turnCount`；内置 Goal judge 的完整对话通过私有运行时通道获得。这样后续维护者不会为了“补上下文”误把 messages 放进公共 `ctx.data`。

## 4. 分阶段实施顺序

1. **先落纯 builder 和测试**：新增 `goal-judge-context.ts`，完成 round 选择、渲染、预算、图片/敏感数据清洗；此阶段不碰运行链路。
2. **接 TurnLoop 私有发布点**：在 `on_stop` 前生成快照，增加 TurnLoop 单测，确认公共 HookContext 没有 conversation 字段。
3. **接 Engine 闭包**：把 run-scoped context 从 TurnLoop 送到 Goal hook getter；先让 hook 只记录 context 元数据，确认每次 stop 都刷新。
4. **切 judge prompt/cache key**：改为 rendered conversation + digest，并把 context missing 设为 fail-closed。
5. **删除 V1 采集器**：如果 V1 已合并，最后删 `toolResults/progress`、12 条/1600 字符/head-tail 逻辑和旧测试，避免在切换期间同时维护两个真相来源。
6. **补集成回归**：覆盖工具失败、相同 finalText 不同工具结果、compaction 后最近轮、敏感结果。确认后再调整默认 N/预算；不要先凭感觉扩大 judge 输入。

## 5. 测试策略

### 5.1 新增 `packages/core/src/engine/goal-judge-context.test.ts`

至少包含：

1. 文本对话按顺序渲染 user/assistant。
2. assistant `tool_use` 与后续 user `tool_result` 保持同一 API round，id/name/input/result 都存在。
3. 超过 N 个 round 时仅删除最老组，最新 N 组原序保留。
4. token 或字符超限时先整轮丢弃，不从中间切断 tool pair。
5. 单个超大最新 round 触发应急标记，最终 chars 不超过硬上限。
6. image/base64 被替换为元数据/omitted 标记，输出不含原始 payload。
7. redaction map 命中的 tool result 只出现 transcript/display 替代值，不出现敏感明文。
8. reasoning 正文不进入 rendered conversation。
9. 相同输入 digest 稳定；任一工具结果变化 digest 改变。
10. 空消息得到明确 `(无最近对话)`，而不是抛错。

### 5.2 扩充 `packages/core/src/hooks/goal-stop-hook.test.ts`

保留当前三态、waiting guard、时间、abort、unparseable、judge failure 测试（现有文件 `packages/core/src/hooks/goal-stop-hook.test.ts:58-294`），并增加：

1. prompt 包含完整 conversation，且不再出现旧“agent 最近的输出”段。
2. prompt 可见工具失败，即使最后 assistant 文本声称成功。
3. 相同 digest + 同一分钟命中 verdict cache。
4. finalText 相同但 conversation digest 不同会重新调用 judge。
5. `getRuntimeContext()` 缺失返回 fail-closed continuation 且不调用 judge。
6. judge 日志只含 digest/roundCount/chars，不含 conversation 正文。

测试 helper `fakeJudge` 需继续捕获 `lastUserContent`；每个构造 hook 的测试都提供最小 runtime context fixture。

### 5.3 扩充 TurnLoop 测试

在 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts` 或独立 `turn-loop-goal-judge-context.test.ts` 增加：

1. `publishGoalJudgeContext` 在 `on_stop` handler 执行前已被调用。
2. 快照包含当前最终 assistant message。
3. 工具轮中 tool_use/tool_result 俱全。
4. `volatileContextMessages` 不进入快照。
5. `sensitive:true` 结果进入快照时已是替代文本。
6. `hooks.emit` 捕获到的公共 data 仍只有既有字段，不出现 `messages`、`conversation` 或 `toolResults`。

### 5.4 Engine 集成回归

扩充 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts` 的 fake provider 场景：主模型先调用一个返回失败文本的工具，再输出“done”；aux judge 捕获的 user prompt 必须包含失败结果。另加 resume/compaction 场景，确保 run-scoped getter 读取本次最新快照而非上一 run。

实施完成后的建议定向命令（本文阶段不执行）：

```bash
bun test packages/core/src/engine/goal-judge-context.test.ts
bun test packages/core/src/hooks/goal-stop-hook.test.ts
bun test packages/core/src/engine/turn-loop-goal-lifecycle.test.ts
```

## 6. 风险与兼容性注意

- **judge 成本上升**：完整 round 必然比 finalText/单抽工具结果更长。默认 N 与双上限必须保守，并在日志记录 `selectedRoundCount/estimatedTokens/chars/truncated` 便于调参。
- **“完整 round”与硬上限冲突**：优先整轮删除；只有单个最新 round 自身超限时才允许块内裁剪，并必须保留 tool pair 元数据和显式 truncated 标记。
- **分组语义**：现有 helper 以 assistant 为新组边界，最初的纯 user 前缀可能单独成组。不要把“最近 N round”实现成简单 `messages.slice(-N)`；测试必须钉住当前 helper 的行为。
- **compaction**：应基于 TurnLoop 当前工作 messages 判定，不把被 summary 替换的旧明文重新从 Transcript 拉回 judge；否则既增加成本，也与主模型的当前认知不一致。
- **敏感信息**：禁止把 conversation 放进 HookContext、StreamEvent 或普通日志。digest 只用于相等性/归因，不可作为安全脱敏的替代；发送前仍需实际替换敏感内容。
- **图片与嵌套 tool_result content**：清洗器必须递归处理 tool result 内的 image block；不能只处理顶层 Message image。
- **provider 兼容**：采用文本序列化而不是原生 tool history，避免 judge 子调用在不同 provider 上因无 tool definitions、role 起始或 tool pairing规则报 400。
- **持久化兼容**：不新增 state.json/transcript event 字段，不迁移历史 session；旧 session resume 后从当前工作 messages 同样能构建最近 round。
- **Hook 兼容**：公共 `on_stop` data 和 `HookResult` 不变。第三方 hook 仍看到 `finalText`，只有内置 GoalStopHook 改用私有 getter。
- **并发隔离**：context 必须留在 `Engine.run()` 局部闭包内。不要放单一 `Engine.latestGoalJudgeContext` 字段，否则未来同 Engine 并发 run 或 sid 切换会串话。

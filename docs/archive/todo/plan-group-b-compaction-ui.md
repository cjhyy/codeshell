# Group B Compaction UI 技术方案

调研日期：2026-07-08

范围：只覆盖 desktop renderer 的手动 `/compact` UI 体验与 context ring 展示修正。方案不要求改 core 协议、不 runtime import 其他 codeshell 包；renderer 继续只通过 `window.codeshell.*` 与 main 通信。

## 现状总览

这三项问题共享同一条路径：

1. 用户在 `ChatView` 输入或选择 `/compact`。
2. `ChatView` 调用 `App.compactActiveSession()`。
3. `App` 通过 `window.codeshell.compactSession(engineSessionId)` 发起 IPC。
4. core protocol 在压缩真实缩小时发送 `context_compact` stream event，同时 RPC 返回 `{ before, after, strategy }`。
5. renderer reducer 把 `context_compact` 折成 `context_boundary` 消息，`App` 另外手动派发 `usage_update` 更新 ring。

关键锚点已按当前代码确认：

- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:241)：`busyKeys` 是现有 per-bucket 运行态。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:335)：`busy = busyKeys.has(activeBucket)`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2443)：`compactActiveSession` 只在触发前检查 `busyKeys.has(activeBucket)`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2454)：调用 `window.codeshell.compactSession(engineSessionId)` 后没有 in-flight UI state。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2462)：成功后手写 `usage_update`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2463)：`promptTokens` 当前直接写 `data.after`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:3437)：`onCompactCommand={compactActiveSession}` 传给 `ChatView`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:3474)：`contextTokens={state.promptTokens}` 传给 ring。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:466)：注释明确 busy 不禁用 textarea，Enter 会排队。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:551)：slash 命令执行入口。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:576)：`text === "/compact"` 时直接执行命令。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:592)：busy 时普通输入走 `onQueueInput`。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:1228)：textarea placeholder。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:1229)：textarea 固定 `disabled={false}`。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:1288)：`ContextRing` 使用 `contextTokens`。
- [packages/desktop/src/renderer/chat/ContextRing.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/chat/ContextRing.tsx:78)：`ratio = used / safeMax`，没有额外校正。
- [packages/desktop/src/renderer/messages/ContextBoundaryView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/messages/ContextBoundaryView.tsx:9)：横幅是简单居中灰字。
- [packages/desktop/src/renderer/chat/compactFeedback.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/chat/compactFeedback.ts:65)：`compactBoundaryDetail()` 生成当前横幅详情文案。
- [packages/desktop/src/renderer/types.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/types.ts:799)：`context_compact` reducer 追加 `context_boundary`。
- [packages/desktop/src/renderer/types.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/types.ts:866)：`usage_update` reducer 更新 `promptTokens`，单轮/累计 cache 字段独立保留。
- [packages/desktop/src/preload/index.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/preload/index.ts:396)：preload 暴露 `compactSession()`。
- [packages/core/src/protocol/server.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/protocol/server.ts:1400)：protocol 调用 `engine.forceCompact()`。
- [packages/core/src/protocol/server.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/protocol/server.ts:1401)：仅 `before > after` 时额外发送 `context_compact`。
- [packages/core/src/engine/engine.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/engine.ts:2913)：`forceCompact` 的 `before` 来自 `estimateTokens(sourceMessages)`。
- [packages/core/src/engine/engine.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/engine.ts:2969)：`forceCompact` 的 `after` 来自 `estimateTokens(compacted)`。
- [packages/core/src/engine/turn-loop.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/turn-loop.ts:440)：正常运行路径知道 message estimate 缺 system/tool overhead。
- [packages/core/src/engine/turn-loop.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/turn-loop.ts:465)：真实 provider usage 会反推并缓存 overhead。

## 共享设计

新增 renderer-only per-bucket 临时状态：

```tsx
const [compactingBuckets, setCompactingBuckets] = useState<Set<string>>(() => new Set());
const compacting = compactingBuckets.has(activeBucket);

const setCompactingForKey = (key: string, val: boolean): void => {
  setCompactingBuckets((prev) => {
    const had = prev.has(key);
    if (had === val) return prev;
    const next = new Set(prev);
    if (val) next.add(key);
    else next.delete(key);
    return next;
  });
};
```

状态放在 `App`，不要放进 `MessagesReducerState` 或 transcript。理由：compaction in-flight 是纯 UI/RPC 生命周期，不应持久化，也不应该影响历史合并、hydration 或 sidebar session status。

`ChatView` 新增 prop：

```tsx
compacting?: boolean;
```

由 `App` 传入：

```tsx
<ChatView
  ...
  busy={busy}
  compacting={compacting}
/>
```

`busy` 仍表示 agent turn 正在运行；`compacting` 表示手动 `/compact` RPC 正在飞行。两者不要合并到 `busyKeys`，否则 sidebar 会误显示 running，Stop 按钮也会暗示可以取消压缩，但当前 preload API 没有 compact cancel。

## Feature 1：`/compact` 进行中缺 UI 反馈和输入禁用

### 涉及文件与锚点

- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:241)：新增 `compactingBuckets` 建议靠近 `busyKeys`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2443)：改造 `compactActiveSession()`。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:3437)：传递 `compacting` 到 `ChatView`。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:49)：`Props` 增加 `compacting?: boolean`。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:466)：调整 busy 不禁用输入的注释，说明 compacting 是例外。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:571)：`submit()` 增加 compacting guard。
- [packages/desktop/src/renderer/ChatView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/ChatView.tsx:1229)：textarea 改成 `disabled={compacting}`。
- [packages/desktop/src/renderer/i18n/ns/chat.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/i18n/ns/chat.ts:6)：增加 composer compacting 文案。
- [packages/desktop/src/renderer/i18n/ns/chat.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/i18n/ns/chat.ts:37)：增加 compact in-flight toast 文案。

### 当前实现分析

`compactActiveSession()` 当前只检查 agent turn 是否 busy：

```tsx
if (busyKeys.has(activeBucket)) {
  toast({ message: t("chat.compact.running"), variant: "error" });
  return;
}
```

之后直接发起 `window.codeshell.compactSession(engineSessionId)`，但没有任何 state 标记这个 Promise 已经 in-flight。因此：

- 用户看不到“正在压缩”的明确反馈。
- textarea 因 `disabled={false}` 仍可输入。
- Enter 仍可能提交普通消息；如果 `busy=false`，会直接 `onSend`。
- 再次输入 `/compact` 会再次调用 `compactSession()`，可能并发压缩同一 engine session。
- busy 队列逻辑不能复用，因为 busy 的语义是 agent turn，可排队、可 Stop；compact 不是 turn。

### 具体改动步骤

1. 在 `App` 增加 `compactingBuckets` 和 `setCompactingForKey()`。

2. 在 `compactActiveSession()` 开头增加重复触发保护。策略选择“忽略重复触发并提示一次”，不合并 Promise：

```tsx
const compactActiveSession = (): void => {
  if (busyKeys.has(activeBucket)) {
    toast({ message: t("chat.compact.running"), variant: "error" });
    return;
  }
  if (compactingBuckets.has(activeBucket)) {
    toast({ message: t("chat.compact.inProgress"), variant: "default" });
    return;
  }

  const bucket = activeBucket;
  const engineSessionId = resolveEngineSessionIdForBucket(bucket);
  if (!engineSessionId) {
    toast({ message: t("chat.compact.noSession"), variant: "error" });
    return;
  }

  const promptTokensBefore = state.promptTokens;
  setCompactingForKey(bucket, true);
  void window.codeshell
    .compactSession(engineSessionId)
    .then((result) => {
      ...
    })
    .catch(...)
    .finally(() => setCompactingForKey(bucket, false));
};
```

3. `ChatView` prop 增加 `compacting = false`，并派生 UI 状态：

```tsx
const controlsDisabled = busy || compacting;
const inputDisabled = compacting;
const placeholder = compacting
  ? t("chat.composer.placeholderCompacting")
  : busy
    ? t("chat.composer.placeholderBusy")
    : t("chat.composer.placeholderIdle");
```

保留 busy 时 textarea 可输入/排队的现有行为；仅 compacting 禁用输入。

4. `submit()` 和 slash 执行入口都加保护：

```tsx
const executeSlashCommand = (item: SlashCommandItem): void => {
  if (compacting) return;
  if (item.name === "/compact") { ... }
};

const submit = (): void => {
  if (compacting) return;
  ...
};
```

5. textarea 与 composer 控件：

```tsx
<textarea
  ...
  placeholder={placeholder}
  disabled={inputDisabled}
/>
```

所有会改变发送上下文或发起动作的控件用 `controlsDisabled` 或 `busy || compacting`：

- 添加图片按钮：`disabled={busy || compacting}`。
- `PermissionPill`、`GoalToggle`：`disabled={controlsDisabled}`。
- `ModelPill`：`disabled={busy || compacting}`。
- send button 显示条件改为 `!busy && !compacting`。
- `ProjectPicker`、`BranchPicker`：`disabled={busy || compacting}`。
- voice button 可按保守策略 `disabled={compacting || voiceState === "transcribing" || ...}`，避免压缩期间转写回填 draft。

6. 在 composer 里增加一条低干扰状态行，复用当前 `runningAgents` 状态行风格：

```tsx
{compacting && (
  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
    <Loader2 size={12} className="animate-spin" />
    <span>{t("chat.composer.compacting")}</span>
  </div>
)}
```

7. i18n key：

中文：

```ts
chat.composer.placeholderCompacting = "正在压缩上下文…"
chat.composer.compacting = "正在压缩上下文…"
chat.compact.inProgress = "上下文正在压缩，请稍候。"
```

英文：

```ts
chat.composer.placeholderCompacting = "Compacting context…"
chat.composer.compacting = "Compacting context…"
chat.compact.inProgress = "Context compaction is already in progress."
```

### 状态 / reducer / i18n

- 新增 React state：`compactingBuckets: Set<string>`。
- 不新增 reducer action；不写 transcript。
- `ChatView` 新 prop：`compacting?: boolean`。
- 新 i18n key：`chat.composer.placeholderCompacting`、`chat.composer.compacting`、`chat.compact.inProgress`。

### 风险与边界情况

- 活动 session 切换：state 按 bucket 存，A 会话压缩中切到 B，不会禁用 B；切回 A 仍显示压缩中。
- RPC 失败：必须在 `.finally()` 清掉 bucket，否则 composer 会永久禁用。
- session 不存在：不要设置 compacting；直接 toast。
- agent busy 与 compacting 理论上互斥，因为触发前挡 busy；但 UI 仍按 `busy || compacting` 处理，防御异步事件竞争。
- 压缩期间不支持取消：不要显示 Stop，不要把 compacting 合入 `busyKeys`。

### 体量估计

S-M。约 50-80 行改动，主要在 `App.tsx` 和 `ChatView.tsx`，另有 i18n 文案。建议补 1-2 个 renderer 单测或组件测试覆盖重复触发与 disabled 状态。

## Feature 2：上下文占用环压缩后虚低

### 涉及文件与锚点

- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2463)：当前 `promptTokens: data.after` 是问题根源。
- [packages/desktop/src/renderer/App.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:3474)：ring 的 `contextTokens` 来自 `state.promptTokens`。
- [packages/desktop/src/renderer/chat/ContextRing.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/chat/ContextRing.tsx:78)：ring 直接用 `used / safeMax`。
- [packages/desktop/src/renderer/types.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/types.ts:866)：`usage_update` reducer 可以只更新 `promptTokens`，不影响 cache 指标。
- [packages/core/src/engine/engine.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/engine.ts:2913)：manual compact 返回的 `before` 是纯消息估算。
- [packages/core/src/engine/engine.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/engine.ts:2969)：manual compact 返回的 `after` 也是纯消息估算。
- [packages/core/src/engine/turn-loop.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/core/src/engine/turn-loop.ts:440)：正常运行路径已说明纯消息估算缺少 system prompt + tool defs overhead。

### 当前实现分析

`ContextRing` 本身没有问题，它只负责渲染 `used`：

```tsx
const ratio = Math.max(0, Math.min(1, used / safeMax));
```

问题在 `App.compactActiveSession()` 成功后派发：

```tsx
event: {
  type: "usage_update",
  promptTokens: data.after,
} as StreamEvent
```

core 的 `forceCompact()` 返回值不是 provider 的真实 prompt usage，而是 `estimateTokens(messages)` 的消息体估算。它不含：

- system prompt；
- tool schema；
- memory/user context 注入；
- provider-specific framing；
- 其他固定或半固定 prompt overhead。

正常 turn-loop 在 provider 返回 usage 后会反推 overhead，并在后续 message-estimate emit 中叠加；manual `/compact` 的 renderer 成功路径绕过了这个校正，所以 ring 压缩后会突然偏低，下一轮真实 `usage_update.promptTokens` 到来时再跳高。

### 具体改动步骤

首选方案：在 renderer 的 manual compact 成功路径用“最近展示的 promptTokens - compact before”作为 baseline anchor，压缩后展示 `after + baseline`。不改 core API。

1. 在触发 compact 时捕获当前 bucket 的 ring 分子：

```tsx
const promptTokensBefore = state.promptTokens;
```

此值是用户压缩前看到的最新 `promptTokens`。如果之前已有真实 provider usage 或 turn-loop 校正过的估算，它已经包含 overhead。

2. 成功后计算 baseline：

```tsx
function promptTokensAfterManualCompact(
  result: { before: number; after: number },
  promptTokensBefore: number,
): number {
  const safeBefore = Number.isFinite(result.before) ? Math.max(0, result.before) : 0;
  const safeAfter = Number.isFinite(result.after) ? Math.max(0, result.after) : 0;
  const safePromptBefore = Number.isFinite(promptTokensBefore)
    ? Math.max(0, promptTokensBefore)
    : 0;
  const baseline = Math.max(0, safePromptBefore - safeBefore);
  return safeAfter + baseline;
}
```

3. 对 no-op 结果不要把 ring 改小。当前 no-op 也会 dispatch `data.after`，应该改成 no-op 只 toast，不派发 ring 更新，或派发 `promptTokensBefore`：

```tsx
const didShrink = data.after < data.before;
if (didShrink) {
  dispatch({
    type: "stream",
    bucket,
    event: {
      type: "usage_update",
      promptTokens: promptTokensAfterManualCompact(data, promptTokensBefore),
    } as StreamEvent,
  });
} else {
  toast({ message: compactOutcomeMessage(data, t, lang), variant: "success" });
}
```

如果希望压缩后即使 no-op 也刷新为更可信的值，可以使用：

```tsx
promptTokens: Math.max(promptTokensBefore, promptTokensAfterManualCompact(data, promptTokensBefore))
```

但推荐 no-op 不动 ring，避免“无需压缩”反而改变数字。

4. helper 放置建议：

- 若只在 `App.tsx` 使用，放在 `compactActiveSession` 附近的本地小函数，减少公共 API。
- 若要加单测，放到 `packages/desktop/src/renderer/chat/compactFeedback.ts`，命名为 `compactPromptTokensWithBaseline()`，并在 `compactFeedback.test.ts` 加用例。

建议为了可测性放到 `compactFeedback.ts`：

```ts
export function compactPromptTokensWithBaseline(
  result: CompactFeedbackInput,
  currentPromptTokens: number,
): number {
  const baseline = Math.max(0, safe(currentPromptTokens) - safe(result.before));
  return safe(result.after) + baseline;
}
```

5. `usage_update` reducer 无需改。当前 reducer 在没有 single-turn/cumulative 字段时只更新 `promptTokens`，并保留 cache tooltip 指标，符合需求。

### 状态 / reducer / i18n

- 不新增持久状态。
- 可新增纯 helper：`compactPromptTokensWithBaseline()`。
- 不新增 reducer action；沿用 `usage_update`。
- 不新增 i18n key。

### 风险与边界情况

- `promptTokensBefore` 为 0：baseline 为 0，表现退化为当前 `data.after`；这是新会话或从未收到 usage 的可接受 fallback。
- `data.before` 高于 `promptTokensBefore`：baseline clamp 到 0，避免负数。
- 工具 schema 或 memory 在压缩期间变化：baseline 可能略旧，但下一轮真实 provider usage 会校正；比直接 `data.after` 更接近真实值。
- 连续 compact：第一次会保留 baseline；第二次用当前展示值减新的 `before`，baseline 会继续保留。
- core 未来如果把 `forceCompact().after` 改为真实 prompt usage：该 helper 会重复加 baseline。因此可在代码注释中明确当前依据是 `engine.ts:2913/2969` 的 `estimateTokens()`，若 core API 语义变更要同步删除 renderer baseline。

### 体量估计

S-M。约 15-35 行生产改动，若抽 helper 加测试再增加约 20-40 行。风险集中在 token 数字语义，建议必须补 helper 单测：

- `current=60_000, before=45_000, after=20_000 => 35_000`。
- `current < before => after`。
- no-op 不改变 ring。

## Feature 3：压缩完成横幅 UI 粗糙

### 涉及文件与锚点

- [packages/desktop/src/renderer/messages/ContextBoundaryView.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/messages/ContextBoundaryView.tsx:9)：当前 UI 是一行 `— title — detail`。
- [packages/desktop/src/renderer/chat/compactFeedback.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/chat/compactFeedback.ts:43)：`compactSuccessParams()` 统一生成 before/after/percent/strategy。
- [packages/desktop/src/renderer/chat/compactFeedback.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/chat/compactFeedback.ts:65)：`compactBoundaryDetail()` 当前返回整句 detail。
- [packages/desktop/src/renderer/i18n/ns/chat.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/i18n/ns/chat.ts:37)：中文 compact 文案标点和空格粗糙。
- [packages/desktop/src/renderer/i18n/ns/chat.ts](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/i18n/ns/chat.ts:236)：英文 compact 文案也有 ASCII hyphen 和句式不统一。
- [packages/desktop/src/renderer/MessageStream.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/MessageStream.tsx:254)：普通流渲染 `ContextBoundaryView`。
- [packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/messages/TurnProcessGroupCard.tsx:147)：turn group 内也复用 `ContextBoundaryView`。

### 当前实现分析

当前组件：

```tsx
<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-2 text-center text-xs text-muted-foreground">
  <span>— {t("chat.compact.boundaryTitle")} —</span>
  <span>{compactBoundaryDetail(message, t, lang)}</span>
</div>
```

问题：

- 手写破折号承担结构，视觉上像临时 debug marker。
- 没有分隔线，和上下消息之间层级不清。
- 没有图标，用户不能快速扫描“这是系统事件/压缩事件”。
- detail 是一整句，数字、节省比例、策略没有结构化。
- i18n 中文缺少全角标点/空格，英文 `minimal - nothing` 应改为更正式的 dash 或重写句式。

### 具体改动步骤

1. `ContextBoundaryView.tsx` 引入 lucide 图标，例如：

```tsx
import { Archive } from "lucide-react";
```

`Archive` 已在 `ChatView` slash command 中用于 `/compact`，语义一致。

2. 将横幅改为正式居中系统事件条：

```tsx
function ContextBoundaryViewImpl({ message }: { message: ContextBoundaryMessage }) {
  const { t, lang } = useT();
  return (
    <div className="my-3 flex items-center gap-3 px-4 text-xs text-muted-foreground">
      <div className="h-px min-w-6 flex-1 bg-border" />
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 shadow-sm">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <Archive size={14} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {t("chat.compact.boundaryTitle")}
          </span>
          <span className="block truncate tabular-nums">
            {compactBoundaryDetail(message, t, lang)}
          </span>
        </span>
      </div>
      <div className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}
```

说明：

- 外层左右细线提供系统事件分隔。
- 中间 chip/card 半径用 `rounded-md`，符合现有 8px 以内约束。
- `max-w-full` + `truncate` 防止窄屏溢出；必要时可以把中间容器改成 `sm:flex-row` / 默认纵向，但优先保持 compact。
- 不在 `MessageStream` 和 `TurnProcessGroupCard` 分别改，复用组件即可覆盖两处渲染。

3. 调整 `compactFeedback.ts` 的 detail 输出格式。保留 helper 入口，文案改为结构化片段：

中文：

```ts
done: "已压缩：{before} → {after} tokens（省 {percent}%）· 策略：{strategy}",
unchanged: "上下文已是最简，无需压缩（当前约 {tokens} tokens）。",
boundaryTitle: "上下文已压缩",
boundaryDetail: "{before} → {after} tokens · 省 {percent}% · {strategy}",
failed: "压缩失败：{error}",
```

英文：

```ts
done: "Context compacted: {before} → {after} tokens · saved {percent}% · strategy: {strategy}.",
unchanged: "Context is already minimal; nothing to compact (about {tokens} tokens).",
boundaryTitle: "Context compacted",
boundaryDetail: "{before} → {after} tokens · saved {percent}% · {strategy}",
failed: "Compaction failed: {error}",
```

4. 如果需要更强结构化，可拆 `compactBoundaryDetail()` 为数组或新增：

```ts
export function compactBoundaryParts(...) {
  return {
    tokenDelta: t("chat.compact.boundaryTokens", { before, after }),
    saved: t("chat.compact.boundarySaved", { percent }),
    strategy,
  };
}
```

但第一版不建议拆太细。当前 `ContextBoundaryMessage` 已有 `before/after/strategy`，一条 detail 字符串足够。

### 状态 / reducer / i18n

- 不新增状态。
- 不改 reducer；`ContextBoundaryMessage` 当前字段足够。
- 修改现有 i18n key：`chat.compact.done`、`chat.compact.unchanged`、`chat.compact.boundaryDetail`、`chat.compact.failed`。
- 可保留 `chat.compact.boundaryTitle` 原 key。

### 风险与边界情况

- 横幅可能出现在 `TurnProcessGroupCard` 内，外层卡片已有边界。`my-3 px-4` 若显得太占空间，可在组件内用更轻的 `my-2`；不要在调用处分叉。
- 窄屏长数字和长 strategy：使用 `truncate` 和 `tabular-nums`；未知 strategy 原样展示，可能很长。
- `compactWasNoop()` 时 protocol 不发 `context_compact`，所以横幅只表示确实缩小的压缩事件；no-op 仍只 toast。

### 体量估计

S。约 20-45 行改动，主要是组件 JSX 和文案。建议更新 `compactFeedback.test.ts` 的期望字符串。

## 实施顺序

1. 先做 Feature 1 的 `compactingBuckets`，因为它保护后续两项在用户层面不被重复触发打乱。
2. 再做 Feature 2，在同一个 `compactActiveSession().then()` 中把 `promptTokens` 改为 baseline 后的数值。
3. 最后做 Feature 3，纯展示改造，与状态逻辑解耦。

三者关系：

- Feature 1 和 Feature 2 都改 `App.compactActiveSession()`，应一次性处理，避免重复触碰 Promise 生命周期。
- Feature 2 不应该依赖 Feature 3 的横幅；ring 更新来自 RPC result，横幅来自 stream event。
- Feature 3 不应该新增手动 dispatch；继续消费 reducer 已生成的 `context_boundary`。

## 验证建议

手工验证：

1. 空会话输入 `/compact`：toast “当前还没有可压缩的会话”，composer 不进入 compacting。
2. busy 会话输入 `/compact`：toast “当前会话正在运行...”，仍不进入 compacting。
3. idle 有历史会话输入 `/compact`：textarea 禁用，显示“正在压缩上下文…”，send/model/permission/project 等控件禁用。
4. 压缩 Promise 未完成时再次触发 `/compact`：只提示 in-progress，不发第二个 RPC。
5. 压缩成功且 `before > after`：出现系统事件条；ring 从 `current` 下降到 `after + baseline`，不应掉到纯 `after`。
6. 下一轮真实 usage 到来：ring 可小幅校正，但不应出现从极低值突然跳大。
7. no-op：toast unchanged，不出现横幅，ring 不降低。

自动化建议：

- `packages/desktop/src/renderer/chat/compactFeedback.test.ts`：
  - 更新中英文文案期望。
  - 若新增 `compactPromptTokensWithBaseline()`，覆盖 baseline 计算。
- `ChatView` 组件测试：
  - `compacting=true` 时 textarea disabled，placeholder 为 compacting 文案，send button 不可用。
  - `busy=true, compacting=false` 时 textarea 仍可用，保持现有排队行为。
- `App` 级测试较重，可用 mock `window.codeshell.compactSession` 验证重复触发只调用一次；如果现有测试基础不适合，先保留手工验证。

## 改动文件清单

预计需要改动：

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/chat/ContextRing.tsx`（可选；若只传 `busy || compacting` 或不改 tooltip，可不动）
- `packages/desktop/src/renderer/messages/ContextBoundaryView.tsx`
- `packages/desktop/src/renderer/chat/compactFeedback.ts`
- `packages/desktop/src/renderer/i18n/ns/chat.ts`
- `packages/desktop/src/renderer/chat/compactFeedback.test.ts`
- 可选新增/更新 `ChatView` 相关组件测试

本次调研/写方案实际只写入：

- `docs/archive/todo/plan-group-b-compaction-ui.md`

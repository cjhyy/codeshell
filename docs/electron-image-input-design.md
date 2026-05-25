# P2-6 图片输入：engine 侧消费设计

## 当前状态

Desktop renderer 已经能：

- 用拖拽 / 粘贴 / 点击 paperclip 上传图片到 composer。
- 在 thumbnail chip 上预览、单张删除。
- 通过新增的 `Capability.supportsVision` 判断当前模型是否支持视觉，模型不支持时展示「当前模型不支持图片」banner 并禁用发送按钮。
- `ModelOption` 增加 `supportsVision`；ModelPill 下拉给支持视觉的模型加了图标。
- 用 `encodeAttachmentsForWire()` 把图片以 `<codeshell-image mime="…">…</codeshell-image>` 块拼接到 `task` 字符串里，发送给 agent worker。

UI 半完成后 commit 是 `3e235ab feat(desktop+core): image input UI with vision-capability gating`。

剩下的工作是 **engine 侧实际把 `<codeshell-image>` 块还原成 LLM 协议里的 image content block**，并端到端跑通。本文档把这块工作拆开，给 subagent 用。

## 涉及的代码位置

- `packages/desktop/src/renderer/chat/attachments.ts` — wire 格式定义在 `encodeAttachmentsForWire`：
  ```
  <codeshell-image mime="image/png" name="screenshot.png">
  data:image/png;base64,iVBORw0KGgo…
  </codeshell-image>
  ```
- `packages/core/src/protocol/server.ts` — `handleRun` 接 RPC，调用 `engine.run(params.task, …)`。
- `packages/core/src/engine/engine.ts` — `async run(task: string, …)` 把 task 喂给 `engine` 主循环。
- `packages/core/src/llm/client-base.ts` & `packages/core/src/llm/providers/` — LLM client 把 message 组装成 provider-specific 协议。
- `packages/core/src/llm/capabilities/types.ts` — `Capability.supportsVision`（已加）。

## 目标

1. Engine 进入 `engine.run(task)` 时，**先解析 `<codeshell-image>` 块**，把它从 plain text 里抽出来。
2. 抽出来后，**用 provider 协议的 image content block** 把图片塞进 user message。
3. 如果当前 LLM client 配的 `Capability.supportsVision === false`，engine 应当：
   - 不要发送给 LLM；
   - 立刻返回一个错误 `EngineResult`，提示用户「当前模型不支持图片」；
   - **不要静默丢弃图片**。这是 checklist 反复强调的红线。
4. 写一个 RoundTrip 测试覆盖：vision-on + 一张 PNG → 调到 mock LLM；vision-off + 一张 PNG → 拒绝。
5. 不要破坏老的 `task: string` 兼容性 —— 没有 `<codeshell-image>` 块的字符串依旧按纯文本处理。

## 推荐实现路径

### Step 1：定义中间表示

加一个 `parseTaskWithImages(task: string)` 工具，返回：

```ts
interface ParsedTask {
  text: string;                 // 剩余的纯文本部分
  images: Array<{               // 解析出来的图片
    mime: string;
    name: string;
    dataUrl: string;
    base64: string;             // 去掉 "data:…;base64," 前缀的纯 base64
  }>;
  hasImages: boolean;
}
```

放在 `packages/core/src/engine/parse-task.ts`。**纯函数，覆盖单元测试**：

- 没有 image 块：返回 `text === input`，`images: []`。
- 一个 image 块：text 不含 image，images 长度 1，base64 正确。
- 多个 image 块（混合文本）：顺序保留。
- 损坏的 image 块（缺 `</codeshell-image>` 或 base64 解析失败）：抛错，调用方决定是丢还是 fail。

### Step 2：Engine.run 入口处理

在 `engine.ts` 的 `async run(task, options)` 顶部：

```ts
const parsed = parseTaskWithImages(task);
if (parsed.hasImages) {
  const cap = this.lastResolvedCapability ?? capabilitiesFor(kind, model);
  if (!cap.supportsVision) {
    return {
      text: "ERROR: 当前模型不支持图片输入。请切换到支持视觉的模型重试。",
      reason: "vision-not-supported",
      sessionId: …,
      turnCount: 0,
      usage: undefined,
    };
  }
}
// 把 parsed.text + parsed.images 一起喂给主循环，而不是原 task。
```

注意 engine 需要知道当前 (kind, model) —— 看 `engine.config.llm.{provider, model}` 即可。

### Step 3：传给 LLM client

LLM client 接受的消息形状已经是 OpenAI-compatible —— 看 `packages/core/src/llm/types.ts` 里的 `LLMMessage`。当前 user 消息是 `{ role: "user", content: string }`。需要支持：

```ts
{ role: "user", content: [
  { type: "text", text: "…" },
  { type: "image_url", image_url: { url: "data:image/png;base64,…" } },
] }
```

OpenAI / OpenRouter / Anthropic（4o-OpenAI-compat 那套）都吃这种数组形式。Anthropic 原生协议是 `{ type: "image", source: { type: "base64", media_type: …, data: … } }`；core 已经有 Anthropic native client，应该在 `packages/core/src/llm/providers/anthropic.ts` 里翻译一次。

具体落到代码：

- 把 `LLMMessage.content` 类型从 `string` 改成 `string | LLMMessageContentBlock[]`。
- `LLMMessageContentBlock` 至少包含 `{type:"text", text}` 和 `{type:"image", mime, base64}` 两种。
- OpenAI-compat clients 把 image block 转成 `{type:"image_url", image_url:{url:`data:${mime};base64,${base64}`}}`。
- Anthropic native client 转成 `{type:"image", source:{type:"base64", media_type:mime, data:base64}}`。

### Step 4：组装第一条 user message

`engine.run` 把 parsed 转给 `contextManager.appendUserMessage(…)` 或当前等价位置时：

```ts
if (parsed.hasImages) {
  contextManager.appendUserMessage({
    role: "user",
    content: [
      ...(parsed.text ? [{ type: "text", text: parsed.text }] : []),
      ...parsed.images.map((img) => ({
        type: "image" as const,
        mime: img.mime,
        base64: img.base64,
      })),
    ],
  });
} else {
  contextManager.appendUserMessage({ role: "user", content: parsed.text });
}
```

### Step 5：日志安全

`packages/core/src/logging/logger.ts` 会把 message 序列化到 ~/.code-shell/logs/。**不能把整段 base64 写进日志**。改 logger 或 message-sanitize 工具，遇到 `{type:"image", base64}` block 时换成 `{type:"image", mime, bytes: <length>, omitted: true}`。

### Step 6：测试

`packages/core/tests/parse-task.test.ts`：

- empty → empty
- text only → text only
- one image → text + image
- two images mixed with text → 保序
- malformed → 抛错

`packages/core/tests/engine-vision.test.ts`：

- mock LLM client + vision capability=true + 一张 PNG → 看到 image block 进了 LLM 请求。
- mock LLM client + vision capability=false + 一张 PNG → engine.run 直接返回错误，**不调用 LLM**。
- 纯文本 task → 行为完全不变（regression）。

### Step 7：兼容性

- TUI / CLI / 现有 SDK 用户都用 `task: string` 纯文本。`parseTaskWithImages` 对纯文本必须零成本（一个不命中的正则）。
- agent-server-stdio 不需要改 —— `params.task` 还是 string，desktop 那边自己把图片嵌进去。
- 后续如果协议要升级到结构化 `content[]`，这套 inline-encoding 可以无痛过渡。

## 不在本次改动里的事

- OCR / 图片描述降级：UI 已经把 fallback 选项框架留好，但具体调哪个 OCR 服务、缓存策略不在这一轮里做。后续 task 单独立。
- 历史消息回放图片：暂时只支持发送新消息附带图片，不解析过往 transcript 里残留的 image block。
- 图片缓存到磁盘：现在是内存里 data URL，发完即弃。如果以后要 transcript 持久化，需要：(a) 把 base64 写到 attachments/ 目录；(b) transcript 引用文件路径而非内联 base64。

## subagent 验收清单

完成后应该满足：

- [ ] 新增 `packages/core/src/engine/parse-task.ts` + 单元测试通过。
- [ ] `Capability.supportsVision === false` 时，`engine.run` 拿到带图片的 task 立刻拒绝，不调 LLM。
- [ ] `Capability.supportsVision === true` 时，LLM 请求里能看到 image block（mock client 验证）。
- [ ] `bun test` 全绿，`bun run typecheck` 在 core 和 desktop 两个包都干净。
- [ ] desktop 端 `bun run build` 成功，没引入新警告。
- [ ] 不修改 `agent-server-stdio` 的 RPC schema；旧 `task: string` 行为保持不变。
- [ ] 日志里不出现完整 base64。

# view_image 工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 codeshell 加一个 `view_image` 内置工具,让模型能把本地图片文件以图片块(base64)回传进上下文,从而用 vision「看一眼自己生成的图来确认」(对照 Codex)。

**Architecture:** 模型调 `view_image({path})` → 工具读文件、做 vision gate(当前模型不支持视觉就只返回文字占位,不读图)→ 返回一个携带 `image` ContentBlock 的结构化结果。为此把内置工具的返回类型从 `Promise<string>` 扩成 `Promise<string | { contentBlocks: ContentBlock[] }>`,registry 把 `contentBlocks` 透传进 `ToolResult.contentBlocks`,turn-loop 构造 `tool_result` 块时优先用 `contentBlocks`。Anthropic/OpenAI provider 已经能处理 `image` 块和 `stripVisionFromHistory`,无需改动。

**Tech Stack:** TypeScript、Bun(`bun test`)、现有 `capabilitiesFor` 能力查询、现有 provider image-block 支持。

**勘探结论(为何范围这么小):**
- 「聊天里显示图」desktop 已实现(`InlineImageLink` 读 `![](path)` 渲染),本计划**不碰**。
- vision 能力判断已有:`capabilitiesFor(providerKind, model).supportsVision`(`packages/core/src/llm/capabilities/index.ts`),engine.ts:833 已在用。
- provider 已支持 `image` 块:`anthropic.ts:363-375`、`openai.ts:657-680`;非视觉模型由 `stripVisionFromHistory`(`anthropic.ts:334`)兜底剥离。
- 唯一缺口:(1) 没有 `view_image` 工具;(2) 内置工具结果只能带 string,无法回传图片块(`builtin/index.ts:57` 的 `BuiltinToolFn`、`registry.ts:137`、`turn-loop.ts:598-605` 三处)。

---

## File Structure

- `packages/core/src/types.ts` — 给 `ToolResult` 加可选 `contentBlocks?: ContentBlock[]`(图片块走这里,`result?: string` 不变)。
- `packages/core/src/tool-system/builtin/index.ts` — 扩 `BuiltinToolFn` 返回类型,接受 `{ contentBlocks }`;注册 `view_image`。
- `packages/core/src/tool-system/registry.ts` — `executeTool` 把 executor 返回的 `{ contentBlocks }` 透传进 `ToolResult`。
- `packages/core/src/engine/turn-loop.ts` — 构造 `tool_result` 块时,有 `contentBlocks` 就用它当 `content`,否则用 string。
- `packages/core/src/llm/providers/anthropic.ts` — tool_result 分支:content 是块数组时把 image/text 块映射进 Anthropic SDK 的 tool_result content(原生支持)。
- `packages/core/src/llm/providers/openai.ts` — tool_result 分支:把 image 块拆出,提升成独立 user `image_url` 消息(OpenAI wire 不允许 tool 消息带 image)。
- `packages/core/src/tool-system/builtin/view-image.ts` — **新建**。`view_image` 工具实现 + def + vision gate + 格式/大小校验。
- `packages/core/src/index.ts` — 导出新工具的 def/fn(若现有 barrel 有导出其它 builtin 则跟随;否则跳过)。
- 测试:`packages/core/src/tool-system/builtin/view-image.test.ts`(新建)、`packages/core/src/engine/turn-loop-image-result.test.ts`(新建)。

---

## Task 1: 给 ToolResult 加 contentBlocks 字段

**Files:**
- Modify: `packages/core/src/types.ts:49-55`

- [ ] **Step 1: 修改 ToolResult 接口**

把 `packages/core/src/types.ts` 现有的:

```typescript
export interface ToolResult {
  id: string;
  toolName: string;
  result?: string;
  error?: string;
  isError?: boolean;
}
```

改成:

```typescript
export interface ToolResult {
  id: string;
  toolName: string;
  result?: string;
  /**
   * 结构化结果块(目前仅图片)。存在时优先于 `result` 用作发给 LLM 的
   * tool_result content —— view_image 用它把本地图片以 image ContentBlock
   * 回传,让 vision 模型能「看」自己生成的图。非视觉模型由 provider 的
   * stripVisionFromHistory 自动剥离,所以这里照常带图也安全。
   */
  contentBlocks?: ContentBlock[];
  error?: string;
  isError?: boolean;
}
```

`ContentBlock` 已在同文件 line 7 定义,无需 import。

- [ ] **Step 2: typecheck 确认不破坏现有代码**

Run: `cd packages/core && bun run build`
Expected: 编译通过(新增可选字段不影响任何现有 `ToolResult` 用法)。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add optional contentBlocks to ToolResult for image tool results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 扩展 BuiltinToolFn 返回类型

**Files:**
- Modify: `packages/core/src/tool-system/builtin/index.ts:57-61`

- [ ] **Step 1: 修改 BuiltinToolFn 类型**

把 `packages/core/src/tool-system/builtin/index.ts` 现有的:

```typescript
export type BuiltinToolFn = (
  args: Record<string, unknown>,
  ctx?: import("../context.js").ToolContext,
) => Promise<string>;
```

改成:

```typescript
/**
 * 内置工具返回值:大多数返回纯文本字符串。需要回传图片(或其它结构化
 * 内容块)的工具(view_image)可改为返回 `{ contentBlocks }`;此时
 * registry 会把它放进 ToolResult.contentBlocks。可选的 `result` 字段是给
 * transcript / 摘要用的纯文本镜像。
 */
export type BuiltinToolResult =
  | string
  | { contentBlocks: import("../../types.js").ContentBlock[]; result?: string };

export type BuiltinToolFn = (
  args: Record<string, unknown>,
  ctx?: import("../context.js").ToolContext,
) => Promise<BuiltinToolResult>;
```

- [ ] **Step 2: typecheck**

Run: `cd packages/core && bun run build`
Expected: 报错,提示 `registry.ts` 里 `return { id, toolName: name, result }` 的 `result` 类型不再是 `string`。这是预期的 —— Task 3 修。

- [ ] **Step 3: Commit(连同 Task 3 一起提交,先不单独 commit)**

本任务不单独提交;留到 Task 3 typecheck 通过后一起 commit。

---

## Task 3: registry 透传 contentBlocks

**Files:**
- Modify: `packages/core/src/tool-system/registry.ts:127-138`

- [ ] **Step 1: 修改 executeTool 的成功返回分支**

`packages/core/src/tool-system/registry.ts` 中,`executeTool` 里 `Promise.race` 拿到 `result` 后,现有代码是:

```typescript
      clearTimeout(timerId);
      parentSignal?.removeEventListener("abort", onParentAbort);
      return { id, toolName: name, result };
```

改成:

```typescript
      clearTimeout(timerId);
      parentSignal?.removeEventListener("abort", onParentAbort);
      // executor 可返回纯字符串,或 { contentBlocks, result? }(view_image
      // 用后者回传图片块)。归一化成 ToolResult:有 contentBlocks 就带上,
      // result 始终保留一份文本镜像供 transcript / 摘要使用。
      if (typeof result === "string") {
        return { id, toolName: name, result };
      }
      return {
        id,
        toolName: name,
        result: result.result ?? "(image)",
        contentBlocks: result.contentBlocks,
      };
```

`result` 此处类型已是 `BuiltinToolResult`(executor 返回值),无需额外 import。

- [ ] **Step 2: typecheck 通过**

Run: `cd packages/core && bun run build`
Expected: 编译通过。

- [ ] **Step 3: Commit(含 Task 2)**

```bash
git add packages/core/src/tool-system/builtin/index.ts packages/core/src/tool-system/registry.ts
git commit -m "feat(core): builtin tools may return image content blocks

BuiltinToolFn now returns string | { contentBlocks }; registry threads
contentBlocks into ToolResult. Prepares view_image to return base64 images.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: turn-loop 构造 tool_result 时优先用 contentBlocks

**Files:**
- Modify: `packages/core/src/engine/turn-loop.ts:596-615`
- Test: `packages/core/src/engine/turn-loop-image-result.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/engine/turn-loop-image-result.test.ts`。这个测试直接验证「带 contentBlocks 的 ToolResult 被转成带 image 块的 tool_result」这一纯函数式映射。由于 turn-loop 的该段是内联逻辑,我们把映射抽成一个可测的纯函数(Step 3 抽出),先对它写测试:

```typescript
import { describe, it, expect } from "bun:test";
import { toolResultToBlock } from "./turn-loop.js";
import type { ToolResult } from "../types.js";

describe("toolResultToBlock", () => {
  it("uses contentBlocks verbatim when present", () => {
    const r: ToolResult = {
      id: "call_1",
      toolName: "view_image",
      result: "(image)",
      contentBlocks: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    };
    const block = toolResultToBlock(r);
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("call_1");
    expect(Array.isArray(block.content)).toBe(true);
    expect((block.content as any)[0].type).toBe("image");
  });

  it("falls back to string content when no contentBlocks", () => {
    const r: ToolResult = { id: "call_2", toolName: "Read", result: "hello" };
    const block = toolResultToBlock(r);
    expect(block.content).toBe("hello");
  });

  it("renders error as string content with is_error", () => {
    const r: ToolResult = { id: "call_3", toolName: "Read", error: "boom", isError: true };
    const block = toolResultToBlock(r);
    expect(block.content).toBe("Error: boom");
    expect(block.is_error).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/core && bun test src/engine/turn-loop-image-result.test.ts`
Expected: FAIL —— `toolResultToBlock` 未导出/未定义。

- [ ] **Step 3: 抽出并修改 turn-loop 逻辑**

在 `packages/core/src/engine/turn-loop.ts` 顶部(import 之后、类定义之前的模块作用域)新增导出函数:

```typescript
/**
 * 把一个 ToolResult 映射成发给 LLM 的 tool_result ContentBlock。
 * 有 contentBlocks(view_image 的图片块)就原样用作 content;否则
 * 用文本(成功用 result,失败用 "Error: ...")。抽成纯函数以便单测。
 */
export function toolResultToBlock(result: ToolResult): ContentBlock {
  const block: ContentBlock = {
    type: "tool_result",
    tool_use_id: result.id,
    content:
      result.error
        ? `Error: ${result.error}`
        : result.contentBlocks ?? (result.result ?? "(no output)"),
  };
  if (result.isError || result.error) block.is_error = true;
  return block;
}
```

确认文件顶部已 import `ContentBlock` 与 `ToolResult`(turn-loop.ts 第 596 行附近已用 `ContentBlock`,说明已 import;若 `ToolResult` 未 import 则加到现有 `../types.js` 的 import 列表)。

然后把 line 596-605 现有的:

```typescript
      const resultBlocks: ContentBlock[] = [];
      for (const result of results) {
        const content = result.error ? `Error: ${result.error}` : (result.result ?? "(no output)");

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: result.id,
          content,
          ...(result.isError ? { is_error: true } : {}),
        });

        this.deps.transcript.appendToolResult(
```

改成:

```typescript
      const resultBlocks: ContentBlock[] = [];
      for (const result of results) {
        resultBlocks.push(toolResultToBlock(result));

        this.deps.transcript.appendToolResult(
```

(注意:`appendToolResult` 之后那几行 —— `result.id, result.toolName, result.result, result.error` —— 不动;transcript 仍存文本镜像,图片不进 transcript,符合「不污染存档」。)

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/core && bun test src/engine/turn-loop-image-result.test.ts`
Expected: PASS(3 个用例全过)。

- [ ] **Step 5: 跑相邻回归测试**

Run: `cd packages/core && bun test src/engine/turn-loop.test.ts`
Expected: PASS(确认抽函数没改变原有行为)。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine/turn-loop.ts packages/core/src/engine/turn-loop-image-result.test.ts
git commit -m "feat(core): tool_result blocks carry image contentBlocks when present

Extract toolResultToBlock; image tool results now reach the LLM as image
blocks instead of being flattened to a string. Transcript keeps the text
mirror only (images stay out of the archive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 实现 view_image 工具(含 vision gate + 格式/大小校验)

**Files:**
- Create: `packages/core/src/tool-system/builtin/view-image.ts`
- Test: `packages/core/src/tool-system/builtin/view-image.test.ts`

设计约束:
- 入参 `{ path: string }`(绝对路径,或相对 `ctx.cwd` 解析)。
- **vision gate**:`capabilitiesFor(providerKind, model).supportsVision === false` 时,**不读文件**,直接返回文字 `[图片未加载: <path> —— 当前模型不支持视觉输入,已跳过]`(string)。这就是「看不了的就别看」。
- **格式校验**:只支持 `image/png|jpeg|gif|webp`(provider image 块支持的 media_type,见 anthropic.ts:367-371)。`.svg`/其它 → 返回文字 `[图片未加载: <path> —— 格式 <ext> 不支持视觉预览,请先转成 PNG/JPEG]`。
- **大小校验**:文件 > 5 MB → 返回文字提示,不读进 base64(防上下文爆炸)。
- 文件不存在/读失败 → 返回文字错误。
- 成功 → 返回 `{ contentBlocks: [{ type: "image", source: { type: "base64", media_type, data } }], result: "[已加载图片: <path> (<media_type>, <n> KB)]" }`。

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/tool-system/builtin/view-image.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewImageTool } from "./view-image.js";
import type { ToolContext } from "../context.js";

// 1x1 透明 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctxWith(model: string, providerKind: string, cwd: string): ToolContext {
  return {
    cwd,
    llmConfig: { provider: providerKind, model, providerKind },
    // 其余 ToolContext 字段在 view_image 路径上用不到;用 as 收窄
  } as unknown as ToolContext;
}

describe("view_image", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "view-image-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an image content block for a PNG under a vision model", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool({ path: p }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("object");
    const blocks = (out as { contentBlocks: any[] }).contentBlocks;
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].source.media_type).toBe("image/png");
    expect(blocks[0].source.data).toBe(PNG_B64);
  });

  it("skips reading (returns text) when model has no vision", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool({ path: p }, ctxWith("deepseek-chat", "deepseek", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("不支持视觉");
  });

  it("rejects unsupported formats (svg) with text", async () => {
    const p = join(dir, "a.svg");
    await writeFile(p, "<svg/>");
    const out = await viewImageTool({ path: p }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("不支持视觉预览");
  });

  it("resolves relative paths against ctx.cwd", async () => {
    const p = join(dir, "rel.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool({ path: "rel.png" }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("object");
  });

  it("returns text error for missing file", async () => {
    const out = await viewImageTool({ path: join(dir, "nope.png") }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("无法读取");
  });

  it("rejects oversized files with text", async () => {
    const p = join(dir, "big.png");
    await writeFile(p, Buffer.alloc(6 * 1024 * 1024)); // 6MB
    const out = await viewImageTool({ path: p }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("过大");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/view-image.test.ts`
Expected: FAIL —— `./view-image.js` 不存在。

- [ ] **Step 3: 实现 view-image.ts**

新建 `packages/core/src/tool-system/builtin/view-image.ts`:

```typescript
/**
 * Built-in view_image tool — 把一个本地图片文件以 base64 image ContentBlock
 * 回传进上下文,让 vision 模型「看」它(对照 codex 的 view_image)。
 *
 * 典型用法:模型先写 SVG/Mermaid 并用 shell 转成 PNG,再调 view_image(png)
 * 检查图画对没有(标签是否重叠、文字是否溢出),不对就改源再重转。
 *
 * 三道闸门,避免污染上下文 / 浪费 token:
 *   1. vision gate —— 当前模型不支持视觉时不读文件,只回文字占位。
 *   2. 格式 gate —— 只支持 png/jpeg/gif/webp(provider image 块能吃的);
 *      svg/pdf 等回文字提示「先转 PNG」。
 *   3. 大小 gate —— 超过 MAX_BYTES 回文字提示,不读进 base64。
 */

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import type { BuiltinToolResult } from "./index.js";
import { capabilitiesFor } from "../../llm/capabilities/index.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB —— vision 模型按 tile 计 token,大图无益且撑大请求

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const viewImageToolDef: ToolDefinition = {
  name: "view_image",
  description:
    "Load a local image file into the conversation so you can SEE it (vision). " +
    "Use after generating or rendering an image (e.g. SVG/Mermaid → PNG) to verify it " +
    "looks right — check for overlapping labels, clipped text, wrong layout — then fix the " +
    "source and re-render if needed. Supports PNG/JPEG/GIF/WebP only; convert SVG/PDF to PNG " +
    "first. Requires a vision-capable model; otherwise the image is skipped.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the image file (absolute, or relative to the working directory).",
      },
    },
    required: ["path"],
  },
};

export async function viewImageTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<BuiltinToolResult> {
  const rawPath = args.path;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return "Error: path is required";
  }

  const cwd = ctx?.cwd ?? process.cwd();
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  // 闸门 1:vision gate —— 不支持视觉就不读文件
  if (ctx?.llmConfig) {
    const kind = (ctx.llmConfig.providerKind ?? ctx.llmConfig.provider) as ProviderKindName;
    const cap = capabilitiesFor(kind, ctx.llmConfig.model);
    if (!cap.supportsVision) {
      return `[图片未加载: ${abs} —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再 view_image。]`;
    }
  }

  // 闸门 2:格式 gate
  const ext = extname(abs).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) {
    return `[图片未加载: ${abs} —— 格式 ${ext || "(无扩展名)"} 不支持视觉预览,请先转成 PNG/JPEG。]`;
  }

  // 闸门 3:大小 gate(读 stat,不读全文件)
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch (err) {
    return `Error: 无法读取 ${abs}: ${(err as Error).message}`;
  }
  if (size > MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return `[图片未加载: ${abs} —— 文件过大 (${mb} MB > 5 MB),请先压缩或缩放再 view_image。]`;
  }

  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    return `Error: 无法读取 ${abs}: ${(err as Error).message}`;
  }

  const data = buf.toString("base64");
  const kb = Math.round(buf.length / 1024);
  return {
    contentBlocks: [
      { type: "image", source: { type: "base64", media_type: mediaType, data } },
    ],
    result: `[已加载图片: ${abs} (${mediaType}, ${kb} KB)]`,
  };
}
```

注意:`ProviderKindName` 导出在 `packages/core/src/llm/provider-kinds.ts`(已核实,line 11 的 capabilities/index.ts 也从这里 import)。`capabilitiesFor(kind, model)` 签名见 capabilities/index.ts:35。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/view-image.test.ts`
Expected: PASS(6 个用例全过)。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-system/builtin/view-image.ts packages/core/src/tool-system/builtin/view-image.test.ts
git commit -m "feat(core): add view_image tool (vision/format/size gated)

Loads a local PNG/JPEG/GIF/WebP as a base64 image block so vision models can
inspect their own generated images. Non-vision models, unsupported formats,
and oversized files return a text placeholder without reading into context.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 注册 view_image 为内置工具

**Files:**
- Modify: `packages/core/src/tool-system/builtin/index.ts`(import 区 + `BUILTIN_TOOLS` 数组)

- [ ] **Step 1: 加 import**

在 `packages/core/src/tool-system/builtin/index.ts` 顶部、`generateImageToolDef` 那行 import(line 8)附近,加:

```typescript
import { viewImageToolDef, viewImageTool } from "./view-image.js";
```

- [ ] **Step 2: 加到 BUILTIN_TOOLS 数组**

在 `BUILTIN_TOOLS` 数组里,紧挨 `generateImageTool` 的注册块(line 88-99 那个 `{ definition: { ...generateImageToolDef, ... }, execute: generateImageTool }`)之后,加:

```typescript
  {
    definition: {
      ...viewImageToolDef,
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    },
    execute: viewImageTool,
  },
```

(`permissionDefault: "allow"` + `isReadOnly: true` —— 读本地图片是只读、低风险操作,和 Read 工具一致,不必每次 ask。)

- [ ] **Step 3: typecheck + 构建**

Run: `cd packages/core && bun run build`
Expected: 编译通过。

- [ ] **Step 4: 验证工具已注册**

Run: `cd packages/core && bun test src/tool-system/builtin/view-image.test.ts && bun test src/engine/turn-loop-image-result.test.ts`
Expected: 两个测试文件全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-system/builtin/index.ts
git commit -m "feat(core): register view_image in BUILTIN_TOOLS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Anthropic provider —— tool_result 携带 image 块

**必做(不是条件性)**:`anthropic.ts:360` 现在是 `content: typeof block.content === "string" ? block.content : ""` —— view_image 把 image 块放进 `tool_result.content` 数组时,会被这行吞成空串,图到不了模型。Anthropic SDK 的 tool_result `content` 原生支持 `Array<{type:"text"|"image"}>`,所以这里要把块数组映射过去。

**Files:**
- Modify: `packages/core/src/llm/providers/anthropic.ts:356-362`
- Test: `packages/core/src/llm/providers/anthropic-tool-result-error.test.ts`(已存在;在其中追加一个 image 用例)

- [ ] **Step 1: 写失败测试(追加到现有文件)**

在 `packages/core/src/llm/providers/anthropic-tool-result-error.test.ts` 末尾追加。该测试通过 provider 的 buildMessages(若已 export 测试钩子则用之;否则用现有文件里已有的调用模式 —— 打开文件看现有用例怎么构造 client 与调 buildMessages,照搬其 setup):

```typescript
it("carries an image block inside tool_result content (vision model)", () => {
  // 复用本文件现有用例的 client 构造方式(grep 本文件里 new AnthropicClient / buildMessages 的调法)
  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "call_1",
          content: [
            { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    },
  ];
  const built = callBuildMessages(messages); // ← 用本文件已有的调用方式替换
  const tr = (built[0].content as any[]).find((b) => b.type === "tool_result");
  expect(Array.isArray(tr.content)).toBe(true);
  expect(tr.content[0].type).toBe("image");
  expect(tr.content[0].source.media_type).toBe("image/png");
});
```

(执行时:先读该测试文件,确认 buildMessages 的既有调用方式 —— 是直接 new client 调私有方法、还是有 helper —— 用相同方式替换上面的 `callBuildMessages`。模型 capability 需是 vision(默认用 claude-* 模型即 supportsVision:true),否则 stripVisionFromHistory 会先剥掉 image。)

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/llm/providers/anthropic-tool-result-error.test.ts`
Expected: FAIL —— 当前 `tr.content` 是 `""`(空串),不是数组。

- [ ] **Step 3: 修 anthropic.ts 的 tool_result 分支**

把 `packages/core/src/llm/providers/anthropic.ts:356-362` 现有的:

```typescript
          } else if (block.type === "tool_result" && block.tool_use_id) {
            blocks.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: typeof block.content === "string" ? block.content : "",
              ...(block.is_error ? { is_error: true } : {}),
            });
          } else if (block.type === "image" && block.source) {
```

改成:

```typescript
          } else if (block.type === "tool_result" && block.tool_use_id) {
            // tool_result.content 可能是字符串,或块数组(view_image 回传
            // image 块时)。Anthropic SDK 的 tool_result 支持 text/image 块
            // 数组,所以把 image/text 块映射过去;其它块类型降级成空串。
            let trContent: Anthropic.ToolResultBlockParam["content"];
            if (typeof block.content === "string") {
              trContent = block.content;
            } else if (Array.isArray(block.content)) {
              trContent = block.content.flatMap((b): Anthropic.ToolResultBlockParam["content"] extends Array<infer E> ? E[] : never => {
                if (b.type === "text" && b.text) return [{ type: "text", text: b.text }] as any;
                if (b.type === "image" && b.source) {
                  return [{
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: b.source.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                      data: b.source.data,
                    },
                  }] as any;
                }
                return [] as any;
              });
            } else {
              trContent = "";
            }
            blocks.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: trContent,
              ...(block.is_error ? { is_error: true } : {}),
            });
          } else if (block.type === "image" && block.source) {
```

(若上面 flatMap 的条件返回类型注解太绕导致 tsc 报错,改用更直白的写法:声明 `const arr: Array<{type:"text";text:string} | {type:"image";source:{type:"base64";media_type:any;data:string}}> = []`,用 for 循环 push,最后 `trContent = arr`。两种都行,以 tsc 通过为准。)

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun test src/llm/providers/anthropic-tool-result-error.test.ts`
Expected: PASS(含新 image 用例和原有用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/providers/anthropic.ts packages/core/src/llm/providers/anthropic-tool-result-error.test.ts
git commit -m "feat(core): anthropic tool_result content carries image blocks

view_image returns image blocks inside tool_result; map them into the
Anthropic SDK tool_result content array instead of dropping to empty string.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: OpenAI provider —— tool_result 里的 image 提升为 user image 消息

**必做**:OpenAI wire 格式**不允许** tool_result(`role:"tool"` 消息)里嵌 image(见 `openai.ts:640-645` 注释)。所以 view_image 在 OpenAI 系模型上的图,要从 tool_result.content 里拆出来,作为独立的 user `image_url` 消息发出 —— 复用文件底部已有的 `imageParts` → user 消息逻辑。

**Files:**
- Modify: `packages/core/src/llm/providers/openai.ts:649-654`(tool_result 分支)

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/llm/providers/openai-tool-result-image.test.ts`(参照 anthropic 测试文件的 client 构造方式;OpenAI client 用 vision 模型如 `gpt-4o`):

```typescript
import { describe, it, expect } from "bun:test";
// 参照同目录 openai 既有测试的 import / client 构造方式

describe("openai tool_result image", () => {
  it("hoists an image inside tool_result into a user image_url message", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "call_1",
            content: [
              { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      },
    ];
    const built = callBuildMessages(messages); // ← 用 openai 测试既有调用方式替换
    // 应有一条 role:"tool" 消息(占位文本)和一条 role:"user" 含 image_url
    const toolMsg = built.find((m: any) => m.role === "tool");
    const userMsg = built.find((m: any) => m.role === "user" && Array.isArray(m.content));
    expect(toolMsg).toBeDefined();
    expect(userMsg).toBeDefined();
    const img = (userMsg!.content as any[]).find((p) => p.type === "image_url");
    expect(img.image_url.url).toContain("data:image/png;base64,AAAA");
  });
});
```

(执行时先 grep 同目录是否已有 openai provider 测试,照搬其 client 构造 + buildMessages 调用方式替换 `callBuildMessages`。)

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/llm/providers/openai-tool-result-image.test.ts`
Expected: FAIL —— 当前 image 被吞,无 image_url 的 user 消息。

- [ ] **Step 3: 修 openai.ts 的 tool_result 分支**

把 `packages/core/src/llm/providers/openai.ts:649-654` 现有的:

```typescript
          for (const block of msg.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              toolResults.push({
                tool_use_id: block.tool_use_id,
                content: typeof block.content === "string" ? block.content : "",
              });
            } else if (block.type === "text" && block.text) {
```

改成:

```typescript
          for (const block of msg.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              // tool_result.content 可能是字符串,或含 image 的块数组
              // (view_image)。OpenAI wire 不允许 tool 消息里带 image,所以
              // 把 image 块拆进 imageParts(下面会 emit 成 user 消息),tool
              // 消息只留文本占位以满足 tool_call_id 配对。
              if (typeof block.content === "string") {
                toolResults.push({ tool_use_id: block.tool_use_id, content: block.content });
              } else if (Array.isArray(block.content)) {
                const texts: string[] = [];
                for (const b of block.content) {
                  if (b.type === "text" && b.text) {
                    texts.push(b.text);
                  } else if (b.type === "image" && b.source) {
                    const wireDetail = mapImageDetailToOpenAI(this.imageDetail);
                    imageParts.push({
                      type: "image_url",
                      image_url: {
                        url: `data:${b.source.media_type};base64,${b.source.data}`,
                        ...(wireDetail ? { detail: wireDetail } : {}),
                      },
                    });
                  }
                }
                toolResults.push({
                  tool_use_id: block.tool_use_id,
                  content: texts.length > 0 ? texts.join("\n") : "[image returned to user message]",
                });
              } else {
                toolResults.push({ tool_use_id: block.tool_use_id, content: "" });
              }
            } else if (block.type === "text" && block.text) {
```

(`mapImageDetailToOpenAI` 和 `this.imageDetail` 在同文件已用于 line 672 的 image 分支,直接复用。)

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun test src/llm/providers/openai-tool-result-image.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/providers/openai.ts packages/core/src/llm/providers/openai-tool-result-image.test.ts
git commit -m "feat(core): openai hoists tool_result images into a user image message

OpenAI wire forbids images inside tool messages; pull view_image's image
blocks out of tool_result into a user image_url message, leaving the tool
message a text placeholder.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 全量回归 + core 重建

**Files:** 无(验证任务)

- [ ] **Step 1: 跑 core 全量测试**

Run: `cd packages/core && bun test`
Expected: 全 PASS。重点关注 `turn-loop.test.ts`、`anthropic-tool-result-error.test.ts`、`image-policy.test.ts`、`strip-vision.test.ts`、新增的三个测试文件。

- [ ] **Step 2: 重建 core(desktop/tui dist 依赖)**

Run: `cd packages/core && bun run build`
Expected: 成功。(记忆:改 core 必 rebuild,否则 desktop/tui 引的是旧 dist。)

- [ ] **Step 3: 端到端冒烟(可选,人工)**

在一个 vision 模型下,让模型 `view_image` 一张真实 PNG,确认它下一轮能描述图片内容;切到非视觉模型重复,确认只回文字占位、不报错。

---

## 验收标准(整体)

1. `view_image({path: "某.png"})` 在 vision 模型下返回带 `image` 块的结果,模型下一轮能描述图片内容(真 vision)。
2. 非视觉模型下 `view_image` 不读文件、只回文字占位 —— 上下文零污染。
3. svg / 超大文件 / 不存在的文件,各自回清晰文字提示,不抛错、不塞 base64。
4. transcript 里只存文本镜像(`[已加载图片: ...]`),不含 base64 —— 存档不膨胀。
5. `bun test`(core)全绿;`bun run build` 成功。

## 不在本计划范围

- 「聊天里显示图」(desktop 已实现,不碰)。
- 策略 B 的「看过一轮后把历史里的图降级成文字」(本计划靠 vision gate + 大小 gate 控制污染;真要降级是后续增量,且 provider 的 stripVisionFromHistory 对非视觉模型已兜底)。
- TUI 端图片渲染(终端 inline image,优先级低)。
- 让 `view_image` 自动转 SVG→PNG(本计划只校验格式并提示;转码交给模型用 shell 做,和它现在的行为一致)。

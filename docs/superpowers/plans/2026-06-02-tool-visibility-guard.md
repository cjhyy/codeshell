# 内建工具凭证/能力可见性守卫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 没配凭证的内建工具(`WebSearch` 没配 search provider、`GenerateImage` 没配 OpenAI provider)不再无条件暴露进工具表 —— 用一个通用守卫在每条消息的 toolDefs 组装处按 cwd 过滤掉不可用工具。

**Architecture:** 通用守卫而非新工具种类。`BuiltinTool` 概念上加「可用性判定」,各工具复用已有的凭证解析函数导出布尔判定,`index.ts` 收集成 `BUILTIN_TOOL_GUARDS: Map<name, (cwd)=>boolean>`。过滤落点 = `engine.ts:1237` 的 `allToolDefs` 组装(每条消息重算,非注册层 —— 配好凭证下一条消息即生效,无需重启)。没声明守卫的工具永远可见,其余工具零影响。执行层 `source:"none"`/`no provider` 兜底保留。

**Tech Stack:** TypeScript (bun)、bun test。`@cjhyy/code-shell-core` 包。

**已核实的落点(行号以实际为准):**
- `BuiltinTool` = `{ definition: RegisteredTool; execute: BuiltinToolFn }`,`BUILTIN_TOOLS` 数组在 `tool-system/builtin/index.ts`。
- `resolveSearchConfig(cwd): ResolvedSearchConfig` 已导出(`web-search.ts:28`),返回带 `source` 字段(`"none"` = 没配)。`web-search.ts:121` 已用它。
- `resolveOpenAIProvider(cwd): OpenAIProvider | null` 在 `generate-image.ts:68` 但**未导出**(`function`,不是 `export function`)。
- 过滤落点 `engine.ts:1237`:`const allToolDefs = this.toolRegistry.getToolDefinitions().map(...)`,这段能拿到 `toolCtx`(含 `toolCtx.cwd`)。这里已有按工具名 map 的 pattern(Agent 改 description)。

**约束:** 仅「已配 key」即可用(不持久化 verified、不动 SearchConnectionsPanel)。配好后下一条消息生效、不重启 Electron。改 core 必 rebuild。subagent 别动 git。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/core/src/tool-system/builtin/web-search.ts` | 导出 `isWebSearchAvailable(cwd): boolean` | Modify |
| `packages/core/src/tool-system/builtin/generate-image.ts` | 把 `resolveOpenAIProvider` 包成导出的 `isGenerateImageAvailable(cwd): boolean`(或直接 `export` 现有函数并加 wrapper) | Modify |
| `packages/core/src/tool-system/builtin/index.ts` | 导出 `BUILTIN_TOOL_GUARDS: Map<string, (cwd: string) => boolean>` | Modify |
| `packages/core/src/tool-system/builtin/tool-guards.test.ts` | 守卫 + map 的单测 | Create |
| `packages/core/src/engine/engine.ts:1237` | `allToolDefs` 组装加 `.filter()` 按守卫剔除不可用工具 | Modify |

---

## Task 1: 两个工具导出可用性判定 + 收集成 Map

**Files:**
- Modify: `web-search.ts`、`generate-image.ts`、`index.ts`
- Test: `packages/core/src/tool-system/builtin/tool-guards.test.ts`

- [ ] **Step 0: 读两个解析函数确认返回形状**

Run: `sed -n '28,60p' packages/core/src/tool-system/builtin/web-search.ts; sed -n '60,90p' packages/core/src/tool-system/builtin/generate-image.ts`
确认:`resolveSearchConfig` 的返回类型里 `source` 取值(`"none"` 表示没配?核对);`resolveOpenAIProvider` 返回 `null` 表示没配。**以真实代码为准**。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/src/tool-system/builtin/tool-guards.test.ts
import { describe, test, expect } from "bun:test";
import { isWebSearchAvailable } from "./web-search.js";
import { isGenerateImageAvailable } from "./generate-image.js";
import { BUILTIN_TOOL_GUARDS } from "./index.js";

describe("builtin tool availability guards", () => {
  test("isWebSearchAvailable returns a boolean for a cwd with no search config", () => {
    // A throwaway dir almost certainly has no search provider configured.
    const r = isWebSearchAvailable("/nonexistent-cwd-xyz");
    expect(typeof r).toBe("boolean");
  });

  test("isGenerateImageAvailable returns a boolean", () => {
    const r = isGenerateImageAvailable("/nonexistent-cwd-xyz");
    expect(typeof r).toBe("boolean");
  });

  test("BUILTIN_TOOL_GUARDS maps the two gated tools to predicates", () => {
    // Names must match the real tool def names (WebSearch / GenerateImage —
    // confirm in Step 0 / the toolDef `name` fields).
    expect(BUILTIN_TOOL_GUARDS.has("WebSearch")).toBe(true);
    expect(BUILTIN_TOOL_GUARDS.has("GenerateImage")).toBe(true);
    expect(typeof BUILTIN_TOOL_GUARDS.get("WebSearch")!("/x")).toBe("boolean");
  });

  test("ungated tools have no guard entry (so they're always visible)", () => {
    expect(BUILTIN_TOOL_GUARDS.has("Read")).toBe(false);
  });
});
```

> **注意工具名**:断言里的 `"WebSearch"` / `"GenerateImage"` 必须等于 `webSearchToolDef.name` / `generateImageToolDef.name` 的真实值。Step 0 确认这两个 def 的 `name` 字段后,把断言对齐(若实际是 `"web_search"` 之类就改断言)。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/tool-guards.test.ts`
Expected: FAIL — 导出不存在。

- [ ] **Step 3: web-search.ts 加导出**

在 `web-search.ts`(`resolveSearchConfig` 之后)加:

```typescript
/**
 * Tool-visibility guard: WebSearch is only useful when a search provider is
 * configured. Mirrors the runtime check in the tool itself (source === "none"
 * means no provider). Cheap + sync so it can run on every toolDefs assembly.
 */
export function isWebSearchAvailable(cwd: string = process.cwd()): boolean {
  try {
    return resolveSearchConfig(cwd).source !== "none";
  } catch {
    return false; // unresolved config → treat as unavailable
  }
}
```

> 若 Step 0 发现 `ResolvedSearchConfig.source` 的「没配」哨兵不是 `"none"`,改成真实值。

- [ ] **Step 4: generate-image.ts 加导出**

`generate-image.ts` 的 `resolveOpenAIProvider`(`:68`,当前 `function`,未导出)保持私有,新增导出 wrapper:

```typescript
/**
 * Tool-visibility guard: GenerateImage needs a kind:"openai" provider with a
 * key. resolveOpenAIProvider returns null when none is configured.
 */
export function isGenerateImageAvailable(cwd: string = process.cwd()): boolean {
  try {
    return resolveOpenAIProvider(cwd) !== null;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: index.ts 导出 BUILTIN_TOOL_GUARDS**

在 `index.ts` import 两个守卫 + 两个 toolDef(取真实 name),并在 `BUILTIN_TOOLS` 定义后加:

```typescript
import { isWebSearchAvailable, webSearchToolDef } from "./web-search.js";
import { isGenerateImageAvailable, generateImageToolDef } from "./generate-image.js";

/**
 * Per-tool availability predicates. A tool listed here is filtered OUT of the
 * exposed toolDefs when its predicate returns false for the active cwd (see
 * engine.ts toolDefs assembly). Tools NOT listed here are always visible.
 * Keyed by the tool's `name` (must match the toolDef name).
 */
export const BUILTIN_TOOL_GUARDS: Map<string, (cwd: string) => boolean> = new Map([
  [webSearchToolDef.name, isWebSearchAvailable],
  [generateImageToolDef.name, isGenerateImageAvailable],
]);
```

> 确认 `webSearchToolDef` / `generateImageToolDef` 已从各自文件导出(web-search.ts:87 是 `export const webSearchToolDef`;generate-image.ts:32 是 `export const generateImageToolDef`)——已是 export,直接 import 即可。

- [ ] **Step 6: 运行确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/tool-guards.test.ts`
Expected: PASS。(若工具名断言因真实 name 不同而失败,改断言为真实 name。)

- [ ] **Step 7: Commit**(由主控执行)

---

## Task 2: engine 在 toolDefs 组装处按守卫过滤

**Files:**
- Modify: `packages/core/src/engine/engine.ts`(`:1237` `allToolDefs` 组装)

- [ ] **Step 0: 读 engine.ts:1233-1250 确认 toolCtx.cwd 可用**

Run: `sed -n '1233,1251p' packages/core/src/engine/engine.ts`
确认 `toolCtx.cwd` 在这段作用域内可读。

- [ ] **Step 1: import 守卫 map**

`engine.ts` 顶部内建工具 import 附近加(确认真实路径):

```typescript
import { BUILTIN_TOOL_GUARDS } from "../tool-system/builtin/index.js";
```

- [ ] **Step 2: 在 allToolDefs 组装加过滤**

把 `:1237` 的:

```typescript
    const allToolDefs = this.toolRegistry.getToolDefinitions().map((t) =>
      t.name === "Agent"
        ? { ...t, description: agentToolDefWithTypes(toolCtx.agentDefinitions).description }
        : t,
    );
```

改为(先 filter 守卫,再 map description):

```typescript
    // Availability guard (tool-visibility): a gated builtin (WebSearch needs a
    // search provider, GenerateImage needs an OpenAI provider) is hidden from
    // the toolDefs the model sees when its credential isn't configured for this
    // cwd. Recomputed every message, so configuring a key takes effect on the
    // NEXT message without a restart. Tools with no guard entry are always kept.
    const guardCwd = toolCtx.cwd;
    const allToolDefs = this.toolRegistry
      .getToolDefinitions()
      .filter((t) => {
        const guard = BUILTIN_TOOL_GUARDS.get(t.name);
        return guard ? guard(guardCwd) : true;
      })
      .map((t) =>
        t.name === "Agent"
          ? { ...t, description: agentToolDefWithTypes(toolCtx.agentDefinitions).description }
          : t,
      );
```

> `toolCtx.cwd` 的真实字段名以 Step 0 为准(ToolContext.cwd 已确认存在)。

- [ ] **Step 3: 类型检查 + 全量 core 测试**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep -v "write-policy.test\|reasoning-effort-drop.test" | head -20 && bun test 2>&1 | tail -8`
Expected: 无**新增** tsc error(忽略两个预存 error:`write-policy.test.ts` 的 CronPermissionLevel、`openai-reasoning-effort-drop.test.ts` 的 OpenAI.APIError);core 测试无回归。

- [ ] **Step 4: Commit**(由主控执行)

---

## Task 3: build + 收尾

- [ ] **Step 1:** `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun run build 2>&1 | tail -8` → core+tui exit 0。
- [ ] **Step 2:** 确认守卫真生效:`grep -n "BUILTIN_TOOL_GUARDS" packages/core/src/engine/engine.ts packages/core/src/tool-system/builtin/index.ts`(两处都有引用)。
- [ ] **Step 3:** 更新 `TODO-week.md` #4 标记完成;Commit(由主控执行)。

---

## Self-Review

**Spec coverage:** 通用守卫(非新工具种类)= Task 1 的 `BUILTIN_TOOL_GUARDS`;两个工具复用解析函数导出布尔 = Task 1 Step 3/4;过滤在 run() 的 toolDefs 组装非注册层 = Task 2;没声明守卫永远可见 = Task 2 的 `guard ? guard(cwd) : true`;配好下条消息生效 = 每消息重算(:1237 在 run 路径内)。✓

**Placeholder scan:** Task 1/2 的 Step 0 是有意调研(工具 def name、source 哨兵值、cwd 字段名以真实代码为准),其余步骤含完整代码。

**Type consistency:** `isWebSearchAvailable`/`isGenerateImageAvailable`/`BUILTIN_TOOL_GUARDS` 命名一致;Map 键用 `webSearchToolDef.name`/`generateImageToolDef.name`(避免硬编码字符串漂移)。

**已知风险:** ① 工具真实 name 可能不是 "WebSearch"/"GenerateImage" —— 用 `.name` 字段而非硬编码,断言 Step 0 后对齐。② permission rule 惰性、不在表里不会被调,无需动(TODO 已确认)。③ 执行层 source:"none" 兜底保留(没删),双重保险。

# 个性化设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设置页「个性化」真正生效,并新增回复语言/称呼画像两个字段与指令文件兼容开关。

**Architecture:** 修复 `agent-server-stdio.ts` engineFactory 的既存断链(让 `settings.agent.*` 作为 per-session 默认值生效),然后沿同一条 `schema → EngineConfig → ComposerOptions → PromptComposer` 链新增三组字段;子 Engine 自动继承,无需额外接线。UI 在 desktop renderer 新增两个 section。

**Tech Stack:** TypeScript, Zod (settings schema), Vitest (core 单测), React + shadcn/ui (desktop renderer)。

> **测试命令约定:** core 包用 `cd packages/core && bunx vitest run <file>`。desktop 改动后按其 CLAUDE.md 用 `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`。core 改动若被 desktop dist 引用,需 `cd packages/core && bun run build`(参考既有约定)。
> **Git:** 用户偏好直接在 main 提交,**subagent 不执行 git**——每个 Task 末尾的 commit 步骤由协调者(主 agent / 用户)完成。

---

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `packages/core/src/cli/agent-server-stdio.ts` | desktop 聊天 worker 的 engineFactory | 修断链 + 接新字段默认值 |
| `packages/core/src/settings/schema.ts` | settings zod schema | agent object 新增 3 组字段 |
| `packages/core/src/engine/engine.ts` | EngineConfig + PromptComposer 构造 | 新增字段声明 + 传入 composer + 子 Engine 继承 |
| `packages/core/src/protocol/chat-session-manager.ts` | EngineConfigSlice 白名单 | (本计划不需扩,见 Task 5 说明) |
| `packages/core/src/prompt/composer.ts` | ComposerOptions + getSections / getInstructions | 新增 personalization section + 接 instructionOptions |
| `packages/desktop/src/renderer/settings/AdvancedSections.tsx` | 设置页个性化 UI | 新增 2 个 section |

---

## Task 1: 修复 engineFactory 断链,让 settings.agent.* 生效

**背景:** `agent-server-stdio.ts:152-154` 的 engineFactory 只读 `slice.xxx`,而 slice 来自 `server.ts:197-200`(只塞 permissionMode+cwd,且 `as any`),导致 `settings.agent.appendSystemPrompt/customSystemPrompt/preset` 永远到不了 Engine——设置页「自定义指令」框一直失效。修复:让 slice 缺省时 fallback 到同文件已读入的 `settings.agent.*`。

**Files:**
- Modify: `packages/core/src/cli/agent-server-stdio.ts:151-154`
- Test: `packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

新建 `packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts`。engineFactory 是模块级闭包,不易直接 import,故抽一个纯函数测合并逻辑。先在 `agent-server-stdio.ts` 顶部(import 之后)新增并导出这个纯函数:

```ts
// agent-server-stdio.ts — 新增导出(测试可 import)
import type { EngineConfigSlice } from "../protocol/chat-session-manager.js";
import type { ValidatedSettings } from "../settings/schema.js";

/**
 * Resolve per-session agent config: protocol slice overrides win, else fall
 * back to disk settings.agent.*. Fixes the bug where settings.agent.* never
 * reached session engines (slice came in with only permissionMode+cwd).
 */
export function resolveSessionAgentConfig(
  slice: EngineConfigSlice,
  settings: ValidatedSettings,
) {
  return {
    preset: slice.preset ?? settings.agent.preset,
    customSystemPrompt: slice.customSystemPrompt ?? settings.agent.customSystemPrompt,
    appendSystemPrompt: slice.appendSystemPrompt ?? settings.agent.appendSystemPrompt,
  };
}
```

测试内容:

```ts
import { describe, it, expect } from "vitest";
import { resolveSessionAgentConfig } from "../agent-server-stdio.js";
import type { ValidatedSettings } from "../../settings/schema.js";

const baseSettings = {
  agent: {
    preset: "terminal-coding",
    enabledBuiltinTools: [],
    disabledBuiltinTools: [],
    customSystemPrompt: "CUSTOM_FROM_SETTINGS",
    appendSystemPrompt: "APPEND_FROM_SETTINGS",
  },
} as unknown as ValidatedSettings;

describe("resolveSessionAgentConfig", () => {
  it("falls back to settings.agent.* when slice fields are undefined", () => {
    const out = resolveSessionAgentConfig({ permissionMode: "default" } as any, baseSettings);
    expect(out.appendSystemPrompt).toBe("APPEND_FROM_SETTINGS");
    expect(out.customSystemPrompt).toBe("CUSTOM_FROM_SETTINGS");
    expect(out.preset).toBe("terminal-coding");
  });

  it("lets protocol slice override settings", () => {
    const out = resolveSessionAgentConfig(
      { appendSystemPrompt: "FROM_SLICE", preset: "general" } as any,
      baseSettings,
    );
    expect(out.appendSystemPrompt).toBe("FROM_SLICE");
    expect(out.preset).toBe("general");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/cli/__tests__/agent-server-stdio-factory.test.ts`
Expected: FAIL —— `resolveSessionAgentConfig is not exported` / undefined。

- [ ] **Step 3: 实现 — 导出纯函数 + 在 engineFactory 里用它**

在 `agent-server-stdio.ts` 顶部新增上面的 `resolveSessionAgentConfig`(含两个 import)。然后把 `151-154` 改为:

```ts
      // Per-session overrides from the protocol request; fall back to
      // settings.agent.* so the user's 个性化 settings actually apply
      // (previously slice came in with only permissionMode+cwd, so these
      // were always undefined — the 自定义指令 box never took effect).
      permissionMode: slice.permissionMode,
      ...resolveSessionAgentConfig(slice, settings),
```

(删除原 `preset: slice.preset` / `customSystemPrompt: slice.customSystemPrompt` / `appendSystemPrompt: slice.appendSystemPrompt` 三行,由展开替代。)

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bunx vitest run src/cli/__tests__/agent-server-stdio-factory.test.ts`
Expected: PASS(2 个用例)。

- [ ] **Step 5: 类型检查**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: 无错误。若提示 `ValidatedSettings` 导出名不符,改用 `schema.ts` 实际导出的 settings 类型名(见该文件末尾 `export type`)。

- [ ] **Step 6: Commit(协调者执行)**

```bash
git add packages/core/src/cli/agent-server-stdio.ts packages/core/src/cli/__tests__/agent-server-stdio-factory.test.ts
git commit -m "fix(chat): settings.agent.* now reaches session engines

engineFactory only read slice.* (preset/custom/append), but the protocol
slice arrives with only permissionMode+cwd — so the 个性化 自定义指令 box
never took effect. Fall back to disk settings.agent.* when slice is empty."
```

---

## Task 2: schema 新增 responseLanguage / userProfile / instructions

**Files:**
- Modify: `packages/core/src/settings/schema.ts:32-41`
- Test: `packages/core/src/settings/__tests__/schema-personalization.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { SettingsSchema } from "../schema.js"; // 若导出名不同,见下方 Step 3 注

describe("agent personalization schema", () => {
  it("accepts responseLanguage / userProfile / instructions", () => {
    const parsed = SettingsSchema.parse({
      agent: {
        responseLanguage: "简体中文",
        userProfile: "叫我 maki",
        instructions: { compatClaude: false, compatCodex: true },
      },
    });
    expect(parsed.agent.responseLanguage).toBe("简体中文");
    expect(parsed.agent.userProfile).toBe("叫我 maki");
    expect(parsed.agent.instructions?.compatClaude).toBe(false);
    expect(parsed.agent.instructions?.compatCodex).toBe(true);
  });

  it("defaults both compat flags to true when instructions omitted-but-present", () => {
    const parsed = SettingsSchema.parse({ agent: { instructions: {} } });
    expect(parsed.agent.instructions?.compatClaude).toBe(true);
    expect(parsed.agent.instructions?.compatCodex).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/settings/__tests__/schema-personalization.test.ts`
Expected: FAIL —— `responseLanguage` 等字段不存在 / `SettingsSchema` 导入名不符。

- [ ] **Step 3: 实现 — 扩 agent object**

把 `schema.ts:32-41` 的 agent object 改为(只加 3 组字段,其余不动):

```ts
    agent: z
      .object({
        // Use z.string() instead of z.enum() to allow custom presets registered via registerPreset()
        preset: z.string().default("terminal-coding"),
        enabledBuiltinTools: z.array(z.string()).default([]),
        disabledBuiltinTools: z.array(z.string()).default([]),
        customSystemPrompt: z.string().optional(),
        appendSystemPrompt: z.string().optional(),
        responseLanguage: z.string().optional(),
        userProfile: z.string().optional(),
        instructions: z
          .object({
            compatClaude: z.boolean().default(true),
            compatCodex: z.boolean().default(true),
          })
          .optional(),
      })
      .default({}),
```

> 注:测试里的 `SettingsSchema` 用的是 `schema.ts` 实际导出的顶层 schema 名。先 grep `export const` / `export.*Schema` 确认真实名字(可能是 `settingsSchema` 或 `SettingsSchema`),测试与实现保持一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bunx vitest run src/settings/__tests__/schema-personalization.test.ts`
Expected: PASS(2 个用例)。

- [ ] **Step 5: Commit(协调者执行)**

```bash
git add packages/core/src/settings/schema.ts packages/core/src/settings/__tests__/schema-personalization.test.ts
git commit -m "feat(settings): add agent.responseLanguage / userProfile / instructions schema"
```

---

## Task 3: EngineConfig + ComposerOptions 新增字段,composer 渲染 personalization section

**Files:**
- Modify: `packages/core/src/engine/engine.ts:124-128`(EngineConfig)、`engine.ts:1170-1178`(主 composer)、`engine.ts:821-828`(子 Engine 继承)
- Modify: `packages/core/src/prompt/composer.ts:17-38`(ComposerOptions)、`composer.ts:190-198`(getSections)
- Test: `packages/core/src/prompt/__tests__/composer-personalization.test.ts`(新建)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { PromptComposer } from "../composer.js";

function composerWith(opts: Record<string, unknown>) {
  return new PromptComposer({ cwd: process.cwd(), model: "test-model", ...opts } as any);
}

describe("composer personalization section", () => {
  it("includes responseLanguage and userProfile when set", async () => {
    const c = composerWith({ responseLanguage: "Always reply in Simplified Chinese", userProfile: "Call me maki" });
    const sys = await c.buildSystemPrompt([]);
    expect(sys).toContain("Always reply in Simplified Chinese");
    expect(sys).toContain("Call me maki");
  });

  it("omits the section entirely when both are empty", async () => {
    const c = composerWith({});
    const sys = await c.buildSystemPrompt([]);
    expect(sys).not.toContain("User & Response Preferences");
  });

  it("includes only the field that is set", async () => {
    const c = composerWith({ userProfile: "Call me maki" });
    const sys = await c.buildSystemPrompt([]);
    expect(sys).toContain("Call me maki");
    expect(sys).not.toContain("Response language");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/prompt/__tests__/composer-personalization.test.ts`
Expected: FAIL —— section 未渲染,断言文本不存在。

- [ ] **Step 3a: ComposerOptions 新增字段**

`composer.ts:17-38` 的 `ComposerOptions` interface 内,在 `appendSystemPrompt?` 之后加:

```ts
  /** User's preferred response language (free text), injected as a stable system section. */
  responseLanguage?: string;
  /** How to address the user / short profile (free text). */
  userProfile?: string;
```

- [ ] **Step 3b: getSections 新增 personalization section**

`composer.ts` 的 `getSections()` 中,在 `append_system` 片段(约 190-196 行)**之后**、`return sections;` 之前插入:

```ts
    // Personalization — stable user preferences (language + how to address
    // the user). Placed in the cacheable system prefix because it doesn't
    // change per-turn. Only emitted when at least one field is set.
    const { responseLanguage, userProfile } = this.options;
    if (responseLanguage || userProfile) {
      sections.push({
        name: "personalization",
        compute: () => {
          const lines = ["# User & Response Preferences"];
          if (userProfile) lines.push(`- About the user: ${userProfile}`);
          if (responseLanguage) lines.push(`- Response language: ${responseLanguage}`);
          return lines.join("\n");
        },
      });
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bunx vitest run src/prompt/__tests__/composer-personalization.test.ts`
Expected: PASS(3 个用例)。

- [ ] **Step 5: EngineConfig 新增字段声明**

`engine.ts:124-128`,在 `appendSystemPrompt?: string;` 之后加:

```ts
  responseLanguage?: string;
  userProfile?: string;
```

- [ ] **Step 6: 主 PromptComposer 构造传入(engine.ts:1170-1178)**

在 `appendSystemPrompt: this.config.appendSystemPrompt,` 之后加:

```ts
      responseLanguage: this.config.responseLanguage,
      userProfile: this.config.userProfile,
```

- [ ] **Step 7: 子 Engine 继承(engine.ts:821-828)**

在子 spawn 的 config 里,`appendSystemPrompt:` 块之后加(让 subagent 也带上):

```ts
          responseLanguage: this.config.responseLanguage,
          userProfile: this.config.userProfile,
```

- [ ] **Step 8: 类型检查**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 9: Commit(协调者执行)**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/prompt/composer.ts packages/core/src/prompt/__tests__/composer-personalization.test.ts
git commit -m "feat(prompt): inject responseLanguage / userProfile as a stable system section"
```

---

## Task 4: 指令文件兼容开关接通 ScanOptions

**背景:** `composer.getInstructions()`(composer.ts:201-206)已支持 `instructionOptions: ScanOptions`,但没人喂它。本任务把 `agent.instructions.{compatClaude,compatCodex}` 拼成 `ScanOptions.compatFileNames` 传入。主名写死 `CODESHELL.md`,不暴露 fileName。

**Files:**
- Modify: `packages/core/src/prompt/composer.ts`(ComposerOptions 已有 `instructionOptions?: ScanOptions`,无需改类型;只需主/子 Engine 构造时传值)
- Modify: `packages/core/src/engine/engine.ts`(EngineConfig 新增 instructions 字段 + 拼 compatFileNames 传给 composer + 子继承)
- Test: `packages/core/src/prompt/__tests__/composer-instructions-compat.test.ts`(新建)

- [ ] **Step 1: 写失败测试 — 抽一个纯函数算 compatFileNames**

在 `engine.ts` 新增并导出一个纯函数(放在 EngineConfig 附近):

```ts
/**
 * Build ScanOptions.compatFileNames from the user's instruction compat toggles.
 * Primary file name stays hard-wired to CODESHELL.md (not exposed). Turning a
 * compat flag off only drops the same-named .md (CLAUDE.md / AGENTS.md); the
 * .claude/ subdir, *.local.md and rules/ are intentionally NOT linked.
 */
export function compatFileNamesFrom(instructions?: { compatClaude?: boolean; compatCodex?: boolean }): string[] {
  const names: string[] = [];
  if (instructions?.compatClaude !== false) names.push("CLAUDE.md");
  if (instructions?.compatCodex !== false) names.push("AGENTS.md");
  return names;
}
```

测试 `packages/core/src/engine/__tests__/compat-filenames.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compatFileNamesFrom } from "../engine.js";

describe("compatFileNamesFrom", () => {
  it("defaults to both when undefined (backward compatible)", () => {
    expect(compatFileNamesFrom(undefined)).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });
  it("drops CLAUDE.md when compatClaude is false", () => {
    expect(compatFileNamesFrom({ compatClaude: false, compatCodex: true })).toEqual(["AGENTS.md"]);
  });
  it("drops AGENTS.md when compatCodex is false", () => {
    expect(compatFileNamesFrom({ compatClaude: true, compatCodex: false })).toEqual(["CLAUDE.md"]);
  });
  it("drops both when both false", () => {
    expect(compatFileNamesFrom({ compatClaude: false, compatCodex: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bunx vitest run src/engine/__tests__/compat-filenames.test.ts`
Expected: FAIL —— `compatFileNamesFrom` 未导出。

- [ ] **Step 3a: 实现纯函数**

把 Step 1 的 `compatFileNamesFrom` 加到 `engine.ts`(EngineConfig interface 之上或之下,顶层导出)。

- [ ] **Step 3b: EngineConfig 新增 instructions 字段**

`engine.ts:124-128` 区,在 Task 3 加的 `userProfile?` 之后加:

```ts
  instructions?: { compatClaude?: boolean; compatCodex?: boolean };
```

- [ ] **Step 3c: 主 composer 构造传 instructionOptions(engine.ts:1170-1178)**

在 PromptComposer 构造里加:

```ts
      instructionOptions: { compatFileNames: compatFileNamesFrom(this.config.instructions) },
```

> `ScanOptions.fileName` 不传 → scanner 用默认 `"CODESHELL.md"`(instruction-scanner.ts:60)。符合"主名写死"。

- [ ] **Step 3d: 子 Engine 继承(engine.ts:821-828)**

在子 spawn config 里加:

```ts
          instructions: this.config.instructions,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bunx vitest run src/engine/__tests__/compat-filenames.test.ts`
Expected: PASS(4 个用例)。

- [ ] **Step 5: 集成测试 — 验证 scanner 真的不读被关掉的文件**

新建 `packages/core/src/prompt/__tests__/composer-instructions-compat.test.ts`,用临时目录放 CLAUDE.md/AGENTS.md/CODESHELL.md,断言 composer 的 userContext 是否含各自内容:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptComposer } from "../composer.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-compat-"));
  writeFileSync(join(dir, "CODESHELL.md"), "PRIMARY_INSTR");
  writeFileSync(join(dir, "CLAUDE.md"), "CLAUDE_INSTR");
  writeFileSync(join(dir, "AGENTS.md"), "AGENTS_INSTR");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function userCtx(opts: Record<string, unknown>) {
  const c = new PromptComposer({ cwd: dir, model: "test", ...opts } as any);
  return c.buildUserContextMessage()?.content ?? "";
}

describe("instruction compat toggles", () => {
  it("reads CODESHELL.md always", () => {
    expect(userCtx({ instructionOptions: { compatFileNames: [] } })).toContain("PRIMARY_INSTR");
  });
  it("reads CLAUDE.md only when CLAUDE.md in compatFileNames", () => {
    expect(userCtx({ instructionOptions: { compatFileNames: ["CLAUDE.md"] } })).toContain("CLAUDE_INSTR");
    expect(userCtx({ instructionOptions: { compatFileNames: ["AGENTS.md"] } })).not.toContain("CLAUDE_INSTR");
  });
  it("reads AGENTS.md only when AGENTS.md in compatFileNames", () => {
    expect(userCtx({ instructionOptions: { compatFileNames: ["AGENTS.md"] } })).toContain("AGENTS_INSTR");
  });
});
```

Run: `cd packages/core && bunx vitest run src/prompt/__tests__/composer-instructions-compat.test.ts`
Expected: PASS(3 个用例)。若 `buildUserContextMessage` 因 git 边界扫到仓库内其它 CLAUDE.md 干扰,改用 `ignoreGitBoundary` 不适用——临时目录在 tmpdir 不属本仓库 git,scanner 的 `findGitRoot` 对它返回 null → ceiling=`/`,只会扫到该目录自身的文件,无干扰。

- [ ] **Step 6: 类型检查**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: Commit(协调者执行)**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/engine/__tests__/compat-filenames.test.ts packages/core/src/prompt/__tests__/composer-instructions-compat.test.ts
git commit -m "feat(prompt): wire agent.instructions compat toggles into ScanOptions.compatFileNames"
```

---

## Task 5: EngineConfigSlice 白名单核对(确认无需扩)

**背景:** `chat-session-manager.ts:6-16` 的 `EngineConfigSlice` 是 `Pick<EngineConfig, ...>` 白名单。新字段 `responseLanguage`/`userProfile`/`instructions` 是否要加进去?

**关键判断:** 这些新字段的值来自**磁盘 settings**,在 Task 1 的 `resolveSessionAgentConfig` / Task 4 的 engineFactory 里,engineFactory 直接持有 `settings` 变量(agent-server-stdio.ts:54),**从 settings 读、不经过 protocol slice**。所以它们**不需要**进 `EngineConfigSlice`(slice 只承载 per-request 协议覆盖,如 permissionMode)。

- [ ] **Step 1: 在 engineFactory 里从 settings 喂新字段**

`agent-server-stdio.ts` engineFactory(Task 1 改过的区域)新增三行,从 `settings.agent` 直接读(不走 slice):

```ts
      // Personalization + instruction compat come from disk settings only
      // (not per-request protocol overrides), so they read straight from
      // `settings` here rather than through the slice.
      responseLanguage: settings.agent.responseLanguage,
      userProfile: settings.agent.userProfile,
      instructions: settings.agent.instructions,
```

- [ ] **Step 2: 类型检查 + 全量 core 测试**

Run: `cd packages/core && bunx tsc --noEmit && bunx vitest run`
Expected: tsc 无错误;新增的测试全 PASS,既有测试不回归。

- [ ] **Step 3: Commit(协调者执行)**

```bash
git add packages/core/src/cli/agent-server-stdio.ts
git commit -m "feat(chat): feed agent personalization + instruction toggles into session engines"
```

---

## Task 6: 验证新字段惠及 subagent

**Files:**
- Test: `packages/core/src/engine/__tests__/subagent-inherits-personalization.test.ts`(新建)

- [ ] **Step 1: 写测试 — 子 Engine config 带上父的个性化字段**

> 子 Engine 在 `engine.ts:spawn` 里构造。该路径较重,优先用纯断言:既然 Task 3/4 已在 spawn config 里加了 `responseLanguage/userProfile/instructions: this.config.xxx`,本测试验证"父 config 有 → 子 config 透传"。若 spawn 难以在单测中隔离调用,退一步:断言 `engine.ts` spawn 块文本包含这三个字段的透传(用读取源码字符串的方式不稳妥)——因此首选下面的行为测试,通过 Engine 公开的 spawn 或 getConfig 验证。

```ts
import { describe, it, expect } from "vitest";
import { Engine } from "../engine.js";

describe("subagent inherits personalization", () => {
  it("parent EngineConfig carries personalization fields into getConfig", () => {
    const engine = new Engine({
      llm: { provider: "openai", model: "m", apiKey: "", baseUrl: "" },
      cwd: process.cwd(),
      responseLanguage: "简体中文",
      userProfile: "maki",
      instructions: { compatClaude: false, compatCodex: true },
    } as any);
    const cfg = engine.getConfig();
    expect(cfg.responseLanguage).toBe("简体中文");
    expect(cfg.userProfile).toBe("maki");
    expect(cfg.instructions?.compatClaude).toBe(false);
  });
});
```

> 说明:`getConfig()` 已在 server.ts:593 被使用,确认是公开方法。本测试守住"字段进了 EngineConfig 且可读出";子 Engine 继承的代码(Task 3 Step 7 / Task 4 Step 3d)是 `this.config.xxx` 直接透传,与父 config 同源,故父可读出即等价保证子继承。

- [ ] **Step 2: 跑测试**

Run: `cd packages/core && bunx vitest run src/engine/__tests__/subagent-inherits-personalization.test.ts`
Expected: PASS。若 Engine 构造需要更多必填字段,补足 `as any` 的最小字段使其能实例化。

- [ ] **Step 3: Commit(协调者执行)**

```bash
git add packages/core/src/engine/__tests__/subagent-inherits-personalization.test.ts
git commit -m "test(engine): assert personalization fields live on EngineConfig (subagent inherits)"
```

---

## Task 7: 重建 core(供 desktop dist 引用)

**背景:** desktop 通过 worker 进程引用 core 的 dist 产物。core 改动需 rebuild 才能被 desktop 运行时看到(项目既有约定)。

- [ ] **Step 1: 重建 core**

Run: `cd packages/core && bun run build`
Expected: 构建成功,无类型错误。

- [ ] **Step 2: Commit(若 build 产物入库则提交,否则跳过)**

```bash
# 仅当 dist 纳入版本控制时:
git add packages/core/dist
git commit -m "build(core): rebuild dist for personalization changes"
```

> 若 `packages/core/dist` 在 .gitignore 中,跳过此 commit。

---

## Task 8: desktop UI — 新增「个性化」与「指令文件」两个 section

**背景:** `AdvancedSections.tsx` 现有 `PersonalizationSection`(= appendSystemPrompt 框)**保持不动**。新增两个独立导出 section。遵循 desktop CLAUDE.md:用 `@/components/ui` 的 Input/Textarea/Switch + Tailwind 语义 token,不手写原生控件。读写沿用现有 `getSettings`/`writeSettings`(scope+cwd)。

**Files:**
- Modify: `packages/desktop/src/renderer/settings/AdvancedSections.tsx`(新增两个导出函数)
- 需确认:新 section 在设置页的挂载点(渲染 PersonalizationSection 的父组件),把两个新 section 也挂上。先 grep `PersonalizationSection` 的引用处。

- [ ] **Step 1: 新增 ResponsePrefsSection(个性化:语言 + 画像)**

在 `AdvancedSections.tsx` 的 `PersonalizationSection` 之后新增。helper `objectOf`/`stringOf` 已在文件内(PersonalizationSection 用到),复用即可:

```tsx
export function ResponsePrefsSection({ scope, activeRepoPath }: ScopedProps) {
  const [language, setLanguage] = useState("");
  const [profile, setProfile] = useState("");
  const [saved, setSaved] = useState({ language: "", profile: "" });
  const [saving, setSaving] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const agent = objectOf(s.agent);
    const lang = stringOf(agent.responseLanguage);
    const prof = stringOf(agent.userProfile);
    setLanguage(lang); setProfile(prof);
    setSaved({ language: lang, profile: prof });
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  const dirty = language !== saved.language || profile !== saved.profile;
  const save = async () => {
    setSaving(true);
    try {
      await writeSettings(scope, { agent: { responseLanguage: language, userProfile: profile } }, cwd);
      setSaved({ language, profile });
    } finally { setSaving(false); }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">个性化</h3>
        <p className="mt-1 text-xs text-muted-foreground">回复语言与称呼会作为稳定偏好注入每次对话(主对话与子代理均生效)。</p>
      </div>
      <Input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="回复语言,如:始终用简体中文" />
      <Textarea value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="称呼 / 画像,如:叫我 maki,后端工程师" className="min-h-[120px] resize-y leading-relaxed" />
      <div className="flex justify-end">
        <Button variant="solid" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "保存中…" : "保存"}</Button>
      </div>
    </section>
  );
}
```

> `Input` 来自 `@/components/ui/input` —— 文件顶部 import 区已有 Textarea/Switch/Button/Select。新增 `import { Input } from "@/components/ui/input";`(若 `@/components/ui/input` 不存在,按 desktop CLAUDE.md 先从 shadcn 拷一个 input 组件再用,不要手写 `<input>`)。

- [ ] **Step 2: 新增 InstructionFilesSection(两个兼容开关)**

```tsx
export function InstructionFilesSection({ scope, activeRepoPath }: ScopedProps) {
  const [compatClaude, setCompatClaude] = useState(true);
  const [compatCodex, setCompatCodex] = useState(true);
  const [saved, setSaved] = useState({ claude: true, codex: true });
  const [saving, setSaving] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const agent = objectOf(s.agent);
    const instr = objectOf(agent.instructions);
    const c = instr.compatClaude !== false;
    const x = instr.compatCodex !== false;
    setCompatClaude(c); setCompatCodex(x);
    setSaved({ claude: c, codex: x });
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  const dirty = compatClaude !== saved.claude || compatCodex !== saved.codex;
  const save = async () => {
    setSaving(true);
    try {
      await writeSettings(scope, { agent: { instructions: { compatClaude, compatCodex } } }, cwd);
      setSaved({ claude: compatClaude, codex: compatCodex });
    } finally { setSaving(false); }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">指令文件</h3>
        <p className="mt-1 text-xs text-muted-foreground">始终读取 CODESHELL.md。可选地兼容读取其他工具的指令文件。</p>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        <span>兼容 Claude(CLAUDE.md)</span>
        <Switch checked={compatClaude} onCheckedChange={setCompatClaude} />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        <span>兼容 Codex(AGENTS.md)</span>
        <Switch checked={compatCodex} onCheckedChange={setCompatCodex} />
      </label>
      <div className="flex justify-end">
        <Button variant="solid" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "保存中…" : "保存"}</Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: 挂载两个新 section**

Run(先定位挂载点):`cd packages/desktop && grep -rn "PersonalizationSection" src/`
然后在渲染 `<PersonalizationSection .../>` 的父组件里,紧随其后挂上 `<ResponsePrefsSection .../>` 和 `<InstructionFilesSection .../>`(传相同的 `scope` / `activeRepoPath`)。

- [ ] **Step 4: 类型检查 + 构建 renderer**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: 无类型错误,renderer 构建成功。

- [ ] **Step 5: Commit(协调者执行)**

```bash
git add packages/desktop/src/renderer/settings/AdvancedSections.tsx
git commit -m "feat(desktop): personalization (language/profile) + instruction-files settings sections"
```

---

## Task 9: 手动验收

- [ ] **Step 1: 起 desktop,设置页填值验证**

Run(由用户执行):`! cd packages/desktop && bun run dev`(或项目既有启动命令)
- 在「个性化」填回复语言「始终用简体中文」→ 保存 → 新开聊天问一句英文问题 → 确认中文回复。
- 在「指令文件」关掉「兼容 Claude」→ 保存 → 确认仓库根 CLAUDE.md 的指令不再注入(可问一个只有 CLAUDE.md 里才有的约定)。
- 验证既有「自定义指令」(append)框现在也真生效了(Task 1 修复)。

- [ ] **Step 2: 无回归确认**

Run: `cd packages/core && bunx vitest run`
Expected: 全绿。

---

## 实现顺序与依赖

```
Task 1 (修断链) ──┐
Task 2 (schema) ──┼─→ Task 3 (字段+composer) ─→ Task 4 (指令开关) ─→ Task 5 (engineFactory 喂值) ─→ Task 6 (继承测试) ─→ Task 7 (rebuild core) ─→ Task 8 (UI) ─→ Task 9 (验收)
```

Task 1 与 Task 2 互不依赖,可任意先后;Task 3 依赖 Task 2 的 schema;Task 5 依赖 1/3/4 的字段就位;Task 8 依赖 7 的 dist。

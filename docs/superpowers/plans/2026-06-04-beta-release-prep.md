# 测试版准备 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让少数熟人拿到能装能跑、开箱有默认 agents+市场源的 Electron App 和 npm rc.1 包,并让 agent 能自己装市场源。

**Architecture:** 修测试腐化(块 0)→ 三条可并行支线:Electron 真打包验证(块 1)、首启 seed 默认 agents+市场源(块 2)、新增 AddMarketplace 内置工具(块 3)→ npm rc.1 发布(块 4)→ 冒烟清单+分发说明(块 5)。块 2/3 是代码改动,块 1/4/5 是验证/发布操作。

**Tech Stack:** TypeScript, bun(test runner + build), Electron + electron-builder, core 的内置工具系统(`BUILTIN_TOOLS` 注册表)。

参考 spec:`docs/superpowers/specs/2026-06-04-beta-release-prep-design.md`

---

## File Structure

**块 0(改)**:4 个 `*.test.ts` 文件(见各任务路径)。
**块 3(创建+改)**:
- Create: `packages/core/src/tool-system/builtin/add-marketplace.ts`(工具定义+执行)
- Create: `packages/core/src/tool-system/builtin/add-marketplace.test.ts`
- Modify: `packages/core/src/tool-system/builtin/index.ts`(注册)
**块 2(创建+改)**:
- Create: `packages/desktop/src/main/seed-defaults.ts`(首启 seed 逻辑)
- Create: `packages/desktop/src/main/seed-defaults.test.ts`
- Create: `packages/desktop/resources/known-marketplaces-seed.json`(市场源种子)
- Modify: `packages/desktop/src/main/index.ts`(whenReady 里调 seedDefaults)
- Modify: `packages/desktop/package.json`(extraResources)
**块 1/4/5**:无新代码文件,操作 `packages/desktop/package.json`(版本)、根 `package.json`(版本)、新建 `docs/beta-smoke-checklist.md`。

---

## 块 0 — 修测试套件腐化(前置)

### Task 0.1: 修 write-policy.test.ts

**Files:**
- Modify: `packages/core/src/automation/write-policy.test.ts:59`

- [ ] **Step 1: 看现状,确认报错行**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep write-policy`
Expected: `write-policy.test.ts(59,25): error TS2345: Argument of type 'undefined' is not assignable to parameter of type 'CronPermissionLevel'.`

- [ ] **Step 2: 读上下文确定该传什么**

Run: `sed -n '50,65p' packages/core/src/automation/write-policy.test.ts`
查清第 59 行调用的函数签名第二参数 `CronPermissionLevel` 的合法值(看该文件顶部 import 或 `grep -rn "type CronPermissionLevel" packages/core/src`)。合法值通常是 `"default" | "read-only" | ...`。该测试用例应是测「未指定权限级别」的退化路径——把 `undefined` 换成该测试语义对应的显式值(若测的是缺省,改成 `"default"`;若专测 read-only 退化,用 `"read-only"`)。

- [ ] **Step 3: 改这一行**

把 `undefined` 替换为显式的 `CronPermissionLevel` 值(依据 Step 2 的语义判断,例如 `"default"`)。

- [ ] **Step 4: 验证该文件类型干净**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep write-policy; echo "exit:$?"`
Expected: 无 write-policy 输出。

- [ ] **Step 5: 跑该测试文件**

Run: `cd packages/core && bun test src/automation/write-policy.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/automation/write-policy.test.ts
git commit -m "test(core): fix write-policy CronPermissionLevel type"
```

### Task 0.2: 修 openai-reasoning-effort-drop.test.ts

**Files:**
- Modify: `packages/core/src/llm/providers/openai-reasoning-effort-drop.test.ts:14`

- [ ] **Step 1: 确认报错**

Run: `sed -n '10,18p' packages/core/src/llm/providers/openai-reasoning-effort-drop.test.ts`
Expected: 第 14 行把 `OpenAI.APIError` 当类型注解用,报 `TS2749: 'OpenAI.APIError' refers to a value, but is being used as a type here.`

- [ ] **Step 2: 改成 typeof**

把第 14 行类型位置的 `OpenAI.APIError` 改为 `InstanceType<typeof OpenAI.APIError>`(若是变量类型注解)或 `typeof OpenAI.APIError`(若需要的是构造器类型)。先用 `InstanceType<typeof OpenAI.APIError>`——这是「一个 APIError 实例」的正确写法,匹配绝大多数用法。

- [ ] **Step 3: 验证**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep openai-reasoning; echo "exit:$?"`
Expected: 无输出。

- [ ] **Step 4: 跑测试**

Run: `cd packages/core && bun test src/llm/providers/openai-reasoning-effort-drop.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/providers/openai-reasoning-effort-drop.test.ts
git commit -m "test(core): fix OpenAI.APIError used as type"
```

### Task 0.3: 修 update-automation-memory.test.ts

**Files:**
- Modify: `packages/core/src/tool-system/builtin/update-automation-memory.test.ts:26,27,36,44`

- [ ] **Step 1: 确认报错根因**

Run: `sed -n '20,48p' packages/core/src/tool-system/builtin/update-automation-memory.test.ts`
Expected: 这些行把工具返回值(`BuiltinToolResult`)直接当字符串调 `.startsWith` / `.toLowerCase`。`BuiltinToolResult` 是 `string | { contentBlocks; result? }`(见 `index.ts:64-66`)。

- [ ] **Step 2: 加一个取文本的辅助,在断言前归一化**

在测试文件顶部(import 之后)加:

```typescript
function asText(r: string | { contentBlocks: unknown[]; result?: string }): string {
  return typeof r === "string" ? r : (r.result ?? "");
}
```

然后把第 26/27/36/44 行的 `result.startsWith(...)` / `result.toLowerCase()` 改成 `asText(result).startsWith(...)` / `asText(result).toLowerCase()`(变量名按文件实际为准)。

- [ ] **Step 3: 验证类型**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep update-automation-memory; echo "exit:$?"`
Expected: 无输出。

- [ ] **Step 4: 跑测试**

Run: `cd packages/core && bun test src/tool-system/builtin/update-automation-memory.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-system/builtin/update-automation-memory.test.ts
git commit -m "test(core): normalize BuiltinToolResult before string assertions"
```

### Task 0.4: 修 executor-abort.test.ts

**Files:**
- Modify: `packages/core/src/tool-system/executor-abort.test.ts:23`

- [ ] **Step 1: 确认报错**

Run: `sed -n '15,30p' packages/core/src/tool-system/executor-abort.test.ts`
Expected: 第 23 行构造的对象缺 `RegisteredTool` 必填字段 `source` 和 `permissionDefault`。

- [ ] **Step 2: 补字段**

给该对象补上 `source: "builtin"` 与 `permissionDefault: "allow"`(只读测试桩,allow 合适)。例如:

```typescript
{
  name: "...",
  description: "...",
  inputSchema: { type: "object", properties: {} },
  source: "builtin",
  permissionDefault: "allow",
}
```

- [ ] **Step 3: 验证**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep executor-abort; echo "exit:$?"`
Expected: 无输出。

- [ ] **Step 4: 跑测试**

Run: `cd packages/core && bun test src/tool-system/executor-abort.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-system/executor-abort.test.ts
git commit -m "test(core): add missing RegisteredTool fields to abort test stub"
```

### Task 0.5: 全量验证块 0

- [ ] **Step 1: 根 typecheck 干净**

Run: `bun run typecheck 2>&1 | tail -5; echo "exit:${PIPESTATUS[0]}"`
Expected: 0 错(无 `error TS` 行)。

- [ ] **Step 2: 全量测试绿**

Run: `bun test 2>&1 | tail -15`
Expected: 0 fail。若有 fail,用 systematic-debugging skill 逐个查,不要跳过。

---

## 块 3 — 新工具 AddMarketplace(TDD)

> 注:这是唯一的创造性新功能,严格 TDD。core 已有 `addMarketplace(name, source: MarketplaceSource): Promise<AddMarketplaceResult>`(`packages/core/src/plugins/marketplaceManager.ts:87`,已从 `index.ts` export)。`MarketplaceSource = { source: "github"; repo } | { source: "git"; url }`(`packages/core/src/plugins/types.ts:8-10`)。新工具就是包一层调它。

### Task 3.1: 写工具的失败测试

**Files:**
- Create: `packages/core/src/tool-system/builtin/add-marketplace.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it, mock } from "bun:test";

// 用依赖注入式测法:工具通过 ctx 不到 addMarketplace,故我们 mock core 的 export。
// 这里测工具的「参数解析 + 调用转发 + 结果文案」三件事,不真去 git clone。
import { addMarketplaceToolDef, addMarketplaceTool } from "./add-marketplace.js";

describe("AddMarketplace tool", () => {
  it("has a name and required source fields in its schema", () => {
    expect(addMarketplaceToolDef.name).toBe("AddMarketplace");
    const props = addMarketplaceToolDef.inputSchema.properties as Record<string, unknown>;
    expect(props.name).toBeDefined();
    expect(props.source_type).toBeDefined();
    expect(addMarketplaceToolDef.inputSchema.required).toContain("name");
    expect(addMarketplaceToolDef.inputSchema.required).toContain("source_type");
  });

  it("rejects missing name", async () => {
    const out = await addMarketplaceTool({ source_type: "github", repo: "a/b" });
    expect(out).toContain("Error");
    expect(out).toContain("name");
  });

  it("rejects github source without repo", async () => {
    const out = await addMarketplaceTool({ name: "x", source_type: "github" });
    expect(out).toContain("Error");
    expect(out).toContain("repo");
  });

  it("rejects git source without url", async () => {
    const out = await addMarketplaceTool({ name: "x", source_type: "git" });
    expect(out).toContain("Error");
    expect(out).toContain("url");
  });

  it("rejects unknown source_type", async () => {
    const out = await addMarketplaceTool({ name: "x", source_type: "ftp" });
    expect(out).toContain("Error");
    expect(out).toContain("source_type");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/tool-system/builtin/add-marketplace.test.ts`
Expected: FAIL —「Cannot find module './add-marketplace.js'」。

### Task 3.2: 实现工具(只做参数校验 + 转发)

**Files:**
- Create: `packages/core/src/tool-system/builtin/add-marketplace.ts`

- [ ] **Step 1: 写实现**

```typescript
/**
 * Built-in AddMarketplace tool — register a plugin marketplace source so the
 * user can browse/install plugins from it in the UI. The tool only *adds the
 * source* (git clone + validate marketplace.json via core's addMarketplace);
 * which plugin to install is left to the user. Pairs with WebSearch/WebFetch:
 * the model can discover a marketplace repo, then add it.
 *
 * Side effects (network + git clone + disk write) → permissionDefault "ask".
 */

import type { ToolDefinition } from "../../types.js";
import { addMarketplace } from "../../plugins/marketplaceManager.js";
import type { MarketplaceSource } from "../../plugins/types.js";

export const addMarketplaceToolDef: ToolDefinition = {
  name: "AddMarketplace",
  description:
    "Register a plugin marketplace source so the user can browse and install " +
    "plugins from it. Provide a short name and a source: either a GitHub repo " +
    "(owner/name) or a git URL. This only ADDS the source — it does not install " +
    "any plugin. Use WebSearch/WebFetch first to find a marketplace repo if you " +
    "don't already have one.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short local name for this marketplace (e.g. 'official').",
      },
      source_type: {
        type: "string",
        enum: ["github", "git"],
        description: "'github' for an owner/name repo, 'git' for a clone URL.",
      },
      repo: {
        type: "string",
        description: "GitHub repo in owner/name form (required when source_type='github').",
      },
      url: {
        type: "string",
        description: "Git clone URL (required when source_type='git').",
      },
    },
    required: ["name", "source_type"],
  },
};

export async function addMarketplaceTool(
  args: Record<string, unknown>,
): Promise<string> {
  const name = args.name;
  if (typeof name !== "string" || !name.trim()) {
    return "Error: name is required";
  }
  const sourceType = args.source_type;
  let source: MarketplaceSource;
  if (sourceType === "github") {
    const repo = args.repo;
    if (typeof repo !== "string" || !repo.includes("/")) {
      return "Error: github source requires repo in owner/name form";
    }
    source = { source: "github", repo };
  } else if (sourceType === "git") {
    const url = args.url;
    if (typeof url !== "string" || !url.trim()) {
      return "Error: git source requires a url";
    }
    source = { source: "git", url };
  } else {
    return "Error: source_type must be 'github' or 'git'";
  }

  try {
    const result = await addMarketplace(name, source);
    if (!result.ok) {
      return `Error adding marketplace ${name}: ${result.error}`;
    }
    return `Marketplace '${name}' added. The user can now browse and install plugins from it in the Extensions → Market UI.`;
  } catch (err) {
    return `Error adding marketplace ${name}: ${(err as Error).message}`;
  }
}
```

- [ ] **Step 2: 跑测试确认通过**

Run: `cd packages/core && bun test src/tool-system/builtin/add-marketplace.test.ts`
Expected: PASS(5 个用例全过——它们只覆盖参数校验,不触发真 clone)。

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/tool-system/builtin/add-marketplace.ts packages/core/src/tool-system/builtin/add-marketplace.test.ts
git commit -m "feat(core): AddMarketplace tool — model can register a marketplace source"
```

### Task 3.3: 注册工具到 BUILTIN_TOOLS

**Files:**
- Modify: `packages/core/src/tool-system/builtin/index.ts:46`(import 区尾)与 `:528`(数组末尾,completeGoal 之后)

- [ ] **Step 1: 加 import**

在 `index.ts` 第 46 行(`import { completeGoalToolDef, ... }` 之后)新增一行:

```typescript
import { addMarketplaceToolDef, addMarketplaceTool } from "./add-marketplace.js";
```

- [ ] **Step 2: 加注册条目**

在 `BUILTIN_TOOLS` 数组末尾(`completeGoalTool` 那个条目之后、`];` 之前)插入:

```typescript
  // ─── Plugin marketplace: model-driven source registration ──────
  {
    definition: {
      ...addMarketplaceToolDef,
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: false,
      isConcurrencySafe: false,
      timeoutMs: 120_000, // git clone over network
    },
    execute: addMarketplaceTool,
  },
```

- [ ] **Step 3: 验证类型 + 工具进了注册表**

Run: `cd packages/core && bunx tsc --noEmit 2>&1 | grep -i "index.ts\|add-marketplace"; echo "exit:$?"`
Expected: 无输出。

- [ ] **Step 4: 写注册测试并跑**

在 `add-marketplace.test.ts` 末尾追加:

```typescript
import { BUILTIN_TOOLS } from "./index.js";

it("is registered in BUILTIN_TOOLS with ask permission", () => {
  const entry = BUILTIN_TOOLS.find((t) => t.definition.name === "AddMarketplace");
  expect(entry).toBeDefined();
  expect(entry!.definition.permissionDefault).toBe("ask");
  expect(entry!.definition.isReadOnly).toBe(false);
});
```

Run: `cd packages/core && bun test src/tool-system/builtin/add-marketplace.test.ts`
Expected: PASS(6 个用例)。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-system/builtin/index.ts packages/core/src/tool-system/builtin/add-marketplace.test.ts
git commit -m "feat(core): register AddMarketplace in BUILTIN_TOOLS (ask permission)"
```

### Task 3.4: rebuild core(desktop/tui dist imports 依赖)

> 记忆:改 core 必 rebuild,否则 desktop/tui 引的是旧 dist。

- [ ] **Step 1: rebuild**

Run: `bun run --filter '@cjhyy/code-shell-core' build 2>&1 | tail -3; echo "exit:${PIPESTATUS[0]}"`
Expected: `Exited with code 0`。

- [ ] **Step 2: 确认 dist 含新工具**

Run: `grep -rl "AddMarketplace" packages/core/dist 2>/dev/null | head`
Expected: 至少一个 dist 文件命中。

---

## 块 2 — 开箱默认 seed(首启初始化)

> 机制:electron-builder `extraResources` 携带 `examples/agents/`(已 git 跟踪)+ 一个市场源种子 json;desktop main 在 `app.whenReady()` 里调 `seedDefaults()`,首启时 seed 到 `~/.code-shell/{agents, plugins}`,已 seed 过则跳过(幂等)。用户可改可删。home 路径用 `process.env.HOME ?? os.homedir()`(与 desktop main 现有 agent-service.ts 同源,core 不导出 userHome)。
>
> **不新建 image SKILL.md**:图像生成已是内置工具,只需熟人配好 OpenAI provider 后 `isGenerateImageAvailable` 自动放行(块 5 冒烟里验证)。

### Task 2.1: 创建市场源种子文件

**Files:**
- Create: `packages/desktop/resources/known-marketplaces-seed.json`

- [ ] **Step 1: 确认 KnownMarketplaces 结构**

种子文件的内容会被 seed 逻辑读出、逐条 `addMarketplace`(而不是直接写 known_marketplaces.json——因为真正的条目需要 git clone 后才有 installLocation/lastUpdated)。所以种子文件存的是**源描述**,不是最终条目。结构:

```json
{
  "official": { "source": "github", "repo": "obra/superpowers-marketplace" }
}
```

> repo 值待用户确认实际官方市场仓库;先放 `obra/superpowers-marketplace` 作占位,seed 逻辑对 clone 失败要容错(块 2.3 测试覆盖)。**执行到本步时若用户已指定真实市场源,替换这里。**

- [ ] **Step 2: 写文件**

按上面结构写入。可放多条(key=本地名)。

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/resources/known-marketplaces-seed.json
git commit -m "chore(desktop): add marketplace seed source list"
```

### Task 2.2: seed 逻辑的失败测试

**Files:**
- Create: `packages/desktop/src/main/seed-defaults.test.ts`

> seedDefaults 需要可测:把「读 agents 源目录」「读市场种子」「home 目录」做成参数注入,纯逻辑可测,不碰真实 ~/.code-shell。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgents } from "./seed-defaults.js";

let home: string;
let agentSrc: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seed-home-"));
  agentSrc = mkdtempSync(join(tmpdir(), "seed-src-"));
  writeFileSync(join(agentSrc, "explorer.md"), "---\nname: explorer\n---\nbody");
  writeFileSync(join(agentSrc, "planner.md"), "---\nname: planner\n---\nbody");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(agentSrc, { recursive: true, force: true });
});

describe("seedAgents", () => {
  it("copies agent .md files into <home>/.code-shell/agents on first run", () => {
    const n = seedAgents(agentSrc, home);
    expect(n).toBe(2);
    const dest = join(home, ".code-shell", "agents");
    expect(existsSync(join(dest, "explorer.md"))).toBe(true);
    expect(existsSync(join(dest, "planner.md"))).toBe(true);
  });

  it("is idempotent — does not overwrite existing user agents", () => {
    const dest = join(home, ".code-shell", "agents");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "explorer.md"), "USER EDITED");
    const n = seedAgents(agentSrc, home);
    // explorer 已存在 → 跳过;planner 新增 → 1
    expect(n).toBe(1);
    expect(readdirSync(dest).sort()).toEqual(["explorer.md", "planner.md"]);
    // 用户编辑的 explorer 不被覆盖
    expect(require("node:fs").readFileSync(join(dest, "explorer.md"), "utf-8")).toBe("USER EDITED");
  });

  it("returns 0 when source dir is missing (no throw)", () => {
    const n = seedAgents(join(agentSrc, "nonexistent"), home);
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd packages/desktop && bun test src/main/seed-defaults.test.ts`
Expected: FAIL —「Cannot find module './seed-defaults.js'」。

### Task 2.3: 实现 seed-defaults.ts

**Files:**
- Create: `packages/desktop/src/main/seed-defaults.ts`

- [ ] **Step 1: 写实现**

```typescript
/**
 * First-run defaults seeding for the desktop app.
 *
 * On startup we copy bundled default agents into ~/.code-shell/agents and
 * register bundled marketplace sources — but only for entries the user doesn't
 * already have (idempotent, never overwrites). Users can freely edit or delete
 * the seeded files afterward; we never re-seed an entry they removed within a
 * run, only fill in what's missing on a fresh install.
 *
 * Resource paths differ dev vs packaged: packaged resources live under
 * process.resourcesPath; in dev they sit at the repo root.
 */

import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { addMarketplace } from "@cjhyy/code-shell-core";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

/** Locate a bundled resource: packaged → resourcesPath, dev → repo root. */
export function resourcePath(...parts: string[]): string {
  if (app.isPackaged) return join(process.resourcesPath, ...parts);
  // dev: __dirname is packages/desktop/out/main → repo root is ../../..
  return resolve(__dirname, "..", "..", "..", ...parts);
}

/**
 * Copy default agent .md files into <home>/.code-shell/agents, skipping any
 * that already exist. Returns the number of files newly written. Missing
 * source dir → 0 (no throw).
 */
export function seedAgents(srcDir: string, home: string): number {
  if (!existsSync(srcDir)) return 0;
  const dest = join(home, ".code-shell", "agents");
  mkdirSync(dest, { recursive: true });
  let written = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const target = join(dest, f);
    if (existsSync(target)) continue; // never overwrite user's file
    copyFileSync(join(srcDir, f), target);
    written++;
  }
  return written;
}

/**
 * Register bundled marketplace sources the user doesn't already have.
 * Reads a seed JSON of { name: MarketplaceSource } and calls core's
 * addMarketplace for each. Clone failures are swallowed (best-effort; a bad
 * network on first launch must not block startup). Returns names attempted.
 */
export async function seedMarketplaces(seedFile: string, home: string): Promise<string[]> {
  if (!existsSync(seedFile)) return [];
  // Skip entries already present in the user's known_marketplaces.json.
  const knownPath = join(home, ".code-shell", "plugins", "known_marketplaces.json");
  let known: Record<string, unknown> = {};
  if (existsSync(knownPath)) {
    try {
      known = JSON.parse(readFileSync(knownPath, "utf-8"));
    } catch {
      known = {};
    }
  }
  let seed: Record<string, { source: "github"; repo: string } | { source: "git"; url: string }>;
  try {
    seed = JSON.parse(readFileSync(seedFile, "utf-8"));
  } catch {
    return [];
  }
  const attempted: string[] = [];
  for (const [name, source] of Object.entries(seed)) {
    if (known[name]) continue;
    attempted.push(name);
    try {
      await addMarketplace(name, source);
    } catch (err) {
      console.error(`seed: failed to add marketplace ${name}`, err);
    }
  }
  return attempted;
}

/** Top-level first-run seeding, called once from app.whenReady. */
export async function seedDefaults(): Promise<void> {
  const home = userHome();
  try {
    const n = seedAgents(resourcePath("examples", "agents"), home);
    if (n > 0) console.log(`seed: copied ${n} default agent(s)`);
  } catch (err) {
    console.error("seed: agents failed", err);
  }
  try {
    const names = await seedMarketplaces(
      resourcePath("packages", "desktop", "resources", "known-marketplaces-seed.json"),
      home,
    );
    if (names.length) console.log(`seed: registered marketplace(s): ${names.join(", ")}`);
  } catch (err) {
    console.error("seed: marketplaces failed", err);
  }
}
```

> 注:`seedMarketplaces` 的 seedFile 路径在 packaged 与 dev 下都通过 `resourcePath(...)` 解析。dev 下 repo root 拼 `packages/desktop/resources/...`;packaged 下 extraResources 会把 `packages/desktop/resources/` 映射进 resourcesPath(在 Task 2.5 的 extraResources 里对齐这个相对结构)。

- [ ] **Step 2: 跑测试通过**

Run: `cd packages/desktop && bun test src/main/seed-defaults.test.ts`
Expected: PASS(3 个 seedAgents 用例)。

- [ ] **Step 3: desktop typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit 2>&1 | grep -i "seed-defaults"; echo "exit:$?"`
Expected: 无输出。(若报 `addMarketplace` 找不到,确认块 3.4 已 rebuild core,且 core `index.ts` 确实 export 了 `addMarketplace`——`grep -n "addMarketplace" packages/core/src/index.ts`。)

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/main/seed-defaults.ts packages/desktop/src/main/seed-defaults.test.ts
git commit -m "feat(desktop): first-run seedDefaults (agents + marketplace sources)"
```

### Task 2.4: 在 app.whenReady 里调 seedDefaults

**Files:**
- Modify: `packages/desktop/src/main/index.ts`(import 区 + whenReady 块约 281 行)

- [ ] **Step 1: 加 import**

在 `index.ts` 顶部 import 区(其它本地 `./` import 附近)加:

```typescript
import { seedDefaults } from "./seed-defaults.js";
```

- [ ] **Step 2: 在 whenReady 里调用**

定位 `app.whenReady().then(() => {` 块中 `void createWindow();` 与 `initUpdater();` 之后(automation 初始化之前)插入:

```typescript
  void seedDefaults();
```

(用 `void`——seed 是 best-effort,不阻塞启动链;内部已全 try/catch。)

- [ ] **Step 3: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit 2>&1 | grep -i "index.ts"; echo "exit:$?"`
Expected: 无输出。

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): call seedDefaults on app ready"
```

### Task 2.5: 打包带上 extraResources

**Files:**
- Modify: `packages/desktop/package.json:19-26`(build 块)

- [ ] **Step 1: 加 extraResources**

在 `build` 对象里(`files` 数组之后)加:

```json
    "extraResources": [
      { "from": "../../examples/agents", "to": "examples/agents" },
      { "from": "resources/known-marketplaces-seed.json", "to": "packages/desktop/resources/known-marketplaces-seed.json" }
    ],
```

> `from` 相对 `packages/desktop`(electron-builder 以包目录为基准);`to` 相对打包后的 `resourcesPath`,刻意对齐 `resourcePath()` 在 packaged 分支拼出的相对路径(`examples/agents`、`packages/desktop/resources/...`)。

- [ ] **Step 2: 校验 JSON 合法**

Run: `cd packages/desktop && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`。

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/package.json
git commit -m "build(desktop): bundle default agents + marketplace seed via extraResources"
```

### Task 2.6: dev 模式验证 seed 真生效

- [ ] **Step 1: 备份并清掉测试 home 的 seed 痕迹**(用隔离 HOME,别动真实 ~/.code-shell)

Run: `export SEED_TEST_HOME=$(mktemp -d) && echo "$SEED_TEST_HOME"`

- [ ] **Step 2: 用隔离 HOME 跑 desktop dev,触发一次 ready**

Run(后台起,几秒后看日志):`cd packages/desktop && HOME=$SEED_TEST_HOME bun run dev` —— 起来后看 console 是否打印 `seed: copied N default agent(s)`。

- [ ] **Step 3: 确认文件落地**

Run: `ls "$SEED_TEST_HOME/.code-shell/agents"`
Expected: explorer.md general-purpose.md planner.md researcher.md（4 个）。
Run: `cat "$SEED_TEST_HOME/.code-shell/plugins/known_marketplaces.json" 2>/dev/null || echo "（市场 clone 可能因网络失败,best-effort,不阻断）"`

- [ ] **Step 4: 清理**

Run: `rm -rf "$SEED_TEST_HOME"`

---

## 块 1 — Electron 真打包 + 验证

> 这块无新代码,是出包+人工验证。依赖块 0(测试绿)和块 2/3 已合(让打包产物含 seed + 新工具)。

### Task 1.1: 全量 build + 出 mac 包

- [ ] **Step 1: 根全量 build**

Run: `bun run build 2>&1 | tail -5; echo "exit:${PIPESTATUS[0]}"`
Expected: core / tui / meta 全 `Exited with code 0`。

- [ ] **Step 2: desktop 自身 build**

Run: `cd packages/desktop && bun run build 2>&1 | tail -10; echo "exit:${PIPESTATUS[0]}"`
Expected: exit 0,`out/` 下有 main/preload/renderer 产物。

- [ ] **Step 3: 出包(electron-builder)**

Run: `cd packages/desktop && bun run dist 2>&1 | tail -20; echo "exit:${PIPESTATUS[0]}"`
Expected: exit 0;`packages/desktop/dist/` 下出现 `code-shell-*.dmg` 与 `.zip`(arm64 + x64)。
若签名报错(无证书),electron-builder 默认会跳过/ad-hoc 签——熟人内测可接受。如卡在签名,设 `CSC_IDENTITY_AUTO_DISCOVERY=false` 重跑。

- [ ] **Step 4: 列产物**

Run: `ls -lh packages/desktop/dist/*.dmg packages/desktop/dist/*.zip`
Expected: 看到 dmg/zip,体积合理(几十~一百多 MB)。

### Task 1.2: 人工验证产物(本机装)

> 这几步需要人操作 GUI,用 AskUser 或交给用户跑;agent 只能列出清单。

- [ ] **Step 1: 装 dmg / 解压 zip,把 code-shell.app 拖进 Applications**
- [ ] **Step 2: hover Dock 图标 → 显示名 = `code-shell`(不是 Electron)** ← 证伪改名问题
- [ ] **Step 3: 双击打开(首次 mac 拦截 → 右键「打开」绕过 Gatekeeper)**
- [ ] **Step 4: 首屏起来,能进入主界面**
- [ ] **Step 5: 子代理列表非空(块 2 seed 生效)、市场有源可逛**
- [ ] **Step 6: 配一个 OpenAI provider(key)→ 跑一轮对话 → 确认 GenerateImage 工具可用(可让模型生成一张图验证)**

记录结果到块 5 的冒烟清单。任何一步失败 → 用 systematic-debugging skill 查,不要带病发布。

---

## 块 4 — npm 测试版发布物

### Task 4.1: 版本号推进到 rc.1

**Files:**
- Modify: `package.json`(根,version)
- Modify: `packages/core/package.json`、`packages/tui/package.json`、`packages/desktop/package.json`(version,保持一致)

- [ ] **Step 1: 看当前各包版本**

Run: `grep -H '"version"' package.json packages/*/package.json`
Expected: 当前均为 `0.5.0-rc.0`。

- [ ] **Step 2: 统一改成 0.5.0-rc.1**

把上述每个文件的 `"version": "0.5.0-rc.0"` 改为 `"0.5.0-rc.1"`。

- [ ] **Step 3: 校验一致**

Run: `grep -H '"version"' package.json packages/*/package.json`
Expected: 全部 `0.5.0-rc.1`。

- [ ] **Step 4: Commit**

```bash
git add package.json packages/*/package.json
git commit -m "chore: bump to 0.5.0-rc.1 for beta"
```

### Task 4.2: 校验 npm 包内容(不真发)

- [ ] **Step 1: rebuild 确保 dist 最新**

Run: `bun run build 2>&1 | tail -3; echo "exit:${PIPESTATUS[0]}"`
Expected: exit 0。

- [ ] **Step 2: npm pack dry-run 看进包文件**

Run: `npm pack --dry-run 2>&1 | tail -30`
Expected: 列出将打包的文件——应含 `dist/`、`README.md`、`LICENSE`、`CHANGELOG.md`、`scripts/check-node.cjs`(对齐根 package.json 的 `files` 字段),不含 `src/`、`tests/`。

- [ ] **Step 3: 核对 bin 入口存在**

Run: `ls dist/cli.js && head -1 dist/cli.js`
Expected: 文件存在,首行是 shebang(`#!/usr/bin/env node` 或类似)。

### Task 4.3: 干净环境冒烟(发前)

- [ ] **Step 1: 本地打 tarball**

Run: `npm pack 2>&1 | tail -3`
Expected: 生成 `cjhyy-code-shell-0.5.0-rc.1.tgz`。

- [ ] **Step 2: 在临时目录装该 tarball 并起一次**

Run:
```bash
TMP=$(mktemp -d) && cp cjhyy-code-shell-0.5.0-rc.1.tgz "$TMP" && cd "$TMP" && npm init -y >/dev/null 2>&1 && npm i ./cjhyy-code-shell-0.5.0-rc.1.tgz 2>&1 | tail -5 && npx code-shell --version 2>&1 | tail -3; echo "exit:$?"
```
Expected: 装成功,`--version` 打出 `0.5.0-rc.1`(或等价版本输出)无崩溃。

- [ ] **Step 3: 清理**

Run: `rm -rf "$TMP" cjhyy-code-shell-0.5.0-rc.1.tgz`

### Task 4.4: 发布到 npm(rc tag)

> ⚠️ 对外动作。执行前向用户确认 npm 已登录(`npm whoami`)且确实要发。

- [ ] **Step 1: 确认登录**

Run: `npm whoami`
Expected: 用户的 npm 账号名。若未登录,提示用户在 prompt 里 `! npm login`。

- [ ] **Step 2: 发 core 与 tui(meta 依赖它们)**

Run: `cd packages/core && npm publish --tag rc --access public 2>&1 | tail -5`
Run: `cd packages/tui && npm publish --tag rc --access public 2>&1 | tail -5`
Expected: 各自 `+ @cjhyy/code-shell-core@0.5.0-rc.1` 等。

- [ ] **Step 3: 发 meta 包**

Run: `npm publish --tag rc --access public 2>&1 | tail -5`
Expected: `+ @cjhyy/code-shell@0.5.0-rc.1`。

- [ ] **Step 4: 验证 rc tag 不污染 latest**

Run: `npm view @cjhyy/code-shell dist-tags`
Expected: `latest` 仍是旧稳定版,`rc: 0.5.0-rc.1`。

---

## 块 5 — 冒烟清单 + 分发说明

### Task 5.1: 写冒烟清单 + 分发说明

**Files:**
- Create: `docs/beta-smoke-checklist.md`

- [ ] **Step 1: 写文件**

```markdown
# 测试版冒烟清单 + 分发说明 (0.5.0-rc.1)

## A. 桌面 App 冒烟(本机,发前必跑)

- [ ] 装 dmg / 解压 zip,拖进 Applications
- [ ] hover Dock 图标 → 名字是 `code-shell`(非 Electron)
- [ ] 双击打开(首次右键「打开」绕过 Gatekeeper)
- [ ] 主界面起来
- [ ] 子代理列表非空(seed 的 explorer/general-purpose/planner/researcher)
- [ ] 市场有源可逛(seed 的市场)
- [ ] 配 OpenAI provider → 跑一轮对话不崩
- [ ] 切一次模型不崩
- [ ] 用一个默认 agent 跑一次
- [ ] 让模型生成一张图(GenerateImage 可用)
- [ ] 关掉重开 → 上一会话能恢复

## B. npm 包冒烟

- [ ] 干净目录 `npm i @cjhyy/code-shell@rc`
- [ ] `npx code-shell --version` → 0.5.0-rc.1
- [ ] 起一次 TUI,跑一轮对话,退出重进

## C. 给熟人的分发说明

**桌面版(推荐)**
1. 下载对应芯片的 dmg(Apple Silicon 选 arm64,Intel 选 x64)
2. 打开 dmg,把 code-shell 拖进「应用程序」
3. 首次打开:右键图标 →「打开」→ 再点「打开」(绕过未签名拦截)
4. 在设置里配置你的模型 provider(API key)
5. 反馈:遇到问题直接发我 + 描述复现步骤;日志在 `~/.code-shell/logs/`

**命令行版(可选)**
- `npm i -g @cjhyy/code-shell@rc` 然后 `code-shell`

## D. 已知限制(测试版)
- mac 未做正式签名/公证 → 首次需右键打开
- 无崩溃自动上报 → 请口头反馈
```

- [ ] **Step 2: Commit**

```bash
git add docs/beta-smoke-checklist.md
git commit -m "docs: beta smoke checklist + distribution notes"
```

### Task 5.2: 跑 A/B 冒烟清单

- [ ] 按 `docs/beta-smoke-checklist.md` A 节走桌面 App(用块 1.2 的产物)
- [ ] 按 B 节走 npm(用块 4.3 的 tarball,或发布后 `@rc`)
- [ ] 全绿后,测试版准备完成。任何红项 → systematic-debugging,修完重跑。

---

## Self-Review 备注

- **Spec 覆盖**:块 0(修测试)、块 1(Electron 打包+证伪改名)、块 2(seed agents+市场源+验证 GenerateImage 不新建 skill)、块 3(AddMarketplace 工具)、块 4(npm rc.1)、块 5(冒烟+分发)——spec 五块全覆盖,排除项(签名/公证、崩溃上报、预装插件、image skill、卸载工具)均未引入任务。
- **类型一致**:工具名全程 `AddMarketplace`;函数 `seedAgents`/`seedMarketplaces`/`seedDefaults`/`resourcePath` 在测试与实现与调用处一致;`MarketplaceSource` 用 core 原型 `{source:"github";repo}|{source:"git";url}`。
- **依赖顺序**:块 3.4 rebuild core 是块 2 typecheck(引 addMarketplace)和块 1 打包的前置;块 0 绿是块 1/4 的前置;已在任务里标注。
- **待用户确认的占位**:块 2.1 的市场仓库 repo 值(`obra/superpowers-marketplace` 占位)——执行到该步若用户已给真实源则替换;clone 失败已容错,不阻断。
```


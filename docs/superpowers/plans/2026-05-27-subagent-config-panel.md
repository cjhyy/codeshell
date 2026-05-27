# Subagent 配置面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在桌面 app 设置页加一个「子代理」模块，让用户新增自定义子代理、禁用/启用内置 4 个、修改任意子代理（含内置）的 model / maxTurns / tools / 系统提示词；用户的改动全部写到用户级 `~/.code-shell/agents/*.md`，禁用通过 `settings.disabledAgents` 实现且让被禁角色对 LLM 不可见。

**Architecture:** core 层：`AgentDefinitionRegistry` 合并项目级 + 用户级两个目录（用户级同名覆盖），新增 `disabledAgents` 过滤与 `serializeAgentDefinition`；引擎缓存随 disabledAgents 失效；导出相关符号供 desktop 复用。desktop 层：新增 `agents-service.ts` + IPC + preload 桥，仿照现有 `skills-service.ts` 的只读枚举 + 写文件模式；renderer 新增 `AgentsSection.tsx`（三栏 + 全字段表单），在 `SettingsPage` 注册「子代理」模块。

**Tech Stack:** TypeScript、Zod（settings schema）、yaml（frontmatter 解析/序列化）、React（renderer）、Electron IPC、bun test。

---

## File Structure

**core（packages/core/src）**
- `agent/agent-definition.ts` — 加 `serializeAgentDefinition`（与 `parseAgentDefinition` 互逆）。
- `agent/agent-definition-registry.ts` — 加 `source`/`filePath`/`override` 元信息；加 `loadFromDirs`（多目录合并）+ disabled 过滤。
- `engine/engine.ts` — `loadAgentDefinitionsForCwd` 合并用户级目录；`getAgentDefinitions` 缓存带 disabledAgents 指纹；从 settings 读 disabledAgents。
- `settings/schema.ts` — 加 `disabledAgents`。
- `tool-system/builtin/agent.ts` — `agent_type` 描述动态列出可用角色。
- `index.ts` — 导出 `AgentDefinition` / `parseAgentDefinition` / `serializeAgentDefinition` / `AgentDefinitionRegistry` / `loadAgentDefinitionsForCwd` / `BUILTIN_TOOLS`（已导出）。
- 测试：`agent/agent-definition.test.ts`、`agent/agent-definition-registry.test.ts`。

**desktop main（packages/desktop/src/main）**
- `agents-service.ts` — `listAgents` / `readAgentBody` / `saveAgent` / `deleteAgent`（新）。
- `index.ts` — 注册 `agents:*` IPC handler。

**desktop preload（packages/desktop/src/preload）**
- `index.ts` — 暴露 4 个 bridge 方法。
- `types.d.ts` — `AgentSummary` 类型 + 方法签名。

**desktop renderer（packages/desktop/src/renderer/settings）**
- `AgentsSection.tsx` — 三栏 + 表单（新）。
- `SettingsPage.tsx` — 注册「子代理」模块。

---

## Task 1: core — `disabledAgents` settings 字段

**Files:**
- Modify: `packages/core/src/settings/schema.ts`（在 `disabledSkills` / `disabledPlugins` 附近，约 176-184 行）
- Test: `packages/core/src/settings/schema.test.ts`（若不存在则创建）

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/settings/schema.test.ts` 追加（若文件不存在，创建并补 import）：

```ts
import { describe, it, expect } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("disabledAgents", () => {
  it("defaults to empty array", () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.disabledAgents).toEqual([]);
  });
  it("accepts an array of agent names", () => {
    const parsed = SettingsSchema.parse({ disabledAgents: ["explorer", "planner"] });
    expect(parsed.disabledAgents).toEqual(["explorer", "planner"]);
  });
});
```

> 注意：确认 `schema.ts` 实际导出名是 `SettingsSchema`。先 `grep -n "export const .*Schema\|export.*SettingsSchema" packages/core/src/settings/schema.ts` 核对，若不同则改 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/settings/schema.test.ts`
Expected: FAIL（`disabledAgents` 为 undefined，第一个断言失败）

- [ ] **Step 3: 加字段**

在 `schema.ts` 中 `disabledPlugins: z.array(z.string()).default([]),` 之后加一行：

```ts
    /**
     * Sub-agent role names (the `name` in .code-shell/agents/*.md) to
     * hide from the registry. A disabled role is filtered out at load
     * so it never appears in registry.list()/get() — the Agent tool's
     * agent_type list won't show it and the LLM can't pick it. Mirrors
     * disabledSkills / disabledPlugins.
     */
    disabledAgents: z.array(z.string()).default([]),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/settings/schema.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/settings/schema.ts packages/core/src/settings/schema.test.ts
git commit -m "feat(core): add settings.disabledAgents

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: core — `serializeAgentDefinition`

**Files:**
- Modify: `packages/core/src/agent/agent-definition.ts`
- Test: `packages/core/src/agent/agent-definition.test.ts`（新）

- [ ] **Step 1: 写失败测试（往返一致 + 省略可选字段）**

创建 `packages/core/src/agent/agent-definition.test.ts`：

```ts
import { describe, it, expect } from "bun:test";
import {
  parseAgentDefinition,
  serializeAgentDefinition,
  type AgentDefinition,
} from "./agent-definition.js";

describe("serializeAgentDefinition", () => {
  it("round-trips a full definition", () => {
    const def: AgentDefinition = {
      name: "researcher",
      description: "Read-only research",
      model: "flash",
      maxTurns: 10,
      tools: ["Read", "Grep"],
      systemPrompt: "You research.\nReport findings.",
    };
    const text = serializeAgentDefinition(def);
    const back = parseAgentDefinition(text, "researcher.md");
    expect(back).toEqual(def);
  });

  it("omits unset optional fields (no model/maxTurns/tools lines)", () => {
    const def: AgentDefinition = {
      name: "min",
      description: "minimal",
      systemPrompt: "Body.",
    };
    const text = serializeAgentDefinition(def);
    expect(text).not.toMatch(/^model:/m);
    expect(text).not.toMatch(/^maxTurns:/m);
    expect(text).not.toMatch(/^tools:/m);
    const back = parseAgentDefinition(text, "min.md");
    expect(back).toEqual(def);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && bun test src/agent/agent-definition.test.ts`
Expected: FAIL（`serializeAgentDefinition is not a function`）

- [ ] **Step 3: 实现 serializer**

在 `agent-definition.ts` 末尾加（用已 import 的 yaml；现有文件顶部是 `import { parse as parseYaml } from "yaml";` — 改成同时引入 `stringify`）：

把第 1 行：
```ts
import { parse as parseYaml } from "yaml";
```
改为：
```ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
```

文件末尾追加：
```ts
/**
 * Serialize an AgentDefinition back to a Markdown file body (YAML
 * frontmatter + system prompt). Inverse of parseAgentDefinition.
 * Optional fields that are unset are omitted entirely so an inheriting
 * role (e.g. model undefined → inherit parent) stays clean on disk.
 */
export function serializeAgentDefinition(def: AgentDefinition): string {
  const fm: Record<string, unknown> = {
    name: def.name,
    description: def.description,
  };
  if (def.model !== undefined) fm.model = def.model;
  if (def.maxTurns !== undefined) fm.maxTurns = def.maxTurns;
  if (def.tools !== undefined) fm.tools = def.tools;
  const yaml = stringifyYaml(fm).trimEnd();
  return `---\n${yaml}\n---\n${def.systemPrompt}\n`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core && bun test src/agent/agent-definition.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/agent/agent-definition.ts packages/core/src/agent/agent-definition.test.ts
git commit -m "feat(core): serializeAgentDefinition (inverse of parse)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: core — registry 元信息 + 多目录合并 + disabled 过滤

**Files:**
- Modify: `packages/core/src/agent/agent-definition.ts`（给 `AgentDefinition` 加运行期元信息）
- Modify: `packages/core/src/agent/agent-definition-registry.ts`
- Test: `packages/core/src/agent/agent-definition-registry.test.ts`（新）

- [ ] **Step 1: 给 AgentDefinition 加运行期元信息字段**

在 `agent-definition.ts` 的 `AgentDefinition` 接口末尾（`systemPrompt` 之后）加：

```ts
  /** Where this def was loaded from. Runtime-only; never serialized. */
  source?: "project" | "user";
  /** Absolute path of the file it came from. Runtime-only. */
  filePath?: string;
  /** True when a user-level def shadows a same-named project-level one. */
  override?: boolean;
```

> 这些是可选运行期字段，`serializeAgentDefinition`（Task 2）不写它们，往返测试用的对象没有这几个字段，故 `toEqual` 仍通过——不要在序列化里加它们。

- [ ] **Step 2: 写失败测试**

创建 `packages/core/src/agent/agent-definition-registry.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDefinitionRegistry } from "./agent-definition-registry.js";

function writeAgent(dir: string, name: string, model?: string) {
  const fm = ["---", `name: ${name}`, `description: ${name} role`];
  if (model) fm.push(`model: ${model}`);
  fm.push("---", `${name} body`);
  writeFileSync(join(dir, `${name}.md`), fm.join("\n"));
}

describe("AgentDefinitionRegistry.loadFromDirs", () => {
  let projectDir: string;
  let userDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "proj-"));
    userDir = mkdtempSync(join(tmpdir(), "user-"));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("merges both dirs; non-overlapping names coexist", () => {
    writeAgent(projectDir, "researcher");
    writeAgent(userDir, "myhelper");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [{ dir: projectDir, source: "project" }, { dir: userDir, source: "user" }],
      [],
    );
    expect(reg.list().map((d) => d.name).sort()).toEqual(["myhelper", "researcher"]);
  });

  it("user-level same name overrides project-level and marks override", () => {
    writeAgent(projectDir, "researcher", "slow");
    writeAgent(userDir, "researcher", "fast");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [{ dir: projectDir, source: "project" }, { dir: userDir, source: "user" }],
      [],
    );
    const def = reg.get("researcher")!;
    expect(def.model).toBe("fast");
    expect(def.source).toBe("user");
    expect(def.override).toBe(true);
  });

  it("disabledAgents filters a role out of list() and get()", () => {
    writeAgent(projectDir, "researcher");
    writeAgent(projectDir, "explorer");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [{ dir: projectDir, source: "project" }],
      ["explorer"],
    );
    expect(reg.has("explorer")).toBe(false);
    expect(reg.get("explorer")).toBeUndefined();
    expect(reg.list().map((d) => d.name)).toEqual(["researcher"]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/core && bun test src/agent/agent-definition-registry.test.ts`
Expected: FAIL（`loadFromDirs is not a function`）

- [ ] **Step 4: 实现 loadFromDirs + 元信息 + 过滤**

把 `agent-definition-registry.ts` 整体替换为：

```ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDefinition, type AgentDefinition } from "./agent-definition.js";

export interface AgentSourceDir {
  dir: string;
  source: "project" | "user";
}

/**
 * Loads reusable sub-agent role definitions from one or more directories
 * of `*.md` files. Non-recursive. Malformed files are skipped with a
 * warning rather than failing the whole load.
 *
 * When multiple dirs define the same role name, the LAST dir wins
 * (callers pass [project, user] so user-level overrides project-level).
 * The shadowing def is marked `override: true`. Names in `disabled` are
 * filtered out entirely.
 */
export class AgentDefinitionRegistry {
  private defs = new Map<string, AgentDefinition>();
  readonly warnings: string[] = [];

  /** Back-compat single-dir loader (project source, no disabled filter). */
  static loadFromDir(dir: string): AgentDefinitionRegistry {
    return AgentDefinitionRegistry.loadFromDirs([{ dir, source: "project" }], []);
  }

  static loadFromDirs(
    dirs: AgentSourceDir[],
    disabled: string[],
  ): AgentDefinitionRegistry {
    const reg = new AgentDefinitionRegistry();
    const disabledSet = new Set(disabled);

    for (const { dir, source } of dirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith(".md")) continue;
        const full = join(dir, entry);
        try {
          if (!statSync(full).isFile()) continue;
          const def = parseAgentDefinition(readFileSync(full, "utf8"), entry);
          def.source = source;
          def.filePath = full;
          if (reg.defs.has(def.name)) {
            // A later dir overrides an earlier one (user over project).
            def.override = true;
          }
          reg.defs.set(def.name, def);
        } catch (err) {
          reg.warnings.push(`${entry}: ${(err as Error).message}`);
        }
      }
    }

    // Filter disabled roles after the merge so a user override of a
    // disabled name is still removed.
    for (const name of disabledSet) reg.defs.delete(name);
    return reg;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }
  get(name: string): AgentDefinition | undefined {
    return this.defs.get(name);
  }
  list(): AgentDefinition[] {
    return [...this.defs.values()];
  }
}
```

> 行为变化说明：原实现里同名是「first wins + warning」；新实现按 dirs 顺序「last wins + override 标记」，因为我们要让用户级覆盖项目级。同一目录内重复同名（少见）也变成 last-wins，可接受。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/core && bun test src/agent/agent-definition-registry.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/agent/agent-definition.ts packages/core/src/agent/agent-definition-registry.ts packages/core/src/agent/agent-definition-registry.test.ts
git commit -m "feat(core): registry merges project+user agent dirs with override + disabled filter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: core — 引擎合并用户级目录 + 缓存随 disabledAgents 失效

**Files:**
- Modify: `packages/core/src/engine/engine.ts`（`loadAgentDefinitionsForCwd` 约 189-192；`getAgentDefinitions` 约 1797-1802；`agentDefsCache` 字段约 227）
- Test: 行为级，沿用现有引擎测试风格（手动验证为主，见 Step 4）

- [ ] **Step 1: 改 `loadAgentDefinitionsForCwd` 合并用户级**

把约 189-192 行：

```ts
/** Load reusable sub-agent role definitions from <cwd>/.code-shell/agents. */
export function loadAgentDefinitionsForCwd(cwd: string): AgentDefinitionRegistry {
  return AgentDefinitionRegistry.loadFromDir(`${cwd}/.code-shell/agents`);
}
```

替换为：

```ts
/**
 * Load reusable sub-agent role definitions, merging:
 *   1. project-level  <cwd>/.code-shell/agents/*.md   (ships built-ins)
 *   2. user-level     ~/.code-shell/agents/*.md        (user wins on name)
 * Names in `disabledAgents` are filtered out so the LLM never sees them.
 */
export function loadAgentDefinitionsForCwd(
  cwd: string,
  disabledAgents: string[] = [],
): AgentDefinitionRegistry {
  const home = os.homedir();
  return AgentDefinitionRegistry.loadFromDirs(
    [
      { dir: `${cwd}/.code-shell/agents`, source: "project" },
      { dir: `${home}/.code-shell/agents`, source: "user" },
    ],
    disabledAgents,
  );
}
```

> 确认 engine.ts 顶部已 `import * as os from "node:os"` 或类似。先 `grep -n "node:os\|from \"os\"\|homedir" packages/core/src/engine/engine.ts`；若没有，在 import 区加 `import * as os from "node:os";`。

- [ ] **Step 2: 改缓存键带 disabledAgents 指纹**

把 `agentDefsCache` 字段声明（约 227 行）：

```ts
  private agentDefsCache?: { cwd: string; reg: AgentDefinitionRegistry };
```

改为：

```ts
  private agentDefsCache?: { cwd: string; disabledKey: string; reg: AgentDefinitionRegistry };
```

把 `getAgentDefinitions`（约 1797-1802）：

```ts
  private getAgentDefinitions(cwd: string): AgentDefinitionRegistry {
    if (this.agentDefsCache?.cwd !== cwd) {
      this.agentDefsCache = { cwd, reg: loadAgentDefinitionsForCwd(cwd) };
    }
    return this.agentDefsCache.reg;
  }
```

替换为：

```ts
  private getAgentDefinitions(cwd: string): AgentDefinitionRegistry {
    const disabledAgents = this.readDisabledAgents();
    const disabledKey = disabledAgents.slice().sort().join(" ");
    if (
      this.agentDefsCache?.cwd !== cwd ||
      this.agentDefsCache.disabledKey !== disabledKey
    ) {
      this.agentDefsCache = {
        cwd,
        disabledKey,
        reg: loadAgentDefinitionsForCwd(cwd, disabledAgents),
      };
    }
    return this.agentDefsCache.reg;
  }

  /**
   * Read settings.disabledAgents. Unlike disabledSkills, sub-agents do
   * NOT skip this — a disabled role must stay invisible everywhere,
   * including inside a sub-agent that might try to spawn (grandchildren
   * are blocked separately, but the filter should be consistent).
   */
  private readDisabledAgents(): string[] {
    try {
      const settings = this.getSettingsManager().get() as {
        disabledAgents?: string[];
      };
      return Array.isArray(settings.disabledAgents) ? settings.disabledAgents : [];
    } catch {
      return [];
    }
  }
```

- [ ] **Step 3: typecheck + 跑 core 全量测试**

Run: `cd packages/core && bun run typecheck && bun test`
Expected: PASS（无类型错误；现有 agent_type smoke 测试仍过——它用项目级 researcher，未被禁，行为不变）

- [ ] **Step 4: 手动验证缓存失效逻辑**

确认 `getSettingsManager()` 是 Engine 已有方法（`grep -n "getSettingsManager" packages/core/src/engine/engine.ts`）。若为 private 且已存在即可直接用。手动 review：禁用列表变化 → `disabledKey` 变 → 缓存重建。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/engine/engine.ts
git commit -m "feat(core): engine merges user-level agents dir; cache keyed by disabledAgents

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: core — Agent 工具 `agent_type` 描述动态列出可用角色 + 导出符号

**Files:**
- Modify: `packages/core/src/tool-system/builtin/agent.ts`（`agent_type` 入参描述，约 136-142）
- Modify: `packages/core/src/index.ts`（导出 agent 相关符号）

- [ ] **Step 1: 让 agent_type 描述携带可用角色**

`agentToolDef` 当前是静态常量（agent.ts:113）。最小改动：保持静态描述不变，但在 `resolveAgentTypeOverrides` 的报错里已列 Available（agent.ts:59）。本任务只需确保 LLM 能「知道有哪些角色」——通过在工具描述里追加一句指引，指向运行时由 registry 决定的角色集。

在 `agent_type` 的 `description`（约 138-141）末尾追加一句：

把：
```ts
        description:
          "Optional reusable role defined in .code-shell/agents/*.md (e.g. 'researcher'). " +
          "Loads that role's model, tool allowlist, turn cap, and system prompt. " +
          "Omit to run an ad-hoc agent described entirely by 'prompt'.",
```
改为：
```ts
        description:
          "Optional reusable role defined in .code-shell/agents/*.md (e.g. 'researcher'). " +
          "Loads that role's model, tool allowlist, turn cap, and system prompt. " +
          "Disabled roles are not available. If you pass an unknown role you'll get " +
          "an error listing the currently available roles. " +
          "Omit to run an ad-hoc agent described entirely by 'prompt'.",
```

> YAGNI：不把 enum 动态注入工具 schema（需要在每次 build tool def 时拿到 registry，改动面大且角色为空时 enum 报错）。既有的 unknown-type 报错（agent.ts:58-60）已经把 Available 角色集喂给 LLM 作纠正，足够。

- [ ] **Step 2: 导出 agent 符号供 desktop 复用**

在 `packages/core/src/index.ts` 合适位置（靠近其他 agent 导出，如 489 行 agent-registry 附近）加：

```ts
export {
  parseAgentDefinition,
  serializeAgentDefinition,
  type AgentDefinition,
} from "./agent/agent-definition.js";
export {
  AgentDefinitionRegistry,
  type AgentSourceDir,
} from "./agent/agent-definition-registry.js";
export { loadAgentDefinitionsForCwd } from "./engine/engine.js";
```

> 先确认 `loadAgentDefinitionsForCwd` 是从 engine.ts `export function` 导出的（Task 4 保持了 `export`）。`BUILTIN_TOOLS` 已在 index.ts:80 导出，desktop 工具清单复用它。

- [ ] **Step 3: typecheck**

Run: `cd packages/core && bun run typecheck`
Expected: PASS

- [ ] **Step 4: 构建 core（desktop 依赖其产物）**

Run: `cd packages/core && bun run build`
Expected: 成功产出 dist（desktop 从 `@cjhyy/code-shell-core` import 这些新符号）

> 若 core 无独立 build 步骤或 desktop 直接吃 src，跳过；确认方式见 `grep -n "\"build\"" packages/core/package.json`。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/builtin/agent.ts packages/core/src/index.ts
git commit -m "feat(core): export agent definition API; clarify agent_type availability

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: desktop main — `agents-service.ts`

**Files:**
- Create: `packages/desktop/src/main/agents-service.ts`
- Test: 手动（IPC 层在 Task 7 接通后端到端验证）

- [ ] **Step 1: 写 service**

创建 `packages/desktop/src/main/agents-service.ts`：

```ts
/**
 * Read + write sub-agent role definitions for the Settings panel.
 *
 * Mirrors skills-service.ts: the main process imports core's registry
 * directly (data is "what's on disk"). Listing merges project-level
 * (.code-shell/agents, ships the built-in 4) with user-level
 * (~/.code-shell/agents). Writes only ever touch the USER-level dir —
 * editing a built-in produces a same-named user override file; the
 * project-level built-in files are never modified.
 */

import {
  loadAgentDefinitionsForCwd,
  serializeAgentDefinition,
  type AgentDefinition,
} from "@cjhyy/code-shell-core";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentSummary {
  name: string;
  description: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt: string;
  source: "project" | "user";
  override: boolean;
  filePath: string;
}

function userAgentsRoot(): string {
  return path.join(os.homedir(), ".code-shell", "agents");
}

/** List merged agents (project + user). Does NOT apply disabledAgents —
 *  the UI shows disabled rows too (with a checkbox), so it needs them. */
export function listAgents(cwd: string): AgentSummary[] {
  const reg = loadAgentDefinitionsForCwd(cwd, []); // empty: show all
  return reg.list().map((d) => ({
    name: d.name,
    description: d.description,
    model: d.model,
    maxTurns: d.maxTurns,
    tools: d.tools,
    systemPrompt: d.systemPrompt,
    source: d.source ?? "project",
    override: d.override === true,
    filePath: d.filePath ?? "",
  }));
}

export async function readAgentBody(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

function normalizeAgentName(input: string): string {
  const name = input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!name) throw new Error("子代理名称不能为空");
  return name;
}

/**
 * Write an agent definition to the user-level dir as <name>.md (atomic:
 * .tmp + rename). Used for both new user agents and overrides of a
 * built-in (same name → creates ~/.code-shell/agents/<name>.md).
 */
export async function saveAgent(def: AgentDefinition): Promise<AgentSummary> {
  const name = normalizeAgentName(def.name);
  const clean: AgentDefinition = {
    name,
    description: def.description,
    model: def.model || undefined,
    maxTurns: typeof def.maxTurns === "number" ? def.maxTurns : undefined,
    tools: Array.isArray(def.tools) && def.tools.length > 0 ? def.tools : undefined,
    systemPrompt: def.systemPrompt ?? "",
  };
  const root = userAgentsRoot();
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.md`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, serializeAgentDefinition(clean), "utf8");
  await fs.rename(tmp, target);
  return {
    name,
    description: clean.description,
    model: clean.model,
    maxTurns: clean.maxTurns,
    tools: clean.tools,
    systemPrompt: clean.systemPrompt,
    source: "user",
    override: false,
    filePath: target,
  };
}

/**
 * Delete a USER-level agent file (a custom agent or a built-in override).
 * Refuses anything outside ~/.code-shell/agents — built-in project files
 * are never deletable here (the UI offers "disable" for those instead).
 */
export async function deleteAgent(name: string): Promise<void> {
  const safe = normalizeAgentName(name);
  const target = path.join(userAgentsRoot(), `${safe}.md`);
  if (!target.startsWith(userAgentsRoot() + path.sep)) {
    throw new Error(`refuse to delete outside user agents dir: ${target}`);
  }
  await fs.rm(target, { force: true });
}
```

- [ ] **Step 2: typecheck desktop**

Run: `cd packages/desktop && bun run typecheck`
Expected: PASS（依赖 Task 5 已导出 core 符号；若报 `has no exported member`，回到 Task 5 Step 2/4 确认导出与 build）

- [ ] **Step 3: 提交**

```bash
git add packages/desktop/src/main/agents-service.ts
git commit -m "feat(desktop): agents-service — list/read/save/delete user-level agents

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: desktop main — IPC handlers

**Files:**
- Modify: `packages/desktop/src/main/index.ts`（import 区约 34-35；handler 区约 220-234）

- [ ] **Step 1: import service**

在 main/index.ts 现有 `import { listSkills, readSkillBody, ... }` 处旁加：

```ts
import {
  listAgents,
  readAgentBody,
  saveAgent,
  deleteAgent,
  type AgentSummary,
} from "./agents-service.js";
import type { AgentDefinition } from "@cjhyy/code-shell-core";
```

> 确认现有 skills 服务的 import 风格与扩展名（`.js`）一致再照抄。

- [ ] **Step 2: 注册 handlers**

在 `skills:uninstall` handler（约 234 行）之后加：

```ts
ipcMain.handle("agents:list", async (_e, cwd: string) => {
  if (typeof cwd !== "string") throw new Error("agents:list requires cwd");
  return listAgents(cwd);
});
ipcMain.handle("agents:read", async (_e, filePath: string) => {
  if (typeof filePath !== "string") throw new Error("agents:read requires filePath");
  return readAgentBody(filePath);
});
ipcMain.handle("agents:save", async (_e, def: AgentDefinition) => {
  if (!def || typeof def !== "object") throw new Error("agents:save requires def");
  if (typeof def.name !== "string" || typeof def.description !== "string")
    throw new Error("agents:save: name and description are required");
  return saveAgent(def);
});
ipcMain.handle("agents:delete", async (_e, name: string) => {
  if (typeof name !== "string" || !name) throw new Error("agents:delete requires name");
  return deleteAgent(name);
});
```

- [ ] **Step 3: typecheck**

Run: `cd packages/desktop && bun run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): agents:* IPC handlers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: desktop preload — bridge + 类型

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`（skills bridge 附近，约 190-199）
- Modify: `packages/desktop/src/preload/types.d.ts`（方法签名约 144-153；`SkillSummary` 附近约 292）

- [ ] **Step 1: 加 bridge 方法**

在 preload/index.ts 的 `uninstallSkill: ...` 行之后加：

```ts
  listAgents: (cwd: string) => ipcRenderer.invoke("agents:list", cwd),
  readAgentBody: (filePath: string) => ipcRenderer.invoke("agents:read", filePath),
  saveAgent: (def: import("./types").AgentDefinitionInput) =>
    ipcRenderer.invoke("agents:save", def),
  deleteAgent: (name: string) => ipcRenderer.invoke("agents:delete", name),
```

- [ ] **Step 2: 加类型**

在 types.d.ts 的 `SkillSummary` 接口附近加：

```ts
export interface AgentSummary {
  name: string;
  description: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt: string;
  source: "project" | "user";
  override: boolean;
  filePath: string;
}

export interface AgentDefinitionInput {
  name: string;
  description: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt: string;
}
```

在 bridge 接口（含 `listSkills` 等的那个 interface，约 144-153）加方法签名：

```ts
  listAgents(cwd: string): Promise<AgentSummary[]>;
  readAgentBody(filePath: string): Promise<string>;
  saveAgent(def: AgentDefinitionInput): Promise<AgentSummary>;
  deleteAgent(name: string): Promise<void>;
```

- [ ] **Step 3: typecheck**

Run: `cd packages/desktop && bun run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop): preload bridge for agents:* + AgentSummary types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: desktop renderer — `AgentsSection.tsx`（三栏 + 表单）

**Files:**
- Create: `packages/desktop/src/renderer/settings/AgentsSection.tsx`

- [ ] **Step 1: 写组件**

创建 `packages/desktop/src/renderer/settings/AgentsSection.tsx`。读取 model key 列表来自 `getSettings(scope)` 的 `models[].key/label`；禁用状态来自 `settings.disabledAgents`，写回用 `updateSettings("user", { disabledAgents })`。工具候选用一份内置工具名常量（与 core BUILTIN_TOOLS 对齐的精简集）。

```tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentSummary, AgentDefinitionInput } from "../../preload/types";
import { useConfirm } from "../ui/ConfirmDialog";

interface Props {
  activeRepoPath: string | null;
}

// Tool names users can grant a sub-agent. "Skill" here is the on/off
// switch for skill usage. Keep in rough sync with core BUILTIN_TOOLS.
const TOOL_CHOICES = [
  "Read", "Write", "Edit", "Grep", "Glob", "Bash",
  "WebSearch", "WebFetch", "Skill", "TodoWrite",
];

interface ModelOption { key: string; label: string; }

const INHERIT = "__inherit__";

export function AgentsSection({ activeRepoPath }: Props) {
  const cwd = activeRepoPath ?? undefined;
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDefinitionInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await window.codeshell.listAgents(cwd ?? "");
      setAgents(list);
      const s = (await window.codeshell.getSettings("user")) ?? {};
      setDisabled(Array.isArray(s.disabledAgents) ? s.disabledAgents : []);
      const ms = Array.isArray(s.models) ? s.models : [];
      setModels(ms.map((m: any) => ({ key: m.key, label: m.label || m.key })));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(
    () => agents.find((a) => a.name === selected) ?? null,
    [agents, selected],
  );

  useEffect(() => {
    if (current) {
      setDraft({
        name: current.name,
        description: current.description,
        model: current.model,
        maxTurns: current.maxTurns,
        tools: current.tools,
        systemPrompt: current.systemPrompt,
      });
    }
  }, [current]);

  const isDisabled = (name: string) => disabled.includes(name);

  const toggleDisabled = async (name: string) => {
    const next = isDisabled(name)
      ? disabled.filter((n) => n !== name)
      : [...disabled, name];
    setDisabled(next);
    await window.codeshell.updateSettings("user", { disabledAgents: next });
    window.dispatchEvent(new Event("codeshell:settings-changed"));
  };

  const startNew = () => {
    setSelected(null);
    setDraft({ name: "", description: "", systemPrompt: "" });
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      await window.codeshell.saveAgent(draft);
      await load();
      setSelected(draft.name);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const remove = async (a: AgentSummary) => {
    const ok = await confirm({
      title: `删除子代理 ${a.name}？`,
      body: a.override ? "这会删除你的覆盖文件，恢复为内置定义。" : "这会删除该自定义子代理。",
    });
    if (!ok) return;
    await window.codeshell.deleteAgent(a.name);
    await load();
    setSelected(null);
    setDraft(null);
  };

  // A built-in (project source) that has no user override: name locked,
  // editing it will create a user override file on save.
  const nameLocked = !!current && current.source === "project";
  const deletable = !!current && (current.source === "user" || current.override);

  return (
    <section className="settings-section ps-section customize-host">
      <div className="customize-three-pane">
        {/* Left: agent list */}
        <div className="customize-pane">
          <div className="customize-toolbar">
            <button className="approval-btn approve" onClick={startNew}>新增子代理</button>
          </div>
          <ul className="customize-plugin-list">
            {agents.map((a) => (
              <li
                key={a.name}
                className={`customize-plugin-row${selected === a.name ? " is-selected" : ""}`}
                onClick={() => setSelected(a.name)}
              >
                <input
                  type="checkbox"
                  className="customize-plugin-row-check"
                  checked={!isDisabled(a.name)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => void toggleDisabled(a.name)}
                  title={isDisabled(a.name) ? "已禁用（LLM 不可见）" : "已启用"}
                />
                <span style={{ flex: 1 }}>{a.name}</span>
                {a.source === "project" && !a.override && <span className="badge">内置</span>}
                {a.override && <span className="badge">已覆盖</span>}
                {a.source === "user" && !a.override && <span className="badge">自定义</span>}
              </li>
            ))}
          </ul>
        </div>

        {/* Right: editor form */}
        <div className="customize-pane" style={{ gridColumn: "span 2" }}>
          {error && <div className="view-error">{error}</div>}
          {!draft ? (
            <div className="mcp-empty"><div className="mcp-empty-hint">选择左侧一个子代理，或「新增子代理」。</div></div>
          ) : (
            <div className="settings-section" style={{ gap: 12, display: "flex", flexDirection: "column" }}>
              <label>名称
                <input
                  type="text"
                  value={draft.name}
                  disabled={nameLocked}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              {nameLocked && <div className="mcp-empty-hint">内置子代理不可改名；保存会在用户级生成同名覆盖文件。</div>}
              <label>描述
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <label>模型
                <select
                  value={draft.model ?? INHERIT}
                  onChange={(e) =>
                    setDraft({ ...draft, model: e.target.value === INHERIT ? undefined : e.target.value })
                  }
                >
                  <option value={INHERIT}>跟随父模型（继承）</option>
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </label>
              <label>最大轮数 (maxTurns)
                <input
                  type="number"
                  value={draft.maxTurns ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, maxTurns: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              <fieldset>
                <legend>工具（不勾任何 = 继承父全集）</legend>
                {TOOL_CHOICES.map((t) => {
                  const checked = (draft.tools ?? []).includes(t);
                  return (
                    <label key={t} style={{ display: "inline-flex", gap: 4, marginRight: 12 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const cur = new Set(draft.tools ?? []);
                          if (checked) cur.delete(t); else cur.add(t);
                          const arr = [...cur];
                          setDraft({ ...draft, tools: arr.length ? arr : undefined });
                        }}
                      />
                      {t}
                    </label>
                  );
                })}
              </fieldset>
              <label>系统提示词
                <textarea
                  className="settings-editor"
                  value={draft.systemPrompt}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  rows={10}
                />
              </label>
              <div className="settings-toolbar">
                {deletable && (
                  <button className="approval-btn deny" onClick={() => current && void remove(current)}>删除</button>
                )}
                <button className="approval-btn approve" onClick={() => void save()}>保存</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
```

> 说明：复用了 customize 三栏 CSS（`customize-three-pane`/`customize-pane`/`customize-plugin-*`）。`useConfirm` 与 PluginsAndSkillsSection 同源（`../ui/ConfirmDialog`）——确认其 API（title/body 返回 boolean）；若签名不同，按实际调整。`badge` class 若不存在，沿用现有徽标类或加一行 CSS（次要）。

- [ ] **Step 2: typecheck**

Run: `cd packages/desktop && bun run typecheck`
Expected: PASS（如 `useConfirm` 签名不符或 `.badge` 缺失导致类型/样式问题，按现有组件实际 API 修正）

- [ ] **Step 3: 提交**

```bash
git add packages/desktop/src/renderer/settings/AgentsSection.tsx
git commit -m "feat(desktop): AgentsSection — three-pane subagent editor

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: desktop renderer — 在 SettingsPage 注册「子代理」模块

**Files:**
- Modify: `packages/desktop/src/renderer/settings/SettingsPage.tsx`（import 约 24；ModuleId 约 40-56；MODULES 约 64-80；render 分支约 225-228）

- [ ] **Step 1: import + 选 icon**

在 SettingsPage.tsx 顶部 import 区加：

```ts
import { AgentsSection } from "./AgentsSection";
```

icon 用 lucide 的 `Bot`（确认该图标已被 import 或在现有 lucide import 块补上 `Bot`）。

- [ ] **Step 2: ModuleId + MODULES 加项**

`ModuleId` union（约 40-56）加 `| "agents"`。

`MODULES` 数组（约 64-80）在 `{ id: "plugins-skills", ... }` 之前或之后加：

```ts
  { id: "agents", label: "子代理", Icon: Bot },
```

- [ ] **Step 3: render 分支**

在 `{active === "plugins-skills" && (...)}` 块附近加：

```tsx
            {active === "agents" && (
              <AgentsSection activeRepoPath={activeRepoPath} />
            )}
```

- [ ] **Step 4: typecheck**

Run: `cd packages/desktop && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/renderer/settings/SettingsPage.tsx
git commit -m "feat(desktop): register 子代理 settings module

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 端到端验证

**Files:** 无（运行验证）

- [ ] **Step 1: 全量 typecheck + core 测试**

Run: `cd packages/core && bun run typecheck && bun test && cd ../desktop && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 2: 启动 app 手动走查**

Run（用户在终端）：`! cd packages/desktop && bun run dev`
走查清单：
- 设置 → 「子代理」模块出现，左栏列出内置 4 个（标「内置」）。
- 选 researcher，改模型为某个已配置 key → 保存 → 列表里 researcher 变「已覆盖」，且 `~/.code-shell/agents/researcher.md` 生成。
- 取消某个的勾选 → `~/.code-shell/settings.json` 的 `disabledAgents` 含该名。
- 「新增子代理」填 name/description/系统提示词 → 保存 → 出现在列表「自定义」。
- 删除一个自定义/覆盖项 → 文件消失，列表更新。

- [ ] **Step 3: 验证 LLM 侧禁用生效（可选，行为级）**

在一次对话里禁用 explorer 后，让模型尝试 `Agent(agent_type="explorer")` → 应得到 unknown agent_type 报错且 Available 不含 explorer。

- [ ] **Step 4: 最终提交（若走查中有微调）**

```bash
git add -A && git commit -m "chore(desktop): subagent panel e2e tweaks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review 结论

- **Spec 覆盖**：disabledAgents(Task1)、序列化(Task2)、合并+覆盖+过滤(Task3/4)、agent_type 可见性(Task5)、service/IPC/preload(Task6-8)、UI+模块(Task9-10)、验证(Task11)——spec 各节均有对应任务。
- **与 spec 的一处偏离**：spec 提到「source 标 builtin/user」，计划统一用 `"project" | "user"`（更准确，内置即项目级），UI 上把「project 且非 override」显示为「内置」徽标。已在 Task9 体现。
- **占位符**：无 TBD；每个代码步骤含完整代码。
- **类型一致**：`AgentSummary`（service / preload / renderer 三处字段一致）、`AgentDefinitionInput`（preload 定义、renderer 使用、IPC `agents:save` 接收 core 的 `AgentDefinition` 结构兼容）、`loadFromDirs(dirs, disabled)` 签名 Task3 定义、Task4/6 调用一致。
- **YAGNI**：未做 per-agent skill 精选层、未做 GitHub 安装、未动态注入 enum——均按 spec 非目标。

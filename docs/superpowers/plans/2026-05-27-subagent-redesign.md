# Sub-Agent 重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 codeshell 的子 agent 加上可复用的角色定义层（Markdown 注册表），并在其上叠加 per-agent 工具白名单、模型路由、并发上限/超时、生命周期 hooks。

**Architecture:** 新增 `.code-shell/agents/*.md` 角色定义（frontmatter + body=systemPrompt），由 `AgentDefinitionRegistry` 加载。`Agent` 工具新增可选 `agentType` 参数：传入时加载角色配置（工具集、模型、prompt、maxTurns），不传时退化为现有临时模式（完全向后兼容）。子 Engine 的 LLM 从写死的父级克隆改为按角色 `model` key 经 `ModelPool.resolveLLMConfig` 解析。

**Tech Stack:** TypeScript / Bun / Vitest。复用现有 `ModelPool`（`resolveLLMConfig(key, base)`）、`SubAgentSpawner`/`SubAgentSpawnRequest`、`Engine.spawn`、`asyncAgentRegistry`、`HookRegistry`。

**关键源码坐标（动手前先读）：**
- `packages/core/src/tool-system/builtin/agent.ts` — `Agent` 工具 inputSchema(:51-84)、`agentTool`(:132)、`runSubAgent`(:91)
- `packages/core/src/tool-system/builtin/agent-registry.ts` — `asyncAgentRegistry`（运行时实例元数据）
- `packages/core/src/tool-system/context.ts` — `SubAgentSpawnRequest`(:58-72)、`SubAgentSpawner`(:74-85)、`ToolContext`(:93)
- `packages/core/src/engine/engine.ts` — `subAgentSpawner.spawn`(:542-615)，子 Engine 构造写死 llm 在 :563-578
- `packages/core/src/llm/model-pool.ts` — `resolveLLMConfig(key?, base?)`(:279)、`has(key)`(:229)、`get(key?)`(:207)

**显式不在本计划范围（YAGNI，留后续）：**
- 后台 agent 结果流式化（doc P2.4）
- LLM 按 description 自动委派（doc P2.6）
- settings.json 内联 agent 定义（已决定只用 Markdown 文件）

---

## File Structure

**新建：**
- `packages/core/src/agent/agent-definition.ts` — `AgentDefinition` 类型 + frontmatter 解析（纯函数，无 IO）
- `packages/core/src/agent/agent-definition-registry.ts` — 从目录加载 `*.md` → `AgentDefinition[]`
- `packages/core/tests/agent/agent-definition.test.ts`
- `packages/core/tests/agent/agent-definition-registry.test.ts`
- `packages/core/tests/tool-system/agent-model-routing.test.ts`
- `packages/core/tests/tool-system/agent-tool-allowlist.test.ts`
- `packages/core/tests/engine/subagent-concurrency.test.ts`

**修改：**
- `packages/core/src/tool-system/context.ts` — `SubAgentSpawnRequest` 加 `model?` / `toolAllowlist?`；`SubAgentSpawner.describe` 不变
- `packages/core/src/tool-system/builtin/agent.ts` — inputSchema 加 `agent_type`；`agentTool` 解析角色定义
- `packages/core/src/engine/engine.ts` — `spawn()` 按 `req.model` 解析 LLM；按 `req.toolAllowlist` 收窄子工具集；加并发计数 + 超时；子 agent 触发 start/finish/error hooks
- `packages/core/src/tool-system/builtin/agent-registry.ts` — 加进程级并发上限常量 + 计数

---

## Task 1: AgentDefinition 类型 + frontmatter 解析（纯函数）

**Files:**
- Create: `packages/core/src/agent/agent-definition.ts`
- Test: `packages/core/tests/agent/agent-definition.test.ts`

定义角色的不可变数据结构，并把一段带 YAML frontmatter 的 Markdown 文本解析成它。这一步**不碰文件系统**——只做 string → object，便于纯单元测试。

> ⚠️ **核对依赖后修正**：`packages/core/package.json` 已有 `yaml@^2.7.0`。**用它解析 frontmatter，不要手写 YAML parser**——手写解析器不支持内联数组 `tools: [Read, Grep]`、注释、引号转义等，是必踩的技术债。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/agent/agent-definition.test.ts
import { describe, it, expect } from "vitest";
import { parseAgentDefinition } from "../../src/agent/agent-definition.js";

describe("parseAgentDefinition", () => {
  it("parses frontmatter fields and uses body as systemPrompt", () => {
    const md = [
      "---",
      "name: researcher",
      "description: Read-only codebase research",
      "model: flash",
      "maxTurns: 8",
      "tools:",
      "  - Read",
      "  - Grep",
      "  - Glob",
      "---",
      "You are a research agent. Investigate and report; never edit files.",
    ].join("\n");

    const def = parseAgentDefinition(md, "researcher.md");

    expect(def.name).toBe("researcher");
    expect(def.description).toBe("Read-only codebase research");
    expect(def.model).toBe("flash");
    expect(def.maxTurns).toBe(8);
    expect(def.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(def.systemPrompt).toBe(
      "You are a research agent. Investigate and report; never edit files.",
    );
  });

  it("defaults optional fields when omitted", () => {
    const md = ["---", "name: planner", "description: Make a plan", "---", "Plan the work."].join("\n");
    const def = parseAgentDefinition(md, "planner.md");
    expect(def.model).toBeUndefined();
    expect(def.maxTurns).toBeUndefined();
    expect(def.tools).toBeUndefined();
    expect(def.systemPrompt).toBe("Plan the work.");
  });

  it("throws a clear error when name is missing", () => {
    const md = ["---", "description: no name here", "---", "body"].join("\n");
    expect(() => parseAgentDefinition(md, "broken.md")).toThrow(/broken\.md.*name/i);
  });

  it("throws when frontmatter delimiters are absent", () => {
    expect(() => parseAgentDefinition("just a body, no frontmatter", "x.md")).toThrow(/x\.md.*frontmatter/i);
  });

  it("supports inline-array tools syntax", () => {
    const md = ["---", "name: r", "description: d", "tools: [Read, Grep, Glob]", "---", "Body."].join("\n");
    const def = parseAgentDefinition(md, "r.md");
    expect(def.tools).toEqual(["Read", "Grep", "Glob"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/agent/agent-definition.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/agent-definition.js'`

- [ ] **Step 3: 写最小实现**

```ts
// packages/core/src/agent/agent-definition.ts
import { parse as parseYaml } from "yaml";

/** A reusable sub-agent role, loaded from a Markdown file. */
export interface AgentDefinition {
  /** Unique role key, e.g. "researcher". Matched against Agent({ agent_type }). */
  name: string;
  /** Human-facing summary of when to use this role. */
  description: string;
  /** Optional ModelPool key (e.g. "flash"). Undefined → inherit parent model. */
  model?: string;
  /** Optional turn cap for this role. Undefined → caller/default decides. */
  maxTurns?: number;
  /** Optional tool allowlist. Undefined → inherit parent's full tool set. */
  tools?: string[];
  /** Markdown body — becomes the child Engine's appendSystemPrompt. */
  systemPrompt: string;
}

interface RawFrontmatter {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  maxTurns?: unknown;
  tools?: unknown;
}

/**
 * Parse a Markdown agent-definition file (YAML frontmatter + body).
 * Pure: no filesystem access. `sourceName` is only used in error messages.
 */
export function parseAgentDefinition(raw: string, sourceName: string): AgentDefinition {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${sourceName}: missing YAML frontmatter (expected leading '---' block)`);
  }
  const [, yamlSrc, body] = match;
  let fm: RawFrontmatter;
  try {
    fm = (parseYaml(yamlSrc) ?? {}) as RawFrontmatter;
  } catch (err) {
    throw new Error(`${sourceName}: invalid YAML frontmatter — ${(err as Error).message}`);
  }

  if (typeof fm.name !== "string" || fm.name.trim().length === 0) {
    throw new Error(`${sourceName}: frontmatter must include a non-empty 'name'`);
  }
  if (typeof fm.description !== "string" || fm.description.trim().length === 0) {
    throw new Error(`${sourceName}: frontmatter must include a non-empty 'description'`);
  }

  const def: AgentDefinition = {
    name: fm.name.trim(),
    description: fm.description.trim(),
    systemPrompt: body.trim(),
  };
  if (typeof fm.model === "string" && fm.model.trim()) def.model = fm.model.trim();
  if (typeof fm.maxTurns === "number") def.maxTurns = fm.maxTurns;
  if (Array.isArray(fm.tools)) {
    def.tools = fm.tools.filter((t): t is string => typeof t === "string");
  }
  return def;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/agent/agent-definition.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/agent/agent-definition.ts packages/core/tests/agent/agent-definition.test.ts
git commit -m "feat(core): AgentDefinition type + frontmatter parser for sub-agent roles"
```

---

## Task 2: AgentDefinitionRegistry — 从目录加载角色

**Files:**
- Create: `packages/core/src/agent/agent-definition-registry.ts`
- Test: `packages/core/tests/agent/agent-definition-registry.test.ts`

把一个目录下的 `*.md` 加载成 `Map<name, AgentDefinition>`。坏文件跳过并收集警告，不让一个写错的角色文件炸掉整个加载。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/agent/agent-definition-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentDefinitionRegistry } from "../../src/agent/agent-definition-registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentdefs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string) {
  writeFileSync(join(dir, name), body);
}

describe("AgentDefinitionRegistry", () => {
  it("loads .md files keyed by name", () => {
    write("researcher.md", "---\nname: researcher\ndescription: research\nmodel: flash\n---\nResearch.");
    write("planner.md", "---\nname: planner\ndescription: plan\n---\nPlan.");

    const reg = AgentDefinitionRegistry.loadFromDir(dir);

    expect(reg.has("researcher")).toBe(true);
    expect(reg.get("researcher")?.model).toBe("flash");
    expect(reg.list().map((d) => d.name).sort()).toEqual(["planner", "researcher"]);
    expect(reg.warnings).toHaveLength(0);
  });

  it("skips malformed files and records a warning instead of throwing", () => {
    write("good.md", "---\nname: good\ndescription: ok\n---\nBody.");
    write("bad.md", "no frontmatter here");

    const reg = AgentDefinitionRegistry.loadFromDir(dir);

    expect(reg.has("good")).toBe(true);
    expect(reg.has("bad")).toBe(false);
    expect(reg.warnings.some((w) => w.includes("bad.md"))).toBe(true);
  });

  it("ignores non-md files", () => {
    write("notes.txt", "name: nope");
    write("a.md", "---\nname: a\ndescription: d\n---\nB.");
    const reg = AgentDefinitionRegistry.loadFromDir(dir);
    expect(reg.list().map((d) => d.name)).toEqual(["a"]);
  });

  it("returns an empty registry when the dir does not exist", () => {
    const reg = AgentDefinitionRegistry.loadFromDir(join(dir, "does-not-exist"));
    expect(reg.list()).toEqual([]);
    expect(reg.warnings).toEqual([]);
  });

  it("later file with duplicate name wins and records a warning", () => {
    mkdirSync(join(dir, "sub"));
    write("a.md", "---\nname: dup\ndescription: first\n---\nFirst.");
    writeFileSync(join(dir, "sub", "z.md"), "---\nname: dup\ndescription: second\n---\nSecond.");
    const reg = AgentDefinitionRegistry.loadFromDir(dir);
    // Only top-level dir is scanned (non-recursive); "first" stays.
    expect(reg.get("dup")?.description).toBe("first");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/agent/agent-definition-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/agent-definition-registry.js'`

- [ ] **Step 3: 写最小实现**

```ts
// packages/core/src/agent/agent-definition-registry.ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDefinition, type AgentDefinition } from "./agent-definition.js";

/**
 * Loads reusable sub-agent role definitions from a directory of `*.md` files.
 * Non-recursive. Malformed files are skipped with a warning rather than
 * failing the whole load — one bad role file must not break the agent system.
 */
export class AgentDefinitionRegistry {
  private defs = new Map<string, AgentDefinition>();
  readonly warnings: string[] = [];

  static loadFromDir(dir: string): AgentDefinitionRegistry {
    const reg = new AgentDefinitionRegistry();
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return reg;

    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isFile()) continue;
        const def = parseAgentDefinition(readFileSync(full, "utf8"), entry);
        if (reg.defs.has(def.name)) {
          reg.warnings.push(`${entry}: duplicate agent name '${def.name}' ignored (first definition wins)`);
          continue;
        }
        reg.defs.set(def.name, def);
      } catch (err) {
        reg.warnings.push(`${entry}: ${(err as Error).message}`);
      }
    }
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

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/agent/agent-definition-registry.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/agent/agent-definition-registry.ts packages/core/tests/agent/agent-definition-registry.test.ts
git commit -m "feat(core): AgentDefinitionRegistry loads sub-agent roles from a dir"
```

---

## Task 3: 扩展 SubAgentSpawnRequest（透传 model + toolAllowlist）

**Files:**
- Modify: `packages/core/src/tool-system/context.ts:58-72`

给 spawn 请求加两个可选字段，作为后续任务的管道。本任务只改类型，不改行为——所以没有独立测试（TypeScript 编译即验证）；行为测试在 Task 4/5。

- [ ] **Step 1: 修改 `SubAgentSpawnRequest`**

在 `packages/core/src/tool-system/context.ts` 的 `SubAgentSpawnRequest` 接口（当前 :58-72，`streamOverride` 字段之后）加入：

```ts
  /**
   * Optional ModelPool key for the child Engine's LLM (e.g. "flash").
   * Undefined → child inherits the parent's model (current behavior).
   */
  model?: string;
  /**
   * Optional tool-name allowlist for the child. When set, the child's tool
   * pool is restricted to these names (still minus the nested-agent tools).
   * Undefined → child inherits the parent's full tool set (current behavior).
   */
  toolAllowlist?: string[];
```

- [ ] **Step 2: 编译确认无类型回归**

Run: `cd packages/core && bun run tsc --noEmit`
Expected: 通过（新字段都是可选的，无现有调用点被破坏）

- [ ] **Step 3: 提交**

```bash
git add packages/core/src/tool-system/context.ts
git commit -m "feat(core): add optional model + toolAllowlist to SubAgentSpawnRequest"
```

---

## Task 4: spawn() 按 model key 解析子 Engine 的 LLM

**Files:**
- Modify: `packages/core/src/engine/engine.ts:563-578`（子 Engine 构造）
- Test: `packages/core/tests/tool-system/agent-model-routing.test.ts`

把写死的 `llm: { ...this.config.llm }` 改为：`req.model` 存在且 ModelPool 有该 key → 用 `resolveLLMConfig` 解析；否则回退父级 llm（key miss 也回退，不崩）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/tool-system/agent-model-routing.test.ts
import { describe, it, expect } from "vitest";
import { ModelPool } from "../../src/llm/model-pool.js";
import { resolveChildLlm } from "../../src/engine/engine.js";

const baseLlm = {
  provider: "openai",
  model: "anthropic/claude-opus-4-6",
  baseUrl: "https://parent.example/v1",
  apiKey: "parent-key",
} as const;

function poolWithFlash(): ModelPool {
  const pool = new ModelPool();
  pool.register({ key: "flash", provider: "google", model: "gemini-flash", baseUrl: "https://flash.example/v1", apiKey: "flash-key" });
  return pool;
}

describe("resolveChildLlm", () => {
  it("returns parent llm unchanged when no model requested", () => {
    const llm = resolveChildLlm(undefined, poolWithFlash(), baseLlm);
    expect(llm.model).toBe("anthropic/claude-opus-4-6");
    expect(llm.baseUrl).toBe("https://parent.example/v1");
  });

  it("resolves the requested model key from the pool", () => {
    const llm = resolveChildLlm("flash", poolWithFlash(), baseLlm);
    expect(llm.model).toBe("gemini-flash");
    expect(llm.baseUrl).toBe("https://flash.example/v1");
    expect(llm.apiKey).toBe("flash-key");
  });

  it("falls back to parent llm when the key is unknown (no throw)", () => {
    const llm = resolveChildLlm("nonexistent", poolWithFlash(), baseLlm);
    expect(llm.model).toBe("anthropic/claude-opus-4-6");
  });

  it("falls back to parent llm when there is no pool", () => {
    const llm = resolveChildLlm("flash", undefined, baseLlm);
    expect(llm.model).toBe("anthropic/claude-opus-4-6");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-model-routing.test.ts`
Expected: FAIL — `resolveChildLlm is not exported` / not a function

- [ ] **Step 3: 在 engine.ts 加导出的纯函数**

在 `packages/core/src/engine/engine.ts` 顶部（import 之后、`class Engine` 之前）加入。注意 import：文件已 import `ModelPool`（:61）和 `LLMConfig`（在 `EngineConfig.llm` 用到）；若 `LLMConfig` 未直接 import，加 `import type { LLMConfig } from "../llm/types.js";`（与 model-pool.ts 的 import 路径一致）。

```ts
/**
 * Resolve the LLM config for a spawned child Engine.
 * - `modelKey` set + present in pool → that model's config (over parent base).
 * - otherwise (no key, no pool, or key miss) → the parent's llm unchanged.
 * Key miss is a soft fallback, NOT an error: a stale agent definition must not
 * crash the spawn.
 */
export function resolveChildLlm(
  modelKey: string | undefined,
  pool: ModelPool | undefined,
  parentLlm: LLMConfig,
): LLMConfig {
  if (modelKey && pool?.has(modelKey)) {
    const resolved = pool.resolveLLMConfig(modelKey, parentLlm);
    if (resolved) return resolved;
  }
  return parentLlm;
}
```

- [ ] **Step 4: 在 spawn() 里使用它**

在 `packages/core/src/engine/engine.ts` 的 `spawn`（当前子 Engine 构造在 :563），把：

```ts
        const child = new Engine({
          llm: { ...this.config.llm, retryMaxAttempts: 2 },
```

改为：

```ts
        const childLlm = resolveChildLlm(req.model, this.modelPool, this.config.llm);
        const child = new Engine({
          llm: { ...childLlm, retryMaxAttempts: 2 },
```

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-model-routing.test.ts && bun run tsc --noEmit`
Expected: PASS（4 用例）+ 编译通过

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/engine/engine.ts packages/core/tests/tool-system/agent-model-routing.test.ts
git commit -m "feat(core): route sub-agent LLM by model key with soft fallback"
```

---

## Task 5: spawn() 按 toolAllowlist 收窄子工具集

**Files:**
- Modify: `packages/core/src/engine/engine.ts:550-562`（`childDisabled`/`childEnabled` 计算处）
- Test: `packages/core/tests/tool-system/agent-tool-allowlist.test.ts`

现状子 Engine 用 `enabledBuiltinTools`/`disabledBuiltinTools` 继承父级。`req.toolAllowlist` 存在时，把它转成子 Engine 的 `enabledBuiltinTools`（白名单），并仍剥离 nested-agent 工具。抽成纯函数测试。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/tool-system/agent-tool-allowlist.test.ts
import { describe, it, expect } from "vitest";
import { resolveChildToolScope } from "../../src/engine/engine.js";

describe("resolveChildToolScope", () => {
  const NESTED = ["Agent", "AgentStatus", "AgentCancel"];

  it("with no allowlist, inherits parent enabled/disabled minus nested tools", () => {
    const scope = resolveChildToolScope(undefined, ["Bash"], undefined);
    expect(scope.enabled).toBeUndefined();
    expect(scope.disabled).toEqual(expect.arrayContaining([...NESTED, "Bash"]));
  });

  it("with an allowlist, child enabled = allowlist minus nested tools", () => {
    const scope = resolveChildToolScope(["Read", "Grep", "Agent"], undefined, undefined);
    expect(scope.enabled).toEqual(["Read", "Grep"]);
    expect(scope.disabled).toEqual(expect.arrayContaining(NESTED));
  });

  it("allowlist is unioned-stripped even if parent had an enabled list", () => {
    const scope = resolveChildToolScope(["Read"], undefined, ["Bash", "Edit"]);
    // Allowlist wins: child sees only Read.
    expect(scope.enabled).toEqual(["Read"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-tool-allowlist.test.ts`
Expected: FAIL — `resolveChildToolScope is not exported`

- [ ] **Step 3: 在 engine.ts 加导出的纯函数**

在 `packages/core/src/engine/engine.ts`（紧邻 `resolveChildLlm`）加入：

```ts
const NESTED_AGENT_TOOLS = ["Agent", "AgentStatus", "AgentCancel"];

/**
 * Compute a child Engine's tool scope.
 * - `allowlist` set → child enabled = allowlist minus nested-agent tools
 *   (a per-role tool whitelist, e.g. a read-only researcher).
 * - `allowlist` undefined → inherit parent enabled/disabled, always with the
 *   nested-agent tools forced into `disabled` (no grandchildren).
 */
export function resolveChildToolScope(
  allowlist: string[] | undefined,
  parentDisabled: string[] | undefined,
  parentEnabled: string[] | undefined,
): { enabled?: string[]; disabled: string[] } {
  if (allowlist) {
    return {
      enabled: allowlist.filter((t) => !NESTED_AGENT_TOOLS.includes(t)),
      disabled: [...NESTED_AGENT_TOOLS],
    };
  }
  const disabled = Array.from(new Set([...(parentDisabled ?? []), ...NESTED_AGENT_TOOLS]));
  const enabled = parentEnabled?.filter((t) => !NESTED_AGENT_TOOLS.includes(t));
  return { enabled, disabled };
}
```

- [ ] **Step 4: 在 spawn() 里替换内联逻辑**

在 `packages/core/src/engine/engine.ts` 的 `spawn` 内，把现有的 `NESTED_AGENT_TOOLS` 常量声明 + `childDisabled`/`childEnabled` 计算（当前 :550-562）整段替换为：

```ts
        const { enabled: childEnabled, disabled: childDisabled } = resolveChildToolScope(
          req.toolAllowlist,
          this.config.disabledBuiltinTools,
          this.config.enabledBuiltinTools,
        );
```

（`new Engine({ ... enabledBuiltinTools: childEnabled, disabledBuiltinTools: childDisabled, ... })` 的用法不变。删掉原 spawn 内的 `const NESTED_AGENT_TOOLS = [...]` 以免与模块级常量重名。）

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-tool-allowlist.test.ts && bun run tsc --noEmit`
Expected: PASS（3 用例）+ 编译通过

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/engine/engine.ts packages/core/tests/tool-system/agent-tool-allowlist.test.ts
git commit -m "feat(core): per-agent tool allowlist for spawned sub-agents"
```

---

## Task 6: Agent 工具接入 agent_type（加载角色定义）

**Files:**
- Modify: `packages/core/src/tool-system/builtin/agent.ts:51-84`（inputSchema）、`:132+`（agentTool）、`:91`（runSubAgent 透传）
- Modify: `packages/core/src/tool-system/context.ts:93`（`ToolContext` 加 `agentDefinitions?`）
- Test: 复用 Task 4/5 的集成路径；本任务加一个解析单测

把 `agent_type` 参数接进来：从 `ctx.agentDefinitions`（一个 `AgentDefinitionRegistry`）查出角色，把 `model`/`tools`/`maxTurns`/`systemPrompt` 填进 spawn 请求。未传 `agent_type` 时行为与今天完全一致。

- [ ] **Step 1: 在 ToolContext 上挂注册表**

在 `packages/core/src/tool-system/context.ts` 的 `ToolContext`（:93）`subAgentSpawner` 字段附近加入：

```ts
  /**
   * Reusable sub-agent role definitions (loaded from .code-shell/agents/*.md).
   * The Agent tool reads this to resolve `agent_type`. Undefined → only the
   * ephemeral (inline prompt) mode is available.
   */
  agentDefinitions?: import("../agent/agent-definition-registry.js").AgentDefinitionRegistry;
```

- [ ] **Step 2: 写失败测试**

```ts
// packages/core/tests/agent/agent-type-resolution.test.ts
import { describe, it, expect } from "vitest";
import { resolveAgentTypeOverrides } from "../../src/tool-system/builtin/agent.js";
import { AgentDefinitionRegistry } from "../../src/agent/agent-definition-registry.js";

function regWith(def: { name: string; description: string; model?: string; maxTurns?: number; tools?: string[]; systemPrompt: string }) {
  // Build a registry by hand via a temp file is heavy; expose a test seam instead.
  const reg = new AgentDefinitionRegistry();
  (reg as unknown as { defs: Map<string, unknown> }).defs.set(def.name, def);
  return reg;
}

describe("resolveAgentTypeOverrides", () => {
  it("returns undefined overrides when agent_type is omitted", () => {
    const out = resolveAgentTypeOverrides(undefined, undefined);
    expect(out).toEqual({});
  });

  it("pulls model/tools/maxTurns/appendPrompt from the matching definition", () => {
    const reg = regWith({ name: "researcher", description: "r", model: "flash", maxTurns: 8, tools: ["Read", "Grep"], systemPrompt: "Be a researcher." });
    const out = resolveAgentTypeOverrides("researcher", reg);
    expect(out.model).toBe("flash");
    expect(out.maxTurns).toBe(8);
    expect(out.toolAllowlist).toEqual(["Read", "Grep"]);
    expect(out.appendSystemPrompt).toBe("Be a researcher.");
  });

  it("throws a clear error when agent_type is unknown", () => {
    const reg = regWith({ name: "researcher", description: "r", systemPrompt: "x" });
    expect(() => resolveAgentTypeOverrides("ghost", reg)).toThrow(/unknown agent_type 'ghost'/i);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/agent/agent-type-resolution.test.ts`
Expected: FAIL — `resolveAgentTypeOverrides is not exported`

- [ ] **Step 4: 实现 + 接线**

(a) 在 `packages/core/src/tool-system/builtin/agent.ts` 顶部加 import 并导出解析函数：

```ts
import type { AgentDefinitionRegistry } from "../../agent/agent-definition-registry.js";

export interface AgentTypeOverrides {
  model?: string;
  maxTurns?: number;
  toolAllowlist?: string[];
  appendSystemPrompt?: string;
}

/**
 * Resolve an `agent_type` against the role registry into spawn overrides.
 * Omitted type → empty overrides (ephemeral mode). Unknown type → throw, so
 * the LLM gets a clear correction instead of silently running a generic agent.
 */
export function resolveAgentTypeOverrides(
  agentType: string | undefined,
  registry: AgentDefinitionRegistry | undefined,
): AgentTypeOverrides {
  if (!agentType) return {};
  const def = registry?.get(agentType);
  if (!def) {
    const available = registry?.list().map((d) => d.name).join(", ") || "(none defined)";
    throw new Error(`unknown agent_type '${agentType}'. Available: ${available}`);
  }
  return {
    model: def.model,
    maxTurns: def.maxTurns,
    toolAllowlist: def.tools,
    appendSystemPrompt: def.systemPrompt,
  };
}
```

(b) 在 inputSchema（:51-84 的 `properties`）加：

```ts
      agent_type: {
        type: "string",
        description:
          "Optional reusable role defined in .code-shell/agents/*.md (e.g. 'researcher'). " +
          "Loads that role's model, tool allowlist, turn cap, and system prompt. " +
          "Omit to run an ad-hoc agent described entirely by 'prompt'.",
      },
```

(c) 在 `agentTool`（:132）解析参数后、构造 spawn 之前：

```ts
  const agentType = (args.agent_type as string | undefined)?.trim() || undefined;
  let overrides: AgentTypeOverrides;
  try {
    overrides = resolveAgentTypeOverrides(agentType, ctx?.agentDefinitions);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
```

(d) `maxTurns` 解析改为让角色定义可覆盖默认值（当前 :160 `const maxTurns = (args.max_turns as number) || 15;`）：

```ts
  const maxTurns = (args.max_turns as number) || overrides.maxTurns || 15;
```

(e) 把 `overrides.model` / `overrides.toolAllowlist` / `overrides.appendSystemPrompt` 透传进 `runSubAgent` → `spawner.spawn` 的 `req`。

`runSubAgent`（:91）的 `opts` 类型加 `model?`/`toolAllowlist?`/`appendSystemPrompt?` 字段，并在它内部调用 `spawner.spawn({ ...opts, streamOverride })`（:126）时自动带上（因为 `...opts` 已含这些字段）。

> ⚠️ **有两个调用 `runSubAgent` 的地方，必须都透传**（核对真实源码后补充）：
> 1. **同步路径** :304（Task 9 已在那段加了 `model`/`toolAllowlist`/`appendSystemPrompt`）。
> 2. **后台路径** :196 的 `void runSubAgent(spawner, { agentId, name, description, prompt, maxTurns, signal: controller.signal }, parentStream, transcriptSink)` —— 现状这个 `opts` 字面量（:198-205）**没有带 overrides**。必须改成：
> ```ts
>     void runSubAgent(
>       spawner,
>       {
>         agentId,
>         name,
>         description,
>         prompt,
>         maxTurns,
>         model: overrides.model,
>         toolAllowlist: overrides.toolAllowlist,
>         appendSystemPrompt: overrides.appendSystemPrompt,
>         signal: controller.signal,
>       },
>       parentStream,
>       transcriptSink,
>     )
> ```
> 漏掉后台路径会导致 `Agent(agent_type=..., run_in_background=true)` 静默丢掉角色的模型/工具/prompt 配置——这是个安静的 bug，没有测试会立刻抓到，所以这里显式点名。

注意：`appendSystemPrompt` 需要 spawn 侧支持——见 Step 5。

- [ ] **Step 5: spawn() 接受 per-call appendSystemPrompt**

现状子 Engine 用 `appendSystemPrompt: this.config.appendSystemPrompt`（engine.ts:571，继承父级）。改为让 spawn 请求可追加角色 prompt：在 `SubAgentSpawnRequest`（context.ts）加 `appendSystemPrompt?: string`，并在 `spawn`（engine.ts:571）改为：

```ts
          appendSystemPrompt: [this.config.appendSystemPrompt, req.appendSystemPrompt]
            .filter(Boolean)
            .join("\n\n") || undefined,
```

- [ ] **Step 6: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/agent/agent-type-resolution.test.ts && bun run tsc --noEmit`
Expected: PASS（3 用例）+ 编译通过

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/tool-system/builtin/agent.ts packages/core/src/tool-system/context.ts packages/core/src/engine/engine.ts packages/core/tests/agent/agent-type-resolution.test.ts
git commit -m "feat(core): Agent tool agent_type loads reusable role definitions"
```

---

## Task 7: Engine 加载 .code-shell/agents 并注入 ToolContext

**Files:**
- Modify: `packages/core/src/engine/engine.ts`（构造 ToolContext 处，:641 附近 `subAgentSpawner,`）
- Test: `packages/core/tests/engine/agent-definitions-loaded.test.ts`

Engine 在构造 ToolContext 时，从 `<cwd>/.code-shell/agents` 加载注册表并挂到 `ctx.agentDefinitions`。加载一次、缓存到 Engine 实例（不必每个 turn 重读盘）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/engine/agent-definitions-loaded.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDefinitionsForCwd } from "../../src/engine/engine.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eng-agents-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadAgentDefinitionsForCwd", () => {
  it("loads from <cwd>/.code-shell/agents", () => {
    mkdirSync(join(dir, ".code-shell", "agents"), { recursive: true });
    writeFileSync(join(dir, ".code-shell", "agents", "r.md"), "---\nname: r\ndescription: d\n---\nBody.");
    const reg = loadAgentDefinitionsForCwd(dir);
    expect(reg.has("r")).toBe(true);
  });

  it("returns an empty registry when the dir is absent", () => {
    const reg = loadAgentDefinitionsForCwd(dir);
    expect(reg.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/engine/agent-definitions-loaded.test.ts`
Expected: FAIL — `loadAgentDefinitionsForCwd is not exported`

- [ ] **Step 3: 实现 + 接线**

(a) 在 `packages/core/src/engine/engine.ts` 顶部加 import：

```ts
import { AgentDefinitionRegistry } from "../agent/agent-definition-registry.js";
```

(b) 加导出的辅助函数（紧邻 `resolveChildLlm`）：

```ts
/** Load reusable sub-agent role definitions from <cwd>/.code-shell/agents. */
export function loadAgentDefinitionsForCwd(cwd: string): AgentDefinitionRegistry {
  return AgentDefinitionRegistry.loadFromDir(`${cwd}/.code-shell/agents`);
}
```

(c) 在 Engine 实例上缓存（class 字段，构造函数里赋值一次）：

```ts
  private agentDefinitions: AgentDefinitionRegistry;
```
构造函数末尾：
```ts
    this.agentDefinitions = loadAgentDefinitionsForCwd(this.config.cwd ?? process.cwd());
```
（确认 EngineConfig 里 cwd 字段名；若用局部 `cwd` 变量，沿用之。）

(d) 在构造 ToolContext 处（:641 附近 `subAgentSpawner,` 同级）加：

```ts
      agentDefinitions: this.agentDefinitions,
```

注意：子 agent（`isSubAgent === true`）的 Engine 也会执行这段，但因为 Agent 工具对子 agent 被剥离 + 运行时拒绝（agent.ts:150），`agentDefinitions` 在子 agent 里不会被用到——无需特殊处理。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/engine/agent-definitions-loaded.test.ts && bun run tsc --noEmit`
Expected: PASS（2 用例）+ 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/engine/engine.ts packages/core/tests/engine/agent-definitions-loaded.test.ts
git commit -m "feat(core): Engine loads .code-shell/agents into ToolContext"
```

---

## Task 8: 后台 agent 并发上限

**Files:**
- Modify: `packages/core/src/tool-system/builtin/agent-registry.ts`（加上限常量 + 计数查询）
- Modify: `packages/core/src/tool-system/builtin/agent.ts:170+`（background 分支，register 前检查）
- Test: `packages/core/tests/engine/subagent-concurrency.test.ts`

后台 agent 现状无界堆积。加进程级上限（默认 6，对齐 Codex `max_threads`）；超限时 `Agent(run_in_background=true)` 返回明确错误而非静默继续。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/engine/subagent-concurrency.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { asyncAgentRegistry, MAX_BACKGROUND_AGENTS } from "../../src/tool-system/builtin/agent-registry.js";

describe("background agent concurrency cap", () => {
  beforeEach(() => {
    asyncAgentRegistry.clearAll();
  });

  it("exposes a positive default cap", () => {
    expect(MAX_BACKGROUND_AGENTS).toBeGreaterThan(0);
  });

  it("runningCount reflects registered running agents", () => {
    expect(asyncAgentRegistry.runningCount()).toBe(0);
    asyncAgentRegistry.register({ agentId: "a1", description: "d", status: "running", startedAt: Date.now(), abort: () => {} });
    asyncAgentRegistry.register({ agentId: "a2", description: "d", status: "running", startedAt: Date.now(), abort: () => {} });
    expect(asyncAgentRegistry.runningCount()).toBe(2);
  });
});
```

> ⚠️ **核对过真实源码**：`asyncAgentRegistry` 是 class `AsyncAgentRegistry`（`agent-registry.ts:44`），现有方法是 `register` / `list` / `markCompleted` / `markFailed` / `markCancelled` / `hasRunning`（已有！基于 `snapshot.some(e => e.status === "running")`）。**没有 `remove`，也没有 `runningCount` / `clearAll`**。本测试用到的 `clearAll`（测试隔离用）和 `runningCount` 都是本任务**新增**的方法。`register` 的真实入参字段形状以 `AsyncAgentEntry`（agent-registry.ts:~30）为准——下面的 `{ agentId, description, status, startedAt, abort }` 是占位，落地时按真实字段名核对。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/engine/subagent-concurrency.test.ts`
Expected: FAIL — `MAX_BACKGROUND_AGENTS` 未导出 / `runningCount`、`clearAll` 不是函数

- [ ] **Step 3: 在 agent-registry.ts 加上限 + 计数 + 测试清理**

在模块顶部加导出常量：
```ts
/** Process-wide cap on concurrent background sub-agents (aligns with Codex max_threads=6). */
export const MAX_BACKGROUND_AGENTS = 6;
```
在 `AsyncAgentRegistry` class（:44）里加两个方法。`runningCount` 复用现有 `hasRunning` 的判定口径（`status === "running"`），`clearAll` 仅供测试隔离用（注意要 `notify()` 让订阅者刷新，与现有 mark* 方法一致）：
```ts
  runningCount(): number {
    return this.snapshot.filter((e) => e.status === "running").length;
  }

  /** Test-only: drop all tracked agents. */
  clearAll(): void {
    this.agents.clear();
    this.notify();
  }
```
（`this.agents`、`this.snapshot`、`this.notify()` 都是该 class 现有的私有成员——见 :46-72。按真实成员名核对。）

- [ ] **Step 4: 在 agent.ts background 分支加检查**

在 `packages/core/src/tool-system/builtin/agent.ts` 的 `if (runInBackground) {`（:170）register 之前：

```ts
    if (asyncAgentRegistry.runningCount() >= MAX_BACKGROUND_AGENTS) {
      return `Error: too many background agents running (limit ${MAX_BACKGROUND_AGENTS}). ` +
        `Wait for some to finish or cancel one with AgentCancel(agent_id) before launching more.`;
    }
```
（确保文件已 import `MAX_BACKGROUND_AGENTS`。）

- [ ] **Step 5: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/engine/subagent-concurrency.test.ts && bun run tsc --noEmit`
Expected: PASS + 编译通过

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tool-system/builtin/agent-registry.ts packages/core/src/tool-system/builtin/agent.ts packages/core/tests/engine/subagent-concurrency.test.ts
git commit -m "feat(core): cap concurrent background sub-agents (default 6)"
```

---

## Task 9: 同步子 agent 超时（仅同步路径）

**Files:**
- Modify: `packages/core/src/tool-system/builtin/agent.ts`（**仅同步路径** :302-316 包一层超时）
- Test: `packages/core/tests/tool-system/agent-timeout.test.ts`

同步子 agent 卡住会空烧父级 maxTurns。给同步 spawn 包一个超时（默认 5 分钟），到点 abort 子 agent 并返回超时文本。

> ⚠️ **范围限定（核对真实源码后修正）**：超时**只加在同步路径**（`agentTool` :302-316 的 `try { return await runSubAgent(...) }`）。**不要加到后台路径**（:196 的 `void runSubAgent(...)`），原因有二：(1) 后台 agent 不阻塞父级，本就没有"空烧 maxTurns"的问题；(2) 后台路径靠 `controller.signal.aborted`（:249）区分"用户取消"（不发通知）vs"失败"（发通知）——若超时也走 `controller.abort()`，后台 agent 超时会被误判成用户取消而**静默丢弃、不通知**。所以超时逻辑放在 `runSubAgent` 之外、同步调用点这一层，不碰 `runSubAgent` 内部，也不碰后台分支。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/tool-system/agent-timeout.test.ts
import { describe, it, expect } from "vitest";
import { runWithTimeout, DEFAULT_SUBAGENT_TIMEOUT_MS } from "../../src/tool-system/builtin/agent.js";

describe("runWithTimeout", () => {
  it("exposes a positive default timeout", () => {
    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("resolves with the value when work finishes in time", async () => {
    const out = await runWithTimeout(() => Promise.resolve("done"), 1000, () => {});
    expect(out).toBe("done");
  });

  it("aborts and throws a timeout error when work exceeds the limit", async () => {
    let aborted = false;
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    await expect(runWithTimeout(slow, 20, () => { aborted = true; })).rejects.toThrow(/timed out/i);
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-timeout.test.ts`
Expected: FAIL — `runWithTimeout` / `DEFAULT_SUBAGENT_TIMEOUT_MS` 未导出

- [ ] **Step 3: 实现 + 接线**

(a) 在 `packages/core/src/tool-system/builtin/agent.ts` 加：

```ts
/** Default per-sub-agent wall-clock timeout (5 minutes). */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Run `work()` with a timeout. On expiry, calls `onTimeout` (to abort the
 * child) and rejects with a timeout error. The child's own abort handling
 * unwinds its resources.
 */
export async function runWithTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

(b) **不动 `runSubAgent` 内部，也不动后台路径**。只把同步路径（`agentTool` 当前 :302-316）那一段 `try { return await runSubAgent(...) }` 包进超时。

同步路径现状（:303-311）是：
```ts
  try {
    return await runSubAgent(spawner, {
      agentId,
      name,
      description,
      prompt,
      maxTurns,
      signal: parentSignal ?? new AbortController().signal,
    });
  } catch (err) { ... }
```

改为：建一个 child controller，超时回调里 abort 它；把它的 signal 作为子 agent 的 signal，同时把父级 abort 转发给它：
```ts
  const syncController = new AbortController();
  const onParentAbort = () => syncController.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await runWithTimeout(
      () =>
        runSubAgent(spawner, {
          agentId,
          name,
          description,
          prompt,
          maxTurns,
          model: overrides.model,                 // Task 6 透传
          toolAllowlist: overrides.toolAllowlist,  // Task 5/6 透传
          appendSystemPrompt: overrides.appendSystemPrompt, // Task 6 透传
          signal: syncController.signal,
        }),
      DEFAULT_SUBAGENT_TIMEOUT_MS,
      () => syncController.abort(),
    );
  } catch (err) {
    safeEmit(parentStream, { type: "agent_end", agentId, name, description, error: (err as Error).message });
    if (parentSignal?.aborted) return "Agent was aborted.";
    return `Agent error: ${(err as Error).message}`;
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
```
（`runWithTimeout` 超时时 reject 的 timeout error 会被 `catch` 接住，因为 `parentSignal?.aborted` 为 false，走 `Agent error: Sub-agent timed out after ...` 分支——符合预期。`overrides` 来自 Task 6；若先做 Task 9 后做 Task 6，这里的三个 `overrides.*` 透传先省略，等 Task 6 再补。）

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-timeout.test.ts && bun run tsc --noEmit`
Expected: PASS（3 用例）+ 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/builtin/agent.ts packages/core/tests/tool-system/agent-timeout.test.ts
git commit -m "feat(core): per-sub-agent wall-clock timeout (default 5m)"
```

---

## Task 10: 子 agent 生命周期 hooks

**Files:**
- Modify: `packages/core/src/tool-system/builtin/agent.ts`（`runSubAgent` 起止处 emit hook）
- Test: `packages/core/tests/tool-system/agent-lifecycle-hooks.test.ts`

现状子 agent 不触发任何 hook，可观测性弱。在 spawn 起/止/错处通过 `ctx.hooks` emit 生命周期事件。

> ⚠️ **核对真实源码后修正**：`HookEventName`（`events.ts:76`）是**封闭 union**，取值固定为 `on_agent_start` / `on_turn_start` / `pre_tool_use` / ... / `notification` 等。**不能凭空 emit 一个 `"subagent_start"`——TS 会编译报错**。后台路径（`agent.ts:240`）已经确立了正确模式：emit 现有的 `"notification"` 事件 + `kind` 字段区分类型（`emit("notification", { kind: "agent_completed", ... })`）。本任务**对齐这个模式**，零 schema 改动。另外 `emit` 是 **async**（`registry.ts:27` `async emit(...): Promise<HookResult>`），fire-and-forget 要 `void`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/tests/tool-system/agent-lifecycle-hooks.test.ts
import { describe, it, expect, vi } from "vitest";
import { emitSubAgentHook } from "../../src/tool-system/builtin/agent.js";

describe("emitSubAgentHook", () => {
  it("emits a notification event with a subagent_ kind + payload", () => {
    const emit = vi.fn().mockResolvedValue({});
    emitSubAgentHook({ emit } as never, "subagent_start", { agentId: "x", description: "d" });
    expect(emit).toHaveBeenCalledWith("notification", { kind: "subagent_start", agentId: "x", description: "d" });
  });

  it("is a no-op when hooks are undefined", () => {
    expect(() => emitSubAgentHook(undefined, "subagent_start", { agentId: "x", description: "d" })).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-lifecycle-hooks.test.ts`
Expected: FAIL — `emitSubAgentHook is not exported`

- [ ] **Step 3: 实现 + 接线**

(a) 在 `agent.ts` 加（import 路径以真实文件为准：`HookRegistry` 在 `../../hooks/registry.js`）：

```ts
import type { HookRegistry } from "../../hooks/registry.js";

type SubAgentLifecycle = "subagent_start" | "subagent_finish" | "subagent_error";

/**
 * Emit a sub-agent lifecycle event via the existing `notification` hook,
 * tagged with a `kind`. No-op when hooks are absent. Fire-and-forget: emit is
 * async, we deliberately `void` it so bookkeeping never blocks on a handler
 * (mirrors the background-completion notification at agent.ts:240).
 */
export function emitSubAgentHook(
  hooks: HookRegistry | undefined,
  kind: SubAgentLifecycle,
  payload: { agentId: string; description: string; text?: string; error?: string },
): void {
  void hooks?.emit("notification", { kind, ...payload });
}
```

(b) `runSubAgent` 需要拿到 `ctx.hooks`——给它的 `opts` 加一个 `hooks?: HookRegistry` 字段，由两个 `agentTool` 调用处（同步 :304 / 后台 :196）都传 `ctx?.hooks`。在 `runSubAgent` 内：
- 起始（emit `agent_start` 之后）：`emitSubAgentHook(opts.hooks, "subagent_start", { agentId, description })`
- 成功（return finalText 前）：`emitSubAgentHook(opts.hooks, "subagent_finish", { agentId, description, text: finalText })`

错误事件（`subagent_error`）在**同步路径的 catch**（Task 9 改造后的那段，:312 附近）里 emit，而不是 `runSubAgent` 内部——因为超时/abort 的错误是在 `runSubAgent` 之外被 `runWithTimeout` 捕获的：
```ts
  } catch (err) {
    emitSubAgentHook(ctx?.hooks, "subagent_error", { agentId, description, error: (err as Error).message });
    safeEmit(parentStream, { type: "agent_end", agentId, name, description, error: (err as Error).message });
    ...
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/core && bun run vitest run tests/tool-system/agent-lifecycle-hooks.test.ts && bun run tsc --noEmit`
Expected: PASS（2 用例）+ 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tool-system/builtin/agent.ts packages/core/tests/tool-system/agent-lifecycle-hooks.test.ts
git commit -m "feat(core): emit sub-agent lifecycle hooks (start/finish/error)"
```

---

## Task 11: 端到端校验 + 样例角色 + 文档

**Files:**
- Create: `.code-shell/agents/researcher.md`（仓库自带样例角色）
- Modify: `docs/tool-system-architecture.md`（补 sub-agent 角色定义一节）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 全量测试 + 类型检查 + lint**

Run: `cd packages/core && bun run vitest run && bun run tsc --noEmit`
然后在仓库根：`bun run lint`（按 package.json 实际 script 名）
Expected: 全绿。若有失败，定位到对应 Task 修复后再继续，不要带着红测试往下走。

- [ ] **Step 2: 写一个样例角色**

```markdown
<!-- .code-shell/agents/researcher.md -->
---
name: researcher
description: Read-only codebase research — investigates and reports, never edits
model: flash
maxTurns: 10
tools:
  - Read
  - Grep
  - Glob
  - WebSearch
---
You are a research sub-agent. Investigate the question thoroughly using read-only
tools and report findings concisely (file:line references where relevant). You
must not modify any files. Return a focused summary, not a transcript.
```

- [ ] **Step 3: 手动冒烟验证（真实跑一次）**

在 REPL/CLI 里：先确认 settings 的 modelPool 有 `flash` 这个 key（没有就先在 settings 加一个指向便宜模型的条目）。然后让主 agent 跑 `Agent(agent_type="researcher", description="find X", prompt="...")`，确认：
1. 子 agent 用的是 flash（看 cost-tracker / 日志里的 model）
2. 子 agent 不能调 Edit/Write/Bash（工具白名单生效）
3. 结果正常回传

把观察结果记到 commit message 或 PR 描述里。**这一步不能用单测替代**——必须真实跑一次。

- [ ] **Step 4: 更新文档 + CHANGELOG**

在 `docs/tool-system-architecture.md` 加一节 "Reusable sub-agent roles (.code-shell/agents)"，说明 frontmatter 字段、`agent_type` 用法、与临时模式的关系、并发上限/超时/hooks。`CHANGELOG.md` 顶部加对应条目。

- [ ] **Step 5: 提交**

```bash
git add .code-shell/agents/researcher.md docs/tool-system-architecture.md CHANGELOG.md
git commit -m "docs(core): sub-agent roles + sample researcher role + changelog"
```

---

## Self-Review 备注

- **Spec 覆盖**：P0（注册表）= Task 1/2/6/7；P1 工具白名单 = Task 5；P1 模型路由 = Task 3/4；P1 并发/超时 = Task 8/9；P2 hooks = Task 10。流式化与自动委派已明确 out-of-scope。
- **类型一致性**：`SubAgentSpawnRequest` 在 Task 3 加 `model`/`toolAllowlist`，Task 6 再加 `appendSystemPrompt`/`signal`（signal 已有）；`resolveChildLlm`/`resolveChildToolScope`/`resolveAgentTypeOverrides` 三个纯函数命名全程一致。
- **落地前必读的真实签名**（计划用占位、动手时核对）：`AsyncAgentEntry` 的真实字段名（register 入参形状）；`EngineConfig` 里 cwd 字段名；`LLMConfig` 的 import 路径；package.json 里 vitest/lint/tsc 的实际 script 名。

### Review 修正记录（v2，对照真实源码后）

第一版计划对着真实源码 review 后修了 5 处，已并入上文对应任务：

1. **Task 10 hook 事件名**：`HookEventName`（events.ts:76）是封闭 union，不能凭空 emit `"subagent_start"`（会编译报错）。改为复用现有 `"notification"` 事件 + `kind` 字段，对齐后台路径 agent.ts:240 的既有模式，零 schema 改动。
2. **`emit` 是 async + registry 没有 `remove`**：`emitSubAgentHook` 用 `void hooks?.emit(...)` fire-and-forget；Task 8 测试隔离改用新增的 `clearAll()`（registry 原本只有 `list`/`markCompleted`/`hasRunning`，无 `remove`），`runningCount()` 也是新增。
3. **Task 6 后台路径透传**：overrides（model/toolAllowlist/appendSystemPrompt）必须在**两个** `runSubAgent` 调用点（同步 :304 + 后台 :196）都传；漏掉后台路径会让 `agent_type + run_in_background` 静默丢角色配置——已显式点名。
4. **Task 9 超时范围**：只加在**同步路径**。后台路径不加——否则超时走 `controller.abort()` 会被 :249 误判成"用户取消"而静默不通知。
5. **Task 1 YAML 解析**：core 已有 `yaml@^2.7.0` 依赖，直接用，删掉手写 `parseSimpleYaml`（不支持内联数组/注释/转义的技术债）。

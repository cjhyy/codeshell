# Composition Phase A Implementation Plan（Compiler 与 golden 基线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地设计稿 `docs/todo/agent-module-resolved-composition-design.md` 的 Phase A——新增 `AgentModule` 类型、纯函数 `compileComposition()`、可序列化 snapshot/digest，并从现行旧路径生成 golden 基线，证明 Compiler 能无损复现当前 Core+Coding+Arena+Pet 组合。**无任何生产路径行为变化。**

**Architecture:** 全部新代码放 `packages/core/src/composition/`（internal，不进公开导出面）。Compiler 是纯函数：输入 `AgentModule[]`，输出冻结的 `ResolvedComposition`，冲突一律抛 `CompositionError`。golden 测试放根 `tests/`，用测试目录内的临时桥接函数把现有 `CapabilityModule`/`ExtensionModule` 喂给 Compiler，与旧路径转储对比。

**Tech Stack:** TypeScript ESM、bun test、node:crypto sha256。

**与设计稿的两处有意偏差**（实现阶段微调，语义不变，落地后回写设计稿）：
1. `activateHost`/`activateEngine`/`privateService`/`LifetimeScope` 属 Phase C，本阶段不建；`createToolService` 原样保留为 engine contribution 字段，Phase C 再改名 `privateService`。
2. hook 规范化名沿用现有 `capability:${id}:...` 前缀与 priority 20 缺省（保证 golden 逐项相等），改名是后续纯美化。

**执行纪律：**
- 工作树里有无关的未提交改动（cdp/updater 等），**每次 commit 只 `git add` 本计划点名的文件**，禁止 `git add -A`。
- 在 `agent-module-composition` 分支上工作。
- 不跑 `bun run format`；只对改过的文件跑 prettier。

---

### Task 0: 建分支

- [ ] **Step 1: 从 main 建分支**

```bash
git checkout -b agent-module-composition
```

预期：`Switched to a new branch 'agent-module-composition'`（无关脏文件跟随，不理会）。

---

### Task 1: CompositionError 与 composition 类型

**Files:**
- Modify: `packages/core/src/exceptions.ts`（在 ConfigError 块后追加）
- Create: `packages/core/src/composition/types.ts`

- [ ] **Step 1: exceptions.ts 追加 CompositionError**

在 `ConfigError` 类定义之后（`// ─── Sandbox Errors` 之前）插入：

```ts
/**
 * Thrown by compileComposition() on any conflicting or invalid module
 * contribution. Structured details carry at least { code, key } plus the
 * owning module ids so hosts can render actionable errors.
 */
export class CompositionError extends FrameworkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "CompositionError";
  }
}
```

- [ ] **Step 2: 创建 composition/types.ts**

```ts
/**
 * AgentModule — the single trusted product-module interface that unifies
 * CapabilityModule and ExtensionModule (design:
 * docs/todo/agent-module-resolved-composition-design.md). Phase A only adds
 * the types and the pure compiler; no production path consumes them yet.
 */
import type {
  CapabilityArtifactDetector,
  CapabilityDynamicContextProvider,
  CapabilityEngineHookContribution,
  CapabilityFileHistoryContribution,
  CapabilityInstructionBoundaryFinder,
  CapabilityModule,
  SessionWorkspaceCapability,
} from "../capabilities/index.js";
import type { AgentPreset } from "../preset/index.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type {
  ExtensionQueryHandler,
  ExtensionTool,
  ProtocolObserver,
  ProtocolObserverHost,
} from "../tool-system/capability-module.js";
import type { RunBehaviorProfile } from "../engine/run-types.js";
import type { HookEventName } from "../hooks/events.js";

/**
 * One tool contribution with explicit exposure:
 * - "preset-tags": full BuiltinTool metadata; joins the composed catalog.
 * - "always": plain ExtensionTool; registered directly, always visible.
 */
export type AgentModuleToolContribution =
  | { readonly kind: "preset-tags"; readonly tool: BuiltinTool }
  | { readonly kind: "always"; readonly tool: ExtensionTool };

export interface AgentEngineContributions {
  readonly tools?: readonly AgentModuleToolContribution[];
  readonly presets?: readonly AgentPreset[];
  /** Preset used when the host does not choose one. At most one module may declare it. */
  readonly defaultPreset?: string;
  readonly promptSections?: Readonly<Record<string, string>>;
  readonly dynamicContextProviders?: readonly CapabilityDynamicContextProvider[];
  readonly instructionBoundary?: CapabilityInstructionBoundaryFinder;
  readonly artifactDetectors?: readonly CapabilityArtifactDetector[];
  readonly fileHistory?: readonly CapabilityFileHistoryContribution[];
  readonly sessionWorkspace?: SessionWorkspaceCapability;
  readonly hooks?: readonly CapabilityEngineHookContribution[];
  readonly behaviorProfiles?: readonly RunBehaviorProfile[];
  readonly adjustToolSelection?: CapabilityModule["adjustToolSelection"];
  /** Phase C renames this to privateService with owned lifetime. */
  readonly createToolService?: CapabilityModule["createToolService"];
}

export interface AgentProtocolContributions {
  readonly queries?: Readonly<Record<string, ExtensionQueryHandler>>;
  /** Existing name createProtocolObserver; renamed here by design. */
  readonly createObserver?: (host: ProtocolObserverHost) => ProtocolObserver;
  readonly validateRunParams?: (params: Record<string, unknown>) => string | null;
  readonly hiddenSessionKinds?: readonly string[];
}

export interface AgentModule {
  readonly id: string;
  readonly engine?: AgentEngineContributions;
  readonly protocol?: AgentProtocolContributions;
}

// ─── Resolved composition ────────────────────────────────────────

export interface ResolvedModule {
  readonly id: string;
  readonly order: number;
  readonly source: "core" | "host";
}

export interface ResolvedContribution<T> {
  readonly key: string;
  readonly moduleId: string;
  readonly value: T;
}

export type ResolvedToolContribution =
  | { readonly kind: "preset-tags"; readonly moduleId: string; readonly tool: BuiltinTool }
  | { readonly kind: "always"; readonly moduleId: string; readonly tool: ExtensionTool };

export interface ResolvedEngineHook {
  readonly moduleId: string;
  readonly event: HookEventName;
  readonly handler: CapabilityEngineHookContribution["handler"];
  readonly priority: number;
  readonly name: string;
}

export interface ResolvedEngineComposition {
  /**
   * Effective registry order: every preset-tags tool (module order) first,
   * then every always tool (module order) — mirrors the current engine's
   * composeToolCatalog() + registerExtensionModules() sequence.
   */
  readonly tools: readonly ResolvedToolContribution[];
  readonly presets: readonly ResolvedContribution<AgentPreset>[];
  readonly defaultPreset: string;
  readonly promptSections: readonly ResolvedContribution<string>[];
  readonly dynamicContextProviders: readonly ResolvedContribution<CapabilityDynamicContextProvider>[];
  readonly instructionBoundaries: readonly ResolvedContribution<CapabilityInstructionBoundaryFinder>[];
  readonly artifactDetectors: readonly ResolvedContribution<CapabilityArtifactDetector>[];
  readonly fileHistory: readonly ResolvedContribution<CapabilityFileHistoryContribution>[];
  readonly sessionWorkspaces: readonly ResolvedContribution<SessionWorkspaceCapability>[];
  readonly hooks: readonly ResolvedEngineHook[];
  readonly behaviorProfiles: readonly ResolvedContribution<RunBehaviorProfile>[];
  readonly toolSelectionAdjusters: readonly ResolvedContribution<
    NonNullable<CapabilityModule["adjustToolSelection"]>
  >[];
  readonly toolServices: readonly ResolvedContribution<
    NonNullable<CapabilityModule["createToolService"]>
  >[];
}

export interface ResolvedProtocolComposition {
  readonly queries: readonly ResolvedContribution<ExtensionQueryHandler>[];
  readonly observerFactories: readonly ResolvedContribution<
    (host: ProtocolObserverHost) => ProtocolObserver
  >[];
  readonly runValidators: readonly ResolvedContribution<
    (params: Record<string, unknown>) => string | null
  >[];
  readonly hiddenSessionKinds: readonly ResolvedContribution<string>[];
}

export interface CompositionDiagnostic {
  readonly code: "empty_module" | "engine_only_module" | "protocol_only_module";
  readonly moduleId: string;
  readonly message: string;
}

export interface ResolvedComposition {
  readonly version: 1;
  readonly digest: string;
  readonly modules: readonly ResolvedModule[];
  readonly engine: ResolvedEngineComposition;
  readonly protocol: ResolvedProtocolComposition;
  readonly diagnostics: readonly CompositionDiagnostic[];
}

export interface CompileCompositionOptions {
  /** Defaults to CORE_AGENT_MODULE. Overridable only for unit tests. */
  readonly core?: AgentModule;
  readonly modules?: readonly AgentModule[];
  /** Module ids the host requires; missing ids are a compile error. */
  readonly expectedModules?: readonly string[];
}

// ─── Serializable snapshot ───────────────────────────────────────

/** Pure-data projection; never contains functions, prompt bodies or paths. */
export interface CompositionSnapshot {
  version: 1;
  modules: Array<{ id: string; order: number; source: string }>;
  tools: Array<{
    name: string;
    moduleId: string;
    exposure: "preset-tags" | "always";
    presetTags: string[];
  }>;
  presets: Array<{ name: string; moduleId: string; isDefault: boolean }>;
  promptSections: Array<{ name: string; moduleId: string }>;
  hooks: Array<{ event: string; name: string; priority: number; moduleId: string }>;
  behaviorProfiles: Array<{ id: string; moduleId: string }>;
  queries: Array<{ type: string; moduleId: string }>;
  observers: string[];
  runValidators: string[];
  hiddenSessionKinds: Array<{ kind: string; moduleId: string }>;
}
```

- [ ] **Step 3: 确认无编译错误（借用后续测试，先跑现有 core 套件保证没碰坏东西）**

Run: `bun test packages/core/src/tool-system/capability-module 2>/dev/null; bun test tests/capabilities.test.ts`
Expected: PASS（纯类型新增不影响现有测试）

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/exceptions.ts packages/core/src/composition/types.ts
git commit -m "feat(core): add AgentModule and ResolvedComposition types (composition Phase A)"
```

---

### Task 2: CORE_AGENT_MODULE

**Files:**
- Create: `packages/core/src/composition/core-module.ts`
- Test: `packages/core/src/composition/core-module.test.ts`

- [ ] **Step 1: 写失败测试 core-module.test.ts**

```ts
import { describe, expect, test } from "bun:test";
import { CORE_AGENT_MODULE } from "./core-module.js";
import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import {
  ISOLATED_TASK_PROFILE,
  QUICK_CHAT_RESTRICTED_PROFILE,
} from "../engine/run-types.js";

describe("CORE_AGENT_MODULE", () => {
  test("mirrors BUILTIN_TOOLS in order as preset-tags tools", () => {
    const tools = CORE_AGENT_MODULE.engine?.tools ?? [];
    expect(tools.map((t) => t.tool.definition.name)).toEqual(
      BUILTIN_TOOLS.map((t) => t.definition.name),
    );
    expect(tools.every((t) => t.kind === "preset-tags")).toBe(true);
  });

  test("mirrors builtin presets and declares no defaultPreset", () => {
    expect(CORE_AGENT_MODULE.engine?.presets).toEqual(
      Object.values(BUILTIN_AGENT_PRESETS),
    );
    expect(CORE_AGENT_MODULE.engine?.defaultPreset).toBeUndefined();
  });

  test("carries the two core behavior profiles in engine order", () => {
    expect(CORE_AGENT_MODULE.engine?.behaviorProfiles).toEqual([
      QUICK_CHAT_RESTRICTED_PROFILE,
      ISOLATED_TASK_PROFILE,
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/src/composition/core-module.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 core-module.ts**

```ts
import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import {
  ISOLATED_TASK_PROFILE,
  QUICK_CHAT_RESTRICTED_PROFILE,
} from "../engine/run-types.js";
import type { AgentModule } from "./types.js";

/**
 * Core's own declarations expressed as a module so one compiler handles a
 * single data path. This does NOT make core unloadable or overridable —
 * it is always module order 0 and duplicate keys against it fail loud.
 *
 * No defaultPreset here: the compiler falls back to DEFAULT_AGENT_PRESET
 * only when no product module declares one (mirrors resolveAgentPreset).
 */
export const CORE_AGENT_MODULE: AgentModule = {
  id: "core",
  engine: {
    tools: BUILTIN_TOOLS.map((tool) => ({ kind: "preset-tags" as const, tool })),
    presets: Object.values(BUILTIN_AGENT_PRESETS),
    behaviorProfiles: [QUICK_CHAT_RESTRICTED_PROFILE, ISOLATED_TASK_PROFILE],
  },
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/core/src/composition/core-module.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/composition/core-module.ts packages/core/src/composition/core-module.test.ts
git commit -m "feat(core): express core builtins as CORE_AGENT_MODULE"
```

---

### Task 3: compileComposition —— 模块注册、顺序、expectedModules

**Files:**
- Create: `packages/core/src/composition/compiler.ts`
- Test: `packages/core/src/composition/compiler.test.ts`

- [ ] **Step 1: 写失败测试（模块层校验）**

```ts
import { describe, expect, test } from "bun:test";
import { compileComposition } from "./compiler.js";
import { CompositionError } from "../exceptions.js";
import type { AgentModule } from "./types.js";

const emptyModule = (id: string): AgentModule => ({ id });

describe("compileComposition module validation", () => {
  test("core is order 0, host modules follow input order", () => {
    const result = compileComposition({
      modules: [emptyModule("alpha"), emptyModule("beta")],
    });
    expect(result.modules).toEqual([
      { id: "core", order: 0, source: "core" },
      { id: "alpha", order: 1, source: "host" },
      { id: "beta", order: 2, source: "host" },
    ]);
  });

  test("duplicate module id fails loud with both owners", () => {
    expect(() =>
      compileComposition({ modules: [emptyModule("alpha"), emptyModule("alpha")] }),
    ).toThrow(CompositionError);
  });

  test("invalid module id format fails loud", () => {
    expect(() => compileComposition({ modules: [emptyModule("Bad Id!")] })).toThrow(
      CompositionError,
    );
  });

  test("missing expected module fails loud", () => {
    expect(() =>
      compileComposition({ modules: [emptyModule("alpha")], expectedModules: ["pet"] }),
    ).toThrow(/pet/);
  });

  test("empty host module produces an empty_module diagnostic", () => {
    const result = compileComposition({ modules: [emptyModule("alpha")] });
    expect(result.diagnostics).toContainEqual({
      code: "empty_module",
      moduleId: "alpha",
      message: 'Module "alpha" declares no contributions',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/src/composition/compiler.test.ts`
Expected: FAIL（compiler.ts 不存在）

- [ ] **Step 3: 实现 compiler.ts 骨架（本任务只到模块层，贡献收集在 Task 4 补全）**

```ts
import { CompositionError } from "../exceptions.js";
import { DEFAULT_AGENT_PRESET } from "../preset/index.js";
import { CORE_AGENT_MODULE } from "./core-module.js";
import type {
  AgentModule,
  CompileCompositionOptions,
  CompositionDiagnostic,
  ResolvedComposition,
  ResolvedModule,
} from "./types.js";

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

interface RegisteredModule {
  readonly module: AgentModule;
  readonly resolved: ResolvedModule;
}

function registerModules(options: CompileCompositionOptions): RegisteredModule[] {
  const core = options.core ?? CORE_AGENT_MODULE;
  const registered: RegisteredModule[] = [];
  const seen = new Set<string>();
  const push = (module: AgentModule, source: "core" | "host"): void => {
    if (!MODULE_ID_PATTERN.test(module.id)) {
      throw new CompositionError(`Invalid module id: "${module.id}"`, {
        code: "invalid_module_id",
        key: module.id,
      });
    }
    if (seen.has(module.id)) {
      throw new CompositionError(`Duplicate module id: "${module.id}"`, {
        code: "duplicate_module",
        key: module.id,
      });
    }
    seen.add(module.id);
    registered.push({
      module,
      resolved: { id: module.id, order: registered.length, source },
    });
  };
  push(core, "core");
  for (const module of options.modules ?? []) push(module, "host");
  for (const id of options.expectedModules ?? []) {
    if (!seen.has(id)) {
      throw new CompositionError(`Expected module "${id}" is missing`, {
        code: "missing_expected_module",
        key: id,
      });
    }
  }
  return registered;
}

function moduleDiagnostics(registered: RegisteredModule[]): CompositionDiagnostic[] {
  const diagnostics: CompositionDiagnostic[] = [];
  for (const { module, resolved } of registered) {
    if (resolved.source === "core") continue;
    const hasEngine = module.engine !== undefined;
    const hasProtocol = module.protocol !== undefined;
    if (!hasEngine && !hasProtocol) {
      diagnostics.push({
        code: "empty_module",
        moduleId: module.id,
        message: `Module "${module.id}" declares no contributions`,
      });
    } else if (!hasProtocol) {
      diagnostics.push({
        code: "engine_only_module",
        moduleId: module.id,
        message: `Module "${module.id}" contributes engine surface only`,
      });
    } else if (!hasEngine) {
      diagnostics.push({
        code: "protocol_only_module",
        moduleId: module.id,
        message: `Module "${module.id}" contributes protocol surface only`,
      });
    }
  }
  return diagnostics;
}

export function compileComposition(
  options: CompileCompositionOptions = {},
): ResolvedComposition {
  const registered = registerModules(options);
  const diagnostics = moduleDiagnostics(registered);
  // Task 4 fills in contribution collection; Task 5 fills in snapshot/digest.
  throw new Error("not implemented");
}
```

（本任务结束时 `compileComposition` 仍未完成——先把 Task 4 的收集函数与 Task 5 的 digest 实现完，Step 4 的测试才能全绿。**Task 3/4/5 是同一个函数的三段，Task 5 结束才 commit。**）

- [ ] **Step 4: 进入 Task 4（不单独 commit）**

---

### Task 4: compileComposition —— 贡献收集与冲突校验

**Files:**
- Modify: `packages/core/src/composition/compiler.ts`
- Test: `packages/core/src/composition/compiler.test.ts`（追加）

- [ ] **Step 1: 追加失败测试（贡献层校验）**

```ts
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type { ExtensionTool } from "../tool-system/capability-module.js";
import type { AgentPreset } from "../preset/index.js";

const presetTagsTool = (name: string): { kind: "preset-tags"; tool: BuiltinTool } => ({
  kind: "preset-tags",
  tool: {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    execute: async () => ({ ok: true }),
    exposure: { presetTags: ["general"] },
  } as unknown as BuiltinTool,
});

const alwaysTool = (name: string): { kind: "always"; tool: ExtensionTool } => ({
  kind: "always",
  tool: {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    execute: async () => ({}),
  } as unknown as ExtensionTool,
});

const preset = (name: string): AgentPreset => ({
  name,
  label: name,
  description: name,
  promptSections: [],
  builtinTools: [],
  defaultPermissionRules: [],
});

describe("compileComposition contributions", () => {
  test("tool order is preset-tags (module order) then always (module order)", () => {
    const result = compileComposition({
      modules: [
        { id: "alpha", engine: { tools: [alwaysTool("A1"), presetTagsTool("A2")] } },
        { id: "beta", engine: { tools: [presetTagsTool("B1")] } },
      ],
    });
    const names = result.engine.tools.map((t) => t.tool.definition.name);
    const alphaIdx = names.indexOf("A2");
    const betaIdx = names.indexOf("B1");
    const alwaysIdx = names.indexOf("A1");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    expect(alwaysIdx).toBeGreaterThan(betaIdx); // always tools after every preset-tags tool
  });

  test("duplicate tool name across modules fails with both owners", () => {
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { tools: [presetTagsTool("Dup")] } },
          { id: "beta", engine: { tools: [alwaysTool("Dup")] } },
        ],
      }),
    ).toThrow(CompositionError);
    try {
      compileComposition({
        modules: [
          { id: "alpha", engine: { tools: [presetTagsTool("Dup")] } },
          { id: "beta", engine: { tools: [alwaysTool("Dup")] } },
        ],
      });
    } catch (error) {
      const details = (error as CompositionError).details;
      expect(details).toMatchObject({
        code: "duplicate_tool",
        key: "Dup",
        firstModuleId: "alpha",
        secondModuleId: "beta",
      });
    }
  });

  test("duplicate tool against core builtin fails", () => {
    expect(() =>
      compileComposition({ modules: [{ id: "alpha", engine: { tools: [presetTagsTool("Read")] } }] }),
    ).toThrow(/Read/);
  });

  test("conflicting default presets fail; single wins; none falls back to harness-min", () => {
    expect(
      compileComposition({
        modules: [{ id: "alpha", engine: { presets: [preset("p1")], defaultPreset: "p1" } }],
      }).engine.defaultPreset,
    ).toBe("p1");
    expect(compileComposition({}).engine.defaultPreset).toBe("harness-min");
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { presets: [preset("p1")], defaultPreset: "p1" } },
          { id: "beta", engine: { presets: [preset("p2")], defaultPreset: "p2" } },
        ],
      }),
    ).toThrow(CompositionError);
  });

  test("default preset must exist among resolved presets", () => {
    expect(() =>
      compileComposition({ modules: [{ id: "alpha", engine: { defaultPreset: "ghost" } }] }),
    ).toThrow(/ghost/);
  });

  test("preset builtinTools must reference known preset-tags tools", () => {
    expect(() =>
      compileComposition({
        modules: [
          {
            id: "alpha",
            engine: { presets: [{ ...preset("p1"), builtinTools: ["NoSuchTool"] }] },
          },
        ],
      }),
    ).toThrow(/NoSuchTool/);
  });

  test("duplicate preset / prompt section / behavior profile / query / hidden kind fail", () => {
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { presets: [preset("p")] } },
          { id: "beta", engine: { presets: [preset("p")] } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { promptSections: { s: "a" } } },
          { id: "beta", engine: { promptSections: { s: "b" } } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", engine: { behaviorProfiles: [{ id: "bp" }] } },
          { id: "beta", engine: { behaviorProfiles: [{ id: "bp" }] } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", protocol: { queries: { q: () => null } } },
          { id: "beta", protocol: { queries: { q: () => null } } },
        ],
      }),
    ).toThrow(CompositionError);
    expect(() =>
      compileComposition({
        modules: [
          { id: "alpha", protocol: { hiddenSessionKinds: ["k"] } },
          { id: "beta", protocol: { hiddenSessionKinds: ["k"] } },
        ],
      }),
    ).toThrow(CompositionError);
  });

  test("hooks get capability-prefixed deterministic names and priority 20 default", () => {
    const handler = async () => ({});
    const result = compileComposition({
      modules: [
        {
          id: "alpha",
          engine: {
            hooks: [
              { event: "on_stop", handler },
              { event: "pre_tool_use", handler, name: "named", priority: 5 },
            ],
          },
        },
      ],
    });
    expect(result.engine.hooks).toEqual([
      { moduleId: "alpha", event: "on_stop", handler, priority: 20, name: "capability:alpha:on_stop:0" },
      { moduleId: "alpha", event: "pre_tool_use", handler, priority: 5, name: "capability:alpha:named" },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/src/composition/compiler.test.ts`
Expected: FAIL（not implemented）

- [ ] **Step 3: 补全 compiler.ts 的贡献收集**

把 `compileComposition` 的 `throw new Error("not implemented")` 替换为：

```ts
  const engine = collectEngine(registered);
  const protocol = collectProtocol(registered);
  const composition: ResolvedComposition = Object.freeze({
    version: 1 as const,
    digest: "", // Task 5 replaces this with the snapshot digest.
    modules: Object.freeze(registered.map((r) => r.resolved)),
    engine,
    protocol,
    diagnostics: Object.freeze(diagnostics),
  });
  return composition;
```

并在文件内新增（完整实现）：

```ts
function duplicate(
  kind: string,
  key: string,
  firstModuleId: string,
  secondModuleId: string,
): CompositionError {
  return new CompositionError(
    `Duplicate ${kind} "${key}" contributed by "${firstModuleId}" and "${secondModuleId}"`,
    { code: `duplicate_${kind.replaceAll(" ", "_")}`, key, firstModuleId, secondModuleId },
  );
}

/** Collect keyed contributions across modules, failing loud on duplicates. */
function collectKeyed<T>(
  registered: RegisteredModule[],
  kind: string,
  pick: (module: AgentModule) => ReadonlyArray<readonly [string, T]>,
): ResolvedContribution<T>[] {
  const owners = new Map<string, string>();
  const collected: ResolvedContribution<T>[] = [];
  for (const { module } of registered) {
    for (const [key, value] of pick(module)) {
      const owner = owners.get(key);
      if (owner !== undefined) throw duplicate(kind, key, owner, module.id);
      owners.set(key, module.id);
      collected.push({ key, moduleId: module.id, value });
    }
  }
  return collected;
}

function collectEngine(registered: RegisteredModule[]): ResolvedEngineComposition {
  // Tools: preset-tags join the composed catalog (module order), always tools
  // are appended afterwards — mirroring composeToolCatalog() followed by
  // registerExtensionModules() in the current engine constructor.
  const toolOwners = new Map<string, string>();
  const presetTagTools: ResolvedToolContribution[] = [];
  const alwaysTools: ResolvedToolContribution[] = [];
  for (const { module } of registered) {
    for (const contribution of module.engine?.tools ?? []) {
      const name = contribution.tool.definition.name;
      const owner = toolOwners.get(name);
      if (owner !== undefined) throw duplicate("tool", name, owner, module.id);
      toolOwners.set(name, module.id);
      if (contribution.kind === "preset-tags") {
        presetTagTools.push({ kind: "preset-tags", moduleId: module.id, tool: contribution.tool });
      } else {
        alwaysTools.push({ kind: "always", moduleId: module.id, tool: contribution.tool });
      }
    }
  }
  const tools = [...presetTagTools, ...alwaysTools];

  const presets = collectKeyed(registered, "preset", (m) =>
    (m.engine?.presets ?? []).map((p) => [p.name, p] as const),
  );

  // Default preset: at most one distinct declaration wins; none → core default.
  let defaultPreset: { name: string; moduleId: string } | undefined;
  for (const { module } of registered) {
    const declared = module.engine?.defaultPreset;
    if (!declared) continue;
    if (defaultPreset && defaultPreset.name !== declared) {
      throw new CompositionError(
        `Conflicting default presets: "${defaultPreset.name}" (${defaultPreset.moduleId}) vs "${declared}" (${module.id})`,
        {
          code: "conflicting_default_preset",
          key: declared,
          firstModuleId: defaultPreset.moduleId,
          secondModuleId: module.id,
        },
      );
    }
    defaultPreset ??= { name: declared, moduleId: module.id };
  }
  const defaultPresetName = defaultPreset?.name ?? DEFAULT_AGENT_PRESET;
  if (!presets.some((p) => p.key === defaultPresetName)) {
    throw new CompositionError(`Default preset "${defaultPresetName}" is not contributed`, {
      code: "unknown_default_preset",
      key: defaultPresetName,
      firstModuleId: defaultPreset?.moduleId ?? "core",
    });
  }

  // Preset tool references must resolve to preset-tags tools.
  const presetTagToolNames = new Set(presetTagTools.map((t) => t.tool.definition.name));
  for (const { key, moduleId, value } of presets) {
    for (const toolName of value.builtinTools) {
      if (!presetTagToolNames.has(toolName)) {
        throw new CompositionError(
          `Preset "${key}" references unknown tool "${toolName}"`,
          { code: "unknown_preset_tool", key: toolName, firstModuleId: moduleId },
        );
      }
    }
  }

  const promptSections = collectKeyed(registered, "prompt section", (m) =>
    Object.entries(m.engine?.promptSections ?? {}),
  );
  const behaviorProfiles = collectKeyed(registered, "behavior profile", (m) =>
    (m.engine?.behaviorProfiles ?? []).map((p) => [p.id, p] as const),
  );

  const hooks: ResolvedEngineHook[] = registered.flatMap(({ module }) =>
    (module.engine?.hooks ?? []).map((hook, index) => ({
      moduleId: module.id,
      event: hook.event,
      handler: hook.handler,
      priority: hook.priority ?? 20,
      name: `capability:${module.id}:${hook.name ?? `${hook.event}:${index}`}`,
    })),
  );

  const single = <T>(pick: (m: AgentModule) => T | undefined): ResolvedContribution<T>[] =>
    registered.flatMap(({ module }) => {
      const value = pick(module);
      return value === undefined ? [] : [{ key: module.id, moduleId: module.id, value }];
    });
  const many = <T>(pick: (m: AgentModule) => readonly T[] | undefined): ResolvedContribution<T>[] =>
    registered.flatMap(({ module }) =>
      (pick(module) ?? []).map((value, index) => ({
        key: `${module.id}:${index}`,
        moduleId: module.id,
        value,
      })),
    );

  return {
    tools,
    presets,
    defaultPreset: defaultPresetName,
    promptSections,
    dynamicContextProviders: many((m) => m.engine?.dynamicContextProviders),
    instructionBoundaries: single((m) => m.engine?.instructionBoundary),
    artifactDetectors: many((m) => m.engine?.artifactDetectors),
    fileHistory: many((m) => m.engine?.fileHistory),
    sessionWorkspaces: single((m) => m.engine?.sessionWorkspace),
    hooks,
    behaviorProfiles,
    toolSelectionAdjusters: single((m) => m.engine?.adjustToolSelection),
    toolServices: single((m) => m.engine?.createToolService),
  };
}

function collectProtocol(registered: RegisteredModule[]): ResolvedProtocolComposition {
  const queries = collectKeyed(registered, "query", (m) =>
    Object.entries(m.protocol?.queries ?? {}),
  );
  const hiddenSessionKinds = collectKeyed(registered, "hidden session kind", (m) =>
    (m.protocol?.hiddenSessionKinds ?? []).map((k) => [k, k] as const),
  );
  const single = <T>(pick: (m: AgentModule) => T | undefined): ResolvedContribution<T>[] =>
    registered.flatMap(({ module }) => {
      const value = pick(module);
      return value === undefined ? [] : [{ key: module.id, moduleId: module.id, value }];
    });
  return {
    queries,
    observerFactories: single((m) => m.protocol?.createObserver),
    runValidators: single((m) => m.protocol?.validateRunParams),
    hiddenSessionKinds,
  };
}
```

补相应 import：`ResolvedContribution`、`ResolvedEngineComposition`、`ResolvedProtocolComposition`、`ResolvedToolContribution`、`ResolvedEngineHook`。

- [ ] **Step 4: 跑测试（除 digest 相关外应全绿）→ 进入 Task 5**

Run: `bun test packages/core/src/composition/compiler.test.ts`
Expected: PASS（Task 3+4 的所有测试）

---

### Task 5: snapshot 与 digest

**Files:**
- Create: `packages/core/src/composition/snapshot.ts`
- Test: `packages/core/src/composition/snapshot.test.ts`
- Modify: `packages/core/src/composition/compiler.ts`（接入 digest）
- Create: `packages/core/src/composition/index.ts`

- [ ] **Step 1: 写失败测试 snapshot.test.ts**

```ts
import { describe, expect, test } from "bun:test";
import { compileComposition } from "./compiler.js";
import { toCompositionSnapshot, computeCompositionDigest } from "./snapshot.js";

describe("composition snapshot and digest", () => {
  test("same input produces byte-identical snapshot and digest", () => {
    const a = compileComposition({});
    const b = compileComposition({});
    expect(JSON.stringify(toCompositionSnapshot(a))).toBe(
      JSON.stringify(toCompositionSnapshot(b)),
    );
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("module order change changes the digest", () => {
    const modA = { id: "alpha", protocol: { hiddenSessionKinds: ["a"] } };
    const modB = { id: "beta", protocol: { hiddenSessionKinds: ["b"] } };
    const ab = compileComposition({ modules: [modA, modB] });
    const ba = compileComposition({ modules: [modB, modA] });
    expect(ab.digest).not.toBe(ba.digest);
  });

  test("snapshot contains no functions and result is frozen", () => {
    const composition = compileComposition({});
    const snapshot = toCompositionSnapshot(composition);
    const walk = (value: unknown): void => {
      expect(typeof value).not.toBe("function");
      if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(snapshot);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(composition.digest).toBe(computeCompositionDigest(snapshot));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/src/composition/snapshot.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 snapshot.ts**

```ts
import { createHash } from "node:crypto";
import type { CompositionSnapshot, ResolvedComposition } from "./types.js";

/**
 * Pure-data projection of a composition. Field construction order is the
 * canonical serialization order — computeCompositionDigest() hashes the
 * JSON directly, so never reorder fields without updating golden fixtures.
 * Unkeyed by design: the snapshot carries no secrets (design §11.2).
 */
export function toCompositionSnapshot(
  composition: Pick<ResolvedComposition, "modules" | "engine" | "protocol">,
): CompositionSnapshot {
  return {
    version: 1,
    modules: composition.modules.map((m) => ({ id: m.id, order: m.order, source: m.source })),
    tools: composition.engine.tools.map((t) => ({
      name: t.tool.definition.name,
      moduleId: t.moduleId,
      exposure: t.kind,
      presetTags: t.kind === "preset-tags" ? [...t.tool.exposure.presetTags] : [],
    })),
    presets: composition.engine.presets.map((p) => ({
      name: p.key,
      moduleId: p.moduleId,
      isDefault: p.key === composition.engine.defaultPreset,
    })),
    promptSections: composition.engine.promptSections.map((s) => ({
      name: s.key,
      moduleId: s.moduleId,
    })),
    hooks: composition.engine.hooks.map((h) => ({
      event: h.event,
      name: h.name,
      priority: h.priority,
      moduleId: h.moduleId,
    })),
    behaviorProfiles: composition.engine.behaviorProfiles.map((p) => ({
      id: p.key,
      moduleId: p.moduleId,
    })),
    queries: composition.protocol.queries.map((q) => ({ type: q.key, moduleId: q.moduleId })),
    observers: composition.protocol.observerFactories.map((o) => o.moduleId),
    runValidators: composition.protocol.runValidators.map((v) => v.moduleId),
    hiddenSessionKinds: composition.protocol.hiddenSessionKinds.map((k) => ({
      kind: k.key,
      moduleId: k.moduleId,
    })),
  };
}

export function computeCompositionDigest(snapshot: CompositionSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
```

- [ ] **Step 4: compiler.ts 接入 digest**

`compileComposition` 尾部改为：

```ts
  const draft = {
    version: 1 as const,
    modules: Object.freeze(registered.map((r) => r.resolved)),
    engine,
    protocol,
    diagnostics: Object.freeze(diagnostics),
  };
  const digest = computeCompositionDigest(toCompositionSnapshot(draft));
  return Object.freeze({ ...draft, digest });
```

并 import `toCompositionSnapshot, computeCompositionDigest`（snapshot.ts 只依赖 types，无循环）。

- [ ] **Step 5: 创建 composition/index.ts**

```ts
export * from "./types.js";
export { CORE_AGENT_MODULE } from "./core-module.js";
export { compileComposition } from "./compiler.js";
export { toCompositionSnapshot, computeCompositionDigest } from "./snapshot.js";
```

- [ ] **Step 6: 跑全部 composition 测试**

Run: `bun test packages/core/src/composition/`
Expected: PASS（Task 2-5 全部测试）

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/composition/compiler.ts packages/core/src/composition/compiler.test.ts packages/core/src/composition/snapshot.ts packages/core/src/composition/snapshot.test.ts packages/core/src/composition/index.ts
git commit -m "feat(core): pure composition compiler with snapshot digest"
```

---

### Task 6: golden 基线 —— 旧路径转储 + Compiler 对齐

**Files:**
- Create: `tests/helpers/composition-bridges.ts`（测试目录内的临时桥接，cutover 后删除）
- Create: `tests/composition-golden.test.ts`
- Create: `tests/fixtures/composition-golden.json`（由 UPDATE flag 生成）

- [ ] **Step 1: 确保产品包 dist 最新**

Run: `bun run build`
Expected: link/core/pet/arena/coding/... 依次构建成功（root tests 从 dist 消费产品包——记忆条目：改 core 后必须重建，否则测的是旧产物）。

- [ ] **Step 2: 写桥接 helpers（tests/helpers/composition-bridges.ts）**

```ts
/**
 * TEST-ONLY bridges from the legacy module interfaces to AgentModule.
 * Live here (not in src/) per design §12 Phase A; deleted at cutover.
 */
import type { CapabilityModule } from "../../packages/core/src/capabilities/index.js";
import type { ExtensionModule } from "../../packages/core/src/tool-system/capability-module.js";
import type { AgentModule } from "../../packages/core/src/composition/types.js";

export function fromCapabilityModule(capability: CapabilityModule): AgentModule {
  return {
    id: capability.id,
    engine: {
      tools: (capability.tools ?? []).map((tool) => ({ kind: "preset-tags" as const, tool })),
      presets: capability.presets,
      defaultPreset: capability.defaultPreset,
      promptSections: capability.promptSections,
      dynamicContextProviders: capability.dynamicContextProviders,
      instructionBoundary: capability.instructionBoundary,
      artifactDetectors: capability.artifactDetectors,
      fileHistory: capability.fileHistory,
      sessionWorkspace: capability.sessionWorkspace,
      hooks: capability.engineHooks,
      adjustToolSelection: capability.adjustToolSelection?.bind(capability),
      createToolService: capability.createToolService?.bind(capability),
    },
  };
}

export function fromExtensionModule(module: ExtensionModule): AgentModule {
  return {
    id: module.id,
    engine: {
      tools: [
        ...(module.catalogTools ?? []).map((tool) => ({ kind: "preset-tags" as const, tool })),
        ...(module.tools ?? []).map((tool) => ({ kind: "always" as const, tool })),
      ],
      behaviorProfiles: module.behaviorProfiles,
    },
    protocol: {
      queries: module.queries,
      createObserver: module.createProtocolObserver,
      validateRunParams: module.validateRunParams,
      hiddenSessionKinds: module.hiddenSessionKinds,
    },
  };
}
```

注意：coding/arena/pet 从 **dist** 导入，其类型与 core **src** 类型标称不同但结构兼容；桥接入参处用 `as unknown as CapabilityModule` 收窄（见 Step 3 用法），运行时结构一致。

- [ ] **Step 3: 写 golden 测试（tests/composition-golden.test.ts）**

```ts
/**
 * Composition golden baseline (design §12 Phase A).
 *
 * Dumps the CURRENT legacy composition path (composeToolCatalog +
 * registerExtensionModules order, composePromptSections,
 * composeCapabilityEngineHooks, resolveAgentPreset, engine behavior-profile
 * merge) for the real Core+Coding+Arena+Pet stack into a snapshot-shaped
 * object, asserts it equals the checked-in golden fixture, and asserts the
 * NEW compiler reproduces the same snapshot from bridged modules.
 *
 * Regenerate: UPDATE_COMPOSITION_GOLDEN=1 bun test tests/composition-golden.test.ts
 * (requires fresh dists: bun run build)
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_CAPABILITY } from "@cjhyy/code-shell-capability-coding";
import { createArenaCapability } from "@cjhyy/code-shell-arena";
import { createPetCapability } from "@cjhyy/code-shell-pet";
import { BUILTIN_TOOLS } from "../packages/core/src/tool-system/builtin/index.js";
import {
  composeCapabilityEngineHooks,
  composePromptSections,
  composeToolCatalog,
  type CapabilityModule,
} from "../packages/core/src/capabilities/index.js";
import {
  BUILTIN_AGENT_PRESETS,
  resolveAgentPreset,
} from "../packages/core/src/preset/index.js";
import {
  ISOLATED_TASK_PROFILE,
  QUICK_CHAT_RESTRICTED_PROFILE,
} from "../packages/core/src/engine/run-types.js";
import type { ExtensionModule } from "../packages/core/src/tool-system/capability-module.js";
import { compileComposition } from "../packages/core/src/composition/compiler.js";
import { toCompositionSnapshot } from "../packages/core/src/composition/snapshot.js";
import type { CompositionSnapshot } from "../packages/core/src/composition/types.js";
import { fromCapabilityModule, fromExtensionModule } from "./helpers/composition-bridges.js";

const GOLDEN_PATH = join(import.meta.dir, "fixtures", "composition-golden.json");

const coding = CODING_CAPABILITY as unknown as CapabilityModule;
const arena = createArenaCapability() as unknown as ExtensionModule;
const pet = createPetCapability() as unknown as ExtensionModule;
const capabilities = [coding];
const extensionModules = [arena, pet];

/** Snapshot of the legacy path, mirroring engine.ts construction order. */
function dumpLegacyComposition(): CompositionSnapshot {
  const catalog = composeToolCatalog(BUILTIN_TOOLS, capabilities, extensionModules);
  const builtinNames = new Set(BUILTIN_TOOLS.map((t) => t.definition.name));
  const codingNames = new Set((coding.tools ?? []).map((t) => t.definition.name));
  const catalogOwner = (name: string): string => {
    if (builtinNames.has(name)) return "core";
    if (codingNames.has(name)) return coding.id;
    for (const module of extensionModules) {
      if ((module.catalogTools ?? []).some((t) => t.definition.name === name)) return module.id;
    }
    throw new Error(`Unattributed catalog tool: ${name}`);
  };
  const defaultPreset = resolveAgentPreset(undefined, capabilities).name;
  const presets = [
    ...Object.values(BUILTIN_AGENT_PRESETS).map((p) => ({ preset: p, moduleId: "core" })),
    ...capabilities.flatMap((c) => (c.presets ?? []).map((p) => ({ preset: p, moduleId: c.id }))),
  ];
  return {
    version: 1,
    modules: [
      { id: "core", order: 0, source: "core" },
      { id: coding.id, order: 1, source: "host" },
      ...extensionModules.map((m, i) => ({ id: m.id, order: 2 + i, source: "host" })),
    ],
    tools: [
      ...catalog.map((tool) => ({
        name: tool.definition.name,
        moduleId: catalogOwner(tool.definition.name),
        exposure: "preset-tags" as const,
        presetTags: [...tool.exposure.presetTags],
      })),
      ...extensionModules.flatMap((module) =>
        (module.tools ?? []).map((tool) => ({
          name: tool.definition.name,
          moduleId: module.id,
          exposure: "always" as const,
          presetTags: [] as string[],
        })),
      ),
    ],
    presets: presets.map(({ preset, moduleId }) => ({
      name: preset.name,
      moduleId,
      isDefault: preset.name === defaultPreset,
    })),
    promptSections: Object.keys(composePromptSections(capabilities)).map((name) => ({
      name,
      moduleId: coding.id,
    })),
    hooks: composeCapabilityEngineHooks(capabilities).map((hook) => ({
      event: hook.event,
      name: hook.name,
      priority: hook.priority,
      moduleId: hook.capabilityId,
    })),
    behaviorProfiles: [
      { id: QUICK_CHAT_RESTRICTED_PROFILE.id, moduleId: "core" },
      { id: ISOLATED_TASK_PROFILE.id, moduleId: "core" },
      ...extensionModules.flatMap((module) =>
        (module.behaviorProfiles ?? []).map((p) => ({ id: p.id, moduleId: module.id })),
      ),
    ],
    queries: extensionModules.flatMap((module) =>
      Object.keys(module.queries ?? {}).map((type) => ({ type, moduleId: module.id })),
    ),
    observers: extensionModules.filter((m) => m.createProtocolObserver).map((m) => m.id),
    runValidators: extensionModules.filter((m) => m.validateRunParams).map((m) => m.id),
    hiddenSessionKinds: extensionModules.flatMap((module) =>
      (module.hiddenSessionKinds ?? []).map((kind) => ({ kind, moduleId: module.id })),
    ),
  };
}

describe("composition golden baseline", () => {
  const legacy = dumpLegacyComposition();

  test("legacy composition matches checked-in golden", () => {
    if (process.env.UPDATE_COMPOSITION_GOLDEN === "1") {
      const baselineCommit = execSync("git rev-parse HEAD").toString().trim();
      writeFileSync(GOLDEN_PATH, JSON.stringify({ baselineCommit, snapshot: legacy }, null, 2));
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
      baselineCommit: string;
      snapshot: CompositionSnapshot;
    };
    expect(golden.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(legacy).toEqual(golden.snapshot);
  });

  test("compiler reproduces the legacy composition item by item", () => {
    const composition = compileComposition({
      modules: [
        fromCapabilityModule(coding),
        ...extensionModules.map((m) => fromExtensionModule(m)),
      ],
      expectedModules: ["coding", "arena", "pet"],
    });
    expect(toCompositionSnapshot(composition)).toEqual(legacy);
  });
});
```

- [ ] **Step 4: 生成 golden 并跑测试**

Run: `UPDATE_COMPOSITION_GOLDEN=1 bun test tests/composition-golden.test.ts && bun test tests/composition-golden.test.ts`
Expected: 两次都 PASS；`tests/fixtures/composition-golden.json` 生成，含 `baselineCommit` 与完整 snapshot。**若第二个测试不等，逐字段 diff——大概率是顺序或归属规则没对齐旧路径，修 compiler/桥接直到逐项相等，不许改 dump 迁就 compiler。**

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/composition-bridges.ts tests/composition-golden.test.ts tests/fixtures/composition-golden.json
git commit -m "test: golden baseline proves compiler reproduces legacy composition"
```

---

### Task 7: 全量验证与收尾

- [ ] **Step 1: 全量测试**

Run: `bun test`
Expected: 全部 PASS（与 main 基线一致；本阶段没有改任何既有生产代码，除 exceptions.ts 纯追加）。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 全 workspace 通过。

- [ ] **Step 3: prettier 只格式化本计划新增/修改的文件**

```bash
bunx prettier --write packages/core/src/exceptions.ts packages/core/src/composition/*.ts tests/composition-golden.test.ts tests/helpers/composition-bridges.ts
git diff --stat
```

如有格式改动，amend 进对应提交或追加一个 `style:` commit。

- [ ] **Step 4: 提交计划文件本身**

```bash
git add docs/superpowers/plans/2026-08-14-composition-phase-a.md
git commit -m "docs: composition Phase A implementation plan"
```

---

## 自检记录

- Spec 覆盖：设计稿 §5 类型（缩减到 Phase A 所需）、§6 ResolvedComposition/snapshot/diagnostics、§7 Compiler 输入与 13 步校验（除 §7.2 第 8 步的 prompt-section 存在性校验——section 内容在磁盘、Compiler 不做 I/O，只校验 module 贡献的 section 冲突与 preset→tool 引用；已在偏差说明）、§12 Phase A 三条全覆盖、§13.1 除"输入不被修改"外全覆盖（freeze 已测）。
- 无占位符：所有代码块完整可粘贴。
- 类型一致性：`ResolvedContribution.key`/`moduleId`、`CompositionSnapshot` 字段名在 compiler/snapshot/golden 三处一致。

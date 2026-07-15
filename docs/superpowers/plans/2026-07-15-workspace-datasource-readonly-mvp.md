# Workspace 数据源绑定 · 只读 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地三层数据源模型（SourceDefinition → WorkspaceSourceBinding → EffectiveSourceAccess）+ mock/mcp-resource/local-files 三种 adapter + ListSources/ReadSource 只读工具面 + desktop 项目配置中心页（上传/绑定/scope）。

**Architecture:** 见 ADR：`docs/todo/workspace-datasource-binding-adr.md`（所有语义决策以它为准，实现遇到歧义先查 ADR）。core 新增 `packages/core/src/sources/`；凭证全局（现有 CredentialStore）、binding 项目级（project settings `sources` 数组，不存 secret）；读取面默认 deny + ReadSource 默认 ask 审批 + `wrapUntrustedInput` 包裹 + provenance + maxBytes；注入只走动态上下文。Profile 求交只留 resolver 参数不接线。

**Tech Stack:** TypeScript + bun test（不是 vitest/jest）、zod、Electron desktop（shadcn/ui + Tailwind）。

**必读约定：** CODESHELL.md；conventional commits；desktop 有独立 typecheck/build（`cd packages/desktop && bun run typecheck`）。root `bun run typecheck` 有 **31 个预先存在**的错误（oauth/mcp-manager/subagent-spawner 等 undici-types 环境问题）——验收标准是"不新增"，不是清零。

**已核实的关键接缝（行号为 2026-07-15 现状）：**
- builtin 工具注册形态：`packages/core/src/tool-system/builtin/index.ts:645-670` —— `{ definition: {...def, source:"builtin", permissionDefault:"allow"|"ask", isReadOnly, isConcurrencySafe}, execute, exposure: expose(HARNESS_TAGS) }`；`ReadMcpResource` 是 `permissionDefault:"ask"` 的现成先例（读内容默认审批）。
- 工具 execute 签名：`(args: Record<string, unknown>, ctx?: ToolContext) => Promise<string | ToolFailure>`，`ctx.cwd` 可用，`args.__signal` 是注入的 AbortSignal（样板 `builtin/glob.ts:29`）。
- MCP 访问：`MCPManager.getInstance()` 单例 + `listResources(serverName?)` / `readResource(serverName, uri)`（`mcp-manager.ts:891/923`；调用样板 `builtin/mcp-tools.ts:42-47`）。
- 不可信包裹：`wrapUntrustedInput(content, source)`（`packages/core/src/automation/write-policy.ts:117`，已从 core 导出）。
- 项目 settings 原子写：`SettingsManager.saveProjectSetting(key, value, cwd)` / `deleteProjectSetting`（`settings/manager.ts:443/:462`）；schema 加字段的样板 = 刚落地的 `profile` 子树（`settings/schema.ts` 搜 `profile:`）。
- 全局家目录：`codeShellHome()`（`session/session-manager.ts:386`，identity dataRoot 生效）。
- 路径 canonicalize：`normalizeCwdPath` / `realpathSync`（`utils/cwd-normalize.ts`）。
- 纵切测试基建：`createToolRegistryHarness` / `createFakeToolContext`（core 公共导出，P7 落地）。
- desktop：IPC 样板 `main/index.ts:1600`（capabilities）/ `:3305`（settings:get/set）；`dialog.showOpenDialog` 用法 `main/index.ts:2820`；preload 样板 `preload/index.ts:895`；renderer 页面开关 `viewMode`（App.tsx，`"settings_page"` 是全页样板，`isSettingsPage` 在 :1726）；项目级区块样板 = `renderer/settings/ProfileSection.tsx`（刚落地）。

---

### Task 1: sources 类型与 schema（types.ts）

**Files:**
- Create: `packages/core/src/sources/types.ts`
- Test: `packages/core/src/sources/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/sources/types.test.ts
import { describe, expect, test } from "bun:test";
import { SourceDefinitionSchema, WorkspaceSourceBindingSchema } from "./types.js";

describe("source schemas", () => {
  test("accepts a full mcp-resource definition", () => {
    const d = SourceDefinitionSchema.parse({
      id: "github-work",
      kind: "mcp-resource",
      label: "GitHub（工作）",
      adapterConfig: { server: "github" },
      credentialRef: "cred-123",
      enabled: true,
    });
    expect(d.enabled).toBe(true);
  });

  test("fills defaults: enabled=true, adapterConfig={}", () => {
    const d = SourceDefinitionSchema.parse({ id: "m1", kind: "mock", label: "Mock" });
    expect(d.enabled).toBe(true);
    expect(d.adapterConfig).toEqual({});
  });

  test("rejects unknown kind and illegal id", () => {
    expect(() => SourceDefinitionSchema.parse({ id: "x", kind: "figma", label: "X" })).toThrow();
    expect(() => SourceDefinitionSchema.parse({ id: "../e", kind: "mock", label: "X" })).toThrow();
    expect(() => SourceDefinitionSchema.parse({ id: "UP", kind: "mock", label: "X" })).toThrow();
  });

  test("binding requires sourceId + scopes; readPolicy defaults to ask and only allows ask|deny", () => {
    const b = WorkspaceSourceBindingSchema.parse({ sourceId: "github-work", scopes: ["issues"] });
    expect(b.readPolicy).toBe("ask");
    expect(() =>
      WorkspaceSourceBindingSchema.parse({ sourceId: "x", scopes: [], readPolicy: "allow" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/sources/types.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/sources/types.ts
/**
 * Workspace 数据源三层模型的数据定义。语义决策见
 * docs/todo/workspace-datasource-binding-adr.md（ADR-1/2/4）。
 * project settings 只存 binding（ref/scope/readPolicy），绝不存 secret。
 */
import { z } from "zod";

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const SOURCE_KINDS = ["mock", "mcp-resource", "local-files"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceDefinitionSchema = z.object({
  id: z.string().regex(SOURCE_ID_RE),
  kind: z.enum(SOURCE_KINDS),
  label: z.string().min(1),
  description: z.string().optional(),
  /** 按 kind 的 adapter 配置（如 mcp-resource: { server }）。 */
  adapterConfig: z.record(z.unknown()).default({}),
  /** 指向全局 CredentialStore 的 id；local-files/mock 不需要。 */
  credentialRef: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type SourceDefinition = z.infer<typeof SourceDefinitionSchema>;

export const WorkspaceSourceBindingSchema = z.object({
  sourceId: z.string().regex(SOURCE_ID_RE),
  /** 显式勾选的 scope id；空数组 = 什么都不可见（不是"全部"）。 */
  scopes: z.array(z.string()),
  /** ask（默认，ReadSource 每次审批）| deny（只许 list metadata，禁读内容）。无 allow 档（ADR §1.2）。 */
  readPolicy: z.enum(["ask", "deny"]).default("ask"),
});
export type WorkspaceSourceBinding = z.infer<typeof WorkspaceSourceBindingSchema>;

/** adapter 返回的 scope/resource/content 形状（运行时对象，不落盘）。 */
export interface SourceScope {
  id: string;
  label: string;
  description?: string;
}

export interface SourceResourceMeta {
  id: string;
  scopeId: string;
  name: string;
  sizeBytes?: number;
  mimeType?: string;
}

export interface SourceContent {
  resourceId: string;
  text: string;
  truncated: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/sources/types.test.ts`
Expected: PASS（4 pass）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sources/
git commit -m "feat(sources): source definition and binding schemas"
```

---

### Task 2: 项目 settings 的 `sources` 数组

**Files:**
- Modify: `packages/core/src/settings/schema.ts`（加在 `profile:` 子树旁）
- Test: `packages/core/src/settings/sources-binding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/settings/sources-binding.test.ts
import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("settings sources bindings", () => {
  test("accepts an array of bindings", () => {
    const s = SettingsSchema.parse({
      sources: [{ sourceId: "github-work", scopes: ["issues", "pulls"] }],
    });
    expect(s.sources?.[0]?.readPolicy).toBe("ask");
  });

  test("absent stays undefined; invalid binding rejected", () => {
    expect(SettingsSchema.parse({}).sources).toBeUndefined();
    expect(() => SettingsSchema.parse({ sources: [{ scopes: [] }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**：`bun test packages/core/src/settings/sources-binding.test.ts`

- [ ] **Step 3: Add the field**

`settings/schema.ts` 顶部 import 区加 `import { WorkspaceSourceBindingSchema } from "../sources/types.js";`（先确认无 import 环：sources/types.ts 只依赖 zod，安全）。在 `profile:` 子树字段之后加：

```ts
    /**
     * Workspace 数据源绑定（只存 ref/scope/readPolicy，绝不存 secret）。
     * 语义见 docs/todo/workspace-datasource-binding-adr.md §1.2。
     * 只存在于 PROJECT settings。
     */
    sources: z.array(WorkspaceSourceBindingSchema).optional(),
```

- [ ] **Step 4: Run**：`bun test packages/core/src/settings/` 全 PASS
- [ ] **Step 5: Commit**：`git add packages/core/src/settings/ && git commit -m "feat(settings): workspace source bindings array"`

---

### Task 3: 全局 SourceCatalog store

**Files:**
- Create: `packages/core/src/sources/catalog.ts`
- Test: `packages/core/src/sources/catalog.test.ts`

存储：`codeShellHome()/sources.json`，versioned `{ version: 1, sources: SourceDefinition[] }`；损坏条目隔离（单条 invalid 跳过并 warn，不拖垮整库）；原子写 tmp+rename。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/sources/catalog.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSourceDefinition, listSourceDefinitions, readSourceDefinition, saveSourceDefinition } from "./catalog.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-cat-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("source catalog store", () => {
  test("save/read/list/delete round-trip, sorted by id", () => {
    saveSourceDefinition({ id: "b", kind: "mock", label: "B", adapterConfig: {}, enabled: true });
    saveSourceDefinition({ id: "a", kind: "mock", label: "A", adapterConfig: {}, enabled: true });
    expect(listSourceDefinitions().map((s) => s.id)).toEqual(["a", "b"]);
    expect(readSourceDefinition("a")?.label).toBe("A");
    saveSourceDefinition({ id: "a", kind: "mock", label: "A2", adapterConfig: {}, enabled: false });
    expect(readSourceDefinition("a")?.label).toBe("A2"); // upsert
    deleteSourceDefinition("a");
    expect(readSourceDefinition("a")).toBeUndefined();
  });

  test("corrupted entries are isolated, valid ones survive", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "sources.json"),
      JSON.stringify({ version: 1, sources: [{ id: "ok", kind: "mock", label: "OK" }, { id: "BAD ID" }] }),
    );
    expect(listSourceDefinitions().map((s) => s.id)).toEqual(["ok"]);
  });

  test("missing/unparseable file → empty list", () => {
    expect(listSourceDefinitions()).toEqual([]);
    writeFileSync(join(home, "sources.json"), "not json");
    expect(listSourceDefinitions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**：`bun test packages/core/src/sources/catalog.test.ts`

- [ ] **Step 3: Implement**

```ts
// packages/core/src/sources/catalog.ts
/** 全局数据源目录：codeShellHome()/sources.json。损坏条目隔离，原子写。 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { codeShellHome } from "../session/session-manager.js";
import { logger } from "../logging/logger.js";
import { SourceDefinitionSchema, type SourceDefinition } from "./types.js";

export function sourceCatalogPath(): string {
  return join(codeShellHome(), "sources.json");
}

function load(): SourceDefinition[] {
  const path = sourceCatalogPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: number; sources?: unknown[] };
    if (raw.version !== 1 || !Array.isArray(raw.sources)) return [];
    const out: SourceDefinition[] = [];
    for (const entry of raw.sources) {
      const parsed = SourceDefinitionSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
      else logger.warn("sources.catalog_entry_invalid", { cat: "sources", entry: JSON.stringify(entry).slice(0, 200) });
    }
    return out;
  } catch (error) {
    logger.warn("sources.catalog_unreadable", { cat: "sources", error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function persist(sources: SourceDefinition[]): void {
  const path = sourceCatalogPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

export function listSourceDefinitions(): SourceDefinition[] {
  return load().sort((a, b) => a.id.localeCompare(b.id));
}

export function readSourceDefinition(id: string): SourceDefinition | undefined {
  return load().find((s) => s.id === id);
}

export function saveSourceDefinition(def: SourceDefinition): void {
  const parsed = SourceDefinitionSchema.parse(def);
  const rest = load().filter((s) => s.id !== parsed.id);
  persist([...rest, parsed]);
}

export function deleteSourceDefinition(id: string): void {
  persist(load().filter((s) => s.id !== id));
}
```

- [ ] **Step 4: Run**：PASS（3 pass）
- [ ] **Step 5: Commit**：`git commit -am "feat(sources): global source catalog store"`

---

### Task 4: ConnectorAdapter 接口 + mock adapter

**Files:**
- Create: `packages/core/src/sources/adapter.ts`
- Create: `packages/core/src/sources/adapters/mock.ts`
- Test: `packages/core/src/sources/adapters/mock.test.ts`

- [ ] **Step 1: Interface**

```ts
// packages/core/src/sources/adapter.ts
/** provider 无关的连接器边界（ADR §4）。core 不出现任何具体 provider 名。 */
import type { SourceContent, SourceDefinition, SourceResourceMeta, SourceScope } from "./types.js";

export interface ConnectorAdapter {
  kind: string;
  listScopes(def: SourceDefinition): Promise<SourceScope[]>;
  listResources(def: SourceDefinition, scopeId: string): Promise<SourceResourceMeta[]>;
  read(def: SourceDefinition, resourceId: string, opts: { maxBytes: number; signal?: AbortSignal; cwd?: string }): Promise<SourceContent>;
}

const registry = new Map<string, ConnectorAdapter>();

export function registerConnectorAdapter(adapter: ConnectorAdapter): void {
  registry.set(adapter.kind, adapter);
}

export function connectorAdapterFor(kind: string): ConnectorAdapter | undefined {
  return registry.get(kind);
}
```

- [ ] **Step 2: Failing test for mock**

```ts
// packages/core/src/sources/adapters/mock.test.ts
import { describe, expect, test } from "bun:test";
import { mockAdapter } from "./mock.js";
import type { SourceDefinition } from "../types.js";

const def: SourceDefinition = { id: "m", kind: "mock", label: "Mock", adapterConfig: {}, enabled: true };

describe("mock adapter", () => {
  test("exposes 2 scopes / 3 resources per ADR DS-13 shape", async () => {
    const scopes = await mockAdapter.listScopes(def);
    expect(scopes.map((s) => s.id)).toEqual(["alpha", "beta"]);
    const alpha = await mockAdapter.listResources(def, "alpha");
    expect(alpha).toHaveLength(2);
    expect(await mockAdapter.listResources(def, "beta")).toHaveLength(1);
  });

  test("read returns content and honors maxBytes truncation", async () => {
    const full = await mockAdapter.read(def, "alpha/doc-1", { maxBytes: 10_000 });
    expect(full.truncated).toBe(false);
    expect(full.text).toContain("alpha doc one");
    const cut = await mockAdapter.read(def, "alpha/doc-1", { maxBytes: 5 });
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(5);
  });

  test("unknown resource throws", async () => {
    await expect(mockAdapter.read(def, "nope", { maxBytes: 100 })).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 3: Run FAIL → implement**

```ts
// packages/core/src/sources/adapters/mock.ts
/** 本地 fake 源：2 scope / 3 resource，纵切 e2e 与 CI 的载体（DS-13）。 */
import type { ConnectorAdapter } from "../adapter.js";
import type { SourceResourceMeta } from "../types.js";

const RESOURCES: Array<SourceResourceMeta & { text: string }> = [
  { id: "alpha/doc-1", scopeId: "alpha", name: "doc-1", text: "alpha doc one content" },
  { id: "alpha/doc-2", scopeId: "alpha", name: "doc-2", text: "alpha doc two content" },
  { id: "beta/note-1", scopeId: "beta", name: "note-1", text: "beta note one content" },
];

export const mockAdapter: ConnectorAdapter = {
  kind: "mock",
  async listScopes() {
    return [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
    ];
  },
  async listResources(_def, scopeId) {
    return RESOURCES.filter((r) => r.scopeId === scopeId).map(({ text: _t, ...meta }) => meta);
  },
  async read(_def, resourceId, opts) {
    const hit = RESOURCES.find((r) => r.id === resourceId);
    if (!hit) throw new Error(`mock resource not found: ${resourceId}`);
    const truncated = Buffer.byteLength(hit.text, "utf-8") > opts.maxBytes;
    return { resourceId, text: truncated ? hit.text.slice(0, opts.maxBytes) : hit.text, truncated };
  },
};
```

- [ ] **Step 4: Run**：PASS（3 pass）
- [ ] **Step 5: Commit**：`git commit -am "feat(sources): connector adapter boundary + mock adapter"`

---

### Task 5: local-files adapter（上传源）

**Files:**
- Create: `packages/core/src/sources/adapters/local-files.ts`
- Test: `packages/core/src/sources/adapters/local-files.test.ts`

要点（ADR §4.3）：隐式源（不进全局 catalog）；文件在 `${cwd}/.code-shell/uploads/`；resourceId = 相对文件名；**路径 canonicalize 防 `../` 逃逸**；单 scope `"uploads"`。

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/sources/adapters/local-files.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_FILES_SOURCE_ID, localFilesAdapter, localFilesSourceFor, uploadsDir } from "./local-files.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cs-uploads-"));
  mkdirSync(join(cwd, ".code-shell", "uploads"), { recursive: true });
  writeFileSync(join(cwd, ".code-shell", "uploads", "spec.md"), "# spec content\n");
  writeFileSync(join(cwd, ".code-shell", "uploads", "notes.txt"), "notes content\n");
  writeFileSync(join(cwd, "outside.txt"), "MUST NOT BE READABLE\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("local-files adapter", () => {
  test("implicit source definition derives from cwd", () => {
    const def = localFilesSourceFor(cwd);
    expect(def.id).toBe(LOCAL_FILES_SOURCE_ID);
    expect(def.kind).toBe("local-files");
    expect(uploadsDir(cwd)).toBe(join(cwd, ".code-shell", "uploads"));
  });

  test("lists a single uploads scope and the uploaded files", async () => {
    const def = localFilesSourceFor(cwd);
    expect((await localFilesAdapter.listScopes(def)).map((s) => s.id)).toEqual(["uploads"]);
    const files = await localFilesAdapter.listResources(def, "uploads");
    expect(files.map((f) => f.name).sort()).toEqual(["notes.txt", "spec.md"]);
    expect(files.every((f) => typeof f.sizeBytes === "number")).toBe(true);
  });

  test("reads content with truncation", async () => {
    const def = localFilesSourceFor(cwd);
    const c = await localFilesAdapter.read(def, "spec.md", { maxBytes: 10_000, cwd });
    expect(c.text).toContain("spec content");
    const cut = await localFilesAdapter.read(def, "spec.md", { maxBytes: 4, cwd });
    expect(cut.truncated).toBe(true);
  });

  test("rejects path escape attempts", async () => {
    const def = localFilesSourceFor(cwd);
    for (const evil of ["../outside.txt", "..%2Foutside.txt", "/etc/passwd", "a/../../outside.txt"]) {
      await expect(localFilesAdapter.read(def, evil, { maxBytes: 100, cwd })).rejects.toThrow();
    }
  });

  test("missing uploads dir → empty resource list, no throw", async () => {
    rmSync(join(cwd, ".code-shell", "uploads"), { recursive: true, force: true });
    const def = localFilesSourceFor(cwd);
    expect(await localFilesAdapter.listResources(def, "uploads")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run FAIL → implement**

```ts
// packages/core/src/sources/adapters/local-files.ts
/**
 * 上传文件源（ADR §4.3）：每个 workspace 隐式自带、不进全局 catalog。
 * 文件在 ${cwd}/.code-shell/uploads/；resourceId = uploads 内的相对路径；
 * read 前 canonicalize 并强制落在 uploads 目录内（防逃逸）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ConnectorAdapter } from "../adapter.js";
import type { SourceDefinition } from "../types.js";

export const LOCAL_FILES_SOURCE_ID = "project-uploads";

export function uploadsDir(cwd: string): string {
  return join(cwd, ".code-shell", "uploads");
}

export function localFilesSourceFor(cwd: string): SourceDefinition {
  return {
    id: LOCAL_FILES_SOURCE_ID,
    kind: "local-files",
    label: "项目文件",
    description: `本 workspace 上传的文件（${uploadsDir(cwd)}）`,
    adapterConfig: {},
    enabled: true,
  };
}

function resolveInsideUploads(cwd: string, resourceId: string): string {
  const root = realpathSync(uploadsDir(cwd));
  const candidate = resolve(root, resourceId);
  const real = realpathSync(candidate); // 文件必须存在；同时消解 symlink
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`resource escapes uploads dir: ${resourceId}`);
  }
  return real;
}

export const localFilesAdapter: ConnectorAdapter = {
  kind: "local-files",
  async listScopes() {
    return [{ id: "uploads", label: "上传文件" }];
  },
  async listResources(_def, scopeId) {
    if (scopeId !== "uploads") return [];
    // cwd 经 read 的 opts 传入不可用于 list —— list 需要 def 侧携带；隐式源的
    // adapterConfig 里不存 cwd（def 是纯数据），因此 list 由调用方先经
    // localFilesSourceFor(cwd) 确认，再直接调用本函数时传入 cwd：
    throw new Error("use listLocalFiles(cwd) — local-files listing is cwd-scoped");
  },
  async read(_def, resourceId, opts) {
    if (!opts.cwd) throw new Error("local-files read requires cwd");
    const path = resolveInsideUploads(opts.cwd, resourceId);
    const buf = readFileSync(path);
    const truncated = buf.byteLength > opts.maxBytes;
    return { resourceId, text: buf.subarray(0, opts.maxBytes).toString("utf-8"), truncated };
  },
};

/** cwd 维度的文件列举（隐式源没有全局身份，list 不走 adapter 通配签名）。 */
export function listLocalFiles(cwd: string): Array<{ id: string; scopeId: "uploads"; name: string; sizeBytes: number }> {
  const dir = uploadsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({
      id: e.name,
      scopeId: "uploads" as const,
      name: e.name,
      sizeBytes: statSync(join(dir, e.name)).size,
    }));
}
```

**实现注意**：上面 `listResources` 抛错是刻意的接口张力记录——写实现时把测试对 `listResources` 的断言改为调用 `listLocalFiles(cwd)`（测试 Step 1 的第 2 个用例相应调整为 `listLocalFiles(cwd)`），保持"隐式源的 list 是 cwd 维度"这一 ADR 语义。Task 8 的工具层对 local-files 分支直接用 `listLocalFiles`。

- [ ] **Step 3: Run**：PASS（5 pass）
- [ ] **Step 4: Commit**：`git commit -am "feat(sources): local-files upload adapter with path-escape guard"`

---

### Task 6: mcp-resource adapter

**Files:**
- Create: `packages/core/src/sources/adapters/mcp-resource.ts`
- Test: `packages/core/src/sources/adapters/mcp-resource.test.ts`

包装 `MCPManager.getInstance()`（样板 `builtin/mcp-tools.ts:42-47`）。单 scope `"resources"`；`adapterConfig.server` 指定服务器。测试用依赖注入（构造函数接受 manager 工厂）避免真连接。

- [ ] **Step 1: Failing test**

```ts
// packages/core/src/sources/adapters/mcp-resource.test.ts
import { describe, expect, test } from "bun:test";
import { createMcpResourceAdapter } from "./mcp-resource.js";
import type { SourceDefinition } from "../types.js";

const def: SourceDefinition = {
  id: "gh", kind: "mcp-resource", label: "GH",
  adapterConfig: { server: "github" }, enabled: true,
};

const fakeManager = {
  listResources: async (server?: string) => {
    expect(server).toBe("github");
    return [{ server: "github", uri: "issue://1", name: "issue-1" }, { server: "github", uri: "issue://2", name: "issue-2" }];
  },
  readResource: async (server: string, uri: string) => {
    expect(server).toBe("github");
    if (uri === "issue://1") return "issue one body";
    throw new Error(`unknown ${uri}`);
  },
};

describe("mcp-resource adapter", () => {
  const adapter = createMcpResourceAdapter(() => fakeManager as never);

  test("single 'resources' scope; resources map from MCP list", async () => {
    expect((await adapter.listScopes(def)).map((s) => s.id)).toEqual(["resources"]);
    const rs = await adapter.listResources(def, "resources");
    expect(rs.map((r) => r.id)).toEqual(["issue://1", "issue://2"]);
  });

  test("read maps uri and truncates", async () => {
    const c = await adapter.read(def, "issue://1", { maxBytes: 5 });
    expect(c.truncated).toBe(true);
    expect(c.text).toBe("issue");
  });

  test("missing adapterConfig.server rejects", async () => {
    const bad = { ...def, adapterConfig: {} };
    await expect(adapter.listResources(bad, "resources")).rejects.toThrow(/server/);
  });
});
```

- [ ] **Step 2: Run FAIL → implement**

```ts
// packages/core/src/sources/adapters/mcp-resource.ts
/** MCP resource 包装 adapter：MCP 只是 kind 之一，不塞 mcpServers（ADR §1/§4）。 */
import type { ConnectorAdapter } from "../adapter.js";
import type { SourceDefinition } from "../types.js";

interface McpLike {
  listResources(server?: string, signal?: AbortSignal): Promise<Array<{ server: string; uri: string; name?: string }>>;
  readResource(server: string, uri: string, signal?: AbortSignal): Promise<string>;
}

function serverOf(def: SourceDefinition): string {
  const server = def.adapterConfig["server"];
  if (typeof server !== "string" || !server) {
    throw new Error(`mcp-resource source "${def.id}" requires adapterConfig.server`);
  }
  return server;
}

export function createMcpResourceAdapter(getManager: () => McpLike): ConnectorAdapter {
  return {
    kind: "mcp-resource",
    async listScopes() {
      return [{ id: "resources", label: "Resources" }];
    },
    async listResources(def, scopeId) {
      if (scopeId !== "resources") return [];
      const server = serverOf(def);
      const all = await getManager().listResources(server);
      return all.map((r) => ({ id: r.uri, scopeId: "resources", name: r.name ?? r.uri }));
    },
    async read(def, resourceId, opts) {
      const text = await getManager().readResource(serverOf(def), resourceId, opts.signal);
      const truncated = Buffer.byteLength(text, "utf-8") > opts.maxBytes;
      return { resourceId, text: truncated ? text.slice(0, opts.maxBytes) : text, truncated };
    },
  };
}

/** 生产默认：真 MCPManager 单例（懒加载避免模块环）。 */
export function defaultMcpResourceAdapter(): ConnectorAdapter {
  return createMcpResourceAdapter(() => {
    // 与 builtin/mcp-tools.ts 相同的取用方式
    const { MCPManager } = require("../../tool-system/mcp-manager.js") as typeof import("../../tool-system/mcp-manager.js");
    return MCPManager.getInstance();
  });
}
```

（若仓库禁 `require`，用与 `mcp-tools.ts` 相同的动态 `await import` 形式，把 `read/list` 改 async 获取。以 lint 结果为准。）

- [ ] **Step 3: Run**：PASS（3 pass）
- [ ] **Step 4: Commit**：`git commit -am "feat(sources): mcp-resource adapter"`

---

### Task 7: binding 读写 + EffectiveSourceAccess resolver

**Files:**
- Create: `packages/core/src/sources/binding.ts`
- Create: `packages/core/src/sources/resolve.ts`
- Test: `packages/core/src/sources/resolve.test.ts`

- [ ] **Step 1: Failing test**

```ts
// packages/core/src/sources/resolve.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { saveSourceDefinition } from "./catalog.js";
import { bindSource, listBindings, unbindSource } from "./binding.js";
import { resolveEffectiveSourceAccess } from "./resolve.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-resolve-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveSourceDefinition({ id: "m1", kind: "mock", label: "Mock1", adapterConfig: {}, enabled: true });
  saveSourceDefinition({ id: "m2", kind: "mock", label: "Mock2", adapterConfig: {}, credentialRef: "cred-x", enabled: true });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const okCred = () => "ok" as const;

describe("effective source access", () => {
  test("default deny: unbound source is invisible", () => {
    const sm = new SettingsManager(cwd, "full");
    const access = resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred });
    expect(access).toEqual([]);
  });

  test("bound source appears with its scopes and status ok (implicit local-files always present)", () => {
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
    const access = resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred });
    const ids = access.map((a) => a.sourceId).sort();
    expect(ids).toEqual(["m1", "project-uploads"]);
    const m1 = access.find((a) => a.sourceId === "m1")!;
    expect(m1.status).toBe("ok");
    expect(m1.scopes).toEqual(["alpha"]);
  });

  test("dangling: binding to a deleted/unknown source is visible but denied", () => {
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "ghost", scopes: ["x"], readPolicy: "ask" });
    const ghost = resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred }).find((a) => a.sourceId === "ghost")!;
    expect(ghost.status).toBe("dangling");
  });

  test("disabled source and bad credential → unavailable", () => {
    const sm = new SettingsManager(cwd, "full");
    saveSourceDefinition({ id: "m1", kind: "mock", label: "Mock1", adapterConfig: {}, enabled: false });
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
    bindSource(sm, cwd, { sourceId: "m2", scopes: ["alpha"], readPolicy: "ask" });
    const access = resolveEffectiveSourceAccess({
      cwd, settings: sm,
      credentialStatus: (ref) => (ref === "cred-x" ? "expired" : "ok"),
    });
    expect(access.find((a) => a.sourceId === "m1")!.status).toBe("unavailable");
    expect(access.find((a) => a.sourceId === "m2")!.status).toBe("unavailable");
  });

  test("unbind removes visibility; bind/unbind round-trips settings", () => {
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
    expect(listBindings(sm, cwd)).toHaveLength(1);
    unbindSource(sm, cwd, "m1");
    expect(listBindings(sm, cwd)).toEqual([]);
    const access = resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred });
    expect(access.find((a) => a.sourceId === "m1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run FAIL → implement binding.ts**

```ts
// packages/core/src/sources/binding.ts
/** WorkspaceSourceBinding 的项目 settings 读写（原子，经 SettingsManager）。 */
import type { SettingsManager } from "../settings/manager.js";
import { WorkspaceSourceBindingSchema, type WorkspaceSourceBinding } from "./types.js";

export function listBindings(sm: SettingsManager, cwd: string): WorkspaceSourceBinding[] {
  try {
    const raw = sm.getForScope("project", cwd).sources as unknown[] | undefined;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((b) => WorkspaceSourceBindingSchema.safeParse(b))
      .filter((r): r is { success: true; data: WorkspaceSourceBinding } => r.success)
      .map((r) => r.data);
  } catch {
    return [];
  }
}

export function bindSource(sm: SettingsManager, cwd: string, binding: WorkspaceSourceBinding): void {
  const parsed = WorkspaceSourceBindingSchema.parse(binding);
  const rest = listBindings(sm, cwd).filter((b) => b.sourceId !== parsed.sourceId);
  sm.saveProjectSetting("sources", [...rest, parsed], cwd);
}

export function unbindSource(sm: SettingsManager, cwd: string, sourceId: string): void {
  sm.saveProjectSetting("sources", listBindings(sm, cwd).filter((b) => b.sourceId !== sourceId), cwd);
}
```

- [ ] **Step 3: Implement resolve.ts**

```ts
// packages/core/src/sources/resolve.ts
/**
 * EffectiveSourceAccess：binding × source.enabled × credential 状态求交，
 * 默认 deny（ADR §1.3/§3）。`profile` 参数为 Profile 求交预留（ADR §6），
 * 本期恒不传；接线时 effective = binding ∩ profile 声明，只能收窄。
 */
import type { SettingsManager } from "../settings/manager.js";
import { readSourceDefinition } from "./catalog.js";
import { listBindings } from "./binding.js";
import { LOCAL_FILES_SOURCE_ID, localFilesSourceFor } from "./adapters/local-files.js";
import type { SourceDefinition, WorkspaceSourceBinding } from "./types.js";

export type SourceAccessStatus = "ok" | "dangling" | "unavailable";
export type CredentialStatusFn = (ref: string) => "ok" | "missing" | "expired";

export interface EffectiveSourceAccess {
  sourceId: string;
  label: string;
  kind: string;
  scopes: string[];
  readPolicy: "ask" | "deny";
  status: SourceAccessStatus;
  definition?: SourceDefinition;
}

export interface ResolveSourceAccessInput {
  cwd: string;
  settings: SettingsManager;
  credentialStatus: CredentialStatusFn;
  /** Profile 求交预留（ADR §6）；本期不实现。 */
  profile?: { requiredSources?: string[] };
}

function statusOf(def: SourceDefinition | undefined, cred: CredentialStatusFn): SourceAccessStatus {
  if (!def) return "dangling";
  if (!def.enabled) return "unavailable";
  if (def.credentialRef && cred(def.credentialRef) !== "ok") return "unavailable";
  return "ok";
}

export function resolveEffectiveSourceAccess(input: ResolveSourceAccessInput): EffectiveSourceAccess[] {
  const bindings = listBindings(input.settings, input.cwd);
  const out: EffectiveSourceAccess[] = bindings.map((b: WorkspaceSourceBinding) => {
    const def = readSourceDefinition(b.sourceId);
    return {
      sourceId: b.sourceId,
      label: def?.label ?? b.sourceId,
      kind: def?.kind ?? "unknown",
      scopes: b.scopes,
      readPolicy: b.readPolicy,
      status: statusOf(def, input.credentialStatus),
      ...(def ? { definition: def } : {}),
    };
  });
  // 隐式上传源：绑定即存在（每个 workspace 自带），除非显式 bind 了同 id 覆盖 readPolicy。
  if (bindings.length > 0 && !out.some((a) => a.sourceId === LOCAL_FILES_SOURCE_ID)) {
    const def = localFilesSourceFor(input.cwd);
    out.push({
      sourceId: def.id, label: def.label, kind: def.kind,
      scopes: ["uploads"], readPolicy: "ask", status: "ok", definition: def,
    });
  }
  return out;
}
```

**实现注意（隐式源出现条件）**：上面按测试语义"绑定了任何源（或上传过文件）→ project-uploads 出现"。写实现时统一为：`bindings.length > 0 || listLocalFiles(cwd).length > 0` 时出现隐式源；两个测试相应覆盖（default-deny 用例里既无 binding 也无上传 → 空数组成立）。

- [ ] **Step 4: Run**：PASS（5 pass）
- [ ] **Step 5: Commit**：`git commit -am "feat(sources): binding persistence + effective access resolver (default deny)"`

---

### Task 8: 默认 credentialStatus 实现

**Files:**
- Create: `packages/core/src/sources/credential-status.ts`
- Test: `packages/core/src/sources/credential-status.test.ts`

- [ ] **Step 1: 读真实 API**

读 `packages/core/src/credentials/access.ts:83-110` 与 `packages/core/src/credentials/store.ts`（找按 id 取凭证 metadata 的读取面——只要 metadata/expiresAt，**不解密 secret**）。

- [ ] **Step 2: 实现 + 测试**

实现 `defaultCredentialStatus(ref: string): "ok" | "missing" | "expired"`：凭证不存在 → `missing`；`oauth` 类型且 `expiresAt` 已过且无 refreshToken → `expired`；其余 → `ok`。测试用临时 CredentialStore（模仿 `credentials/access.test.ts` 的隔离方式）覆盖三种状态。语义与 ADR §3 表格一致：**expired 即 unavailable，不尝试刷新**（刷新是 OAuth 链路的事，不在只读 MVP）。

- [ ] **Step 3: Run + Commit**：`git commit -am "feat(sources): default credential status probe (metadata only)"`

---

### Task 9: ListSources / ReadSource 工具 + 注册

**Files:**
- Create: `packages/core/src/tool-system/builtin/sources.ts`
- Modify: `packages/core/src/tool-system/builtin/index.ts`（注册两个工具，样板 :645-670 的 ListMcpResources/ReadMcpResource 对）
- Test: `packages/core/src/tool-system/builtin/sources.test.ts`

- [ ] **Step 1: Failing test**

```ts
// packages/core/src/tool-system/builtin/sources.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../../settings/manager.js";
import { saveSourceDefinition } from "../../sources/catalog.js";
import { bindSource } from "../../sources/binding.js";
import { listSourcesTool, readSourceTool } from "./sources.js";
import type { ToolContext } from "../context.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-tools-"));
  cwd = join(home, "ws");
  mkdirSync(join(cwd, ".code-shell", "uploads"), { recursive: true });
  writeFileSync(join(cwd, ".code-shell", "uploads", "brief.md"), "brief body");
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveSourceDefinition({ id: "m1", kind: "mock", label: "Mock1", adapterConfig: {}, enabled: true });
  const sm = new SettingsManager(cwd, "full");
  bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const ctx = () => ({ cwd }) as unknown as ToolContext;

describe("ListSources", () => {
  test("lists bound sources + implicit uploads with scopes/status/resource names only", async () => {
    const out = (await listSourcesTool({}, ctx())) as string;
    expect(out).toContain("m1");
    expect(out).toContain("alpha");
    expect(out).toContain("project-uploads");
    expect(out).toContain("brief.md");
    expect(out).not.toContain("alpha doc one content"); // 绝不含内容
  });
});

describe("ReadSource", () => {
  test("reads bound mock content wrapped as untrusted with provenance", async () => {
    const out = (await readSourceTool(
      { source: "m1", scope: "alpha", resource: "alpha/doc-1" }, ctx(),
    )) as string;
    expect(out).toContain("alpha doc one content");
    expect(out).toContain("m1");            // provenance
    expect(out).toMatch(/untrusted/i);       // wrapUntrustedInput 痕迹
  });

  test("denies: scope not bound / source not bound / readPolicy deny", async () => {
    expect(await readSourceTool({ source: "m1", scope: "beta", resource: "beta/note-1" }, ctx())).toMatch(/^Error/);
    expect(await readSourceTool({ source: "ghost", scope: "x", resource: "y" }, ctx())).toMatch(/^Error/);
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "deny" });
    expect(await readSourceTool({ source: "m1", scope: "alpha", resource: "alpha/doc-1" }, ctx())).toMatch(/^Error/);
  });

  test("reads uploaded file via implicit source; escape attempts denied", async () => {
    const ok = (await readSourceTool({ source: "project-uploads", scope: "uploads", resource: "brief.md" }, ctx())) as string;
    expect(ok).toContain("brief body");
    expect(await readSourceTool({ source: "project-uploads", scope: "uploads", resource: "../secret" }, ctx())).toMatch(/^Error/);
  });
});
```

- [ ] **Step 2: Run FAIL → implement**

`sources.ts` 要点（完整写出 toolDef + execute）：

```ts
// packages/core/src/tool-system/builtin/sources.ts
/**
 * 数据源只读读取面（ADR §5）。ListSources 只出 metadata（自动允许）；
 * ReadSource 读内容（permissionDefault: ask，在 index.ts 注册处声明），
 * 执行时对 source/scope/resource 二次校验（防审批后换参），结果带
 * provenance + maxBytes 截断 + wrapUntrustedInput 包裹。
 */
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import { wrapUntrustedInput } from "../../automation/write-policy.js";
import { resolveEffectiveSourceAccess, type EffectiveSourceAccess } from "../../sources/resolve.js";
import { defaultCredentialStatus } from "../../sources/credential-status.js";
import { connectorAdapterFor } from "../../sources/adapter.js";
import { listLocalFiles, localFilesAdapter, LOCAL_FILES_SOURCE_ID } from "../../sources/adapters/local-files.js";
import { mockAdapter } from "../../sources/adapters/mock.js";
import { defaultMcpResourceAdapter } from "../../sources/adapters/mcp-resource.js";

const DEFAULT_MAX_BYTES = 262_144; // 256 KiB，超限截断并声明

// 注册内置 adapter（幂等）
import { registerConnectorAdapter } from "../../sources/adapter.js";
registerConnectorAdapter(mockAdapter);
registerConnectorAdapter(localFilesAdapter);
registerConnectorAdapter(defaultMcpResourceAdapter());

function accessFor(cwd: string): EffectiveSourceAccess[] {
  const sm = new SettingsManager(cwd, "full");
  return resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: defaultCredentialStatus });
}

export const listSourcesToolDef: ToolDefinition = {
  name: "ListSources",
  description:
    "List the data sources bound to this workspace: names, scopes, availability status and resource names/sizes. Metadata only — use ReadSource to read content (requires approval).",
  inputSchema: { type: "object", properties: {} },
};

export async function listSourcesTool(_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const access = accessFor(cwd);
  if (access.length === 0) return "No data sources are bound to this workspace.";
  const lines: string[] = [];
  for (const a of access) {
    lines.push(`## ${a.label} (id: ${a.sourceId}, kind: ${a.kind}, status: ${a.status}, readPolicy: ${a.readPolicy})`);
    if (a.status !== "ok") continue;
    for (const scopeId of a.scopes.length > 0 ? a.scopes : []) {
      const resources =
        a.sourceId === LOCAL_FILES_SOURCE_ID
          ? listLocalFiles(cwd)
          : await connectorAdapterFor(a.kind)?.listResources(a.definition!, scopeId).catch(() => []) ?? [];
      lines.push(`### scope: ${scopeId}`);
      for (const r of resources) lines.push(`- ${r.name} (resource: ${r.id}${r.sizeBytes !== undefined ? `, ${r.sizeBytes}B` : ""})`);
    }
  }
  return lines.join("\n");
}

export const readSourceToolDef: ToolDefinition = {
  name: "ReadSource",
  description:
    "Read the content of one resource from a bound data source. Requires approval. Args must exactly match a bound source/scope and a listed resource id.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Bound source id (from ListSources)" },
      scope: { type: "string", description: "Bound scope id" },
      resource: { type: "string", description: "Resource id within that scope" },
    },
    required: ["source", "scope", "resource"],
  },
};

export async function readSourceTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const source = String(args.source ?? "");
  const scope = String(args.scope ?? "");
  const resource = String(args.resource ?? "");
  const signal = args.__signal as AbortSignal | undefined;

  // 二次校验（防审批后换参 / 越权）：source 必须绑定且 ok、scope 必须在勾选列表内。
  const access = accessFor(cwd).find((a) => a.sourceId === source);
  if (!access) return `Error: source "${source}" is not bound to this workspace.`;
  if (access.status !== "ok") return `Error: source "${source}" is ${access.status}.`;
  if (access.readPolicy === "deny") return `Error: source "${source}" is metadata-only in this workspace (readPolicy: deny).`;
  if (!access.scopes.includes(scope)) return `Error: scope "${scope}" is not bound for source "${source}".`;

  try {
    const adapter = connectorAdapterFor(access.kind);
    if (!adapter) return `Error: no adapter for kind "${access.kind}".`;
    const content = await adapter.read(access.definition!, resource, { maxBytes: DEFAULT_MAX_BYTES, signal, cwd });
    const provenance = `source=${source} scope=${scope} resource=${resource}${content.truncated ? " (truncated)" : ""}`;
    // Secret redaction（ADR §5/§8）：复用核心现有的密钥脱敏工具后再包裹。
    // 实现前先 `grep -rn 'redact' packages/core/src --include='*.ts' | grep -v test`
    // 找到"密钥脱敏硬化"落地的 canonical helper（2026-07 小 feature 批次），
    // 对 content.text 先脱敏再 wrapUntrustedInput；测试补一条：内容含
    // `sk-ant-`/`ghp_` 形态 token 时输出被打码。
    return wrapUntrustedInput(content.text, provenance);
  } catch (error) {
    return `Error: read failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

- [ ] **Step 3: Register in builtin/index.ts**

import 两对 def/execute；在 ListMcpResources/ReadMcpResource 注册块（:645-670）之后按同形态加：`ListSources` → `permissionDefault: "allow", isReadOnly: true, isConcurrencySafe: true` + `defaultPermissionRules: allow(listSourcesToolDef.name)`；`ReadSource` → `permissionDefault: "ask", isReadOnly: true, isConcurrencySafe: true`（注释引用 ReadMcpResource 同款理由）。`exposure: expose(HARNESS_TAGS)`。同时检查 `tool-coverage.test.ts` 的 59 项覆盖矩阵是否需要登记新工具（跑一下便知）。

- [ ] **Step 4: Run**：`bun test packages/core/src/tool-system/builtin/sources.test.ts packages/core/src/tool-system/builtin/tool-coverage.test.ts`
Expected: PASS（coverage 矩阵若失败按其输出登记两个新工具条目）

- [ ] **Step 5: Commit**：`git commit -am "feat(sources): ListSources/ReadSource read surface with approval + provenance"`

---

### Task 10: 动态上下文注入

**Files:**
- Modify: `packages/core/src/prompt/composer.ts`（ComposerOptions + `buildDynamicContextMessage`）
- Modify: `packages/core/src/engine/engine.ts`（composer 构建处传 provider）
- Test: `packages/core/src/prompt/composer.sources.test.ts`

- [ ] **Step 1: Failing test**

```ts
// packages/core/src/prompt/composer.sources.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptComposer } from "./composer.js";

const cwd = mkdtempSync(join(tmpdir(), "cs-composer-src-"));

describe("composer sources context", () => {
  test("provider output rides the dynamic context message", async () => {
    const composer = new PromptComposer({
      cwd, model: "m",
      sourcesContextProvider: () => "## Bound data sources\n- m1 (mock, ok): alpha",
    });
    const msg = await composer.buildDynamicContextMessage();
    expect(msg?.content).toContain("Bound data sources");
  });

  test("empty provider output → not injected", async () => {
    const composer = new PromptComposer({ cwd, model: "m", sourcesContextProvider: () => "" });
    const msg = await composer.buildDynamicContextMessage();
    expect(msg?.content ?? "").not.toContain("Bound data sources");
  });
});
```

- [ ] **Step 2: Implement**

`ComposerOptions` 加：

```ts
  /** 已绑定数据源的 metadata 摘要（名称/scope/状态；无源返回 ""）。走动态
   *  上下文（不进可缓存 system 前缀），内容永不注入（ADR §5/§7）。 */
  sourcesContextProvider?: () => string | Promise<string>;
```

`buildDynamicContextMessage()`（~136 行）里 `const memoryContext = this.getMemoryContext();` 旁加：

```ts
    const sourcesContext = this.options.sourcesContextProvider
      ? await Promise.resolve(this.options.sourcesContextProvider()).catch(() => "")
      : "";
```

并把 `sourcesContext` 加进 `parts` 数组（memoryContext 之后）。

engine（composer 构建处，Task 8 of profile 计划加的 `workspaceProfile` 一带）加：

```ts
        sourcesContextProvider: () => buildSourcesContextSummary(cwd),
```

`buildSourcesContextSummary` 放 `packages/core/src/sources/context-summary.ts`：调 `resolveEffectiveSourceAccess`（settings 用 engine 的 `this.getSettingsManager()` 传入或函数内自建），**只输出源名/kind/状态/scope 名摘要，无 binding 返回 ""**；≤ 20 行普通字符串拼接，写完补一个单测覆盖"无源返回空串"。

- [ ] **Step 3: Run**：`bun test packages/core/src/prompt/ packages/core/src/sources/ 2>&1 | tail -3` 全 PASS
- [ ] **Step 4: Commit**：`git commit -am "feat(sources): dynamic-context metadata injection (no content, absent when unbound)"`

---

### Task 11: core 导出 + 契约测试

**Files:**
- Create: `packages/core/src/sources/index.ts`（barrel：types/catalog/adapter/adapters×3/binding/resolve/credential-status/context-summary 全部再导出）
- Modify: `packages/core/src/index.ts`（公共导出一段，样板 = profile 导出块）

- [ ] Steps：barrel → 公共导出 → `bun test packages/core/src/index.exports.test.ts`（该测试约束 internal 入口，公共导出不该影响；失败则按输出登记）→ `bun test packages/core/ 2>&1 | tail -3` 全 PASS → commit `feat(sources): public exports`。

---

### Task 12: desktop main — sources service + IPC + preload

**Files:**
- Create: `packages/desktop/src/main/sources-service.ts`
- Modify: `packages/desktop/src/main/index.ts`（IPC 注册，样板 :1600 capabilities 块 + :2820 dialog 用法）
- Modify: `packages/desktop/src/preload/index.ts` + `types.d.ts`
- Test: `packages/desktop/src/main/sources-service.test.ts`

- [ ] **Step 1: Service**（完整实现；测试模仿 `profiles-service.test.ts` 的 CODE_SHELL_HOME 隔离，覆盖 catalog CRUD / bind / unbind / upload 拷贝 / uploads 列表 / 删除上传文件）

```ts
// packages/desktop/src/main/sources-service.ts
/** 数据源的 desktop main 门面（组合 core 公共 API，样板 = profiles-service.ts）。 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  bindSource, deleteSourceDefinition, listBindings, listLocalFiles,
  listSourceDefinitions, resolveEffectiveSourceAccess, saveSourceDefinition,
  SettingsManager, unbindSource, uploadsDir, defaultCredentialStatus,
} from "@cjhyy/code-shell-core";

export function catalogList() {
  return listSourceDefinitions();
}
export function catalogSave(def: Parameters<typeof saveSourceDefinition>[0]) {
  saveSourceDefinition(def);
}
export function catalogDelete(id: string) {
  deleteSourceDefinition(id);
}

export function workspaceAccess(cwd: string) {
  const sm = new SettingsManager(cwd, "full");
  return {
    bindings: listBindings(sm, cwd),
    access: resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: defaultCredentialStatus }),
    uploads: listLocalFiles(cwd),
  };
}

export function bind(cwd: string, binding: Parameters<typeof bindSource>[2]) {
  bindSource(new SettingsManager(cwd, "full"), cwd, binding);
}
export function unbind(cwd: string, sourceId: string) {
  unbindSource(new SettingsManager(cwd, "full"), cwd, sourceId);
}

/** 上传 = 把用户选中的文件拷进 uploads 目录（同名覆盖）。 */
export function uploadFiles(cwd: string, absolutePaths: string[]): string[] {
  const dir = uploadsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  for (const p of absolutePaths) {
    const name = basename(p);
    copyFileSync(p, join(dir, name));
    copied.push(name);
  }
  return copied;
}

export function deleteUpload(cwd: string, name: string) {
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`invalid upload name: ${name}`);
  }
  rmSync(join(uploadsDir(cwd), name), { force: true });
}
```

- [ ] **Step 2: IPC**（在 capabilities 块后注册；全部做参数类型校验，样板同块）：
`sources:catalogList` / `sources:catalogSave` / `sources:catalogDelete` / `sources:workspaceAccess(cwd)` / `sources:bind(cwd, binding)` / `sources:unbind(cwd, sourceId)` / `sources:listScopes(sourceId)`（service 里查 catalog 取 def → `connectorAdapterFor(def.kind).listScopes(def)`；Task 13 的 scope 勾选框用它）/ `sources:pickAndUpload(cwd)`（main 内 `dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] })` → `uploadFiles`，样板 :2820）/ `sources:deleteUpload(cwd, name)`。

- [ ] **Step 3: preload + types.d.ts**（样板 :895 一段）：暴露同名八个方法。

- [ ] **Step 4: Run**：service 测试 PASS + `cd packages/desktop && bun run typecheck`
- [ ] **Step 5: Commit**：`git commit -am "feat(desktop): sources service, IPC and preload surface"`

---

### Task 13: desktop renderer — 项目配置中心页

**Files:**
- Create: `packages/desktop/src/renderer/project-config/ProjectConfigPage.tsx`
- Create: `packages/desktop/src/renderer/project-config/DataSourcesSection.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`（新增 viewMode `"project_config"`，渲染与入口）
- Modify: i18n ns（新增 `projectConfig.*` keys，中英双语）
- Test: `packages/desktop/src/renderer/project-config/DataSourcesSection.test.tsx`

- [ ] **Step 1: 页面框架**

`ProjectConfigPage`（接 `cwd` prop）四个区块按序渲染：
1. `DataSourcesSection`（本 task 新建）
2. `ProfileSection`（直接复用 `../settings/ProfileSection`）
3. 项目指令：只读展示 `CLAUDE.md` 是否存在 + "在编辑器打开"按钮（走现有 fs IPC；MVP 不做内嵌编辑器）
4. 能力开关：复用 `CapabilitiesOverviewSection`（传同样的 props；读 SettingsPage.tsx 里它的取参方式照搬）

App.tsx：viewMode 联合类型加 `"project_config"`；渲染方式模仿 `isSettingsPage`（:1726 与 :2128 两处的 hidden/条件渲染样板）；入口：TopBar 的 workspace 指示器点击菜单/现有项目上下文菜单里加"项目配置"项（读 WorkspaceIndicator 现有交互后选自然位置，跳转 `setViewMode("project_config")`）。

- [ ] **Step 2: DataSourcesSection**（完整组件，shadcn/ui + Tailwind 语义 token，样板 ProfileSection.tsx）：

三块 UI：
- **上传文件**：`Button` "上传文件" → `window.codeshell.pickAndUploadSources(cwd)`；下方列 `uploads`（名字+大小+删除按钮 → `deleteUpload`）。
- **已绑定源**：列 `access`（label/kind/status 徽标——`ok`=default、`dangling`/`unavailable`=destructive 徽标、readPolicy）+ 解绑按钮。
- **绑定新源**：`Select` 列 catalog 中未绑定的 source → 选中后调 `listScopes`？（MVP 简化：绑定对话框里 scope 输入为多选 checkbox，选项来自 `sources:workspaceAccess` 无法提供的 scope 列表——给 main 加 `sources:listScopes(sourceId)` IPC 一并在 Task 12 补上，adapter 侧已有 `listScopes`）→ 勾 scope → `bind`。

状态刷新：每次操作后重拉 `workspaceAccess`；错误用区块内 `text-status-err` 行展示（同 ProfileSection 手法）。

- [ ] **Step 3: i18n**（`projectConfig.title/dataSources/upload/bound/bindNew/scopes/unbind/deleteUpload/statusOk/statusDangling/statusUnavailable/...` 中英双份，结构模仿 settings ns 的 profiles 块）。

- [ ] **Step 4: Test**：模仿 ProfileSection.test.tsx 的 mock `window.codeshell` 方式，断言：access 两项渲染两行、dangling 显示失效徽标、点解绑调用 `unbindSource` IPC、上传列表渲染与删除调用。

- [ ] **Step 5: Run + typecheck + commit**：`bun test packages/desktop/src/renderer/project-config/ && cd packages/desktop && bun run typecheck && cd ../..` → `git commit -am "feat(desktop): project config center page with data sources section"`

---

### Task 13b: 全局 Connections 数据化（最小，ADR §9 第 10 项后半）

**Files:**
- Modify: `packages/desktop/src/renderer/credentials/LinkTab.tsx`（或其同级新组件，读文件后选自然挂点）
- Test: 同目录新建对应测试

- [ ] 在 Link/Connections 页现有静态 catalog 之外，加一个"自定义数据源"最小区块：从 `sources:catalogList` 渲染（id/kind/label/enabled 徽标），提供 **新建**（最小表单：id + kind 下拉 mock|mcp-resource + label + server（kind=mcp-resource 时必填）→ `sources:catalogSave`）、**启用/禁用**（save enabled 翻转）、**删除**（`sources:catalogDelete`，确认后执行）。不动现有 OAuth catalog 卡片。i18n 双语。测试断言：列表渲染、新建调用 catalogSave、删除需确认。

- [ ] Run + typecheck + commit：`git commit -am "feat(desktop): minimal data-source catalog management in Connections"`

---

### Task 14: mock 纵切 e2e（ToolRegistry harness）

**Files:**
- Test: `packages/core/src/sources/e2e-mock-vertical.test.ts`

- [ ] 用 `createToolRegistryHarness`/`createFakeToolContext`（core 公共导出，P7 基建）驱动完整链路，不起 Electron：

```
准备：临时 CODE_SHELL_HOME + 临时 cwd；catalog 存 mock 源
1. bind m1(scopes:["alpha"]) → ListSources 出现 m1 + alpha 且不含内容
2. ReadSource(m1, alpha, alpha/doc-1) → 内容 + provenance + untrusted 包裹
3. ReadSource(m1, beta, ...) → Error（scope 未绑定）
4. unbind → ListSources 无 m1；ReadSource → Error（未绑定）
5. 禁用源（enabled:false）后重新 bind → status unavailable，ReadSource 拒绝
6. readPolicy:"deny" → list 可见、read 拒绝
```

harness 的权限面用 fake context 的默认（审批在 permissionDefault 层由 registry 声明，e2e 里直接调 execute 验证业务逻辑；`permissionDefault:"ask"` 的注册属性已在 Task 9 的注册代码里静态可断言——加一条断言：从 registry 读 `ReadSource` 定义，`expect(def.permissionDefault).toBe("ask")`）。

- [ ] Run：PASS → `git commit -am "test(sources): mock connector vertical e2e via tool-registry harness"`

---

### Task 15: 全量回归 + TODO 更新

- [ ] **Step 1: Regression**

```bash
bun test 2>&1 | tail -5                       # 0 fail
bun run typecheck 2>&1 | grep -c 'error TS'   # = 31（既有基线，不新增）
cd packages/desktop && bun run typecheck && bun run build && cd ../..
bun run lint 2>&1 | tail -3
```

- [ ] **Step 2: TODO.md**

把「Workspace 数据源绑定」条目改写为"只读 MVP 已完成（日期 + 本计划路径 + ADR 路径），剩余阶段：真实 OAuth provider adapter、Profile 求交接线（resolver `profile` 参数已留）、写操作、上传文件解析/索引"，格式模仿数字人条目。

- [ ] **Step 3: Commit**：`git commit -am "docs(todo): record datasource read-only MVP completion"`

---

## 验收清单（对照 ADR §9）

- [ ] 三层模型落地：catalog（全局）/ binding（项目，无 secret）/ resolver（默认 deny、dangling/unavailable 显式）
- [ ] mock / mcp-resource / local-files 三 adapter，core 无 provider 特判
- [ ] 上传：文件进 `${cwd}/.code-shell/uploads/`，路径逃逸被拒，隐式源可 list/read
- [ ] ListSources 自动允许且只含 metadata；ReadSource 注册为 `permissionDefault:"ask"`，带二次校验 + provenance + 256KiB 截断 + untrusted 包裹
- [ ] readPolicy 仅 ask/deny；deny 下 list 可见 read 拒绝
- [ ] 凭证过期/缺失 → unavailable；源删除 → dangling；unbind 立即不可见
- [ ] 动态上下文只注入 metadata 摘要，无源不注入
- [ ] resolver 留 `profile?` 参数未接线
- [ ] desktop 项目配置中心页：上传/绑定/scope 勾选/解绑/状态徽标；复用 ProfileSection 与能力区块
- [ ] mock 纵切 e2e 六步全绿；全量 bun test 0 fail；root typecheck 不新增；desktop typecheck/build 通过

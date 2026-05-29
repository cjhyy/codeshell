# Plugin CC+Codex Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `codeshell plugin install <local-path>` that installs both CC-format and Codex-format plugins into `~/.code-shell/plugins/<name>/`, converting Codex MCP/skills/agents to CC layout at install time.

**Architecture:** A new `packages/core/src/plugins/installer/` module. Pure converters (format detect, manifest parse, Codex→CC agent/skill/mcp transform) are unit-tested with tmpdir fixtures; an `install()` orchestrator dispatches CC vs Codex and writes the result + `.cs-meta.json`. A thin commander factory in `packages/tui` exposes the `plugin install` subcommand. Runtime loaders (M5) and update/list/uninstall (rest of M4) follow in a later plan.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Bun test runner (`bun:test`), `zod` (validation), `yaml` (frontmatter via existing `serializeAgentDefinition`), `smol-toml` (NEW dep for Codex agent TOML), `commander` (CLI).

Spec: `docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`

## Scope of THIS plan

Covers spec **M1 (skeleton) + M2 (CC install) + M3 (Codex converters) + M4-install (dispatch + CLI install only)**. Produces a working `codeshell plugin install`. **Out of scope here** (next plan): `update`/`list`/`uninstall` commands, runtime loaders (M5: loadPluginAgents/loadPluginMcp + EngineConfig merge), failure-matrix polish (M6). These are listed at the end.

## File Structure

- `packages/core/src/plugins/installer/types.ts` — zod schemas (`CodexPluginManifest`, `CSMeta`) + error classes.
- `packages/core/src/plugins/installer/detectFormat.ts` — `detectPluginFormat()`.
- `packages/core/src/plugins/installer/paths.ts` — install-dir + meta-path resolution.
- `packages/core/src/plugins/installer/codex/convertAgents.ts` — TOML→CC `AgentDefinition` + serialize.
- `packages/core/src/plugins/installer/codex/convertMcp.ts` — extract `.mcp.json`/inline → `mcp-servers.json` content.
- `packages/core/src/plugins/installer/codex/convertSkills.ts` — `cp -r skills/`.
- `packages/core/src/plugins/installer/install.ts` — orchestrator (dispatch + write meta).
- `packages/core/src/plugins/installer/*.test.ts` — colocated tests.
- `packages/tui/src/cli/commands/plugin.ts` — `createPluginCommand()`.
- Modify `packages/tui/src/cli/main.ts` — register the command.
- Modify `packages/core/src/index.ts` — export installer public API.
- Modify `packages/core/package.json` — add `smol-toml`.

---

### Task 1: Add smol-toml dependency

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add the dependency**

Run: `cd packages/core && bun add smol-toml`
Expected: `smol-toml` appears in `dependencies`, lockfile updated.

- [ ] **Step 2: Verify it imports under bun**

Run: `cd packages/core && bun -e "import { parse } from 'smol-toml'; console.log(typeof parse)"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json ../../bun.lock
git commit -m "build(core): add smol-toml for Codex agent TOML parsing"
```

---

### Task 2: types.ts — manifest + meta schemas + errors

**Files:**
- Create: `packages/core/src/plugins/installer/types.ts`
- Test: `packages/core/src/plugins/installer/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { CodexPluginManifest, CSMeta, PluginInstallError } from "./types.js";

describe("CodexPluginManifest", () => {
  test("accepts minimal manifest with string mcpServers ref", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1.0.0", mcpServers: "./.mcp.json" });
    expect(m.name).toBe("p");
    expect(m.mcpServers).toBe("./.mcp.json");
  });
  test("accepts inline mcpServers object", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1", mcpServers: { foo: { command: "x" } } });
    expect(typeof m.mcpServers).toBe("object");
  });
  test("preserves unknown fields via passthrough", () => {
    const m = CodexPluginManifest.parse({ name: "p", version: "1", futureField: 42 }) as Record<string, unknown>;
    expect(m.futureField).toBe(42);
  });
  test("rejects missing name", () => {
    expect(() => CodexPluginManifest.parse({ version: "1" })).toThrow();
  });
});

describe("CSMeta", () => {
  test("round-trips a codex meta", () => {
    const meta = CSMeta.parse({
      name: "p", format: "codex", version: "1.2.3",
      source: "/abs/src", installedAt: "2026-05-29T10:00:00Z",
    });
    expect(meta.format).toBe("codex");
  });
});

describe("PluginInstallError", () => {
  test("carries a message", () => {
    const e = new PluginInstallError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PluginInstallError");
    expect(e.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/types.test.ts`
Expected: FAIL — `Cannot find module './types.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
import { z } from "zod";

/** Codex `.codex-plugin/plugin.json`. v1 reads required fields; unknowns pass through. */
export const CodexPluginManifest = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    // string → relative path to a .mcp.json; object → inline mcpServers map
    mcpServers: z.union([z.string(), z.record(z.any())]).optional(),
    skills: z.string().optional(),
    agents: z.string().optional(),
  })
  .passthrough();

export type CodexPluginManifest = z.infer<typeof CodexPluginManifest>;

/** `.cs-meta.json` written into every installed plugin dir. */
export const CSMeta = z.object({
  name: z.string(),
  format: z.enum(["cc", "codex"]),
  version: z.string().optional(),
  source: z.string(),
  installedAt: z.string(),
});

export type CSMeta = z.infer<typeof CSMeta>;

export class PluginInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInstallError";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/types.ts packages/core/src/plugins/installer/types.test.ts
git commit -m "feat(plugin-installer): manifest + meta zod schemas + error type"
```

---

### Task 3: detectFormat.ts

**Files:**
- Create: `packages/core/src/plugins/installer/detectFormat.ts`
- Test: `packages/core/src/plugins/installer/detectFormat.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPluginFormat } from "./detectFormat.js";

describe("detectPluginFormat", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-fmt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns codex when .codex-plugin/plugin.json exists", () => {
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), "{}");
    expect(detectPluginFormat(dir)).toBe("codex");
  });

  test("returns cc otherwise", () => {
    mkdirSync(join(dir, "skills"), { recursive: true });
    expect(detectPluginFormat(dir)).toBe("cc");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/detectFormat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Binary detection: a Codex plugin has `.codex-plugin/plugin.json`; everything else is CC. */
export function detectPluginFormat(sourceDir: string): "codex" | "cc" {
  return existsSync(join(sourceDir, ".codex-plugin", "plugin.json")) ? "codex" : "cc";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/detectFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/detectFormat.ts packages/core/src/plugins/installer/detectFormat.test.ts
git commit -m "feat(plugin-installer): binary CC/Codex format detection"
```

---

### Task 4: paths.ts — install dir + meta path (with containment)

**Files:**
- Create: `packages/core/src/plugins/installer/paths.ts`
- Test: `packages/core/src/plugins/installer/paths.test.ts`

Reuses the `userHome()` convention (`process.env.HOME ?? homedir()`) seen in `installedPlugins.ts:11-13`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { pluginInstallDir, pluginMetaPath, assertSafePluginName } from "./paths.js";

describe("plugin paths", () => {
  test("install dir is a direct child of ~/.code-shell/plugins", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/fakehome";
    try {
      expect(pluginInstallDir("foo")).toBe("/tmp/fakehome/.code-shell/plugins/foo");
      expect(pluginMetaPath("foo")).toBe(join("/tmp/fakehome/.code-shell/plugins/foo", ".cs-meta.json"));
    } finally {
      process.env.HOME = prev;
    }
  });

  test("assertSafePluginName rejects path traversal and separators", () => {
    expect(() => assertSafePluginName("../evil")).toThrow();
    expect(() => assertSafePluginName("a/b")).toThrow();
    expect(() => assertSafePluginName("")).toThrow();
    expect(() => assertSafePluginName("..")).toThrow();
  });

  test("assertSafePluginName accepts a normal name", () => {
    expect(() => assertSafePluginName("my-plugin")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginInstallError } from "./types.js";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

/** A plugin name must be a single safe path segment — no separators, no traversal. */
export function assertSafePluginName(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new PluginInstallError(`invalid plugin name: ${JSON.stringify(name)}`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new PluginInstallError(`plugin name must be a single path segment: ${JSON.stringify(name)}`);
  }
}

export function pluginsRoot(): string {
  return join(userHome(), ".code-shell", "plugins");
}

export function pluginInstallDir(name: string): string {
  assertSafePluginName(name);
  return join(pluginsRoot(), name);
}

export function pluginMetaPath(name: string): string {
  return join(pluginInstallDir(name), ".cs-meta.json");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/paths.ts packages/core/src/plugins/installer/paths.test.ts
git commit -m "feat(plugin-installer): install-dir/meta-path resolution + name containment"
```

---

### Task 5: codex/convertAgents.ts — TOML → CC AgentDefinition

**Files:**
- Create: `packages/core/src/plugins/installer/codex/convertAgents.ts`
- Test: `packages/core/src/plugins/installer/codex/convertAgents.test.ts`

Spec §6.6 + §7.1: only `name`/`description`/`model` map to real CC fields (+ `developer_instructions`→body). Everything else gets a `codex_` prefix. Missing `name`/`description` → throw (whole-install failure). Reuses `serializeAgentDefinition` for `name`/`description`/`model`/body, then appends `codex_*` lines into the frontmatter manually (since `AgentDefinition` can't hold them).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { convertCodexAgentToml } from "./convertAgents.js";

describe("convertCodexAgentToml", () => {
  test("maps name/description/model and developer_instructions→body", () => {
    const toml = [
      'name = "researcher"',
      'description = "Read-only research"',
      'model = "flash"',
      'developer_instructions = "Investigate. Never edit."',
    ].join("\n");
    const md = convertCodexAgentToml(toml, "researcher.toml", "myplugin");
    expect(md).toContain("name: researcher");
    expect(md).toContain("description: Read-only research");
    expect(md).toContain("model: flash");
    expect(md).toContain("Investigate. Never edit.");
  });

  test("preserves unmappable fields with codex_ prefix", () => {
    const toml = [
      'name = "a"', 'description = "d"',
      'model_reasoning_effort = "high"',
      'sandbox_mode = "read-only"',
    ].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_model_reasoning_effort: high");
    expect(md).toContain("codex_sandbox_mode: read-only");
    expect(md).not.toContain("thinking:");
  });

  test("rewrites mcp_servers values to <plugin>:<server> under codex_mcp_servers", () => {
    const toml = ['name = "a"', 'description = "d"', 'mcp_servers = ["fs", "gh"]'].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_mcp_servers:");
    expect(md).toContain("myplugin:fs");
    expect(md).toContain("myplugin:gh");
  });

  test("double-prefixes a field that already starts with codex_", () => {
    const toml = ['name = "a"', 'description = "d"', 'codex_foo = "x"'].join("\n");
    const md = convertCodexAgentToml(toml, "a.toml", "myplugin");
    expect(md).toContain("codex_codex_foo: x");
  });

  test("throws when name is missing", () => {
    expect(() => convertCodexAgentToml('description = "d"', "bad.toml", "p")).toThrow(/name/);
  });

  test("throws when description is missing", () => {
    expect(() => convertCodexAgentToml('name = "a"', "bad.toml", "p")).toThrow(/description/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/codex/convertAgents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { parse as parseToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import { serializeAgentDefinition } from "../../../agent/agent-definition.js";
import { PluginInstallError } from "../types.js";

const MAPPED = new Set(["name", "description", "model", "developer_instructions"]);

/**
 * Convert one Codex agent TOML into a CC agent Markdown string.
 * Real CC fields: name, description, model, body(=developer_instructions).
 * Every other field is preserved with a `codex_` prefix (v1 inert; see spec §7.1).
 * `mcp_servers` values are rewritten to `<plugin>:<server>` to match the MCP merge key.
 */
export function convertCodexAgentToml(
  toml: string,
  sourceName: string,
  pluginName: string,
): string {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(toml) as Record<string, unknown>;
  } catch (err) {
    throw new PluginInstallError(`${sourceName}: invalid TOML — ${(err as Error).message}`);
  }

  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new PluginInstallError(`${sourceName}: missing required 'name'`);
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    throw new PluginInstallError(`${sourceName}: missing required 'description'`);
  }

  const body =
    typeof raw.developer_instructions === "string" ? raw.developer_instructions.trim() : "";

  const base = serializeAgentDefinition({
    name: raw.name.trim(),
    description: raw.description.trim(),
    systemPrompt: body,
    ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
  });

  // Collect codex_-prefixed extras.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MAPPED.has(key)) continue;
    let outKey = key.startsWith("codex_") ? `codex_${key}` : `codex_${key}`;
    if (key === "mcp_servers" && Array.isArray(value)) {
      extras[outKey] = value.map((s) => (typeof s === "string" ? `${pluginName}:${s}` : s));
    } else {
      extras[outKey] = value;
    }
  }

  if (Object.keys(extras).length === 0) return base;

  // Splice the extra YAML lines into the existing frontmatter block.
  const extraYaml = stringifyYaml(extras).trimEnd();
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(base);
  if (!match) throw new PluginInstallError(`${sourceName}: internal — serializer produced no frontmatter`);
  const [, fm, rest] = match;
  return `---\n${fm}\n${extraYaml}\n---\n${rest}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/codex/convertAgents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/codex/convertAgents.ts packages/core/src/plugins/installer/codex/convertAgents.test.ts
git commit -m "feat(plugin-installer): Codex agent TOML → CC Markdown converter"
```

---

### Task 6: codex/convertMcp.ts — extract mcpServers → map

**Files:**
- Create: `packages/core/src/plugins/installer/codex/convertMcp.ts`
- Test: `packages/core/src/plugins/installer/codex/convertMcp.test.ts`

Spec §6.4: `manifest.mcpServers` is either a string (relative path to `.mcp.json` whose top-level `mcpServers` key holds the map) or an inline object. Field passthrough (standard MCP schema). Returns the raw server map; the orchestrator writes it to `mcp-servers.json`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCodexMcpServers } from "./convertMcp.js";

describe("resolveCodexMcpServers", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cs-mcp-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns inline object as-is", () => {
    const servers = resolveCodexMcpServers(dir, { foo: { command: "x" } });
    expect(servers).toEqual({ foo: { command: "x" } });
  });

  test("reads a referenced .mcp.json (mcpServers key)", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { gh: { command: "g" } } }));
    const servers = resolveCodexMcpServers(dir, "./.mcp.json");
    expect(servers).toEqual({ gh: { command: "g" } });
  });

  test("reads a referenced .mcp.json that IS the map (no mcpServers wrapper)", () => {
    writeFileSync(join(dir, "m.json"), JSON.stringify({ gh: { command: "g" } }));
    const servers = resolveCodexMcpServers(dir, "m.json");
    expect(servers).toEqual({ gh: { command: "g" } });
  });

  test("returns empty when undefined", () => {
    expect(resolveCodexMcpServers(dir, undefined)).toEqual({});
  });

  test("throws on malformed referenced json", () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => resolveCodexMcpServers(dir, "bad.json")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/codex/convertMcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginInstallError } from "../types.js";

/**
 * Resolve a Codex manifest's mcpServers declaration into a plain server map.
 * - object → returned as-is (inline)
 * - string → read that file relative to sourceDir; accept either a bare map
 *   or a `{ mcpServers: {...} }` wrapper.
 * - undefined → {}
 */
export function resolveCodexMcpServers(
  sourceDir: string,
  decl: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (decl === undefined) return {};
  if (typeof decl === "object") return decl;

  const path = join(sourceDir, decl);
  if (!existsSync(path)) {
    throw new PluginInstallError(`mcpServers ref not found: ${decl}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new PluginInstallError(`invalid mcp json ${decl}: ${(err as Error).message}`);
  }
  if (parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)) {
    return (parsed as { mcpServers: Record<string, unknown> }).mcpServers ?? {};
  }
  return (parsed as Record<string, unknown>) ?? {};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/codex/convertMcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/codex/convertMcp.ts packages/core/src/plugins/installer/codex/convertMcp.test.ts
git commit -m "feat(plugin-installer): resolve Codex mcpServers (inline or .mcp.json ref)"
```

---

### Task 7: codex/convertSkills.ts — copy skills dir

**Files:**
- Create: `packages/core/src/plugins/installer/codex/convertSkills.ts`
- Test: `packages/core/src/plugins/installer/codex/convertSkills.test.ts`

Spec §6.5: identical frontmatter, just `cp -r`. Plus a minimal frontmatter check (spec §10 row "Skill 文件缺 frontmatter → 整装失败").

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyCodexSkills } from "./convertSkills.js";

describe("copyCodexSkills", () => {
  let src: string, dest: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "cs-skill-src-"));
    dest = mkdtempSync(join(tmpdir(), "cs-skill-dest-"));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  test("copies skills/<name>/SKILL.md into dest", () => {
    mkdirSync(join(src, "skills", "foo"), { recursive: true });
    writeFileSync(join(src, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: d\n---\nbody");
    copyCodexSkills(src, dest);
    expect(existsSync(join(dest, "skills", "foo", "SKILL.md"))).toBe(true);
  });

  test("no-op when source has no skills dir", () => {
    copyCodexSkills(src, dest);
    expect(existsSync(join(dest, "skills"))).toBe(false);
  });

  test("throws when a SKILL.md lacks frontmatter", () => {
    mkdirSync(join(src, "skills", "bad"), { recursive: true });
    writeFileSync(join(src, "skills", "bad", "SKILL.md"), "no frontmatter here");
    expect(() => copyCodexSkills(src, dest)).toThrow(/frontmatter/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/codex/convertSkills.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { existsSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { PluginInstallError } from "../types.js";

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---/;

/**
 * Copy <sourceDir>/skills into <destDir>/skills verbatim (Codex & CC SKILL.md
 * are isomorphic). Validates each SKILL.md has a frontmatter block first — a
 * malformed skill fails the whole install (spec §10).
 */
export function copyCodexSkills(sourceDir: string, destDir: string): void {
  const skillsSrc = join(sourceDir, "skills");
  if (!existsSync(skillsSrc)) return;

  for (const dirent of readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const skillFile = join(skillsSrc, dirent.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const raw = readFileSync(skillFile, "utf-8").trim();
    if (!FRONTMATTER.test(raw)) {
      throw new PluginInstallError(`skills/${dirent.name}/SKILL.md: missing frontmatter`);
    }
  }
  cpSync(skillsSrc, join(destDir, "skills"), { recursive: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/codex/convertSkills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/codex/convertSkills.ts packages/core/src/plugins/installer/codex/convertSkills.test.ts
git commit -m "feat(plugin-installer): copy Codex skills with frontmatter validation"
```

---

### Task 8: install.ts — orchestrator (dispatch + write)

**Files:**
- Create: `packages/core/src/plugins/installer/install.ts`
- Test: `packages/core/src/plugins/installer/install.test.ts`

Ties it together. CC path = `cp -r` whole source. Codex path = parse manifest, run 3 converters into a fresh dir, write `mcp-servers.json` if non-empty. Both write `.cs-meta.json`. Refuses if install dir exists (spec §9.1). Writes to a temp dir then renames (spec §6.7 — never leave a half dir on failure; uses `installedAt` passed in, since `Date.now()` is unavailable in some contexts — caller stamps).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPluginFromPath } from "./install.js";

const STAMP = "2026-05-29T10:00:00Z";

describe("installPluginFromPath", () => {
  let home: string, src: string, prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("installs a CC plugin: copies dir + writes cc meta", () => {
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    const dir = installPluginFromPath(src, "ccplug", STAMP);
    expect(existsSync(join(dir, "skills", "s", "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "ccplug", format: "cc", source: src, installedAt: STAMP });
  });

  test("installs a Codex plugin: converts agent + writes mcp-servers.json + codex meta", () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "cx", version: "2.0.0", mcpServers: { fs: { command: "f" } } }),
    );
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "r.toml"), 'name = "r"\ndescription = "d"\nmodel = "flash"');
    const dir = installPluginFromPath(src, "cx", STAMP);
    // agent converted to .md
    const md = readFileSync(join(dir, "agents", "r.md"), "utf-8");
    expect(md).toContain("name: r");
    expect(md).toContain("model: flash");
    // mcp written with <plugin>:<server> key
    const mcp = JSON.parse(readFileSync(join(dir, "mcp-servers.json"), "utf-8"));
    expect(mcp["cx:fs"]).toMatchObject({ command: "f", name: "cx:fs" });
    // meta
    const meta = JSON.parse(readFileSync(join(dir, ".cs-meta.json"), "utf-8"));
    expect(meta).toMatchObject({ name: "cx", format: "codex", version: "2.0.0" });
  });

  test("refuses when install dir already exists", () => {
    mkdirSync(join(home, ".code-shell", "plugins", "dup"), { recursive: true });
    expect(() => installPluginFromPath(src, "dup", STAMP)).toThrow(/already installed/);
  });

  test("leaves no install dir when conversion fails", () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "x", version: "1" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "bad.toml"), 'description = "no name"'); // missing name → throw
    expect(() => installPluginFromPath(src, "x", STAMP)).toThrow(/name/);
    expect(existsSync(join(home, ".code-shell", "plugins", "x"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && bun test src/plugins/installer/install.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  cpSync, rmSync, renameSync, statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { detectPluginFormat } from "./detectFormat.js";
import { pluginInstallDir, pluginsRoot, assertSafePluginName } from "./paths.js";
import { CodexPluginManifest, type CSMeta, PluginInstallError } from "./types.js";
import { convertCodexAgentToml } from "./codex/convertAgents.js";
import { resolveCodexMcpServers } from "./codex/convertMcp.js";
import { copyCodexSkills } from "./codex/convertSkills.js";

/**
 * Install a local plugin directory into ~/.code-shell/plugins/<name>/.
 * Builds into a temp sibling dir, then renames into place — a conversion
 * failure leaves nothing behind. `installedAt` is passed in (caller stamps the
 * timestamp) to keep this function pure of the unavailable Date.now().
 */
export function installPluginFromPath(
  sourceDir: string,
  name: string,
  installedAt: string,
): string {
  assertSafePluginName(name);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new PluginInstallError(`source is not a directory: ${sourceDir}`);
  }
  const finalDir = pluginInstallDir(name);
  if (existsSync(finalDir)) {
    throw new PluginInstallError(
      `plugin '${name}' already installed; uninstall first or rename the source`,
    );
  }
  mkdirSync(pluginsRoot(), { recursive: true });
  const tmpDir = join(pluginsRoot(), `.tmp-${name}-${process.pid}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    const format = detectPluginFormat(sourceDir);
    let meta: CSMeta;

    if (format === "cc") {
      cpSync(sourceDir, tmpDir, { recursive: true });
      meta = { name, format: "cc", source: sourceDir, installedAt };
    } else {
      const manifest = CodexPluginManifest.parse(
        JSON.parse(readFileSync(join(sourceDir, ".codex-plugin", "plugin.json"), "utf-8")),
      );
      // skills (verbatim copy)
      copyCodexSkills(sourceDir, tmpDir);
      // agents (TOML → MD)
      convertAgentsInto(sourceDir, tmpDir, name);
      // mcp → mcp-servers.json keyed <plugin>:<server>
      const servers = resolveCodexMcpServers(sourceDir, manifest.mcpServers);
      const keyed: Record<string, unknown> = {};
      for (const [serverName, cfg] of Object.entries(servers)) {
        const key = `${name}:${serverName}`;
        keyed[key] = { ...(cfg as object), name: key };
      }
      if (Object.keys(keyed).length > 0) {
        writeFileSync(join(tmpDir, "mcp-servers.json"), JSON.stringify(keyed, null, 2));
      }
      meta = { name, format: "codex", version: manifest.version, source: sourceDir, installedAt };
    }

    writeFileSync(join(tmpDir, ".cs-meta.json"), JSON.stringify(meta, null, 2));
    renameSync(tmpDir, finalDir);
    return finalDir;
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Walk <sourceDir>/agents/**.toml → <destDir>/agents/**.md (structure preserved). */
function convertAgentsInto(sourceDir: string, destDir: string, pluginName: string): void {
  const agentsSrc = join(sourceDir, "agents");
  if (!existsSync(agentsSrc)) return;

  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) { walk(abs); continue; }
      if (!dirent.name.endsWith(".toml")) continue;
      const rel = relative(agentsSrc, abs).replace(/\.toml$/, ".md");
      const outPath = join(destDir, "agents", rel);
      mkdirSync(join(outPath, ".."), { recursive: true });
      const md = convertCodexAgentToml(readFileSync(abs, "utf-8"), rel, pluginName);
      writeFileSync(outPath, md);
    }
  };
  walk(agentsSrc);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && bun test src/plugins/installer/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/install.ts packages/core/src/plugins/installer/install.test.ts
git commit -m "feat(plugin-installer): install orchestrator (CC copy / Codex convert) with temp-dir safety"
```

---

### Task 9: Export installer API from core barrel

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the export**

Add after the Skills export block (around line 193):

```typescript
// ─── Plugin installer (CC + Codex) ───────────────────────────────
export { installPluginFromPath } from "./plugins/installer/install.js";
export { detectPluginFormat } from "./plugins/installer/detectFormat.js";
export {
  CodexPluginManifest,
  CSMeta,
  PluginInstallError,
} from "./plugins/installer/types.js";
```

- [ ] **Step 2: Typecheck + run full installer suite**

Run: `cd packages/core && npx tsc --noEmit && bun test src/plugins/installer/`
Expected: PASS, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(plugin-installer): export public API from core barrel"
```

---

### Task 10: CLI `plugin install` subcommand

**Files:**
- Create: `packages/tui/src/cli/commands/plugin.ts`
- Modify: `packages/tui/src/cli/main.ts`

Mirrors `createRunsCommand` (`packages/tui/src/cli/commands/runs.ts`). The CLI stamps `installedAt` (it has access to the real clock).

- [ ] **Step 1: Write the command factory**

```typescript
import { Command } from "commander";
import { resolve } from "node:path";
import { installPluginFromPath, PluginInstallError } from "@cjhyy/code-shell-core";

export function createPluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage plugins (CC + Codex formats)");

  plugin
    .command("install")
    .description("Install a local CC or Codex plugin directory")
    .argument("<source>", "Path to the plugin source directory")
    .option("--name <name>", "Override the installed plugin name")
    .action(async (source: string, opts: { name?: string }) => {
      const sourceDir = resolve(source);
      const name = opts.name ?? basenameOf(sourceDir);
      try {
        const dir = installPluginFromPath(sourceDir, name, new Date().toISOString());
        console.log(`Installed '${name}' → ${dir}`);
      } catch (err) {
        if (err instanceof PluginInstallError) {
          console.error(`plugin install failed: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return plugin;
}

function basenameOf(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
```

- [ ] **Step 2: Register it in main.ts**

Add the import near the other command imports and register near `program.addCommand(createRunsCommand())`:

```typescript
import { createPluginCommand } from "./commands/plugin.js";
program.addCommand(createPluginCommand());
```

- [ ] **Step 3: Typecheck tui**

Run: `cd packages/desktop 2>/dev/null; cd packages/core && bun run build && cd ../tui && npx tsc --noEmit`
Expected: PASS (core must be built so `@cjhyy/code-shell-core` dist exposes the new exports).

- [ ] **Step 4: Smoke-test the command end-to-end**

```bash
# build a throwaway codex plugin fixture
TMP=$(mktemp -d); mkdir -p "$TMP/src/.codex-plugin" "$TMP/src/agents"
echo '{"name":"smoke","version":"1.0.0","mcpServers":{"fs":{"command":"echo"}}}' > "$TMP/src/.codex-plugin/plugin.json"
printf 'name = "r"\ndescription = "d"\nmodel = "flash"\n' > "$TMP/src/agents/r.toml"
HOME="$TMP/home" bun run packages/tui/src/cli/main.ts plugin install "$TMP/src" --name smoke
ls -R "$TMP/home/.code-shell/plugins/smoke"
```
Expected: prints `Installed 'smoke' → .../smoke`; tree shows `agents/r.md`, `mcp-servers.json`, `.cs-meta.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/cli/commands/plugin.ts packages/tui/src/cli/main.ts
git commit -m "feat(cli): plugin install subcommand (CC + Codex)"
```

---

## Self-Review notes

- **Spec coverage:** §6.2 detect→T3; §6.3 manifest→T2; §6.4 mcp resolve→T6 (orchestrator keys `<plugin>:<server>` + sets `name`→T8); §6.5 skills→T7; §6.6/§7.1 agents `codex_` prefix→T5; §6.7 temp-dir-then-rename→T8; §9.1 refuse dup→T8; §8.4 name containment→T4; §10 skill-frontmatter/missing-name failures→T7/T5/T8; §8.1 install CLI→T10.
- **Deferred (next plan, stated in Scope):** §6.7 update/version compare, §8.2 update `--force`/mtime, §8.3 list, §8.4 uninstall, §M5 runtime loaders + EngineConfig merge, §M6 failure-matrix completeness + arch docs. Not silently dropped — explicitly out of this plan's scope.
- **Type consistency:** `installPluginFromPath(sourceDir, name, installedAt)`, `convertCodexAgentToml(toml, sourceName, pluginName)`, `resolveCodexMcpServers(sourceDir, decl)`, `copyCodexSkills(sourceDir, destDir)`, `CSMeta`/`CodexPluginManifest`/`PluginInstallError` — names stable across T2–T10.
- **Date.now() unavailable:** the orchestrator takes `installedAt` as a param; only the CLI (T10) calls `new Date().toISOString()`. Tests pass a fixed `STAMP`.
- **Known approximation:** `convertAgents` `codex_`-prefix branch double-prefixes any key already starting with `codex_` (spec §9.5) — covered by a test.

## Out of scope for this plan (next plan)

- `plugin update [<name>] [--force]` — version/mtime compare, temp-dir replace (spec §6.7/§8.2).
- `plugin list` — local + marketplace installs (spec §8.3).
- `plugin uninstall <name>` — with containment check (spec §8.4).
- **Runtime loaders (M5):** `loadPluginAgents.ts`, `loadPluginMcp.ts`, registration into `installed_plugins.json` so existing `loadPluginHooks`/`scanInstalledPlugins` discover the new installs; `mcp-servers.json` merge into `settings.mcpServers` **before EngineConfig construction** (spec §6.4 injection-point calibration). **This is what makes the plugin's MCP actually callable** — high priority for the very next plan.
- Failure-matrix completeness + arch-doc updates (M6).

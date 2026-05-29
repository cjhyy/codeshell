# Capability Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the "扩展能力" UI group a real backend — a control-layer projection (`list()`) over builtin/MCP/skill/plugin, plus a single switch router (`setEnabled()`), without touching the execution path.

**Architecture:** New `packages/core/src/capability-control/` module. Pure projection functions turn each loader's output + current settings into a uniform `CapabilityDescriptor[]`. `CapabilityService` composes them for `list()` and reads each descriptor's inlined `control` to route `setEnabled()` writes through the existing `SettingsManager.saveUserSetting` (dotted-path aware, atomic). Desktop adds two thin `ipcMain.handle` forwarders.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, existing `ToolRegistry` / `SettingsManager` / `scanSkills` / `readInstalledPlugins`.

Spec: `docs/superpowers/specs/2026-05-29-capability-control-design.md`

## File Structure

- Create `packages/core/src/capability-control/types.ts` — `CapabilityDescriptor`, `CapabilityControl`, `CapabilityNotFoundError`.
- Create `packages/core/src/capability-control/project.ts` — four pure projection functions + a `projectAll` composer.
- Create `packages/core/src/capability-control/service.ts` — `CapabilityService` (`list`, `setEnabled`).
- Create `packages/core/src/capability-control/index.ts` — re-exports.
- Create `packages/core/src/capability-control/project.test.ts` and `service.test.ts`.
- Modify `packages/core/src/index.ts` — export the new public API (only if the package has a barrel; check).
- Desktop wiring (Task 6) — `packages/desktop/src/main/capabilities-service.ts` + `index.ts` handlers.

---

### Task 1: Types

**Files:**
- Create: `packages/core/src/capability-control/types.ts`

- [ ] **Step 1: Write types**

```typescript
/** A uniform, read-only projection of one extension capability. */
export interface CapabilityDescriptor {
  /** Globally unique; source prefix isolates the namespace. */
  id: string;
  kind: "builtin" | "mcp" | "skill" | "plugin";
  name: string;
  description: string;
  enabled: boolean;
  control: CapabilityControl;
  origin?: {
    serverName?: string;
    pluginName?: string;
    filePath?: string;
    toolCount?: number;
    isReadOnly?: boolean;
  };
}

/** Describes which settings key the switch writes and how. */
export interface CapabilityControl {
  settingsKey:
    | "agent.enabledBuiltinTools"
    | "agent.disabledBuiltinTools"
    | "mcpServers"
    | "disabledSkills"
    | "disabledPlugins";
  mode: "denylist" | "allowlist" | "record-flag";
  token: string;
}

export class CapabilityNotFoundError extends Error {
  constructor(id: string) {
    super(`Capability not found: ${id}`);
    this.name = "CapabilityNotFoundError";
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/capability-control/types.ts
git commit -m "feat(capability-control): descriptor + control types"
```

---

### Task 2: Builtin + MCP projections (TDD)

**Files:**
- Create: `packages/core/src/capability-control/project.ts`
- Test: `packages/core/src/capability-control/project.test.ts`

Deps recap (verified): `RegisteredTool` has `{name, description, source: "builtin"|"mcp", serverName?, isReadOnly?}`. `resolveBuiltinToolNames({preset, enabledBuiltinTools, disabledBuiltinTools})` = `preset.builtinTools` ∪ enabled − disabled. Preset default set obtained from `resolveBuiltinToolNames({preset})` (no overrides). `settings.mcpServers` is `Record<string, MCPServerConfig>` with optional `enabled`.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { projectBuiltin, projectMcp } from "./project.js";
import type { RegisteredTool } from "../types.js";

const tool = (name: string, extra: Partial<RegisteredTool> = {}): RegisteredTool => ({
  name, description: `${name} desc`, inputSchema: {}, source: "builtin",
  permissionDefault: "allow" as never, ...extra,
});

describe("projectBuiltin", () => {
  it("marks preset-default tools enabled, with denylist control", () => {
    const tools = [tool("Read")];
    const out = projectBuiltin({
      tools,
      presetDefaults: ["Read", "Bash"],
      effective: ["Read", "Bash"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "builtin:Read", kind: "builtin", name: "Read", enabled: true,
      control: { settingsKey: "agent.disabledBuiltinTools", mode: "denylist", token: "Read" },
    });
  });

  it("keeps a disabled (preset-default) tool in the list, enabled:false", () => {
    const out = projectBuiltin({
      tools: [tool("Read")],
      presetDefaults: ["Read"],
      effective: [],
    });
    expect(out[0]).toMatchObject({ id: "builtin:Read", enabled: false });
    expect(out[0].control.settingsKey).toBe("agent.disabledBuiltinTools");
  });

  it("uses allowlist control for non-preset-default tools", () => {
    const out = projectBuiltin({
      tools: [tool("REPL")],
      presetDefaults: ["Read"],
      effective: ["Read", "REPL"],
    });
    expect(out[0]).toMatchObject({ enabled: true });
    expect(out[0].control).toMatchObject({
      settingsKey: "agent.enabledBuiltinTools", mode: "allowlist", token: "REPL",
    });
  });

  it("carries isReadOnly into origin", () => {
    const out = projectBuiltin({
      tools: [tool("Read", { isReadOnly: true })],
      presetDefaults: ["Read"], effective: ["Read"],
    });
    expect(out[0].origin?.isReadOnly).toBe(true);
  });
});

describe("projectMcp", () => {
  it("projects per-server, counts tools, enabled by default", () => {
    const out = projectMcp({
      mcpServers: { github: { name: "github" } },
      mcpTools: [tool("mcp_github_x", { source: "mcp", serverName: "github" })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "mcp:github", kind: "mcp", name: "github", enabled: true,
      control: { settingsKey: "mcpServers", mode: "record-flag", token: "github" },
    });
    expect(out[0].origin?.toolCount).toBe(1);
  });

  it("treats enabled:false as disabled, still lists it", () => {
    const out = projectMcp({
      mcpServers: { gh: { name: "gh", enabled: false } },
      mcpTools: [],
    });
    expect(out[0]).toMatchObject({ id: "mcp:gh", enabled: false });
    expect(out[0].origin?.toolCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd packages/core && npx vitest run src/capability-control/project.test.ts`
Expected: FAIL — `projectBuiltin`/`projectMcp` not exported.

- [ ] **Step 3: Implement the two projections**

```typescript
import type { RegisteredTool, MCPServerConfig } from "../types.js";
import type { CapabilityDescriptor } from "./types.js";

export function projectBuiltin(input: {
  tools: RegisteredTool[];
  presetDefaults: string[];
  effective: string[];
}): CapabilityDescriptor[] {
  const defaults = new Set(input.presetDefaults);
  const on = new Set(input.effective);
  return input.tools.map((t) => {
    const inPreset = defaults.has(t.name);
    return {
      id: `builtin:${t.name}`,
      kind: "builtin" as const,
      name: t.name,
      description: t.description,
      enabled: on.has(t.name),
      control: inPreset
        ? { settingsKey: "agent.disabledBuiltinTools" as const, mode: "denylist" as const, token: t.name }
        : { settingsKey: "agent.enabledBuiltinTools" as const, mode: "allowlist" as const, token: t.name },
      origin: { isReadOnly: t.isReadOnly },
    };
  });
}

export function projectMcp(input: {
  mcpServers: Record<string, MCPServerConfig>;
  mcpTools: RegisteredTool[];
}): CapabilityDescriptor[] {
  const counts = new Map<string, number>();
  for (const t of input.mcpTools) {
    if (t.source !== "mcp" || !t.serverName) continue;
    counts.set(t.serverName, (counts.get(t.serverName) ?? 0) + 1);
  }
  return Object.entries(input.mcpServers).map(([serverName, cfg]) => ({
    id: `mcp:${serverName}`,
    kind: "mcp" as const,
    name: serverName,
    description: `${counts.get(serverName) ?? 0} tools`,
    enabled: cfg.enabled !== false,
    control: { settingsKey: "mcpServers" as const, mode: "record-flag" as const, token: serverName },
    origin: { serverName, toolCount: counts.get(serverName) ?? 0 },
  }));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd packages/core && npx vitest run src/capability-control/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capability-control/project.ts packages/core/src/capability-control/project.test.ts
git commit -m "feat(capability-control): builtin + mcp projections"
```

---

### Task 3: Skill + plugin projections (TDD)

**Files:**
- Modify: `packages/core/src/capability-control/project.ts`
- Modify: `packages/core/src/capability-control/project.test.ts`

Deps recap (verified): `SkillDefinition` = `{name, description, content, filePath, source: "project"|"user"|"plugin"}`. `scanSkills(cwd, {})` returns the FULL set (empty opts → no filtering). Plugin names come from `readInstalledPlugins().plugins` keys; the plugin name is the substring before the last `@`.

- [ ] **Step 1: Add failing tests**

```typescript
import { projectSkills, projectPlugins } from "./project.js";
import type { SkillDefinition } from "../skills/scanner.js";

const skill = (name: string, source: SkillDefinition["source"]): SkillDefinition => ({
  name, description: `${name} desc`, content: "", filePath: `/x/${name}/SKILL.md`, source,
});

describe("projectSkills", () => {
  it("lists project/user skills, denylist control, enabled unless in disabledSkills", () => {
    const out = projectSkills({
      skills: [skill("a", "project"), skill("b", "user"), skill("p:c", "plugin")],
      disabledSkills: ["b"],
    });
    expect(out.map((d) => d.id).sort()).toEqual(["skill:a", "skill:b"]); // plugin excluded
    const b = out.find((d) => d.id === "skill:b")!;
    expect(b.enabled).toBe(false);
    expect(b.control).toMatchObject({ settingsKey: "disabledSkills", mode: "denylist", token: "b" });
    expect(out.find((d) => d.id === "skill:a")!.origin?.filePath).toBe("/x/a/SKILL.md");
  });
});

describe("projectPlugins", () => {
  it("lists installed plugins by bare name, denylist control", () => {
    const out = projectPlugins({
      installed: { "myplug@market": [], "other@m2": [] },
      disabledPlugins: ["other"],
    });
    expect(out.map((d) => d.id).sort()).toEqual(["plugin:myplug", "plugin:other"]);
    const other = out.find((d) => d.id === "plugin:other")!;
    expect(other).toMatchObject({ kind: "plugin", name: "other", enabled: false });
    expect(other.control).toMatchObject({ settingsKey: "disabledPlugins", mode: "denylist", token: "other" });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd packages/core && npx vitest run src/capability-control/project.test.ts`
Expected: FAIL — `projectSkills`/`projectPlugins` not exported.

- [ ] **Step 3: Implement**

```typescript
import type { SkillDefinition } from "../skills/scanner.js";

export function projectSkills(input: {
  skills: SkillDefinition[];
  disabledSkills: string[];
}): CapabilityDescriptor[] {
  const disabled = new Set(input.disabledSkills);
  return input.skills
    .filter((s) => s.source === "project" || s.source === "user")
    .map((s) => ({
      id: `skill:${s.name}`,
      kind: "skill" as const,
      name: s.name,
      description: s.description,
      enabled: !disabled.has(s.name),
      control: { settingsKey: "disabledSkills" as const, mode: "denylist" as const, token: s.name },
      origin: { filePath: s.filePath },
    }));
}

export function projectPlugins(input: {
  installed: Record<string, unknown>;
  disabledPlugins: string[];
}): CapabilityDescriptor[] {
  const disabled = new Set(input.disabledPlugins);
  const names = new Set<string>();
  for (const key of Object.keys(input.installed)) {
    const at = key.lastIndexOf("@");
    names.add(at > 0 ? key.slice(0, at) : key);
  }
  return [...names].map((name) => ({
    id: `plugin:${name}`,
    kind: "plugin" as const,
    name,
    description: "",
    enabled: !disabled.has(name),
    control: { settingsKey: "disabledPlugins" as const, mode: "denylist" as const, token: name },
    origin: { pluginName: name },
  }));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd packages/core && npx vitest run src/capability-control/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capability-control/project.ts packages/core/src/capability-control/project.test.ts
git commit -m "feat(capability-control): skill + plugin projections"
```

---

### Task 4: CapabilityService (TDD)

**Files:**
- Create: `packages/core/src/capability-control/service.ts`
- Create: `packages/core/src/capability-control/index.ts`
- Test: `packages/core/src/capability-control/service.test.ts`

The service composes projections for `list()`, and routes `setEnabled()`. It depends on a `ToolRegistry` (for `listToolsDetailed()`), a `SettingsManager` (for `get()`/`saveUserSetting()`), and `cwd` (for `scanSkills`). Tests use fakes — no real disk.

Note on `readArray`: builtin keys are dotted (`agent.disabledBuiltinTools`), so the service reads them from `settings.agent.*`; the other arrays are top-level.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { CapabilityService } from "./service.js";
import { CapabilityNotFoundError } from "./types.js";

function fakes(initial: Record<string, unknown> = {}) {
  let s: any = {
    agent: { preset: "general", enabledBuiltinTools: [], disabledBuiltinTools: [] },
    mcpServers: {}, disabledSkills: [], disabledPlugins: [], ...initial,
  };
  const saved: Array<[string, unknown]> = [];
  const settings = {
    get: () => s,
    saveUserSetting: (k: string, v: unknown) => {
      saved.push([k, v]);
      // apply dotted path so a subsequent get() reflects it
      const parts = k.split(".");
      let t = s;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]] ??= {};
      t[parts[parts.length - 1]] = v;
    },
  };
  const registry = { listToolsDetailed: () => [] as any[] };
  return { settings, registry, saved, get: () => s };
}

describe("CapabilityService.setEnabled", () => {
  it("denylist: turning off adds token; turning on removes it", () => {
    const f = fakes({ disabledSkills: [] });
    const svc = new CapabilityService({
      registry: f.registry as any, settings: f.settings as any, cwd: "/x",
      scanSkills: () => [{ name: "a", description: "", content: "", filePath: "/x/a", source: "project" }] as any,
      readInstalledPlugins: () => ({ version: 2, plugins: {} }) as any,
      resolveBuiltinToolNames: () => [],
    });
    svc.setEnabled("skill:a", false);
    expect(f.get().disabledSkills).toEqual(["a"]);
    svc.setEnabled("skill:a", true);
    expect(f.get().disabledSkills).toEqual([]);
  });

  it("allowlist: builtin not in preset writes agent.enabledBuiltinTools (dotted)", () => {
    const f = fakes();
    const svc = new CapabilityService({
      registry: { listToolsDetailed: () => [{ name: "REPL", description: "", inputSchema: {}, source: "builtin", permissionDefault: "allow" }] } as any,
      settings: f.settings as any, cwd: "/x",
      scanSkills: () => [], readInstalledPlugins: () => ({ version: 2, plugins: {} }) as any,
      resolveBuiltinToolNames: (o?: any) => (o?.enabledBuiltinTools?.length ? ["REPL"] : []),
    });
    svc.setEnabled("builtin:REPL", true);
    expect(f.get().agent.enabledBuiltinTools).toEqual(["REPL"]);
  });

  it("record-flag: flips mcpServers[token].enabled, never creates missing server", () => {
    const f = fakes({ mcpServers: { gh: { name: "gh" } } });
    const svc = new CapabilityService({
      registry: f.registry as any, settings: f.settings as any, cwd: "/x",
      scanSkills: () => [], readInstalledPlugins: () => ({ version: 2, plugins: {} }) as any,
      resolveBuiltinToolNames: () => [],
    });
    svc.setEnabled("mcp:gh", false);
    expect(f.get().mcpServers.gh.enabled).toBe(false);
  });

  it("throws CapabilityNotFoundError on unknown id", () => {
    const f = fakes();
    const svc = new CapabilityService({
      registry: f.registry as any, settings: f.settings as any, cwd: "/x",
      scanSkills: () => [], readInstalledPlugins: () => ({ version: 2, plugins: {} }) as any,
      resolveBuiltinToolNames: () => [],
    });
    expect(() => svc.setEnabled("skill:nope", true)).toThrow(CapabilityNotFoundError);
  });
});

describe("CapabilityService.list", () => {
  it("composes all four sources", () => {
    const f = fakes({ mcpServers: { gh: { name: "gh" } }, disabledPlugins: [] });
    const svc = new CapabilityService({
      registry: { listToolsDetailed: () => [{ name: "Read", description: "", inputSchema: {}, source: "builtin", permissionDefault: "allow" }] } as any,
      settings: f.settings as any, cwd: "/x",
      scanSkills: () => [{ name: "a", description: "", content: "", filePath: "/x/a", source: "project" }] as any,
      readInstalledPlugins: () => ({ version: 2, plugins: { "p@m": [] } }) as any,
      resolveBuiltinToolNames: () => ["Read"],
    });
    const kinds = new Set(svc.list().map((d) => d.kind));
    expect(kinds).toEqual(new Set(["builtin", "mcp", "skill", "plugin"]));
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd packages/core && npx vitest run src/capability-control/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement service + index**

`service.ts`:

```typescript
import type { ToolRegistry } from "../tool-system/registry.js";
import type { SettingsManager } from "../settings/manager.js";
import type { SkillDefinition } from "../skills/scanner.js";
import type { InstalledPluginsV2 } from "../plugins/types.js";
import type { CapabilityDescriptor } from "./types.js";
import { CapabilityNotFoundError } from "./types.js";
import { projectBuiltin, projectMcp, projectSkills, projectPlugins } from "./project.js";

export interface CapabilityServiceDeps {
  registry: Pick<ToolRegistry, "listToolsDetailed">;
  settings: Pick<SettingsManager, "get" | "saveUserSetting">;
  cwd: string;
  scanSkills: (cwd: string, opts?: { disabledSkills?: string[]; disabledPlugins?: string[] }) => SkillDefinition[];
  readInstalledPlugins: () => InstalledPluginsV2;
  resolveBuiltinToolNames: (o?: { preset?: string; enabledBuiltinTools?: string[]; disabledBuiltinTools?: string[] }) => string[];
}

export class CapabilityService {
  constructor(private deps: CapabilityServiceDeps) {}

  list(): CapabilityDescriptor[] {
    const s: any = this.deps.settings.get();
    const tools = this.deps.registry.listToolsDetailed();
    const preset = s.agent?.preset;
    return [
      ...projectBuiltin({
        tools: tools.filter((t) => t.source === "builtin"),
        presetDefaults: this.deps.resolveBuiltinToolNames({ preset }),
        effective: this.deps.resolveBuiltinToolNames({
          preset,
          enabledBuiltinTools: s.agent?.enabledBuiltinTools ?? [],
          disabledBuiltinTools: s.agent?.disabledBuiltinTools ?? [],
        }),
      }),
      ...projectMcp({ mcpServers: s.mcpServers ?? {}, mcpTools: tools.filter((t) => t.source === "mcp") }),
      ...projectSkills({ skills: this.deps.scanSkills(this.deps.cwd, {}), disabledSkills: s.disabledSkills ?? [] }),
      ...projectPlugins({ installed: this.deps.readInstalledPlugins().plugins, disabledPlugins: s.disabledPlugins ?? [] }),
    ];
  }

  setEnabled(id: string, on: boolean): void {
    const d = this.list().find((c) => c.id === id);
    if (!d) throw new CapabilityNotFoundError(id);
    const { settingsKey, mode, token } = d.control;
    const s: any = this.deps.settings.get();

    if (mode === "record-flag") {
      const servers = { ...(s.mcpServers ?? {}) };
      if (!servers[token]) return; // never create a missing server
      servers[token] = { ...servers[token], enabled: on };
      this.deps.settings.saveUserSetting("mcpServers", servers);
      return;
    }

    const arr = new Set<string>(readArray(s, settingsKey));
    const wantPresent = mode === "allowlist" ? on : !on; // denylist: present means OFF
    if (wantPresent) arr.add(token);
    else arr.delete(token);
    this.deps.settings.saveUserSetting(settingsKey, [...arr]);
  }
}

function readArray(s: any, key: string): string[] {
  const parts = key.split(".");
  let t = s;
  for (const p of parts) t = t?.[p];
  return Array.isArray(t) ? t : [];
}
```

`index.ts`:

```typescript
export { CapabilityService } from "./service.js";
export type { CapabilityServiceDeps } from "./service.js";
export type { CapabilityDescriptor, CapabilityControl } from "./types.js";
export { CapabilityNotFoundError } from "./types.js";
export { projectBuiltin, projectMcp, projectSkills, projectPlugins } from "./project.js";
```

- [ ] **Step 4: Run, verify pass**

Run: `cd packages/core && npx vitest run src/capability-control/`
Expected: PASS (all project + service tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capability-control/service.ts packages/core/src/capability-control/index.ts packages/core/src/capability-control/service.test.ts
git commit -m "feat(capability-control): CapabilityService list + setEnabled router"
```

---

### Task 5: Wire into core barrel + typecheck

**Files:**
- Modify: `packages/core/src/index.ts` (only if a barrel exists exporting public API)

- [ ] **Step 1: Add export (if barrel exists)**

Check `packages/core/src/index.ts`. If it re-exports subsystems, add:

```typescript
export * from "./capability-control/index.js";
```

If no barrel, skip — desktop will import the deep path.

- [ ] **Step 2: Typecheck + full core tests**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors. (Regression: execution-path tests unchanged.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(capability-control): export public API from core barrel"
```

---

### Task 6: Desktop IPC forwarders

**Files:**
- Create: `packages/desktop/src/main/capabilities-service.ts`
- Modify: `packages/desktop/src/main/index.ts` (register two handlers, near skills:list at :252)

Pattern mirrors `skills-service.ts` + `ipcMain.handle("skills:list", ...)`. The service constructs a `CapabilityService` with a `SettingsManager(cwd, scope)`, the core loaders, and a `ToolRegistry`. For the registry source: instantiate a `ToolRegistry` seeded with `resolveBuiltinToolNames({preset})` (builtin names suffice for builtin/skill/plugin projection; MCP tool counts will be 0 in the main-process registry, which is acceptable for the settings UI — `mcpServers` config still drives MCP enabled state). Confirm the exact `SettingsManager` scope used elsewhere in desktop settings-service before finalizing.

- [ ] **Step 1: Implement service forwarder**

```typescript
import { CapabilityService, resolveBuiltinToolNames, ToolRegistry, SettingsManager, scanSkills, readInstalledPlugins } from "@cjhyy/code-shell-core";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";

function makeService(cwd: string): CapabilityService {
  const settings = new SettingsManager(cwd, "user");
  const preset = (settings.get() as any).agent?.preset;
  const registry = new ToolRegistry({ builtinTools: resolveBuiltinToolNames({ preset }) });
  return new CapabilityService({ registry, settings, cwd, scanSkills, readInstalledPlugins, resolveBuiltinToolNames });
}

export function listCapabilities(cwd: string): CapabilityDescriptor[] {
  return makeService(cwd).list();
}

export function setCapabilityEnabled(cwd: string, id: string, on: boolean): void {
  makeService(cwd).setEnabled(id, on);
}
```

(Adjust import names/paths to whatever `@cjhyy/code-shell-core` actually exports — verify against `skills-service.ts` imports.)

- [ ] **Step 2: Register IPC handlers in index.ts (near line 252)**

```typescript
ipcMain.handle("capabilities:list", async (_e, cwd: string) => listCapabilities(cwd));
ipcMain.handle("capabilities:setEnabled", async (_e, cwd: string, id: string, on: boolean) =>
  setCapabilityEnabled(cwd, id, on),
);
```

- [ ] **Step 3: Typecheck desktop**

Run: `cd packages/desktop && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/main/capabilities-service.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): capabilities:list + setEnabled IPC forwarders"
```

---

## Self-Review notes

- **Spec coverage:** §4 types→T1; §5.1-5.4 projections→T2/T3; §7 router→T4; §10 tests→T2/T3/T4; §9 desktop→T6. All covered.
- **Type consistency:** `CapabilityDescriptor`/`CapabilityControl` used identically across T1/T2/T3/T4; `setEnabled`/`list` signatures stable.
- **Known approximation (logged, not silent):** the main-process `ToolRegistry` in T6 is not MCP-connected, so MCP `toolCount` shows 0 in the settings UI. MCP enabled/disabled state is still correct (driven by `mcpServers` config). If live tool counts are needed later, source the registry from the worker. This is a deliberate scope cut per the spec's "control layer only".

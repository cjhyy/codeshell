# Project-Scoped Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each project (`${cwd}/.code-shell/settings.json`) override global skill/plugin/MCP enablement with a tri-state (`inherit`/`on`/`off`) overlay, write project-level agent definition files with `project > user` precedence, and surface all of it in a tree-navigable Capabilities Overview UI.

**Architecture:** Add a `capabilityOverrides` map to project settings that layers over the existing global `disabledSkills`/`disabledPlugins`/`mcpServers.*.enabled` baseline (NOT a second denylist). `SettingsManager` gains project write/delete methods and raw-scope reads so overlay computation can read baseline and overlay separately. `CapabilityService` gains a `scope`/`cwd`-aware write path and overlay-aware descriptors. The engine applies the overlay during per-run capability assembly. The desktop main process threads `scope`/`cwd`/`state` through IPC. Agent *definition* files become project-writable and reverse precedence to `project > user`. Model/session isolation (spec Phase 4) is explicitly OUT OF SCOPE for this plan.

**Tech Stack:** TypeScript, bun (`bun test`), Zod (settings schema), Electron (desktop main + preload + renderer), React + shadcn/ui + Tailwind v4 (renderer).

**Spec:** `docs/superpowers/specs/2026-06-01-project-scoped-capabilities-and-session-isolation-design.md` (this plan covers Phases 1, 2, 3, 3.5; NOT Phase 4).

---

## Key codebase facts (grounded, current as of this branch)

- `SettingsManager` (`packages/core/src/settings/manager.ts`): only writer is `saveUserSetting(key, value)` → `~/.code-shell/settings.json`, atomic tmp+rename, dotted paths, `invalidate()` after write. Constructor `(cwd, scope)` where `scope: "isolated"|"project"|"full"` controls which **disk layers** are *read* (NOT the same axis as our write-scope). Tests: `manager.test.ts` uses `process.env.HOME` + temp dirs.
- Settings schema (`packages/core/src/settings/schema.ts`): Zod with `.passthrough()`. Relevant fields: `mcpServers` (record, line ~166), `disabledSkills` (~189), `disabledPlugins` (~197), `disabledAgents` (~206). No `capabilityOverrides` exists yet.
- `CapabilityService` (`packages/core/src/capability-control/service.ts`): `list()` composes 4 pure projections (`projectBuiltin/Mcp/Skills/Plugins` in `project.ts`); `setEnabled(id, on)` routes by `descriptor.control.{settingsKey,mode,token}` and writes via `saveUserSetting`. `deps` has `cwd`, `settings: Pick<…,"get"|"saveUserSetting">`. `CapabilityDescriptor.kind` is `"builtin"|"mcp"|"skill"|"plugin"` — **no `"agent"` kind**.
- IDs are `"<kind>:<name>"` via template literals; no shared parser exists.
- Engine (`packages/core/src/engine/engine.ts`): `readDisabledLists()` (~2002) reads `this.getSettingsManager().get()` merged → `{disabledSkills, disabledPlugins}`; subagents return empty. `loadAgentDefinitionsForCwd(cwd, disabledAgents, disabledPlugins)` (~226) builds dirs array `[project?, ...plugins, user]` and relies on `AgentDefinitionRegistry.loadFromDirs` **last-dir-wins** → current precedence is **user > plugin > project**. `getSettingsManager()` (~1792) lazily makes a per-Engine `SettingsManager(config.cwd, config.settingsScope ?? "project")`.
- `AgentDefinitionRegistry.loadFromDirs(dirs, disabled)` (`packages/core/src/agent/agent-definition-registry.ts`): iterates dirs in order, `reg.defs.set(name, def)` (last wins), sets `def.override=true` when a name was already present. `AgentDefinition` has `source?: "project"|"user"|"plugin"`, `override?: boolean`.
- Desktop main `capabilities-service.ts`: `listCapabilities(cwd)`, `setCapabilityEnabled(cwd, id, on)`; `makeService(cwd)` builds `CapabilityService` with `SettingsManager(cwd, "full")`.
- Desktop main `agents-service.ts`: `listAgents(cwd)`, `saveAgent(def)` (hardcoded `userAgentsRoot()`), `deleteAgent(name)` (refuses outside `~/.code-shell/agents`). `AgentSummary` has `source`, `override`, `filePath`.
- IPC: handlers in `packages/desktop/src/main/index.ts` (`capabilities:list`, `capabilities:setEnabled`, `agents:list`, `agents:read`, `agents:save`, `agents:delete`); preload wrappers in `packages/desktop/src/preload/index.ts`; renderer calls `window.codeshell.*` directly (no extra service layer).
- UI `CapabilitiesOverviewSection.tsx`: props `{ scope: "user"|"project"; activeRepoPath: string|null }`; raw `<input type="checkbox">` toggles. **MUST switch to shadcn `Switch`/`Select` per `packages/desktop/CLAUDE.md`** — no raw inputs.
- `repos.ts`: `Repo { id, name, path, addedAt, displayName?, pinned? }`, localStorage keys `codeshell.repos` / `codeshell.activeRepoId`; `loadRepos()`, `saveRepos()`, `loadActiveRepoId()`, `saveActiveRepoId()`.

## Verification commands

- Core tests: from repo root, `bun test packages/core` (baseline: 354 pass, 0 fail).
- Single core test file: `bun test packages/core/src/settings/manager.test.ts`.
- Desktop typecheck: `cd packages/desktop && bunx tsc --noEmit` (baseline: clean).
- Desktop renderer build: `cd packages/desktop && bun run build:renderer`.

---

## File Structure

**Create:**
- `packages/core/src/capability-control/overlay.ts` — pure `applyOverride()` + bucket/id helpers + overlay-aware descriptor merge. One responsibility: tri-state overlay math.
- `packages/core/src/capability-control/overlay.test.ts` — overlay unit tests (the §12.2 matrix).

**Modify:**
- `packages/core/src/settings/schema.ts` — add `capabilityOverrides` Zod schema + exported types.
- `packages/core/src/settings/manager.ts` — add `saveProjectSetting`, `deleteProjectSetting`, `getForScope`.
- `packages/core/src/settings/manager.test.ts` — project write/delete + raw-scope read tests.
- `packages/core/src/capability-control/types.ts` — add overlay view fields to `CapabilityDescriptor`; add `WriteScope`/`CapabilityOverrideState` types.
- `packages/core/src/capability-control/service.ts` — `scope`/`cwd` write path + `setOverride` + overlay-aware `list(cwd?)`.
- `packages/core/src/capability-control/service.test.ts` — project-scope write/override tests.
- `packages/core/src/engine/engine.ts` — `readDisabledLists()` applies overlay; reverse `loadAgentDefinitionsForCwd` precedence to `project > user`.
- `packages/core/src/agent/agent-definition.ts` — add `shadowedSources?` to `AgentDefinition`.
- `packages/core/src/agent/agent-definition-registry.ts` — track shadowed sources on override; tests.
- `packages/core/src/agent/agent-definition-registry.test.ts` — reversal regression + shadowedSources (create if absent).
- `packages/core/src/engine/engine.test.ts` (or the existing engine agent-loading test) — reversal regression at the `loadAgentDefinitionsForCwd` level.
- `packages/desktop/src/main/capabilities-service.ts` — `setCapabilityEnabled` scope/cwd + `setCapabilityOverride`; `listCapabilities` returns overlay-aware descriptors.
- `packages/desktop/src/main/agents-service.ts` — `saveAgent(def, opts?)` + `deleteAgent(name, opts?)` with `scope`/`cwd`.
- `packages/desktop/src/main/index.ts` — IPC handlers thread scope/cwd/state.
- `packages/desktop/src/preload/index.ts` — preload wrappers thread scope/cwd/state.
- `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx` — tree UI (user + repos), tri-state per project, shadcn components.

---

## Phase 1 — project scope write path + overlay schema

### Task 1: `capabilityOverrides` schema

**Files:**
- Modify: `packages/core/src/settings/schema.ts`
- Test: `packages/core/src/settings/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/settings/schema.test.ts`:

```ts
import { validateSettings } from "./schema.js";

describe("capabilityOverrides schema", () => {
  test("accepts tri-state buckets", () => {
    const v = validateSettings({
      capabilityOverrides: {
        skills: { "superpowers:brainstorming": "off", helper: "on" },
        plugins: { superpowers: "off" },
        agents: { "my-agent": "on" },
        mcp: { playwright: "off" },
      },
    });
    expect(v.capabilityOverrides?.skills?.helper).toBe("on");
    expect(v.capabilityOverrides?.mcp?.playwright).toBe("off");
  });

  test("absent capabilityOverrides stays undefined (zero-regression)", () => {
    const v = validateSettings({});
    expect(v.capabilityOverrides).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/settings/schema.test.ts`
Expected: FAIL — `capabilityOverrides` not on the validated type / value undefined where "on" expected (the first test fails because the field is stripped or types don't compile).

- [ ] **Step 3: Add schema**

In `packages/core/src/settings/schema.ts`, before `export const SettingsSchema = z.object({`, add:

```ts
export const CapabilityOverrideSchema = z.enum(["inherit", "on", "off"]);
export type CapabilityOverride = z.infer<typeof CapabilityOverrideSchema>;

export const CapabilityOverridesSchema = z
  .object({
    skills: z.record(CapabilityOverrideSchema).optional(),
    plugins: z.record(CapabilityOverrideSchema).optional(),
    agents: z.record(CapabilityOverrideSchema).optional(),
    mcp: z.record(CapabilityOverrideSchema).optional(),
  })
  .optional();
export type CapabilityOverrides = z.infer<typeof CapabilityOverridesSchema>;
```

Then add inside the `z.object({ ... })` body (alongside `disabledSkills` etc.):

```ts
    capabilityOverrides: CapabilityOverridesSchema,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/settings/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings/schema.ts packages/core/src/settings/schema.test.ts
git commit -m "feat(settings): add capabilityOverrides tri-state schema"
```

---

### Task 2: `SettingsManager.saveProjectSetting` / `deleteProjectSetting`

**Files:**
- Modify: `packages/core/src/settings/manager.ts`
- Test: `packages/core/src/settings/manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` to `packages/core/src/settings/manager.test.ts`:

```ts
import { readFileSync as _rf } from "node:fs";

describe("SettingsManager project writes", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function projectJson(): any {
    return JSON.parse(_rf(join(cwd, ".code-shell", "settings.json"), "utf-8"));
  }

  test("saveProjectSetting writes dotted path to project settings.json", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.helper", "on", cwd);
    expect(projectJson().capabilityOverrides.skills.helper).toBe("on");
  });

  test("saveProjectSetting creates .code-shell dir if absent", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.mcp.playwright", "off", cwd);
    expect(existsSync(join(cwd, ".code-shell", "settings.json"))).toBe(true);
  });

  test("deleteProjectSetting removes the leaf key (inherit)", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.a", "off", cwd);
    sm.saveProjectSetting("capabilityOverrides.skills.b", "on", cwd);
    sm.deleteProjectSetting("capabilityOverrides.skills.a", cwd);
    const j = projectJson();
    expect(j.capabilityOverrides.skills.a).toBeUndefined();
    expect(j.capabilityOverrides.skills.b).toBe("on");
  });

  test("empty cwd throws (boundary guard)", () => {
    const sm = new SettingsManager(cwd, "project");
    expect(() => sm.saveProjectSetting("x.y", "on", "")).toThrow();
  });

  test("write invalidates cache so next get() reflects it", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.get(); // prime cache
    sm.saveProjectSetting("capabilityOverrides.skills.z", "on", cwd);
    expect((sm.get() as any).capabilityOverrides.skills.z).toBe("on");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/settings/manager.test.ts`
Expected: FAIL — `saveProjectSetting`/`deleteProjectSetting` not a function.

- [ ] **Step 3: Implement**

In `packages/core/src/settings/manager.ts`, add a private helper and two public methods to the `SettingsManager` class (place after `saveUserSetting`):

```ts
  /**
   * Persist a single setting (dotted key path) to the PROJECT-level config
   * file at ${cwd}/.code-shell/settings.json. Used for capabilityOverrides:
   * project overlays live here, never in the global user file. Atomic write
   * + cache invalidation mirror saveUserSetting.
   */
  saveProjectSetting(key: string, value: unknown, cwd: string): void {
    const path = this.projectSettingsPath(cwd);
    const current = this.readJsonObject(path);
    const parts = key.split(".");
    let target: Record<string, unknown> = current;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      const next = target[seg];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        target[seg] = {};
      }
      target = target[seg] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = value;
    this.atomicWriteJson(path, current);
    this.invalidate();
  }

  /**
   * Delete a single dotted key from the PROJECT-level config file. Used to
   * express "inherit" (we don't persist the literal "inherit"; we remove the
   * override key). No-ops if the file or any intermediate segment is absent.
   */
  deleteProjectSetting(key: string, cwd: string): void {
    const path = this.projectSettingsPath(cwd);
    if (!existsSync(path)) return;
    const current = this.readJsonObject(path);
    const parts = key.split(".");
    let target: Record<string, unknown> | undefined = current;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = target?.[parts[i]!];
      if (!next || typeof next !== "object" || Array.isArray(next)) return;
      target = next as Record<string, unknown>;
    }
    if (target) delete target[parts[parts.length - 1]!];
    this.atomicWriteJson(path, current);
    this.invalidate();
  }

  private projectSettingsPath(cwd: string): string {
    if (!cwd || cwd.trim().length === 0) {
      throw new Error("saveProjectSetting/deleteProjectSetting requires a non-empty cwd");
    }
    return join(cwd, ".code-shell", "settings.json");
  }

  private readJsonObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file — overwrite rather than crash.
    }
    return {};
  }

  private atomicWriteJson(path: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, path);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/settings/manager.test.ts`
Expected: PASS (all old scope tests + new project-write tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings/manager.ts packages/core/src/settings/manager.test.ts
git commit -m "feat(settings): SettingsManager project write/delete (capabilityOverrides target)"
```

---

### Task 3: `SettingsManager.getForScope` (raw-scope read)

**Files:**
- Modify: `packages/core/src/settings/manager.ts`
- Test: `packages/core/src/settings/manager.test.ts`

Per spec §6.2: overlay math must read the baseline and the project overlay *separately*; the merged `get()` can't express tri-state inheritance. `getForScope("project", cwd)` returns ONLY that one disk file's raw parsed object (not merged).

- [ ] **Step 1: Write the failing test**

Append to the "SettingsManager project writes" describe in `manager.test.ts`:

```ts
  test("getForScope('project') returns only the project file, unmerged", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.a", "off", cwd);
    const proj = sm.getForScope("project", cwd);
    expect(proj.capabilityOverrides?.skills?.a).toBe("off");
    // user-only fields are not present in the project-scope view
    expect((proj as any).disabledSkills).toBeUndefined();
  });

  test("getForScope('project') returns {} when no project file", () => {
    const sm = new SettingsManager(cwd, "project");
    expect(sm.getForScope("project", cwd)).toEqual({});
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/settings/manager.test.ts`
Expected: FAIL — `getForScope` not a function.

- [ ] **Step 3: Implement**

Add to `SettingsManager` (after `deleteProjectSetting`). Note the return is a partial validated shape — we validate the single file so types line up:

```ts
  /**
   * Read ONE scope's raw settings file, validated but UNMERGED. Capability
   * overlay math needs the project overlay and the user/global baseline
   * separately — the merged get() collapses provenance and can't express
   * tri-state inheritance (spec §6.2). user → ~/.code-shell/settings.json,
   * project → ${cwd}/.code-shell/settings.json.
   */
  getForScope(scope: "user" | "project", cwd?: string): Partial<ValidatedSettings> {
    const path =
      scope === "user"
        ? join(userHome(), ".code-shell", "settings.json")
        : this.projectSettingsPath(cwd ?? this.cwd);
    const raw = this.readJsonObject(path);
    // validateSettings applies defaults; for a scope view we want the file's
    // own keys, so re-derive a partial by validating then keeping only keys
    // that were actually present.
    const validated = validateSettings(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) out[k] = validated[k];
    return out as Partial<ValidatedSettings>;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/settings/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings/manager.ts packages/core/src/settings/manager.test.ts
git commit -m "feat(settings): getForScope raw-scope read for overlay math"
```

---

## Phase 2 — capability-control project overlay (skill/plugin/MCP)

### Task 4: pure overlay module

**Files:**
- Create: `packages/core/src/capability-control/overlay.ts`
- Create: `packages/core/src/capability-control/overlay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/capability-control/overlay.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { applyOverride, bucketForKind, overrideTokenForId } from "./overlay.js";

describe("applyOverride matrix (spec §12.2)", () => {
  const cases: Array<[boolean, "inherit" | "on" | "off" | undefined, boolean]> = [
    [true, undefined, true],
    [true, "inherit", true],
    [true, "off", false],
    [true, "on", true],
    [false, undefined, false],
    [false, "inherit", false],
    [false, "off", false],
    [false, "on", true],
  ];
  for (const [global, override, expected] of cases) {
    test(`global=${global} override=${override} -> ${expected}`, () => {
      expect(applyOverride(global, override)).toBe(expected);
    });
  }
  test("unknown override value treated as inherit", () => {
    expect(applyOverride(true, "bogus" as any)).toBe(true);
    expect(applyOverride(false, "bogus" as any)).toBe(false);
  });
});

describe("bucketForKind", () => {
  test("maps descriptor kinds to override buckets", () => {
    expect(bucketForKind("skill")).toBe("skills");
    expect(bucketForKind("plugin")).toBe("plugins");
    expect(bucketForKind("mcp")).toBe("mcp");
    expect(bucketForKind("agent")).toBe("agents");
  });
  test("builtin has no bucket", () => {
    expect(bucketForKind("builtin")).toBeUndefined();
  });
});

describe("overrideTokenForId", () => {
  test("strips the kind prefix", () => {
    expect(overrideTokenForId("skill:superpowers:brainstorming")).toBe(
      "superpowers:brainstorming",
    );
    expect(overrideTokenForId("mcp:playwright")).toBe("playwright");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/capability-control/overlay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/capability-control/overlay.ts`:

```ts
/**
 * Pure tri-state overlay math for project-scoped capability control.
 *
 * The overlay is NOT a second denylist. It layers over a global baseline:
 *   - "on"      → force enabled (even if globally disabled)
 *   - "off"     → force disabled (even if globally enabled)
 *   - "inherit" → take the global baseline (we never persist this literal;
 *                 absence of a key === inherit)
 * Unknown/garbage values are treated as inherit so a bad config never makes
 * every capability vanish (spec §9).
 */
import type { CapabilityOverride, CapabilityOverrides } from "../settings/schema.js";
import type { CapabilityDescriptor } from "./types.js";

export type OverrideBucket = keyof NonNullable<CapabilityOverrides>; // "skills"|"plugins"|"agents"|"mcp"

export function applyOverride(globalEnabled: boolean, override?: CapabilityOverride): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return globalEnabled;
}

/** Which capabilityOverrides bucket a descriptor kind writes to (builtin: none). */
export function bucketForKind(
  kind: CapabilityDescriptor["kind"] | "agent",
): OverrideBucket | undefined {
  switch (kind) {
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "mcp":
      return "mcp";
    case "agent":
      return "agents";
    default:
      return undefined;
  }
}

/** Strip the "<kind>:" prefix from a capability id to get the override token. */
export function overrideTokenForId(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
}

/** Read the project override for a descriptor, normalizing inherit/garbage to undefined. */
export function overrideFor(
  overrides: CapabilityOverrides | undefined,
  kind: CapabilityDescriptor["kind"] | "agent",
  token: string,
): "on" | "off" | undefined {
  const bucket = bucketForKind(kind);
  if (!bucket || !overrides) return undefined;
  const v = overrides[bucket]?.[token];
  return v === "on" || v === "off" ? v : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/capability-control/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/capability-control/overlay.ts packages/core/src/capability-control/overlay.test.ts
git commit -m "feat(capability): pure tri-state overlay math"
```

---

### Task 5: descriptor overlay view fields + scope types

**Files:**
- Modify: `packages/core/src/capability-control/types.ts`

This task only adds types (consumed in Task 6); no standalone test — Task 6's tests exercise them. Type consistency is verified by `bun test packages/core` compiling.

- [ ] **Step 1: Add types**

In `packages/core/src/capability-control/types.ts`, add the overlay view fields to `CapabilityDescriptor` (after `control`):

```ts
  /** user/global baseline enablement (before any project overlay). */
  globalEnabled?: boolean;
  /** Project overlay state, if this scope view is a project. Absent = inherit. */
  projectOverride?: "on" | "off";
  /** Where the effective `enabled` value came from. */
  effectiveSource?: "user" | "project" | "default";
```

And add the shared scope/state types at the bottom of the file:

```ts
/** Which settings file a capability write targets. Distinct from SettingsManager's
 *  disk-read SettingsScope ("isolated"|"project"|"full"). */
export type WriteScope = "user" | "project";

/** Tri-state project override as seen by callers. */
export type CapabilityOverrideState = "inherit" | "on" | "off";
```

- [ ] **Step 2: Verify it compiles**

Run: `bun test packages/core/src/capability-control/service.test.ts`
Expected: PASS (existing tests still compile/pass — descriptors gained optional fields).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/capability-control/types.ts
git commit -m "feat(capability): descriptor overlay view fields + WriteScope type"
```

---

### Task 6: `CapabilityService` scope-aware write + `setOverride` + overlay `list`

**Files:**
- Modify: `packages/core/src/capability-control/service.ts`
- Test: `packages/core/src/capability-control/service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/capability-control/service.test.ts`. First extend the `fakes()` helper to record project writes; add a new helper rather than editing the old one to avoid breaking existing tests:

```ts
import { applyOverride } from "./overlay.js";

function fakesWithProject(initial: Record<string, unknown> = {}) {
  const s: any = {
    agent: { preset: "general", enabledBuiltinTools: [], disabledBuiltinTools: [] },
    mcpServers: {},
    disabledSkills: [],
    disabledPlugins: [],
    capabilityOverrides: {},
    ...initial,
  };
  const projectWrites: Array<[string, unknown]> = [];
  const projectDeletes: string[] = [];
  const settings = {
    get: () => s,
    saveUserSetting: (k: string, v: unknown) => {
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]!] ??= {};
      t[parts[parts.length - 1]!] = v;
    },
    saveProjectSetting: (k: string, v: unknown, _cwd: string) => {
      projectWrites.push([k, v]);
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]!] ??= {};
      t[parts[parts.length - 1]!] = v;
    },
    deleteProjectSetting: (k: string, _cwd: string) => {
      projectDeletes.push(k);
      const parts = k.split(".");
      let t: any = s;
      for (let i = 0; i < parts.length - 1; i++) t = t?.[parts[i]!];
      if (t) delete t[parts[parts.length - 1]!];
    },
    getForScope: (_scope: "user" | "project", _cwd?: string) => ({
      capabilityOverrides: s.capabilityOverrides,
    }),
  };
  const registry = { listToolsDetailed: () => [] as any[] };
  const emptyPlugins = () => ({ version: 2 as const, plugins: {} });
  return { settings, registry, get: () => s, emptyPlugins, projectWrites, projectDeletes };
}

describe("CapabilityService project scope", () => {
  function svcFor(f: ReturnType<typeof fakesWithProject>) {
    return new CapabilityService({
      registry: f.registry as any,
      settings: f.settings as any,
      cwd: "/proj",
      scanSkills: () =>
        [{ name: "a", description: "", content: "", filePath: "/x/a", source: "project" }] as any,
      readInstalledPlugins: f.emptyPlugins as any,
      resolveBuiltinToolNames: () => [],
    });
  }

  test("setOverride 'off' writes capabilityOverrides.skills.<token>", () => {
    const f = fakesWithProject();
    svcFor(f).setOverride("skill:a", "off", { scope: "project", cwd: "/proj" });
    expect(f.projectWrites).toContainEqual(["capabilityOverrides.skills.a", "off"]);
  });

  test("setOverride 'on' writes 'on'", () => {
    const f = fakesWithProject();
    svcFor(f).setOverride("skill:a", "on", { scope: "project", cwd: "/proj" });
    expect(f.projectWrites).toContainEqual(["capabilityOverrides.skills.a", "on"]);
  });

  test("setOverride 'inherit' deletes the key (not a literal write)", () => {
    const f = fakesWithProject({ capabilityOverrides: { skills: { a: "off" } } });
    svcFor(f).setOverride("skill:a", "inherit", { scope: "project", cwd: "/proj" });
    expect(f.projectDeletes).toContain("capabilityOverrides.skills.a");
  });

  test("setEnabled with scope:user keeps old global behavior", () => {
    const f = fakesWithProject();
    svcFor(f).setEnabled("skill:a", false, { scope: "user" });
    expect(f.get().disabledSkills).toEqual(["a"]);
    expect(f.projectWrites).toEqual([]);
  });

  test("setEnabled with no opts defaults to user scope (back-compat)", () => {
    const f = fakesWithProject();
    svcFor(f).setEnabled("skill:a", false);
    expect(f.get().disabledSkills).toEqual(["a"]);
  });

  test("list(cwd) reflects project override: global off + project on => enabled", () => {
    const f = fakesWithProject({
      disabledSkills: ["a"],
      capabilityOverrides: { skills: { a: "on" } },
    });
    const d = svcFor(f).list("/proj").find((c) => c.id === "skill:a")!;
    expect(d.globalEnabled).toBe(false);
    expect(d.projectOverride).toBe("on");
    expect(d.enabled).toBe(true);
    expect(d.effectiveSource).toBe("project");
  });

  test("list() with no cwd = user view: no projectOverride, enabled=global", () => {
    const f = fakesWithProject({ disabledSkills: ["a"] });
    const d = svcFor(f).list().find((c) => c.id === "skill:a")!;
    expect(d.enabled).toBe(false);
    expect(d.projectOverride).toBeUndefined();
    expect(d.effectiveSource).toBe("user");
  });

  test("project override 'off' wins over MCP enabled baseline", () => {
    const f = fakesWithProject({
      mcpServers: { playwright: { name: "playwright" } },
      capabilityOverrides: { mcp: { playwright: "off" } },
    });
    const d = svcFor(f).list("/proj").find((c) => c.id === "mcp:playwright")!;
    expect(d.globalEnabled).toBe(true);
    expect(d.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/capability-control/service.test.ts`
Expected: FAIL — `setOverride` not a function / `list` ignores cwd / overlay fields undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/capability-control/service.ts`:

(a) Extend `CapabilityServiceDeps.settings` Pick and imports at top:

```ts
import type { CapabilityDescriptor, WriteScope, CapabilityOverrideState } from "./types.js";
import { CapabilityNotFoundError } from "./types.js";
import { applyOverride, bucketForKind, overrideTokenForId, overrideFor } from "./overlay.js";
import type { CapabilityOverrides } from "../settings/schema.js";
```

Change the deps settings Pick:

```ts
  settings: Pick<
    SettingsManager,
    "get" | "saveUserSetting" | "saveProjectSetting" | "deleteProjectSetting" | "getForScope"
  >;
```

(b) Replace `list()` with an overlay-aware `list(cwd?: string)`. The 4 projections stay the same; after composing, decorate each descriptor with overlay fields. When `cwd` is provided we read the project overlay via `getForScope`; otherwise it's a pure user view.

```ts
  /**
   * List capability descriptors. With no `cwd` this is the user/global view
   * (enabled === global baseline). With a `cwd` it's that project's view:
   * each descriptor gains globalEnabled / projectOverride / effectiveSource
   * and `enabled` reflects the tri-state overlay (spec §6.1).
   */
  list(cwd?: string): CapabilityDescriptor[] {
    const s = this.deps.settings.get() as Record<string, any>;
    const agent = (s.agent ?? {}) as Record<string, any>;
    const tools = this.deps.registry.listToolsDetailed();
    const preset: string | undefined = agent.preset;

    const base: CapabilityDescriptor[] = [
      ...projectBuiltin({
        tools: tools.filter((t) => t.source === "builtin"),
        presetDefaults: this.deps.resolveBuiltinToolNames({ preset }),
        effective: this.deps.resolveBuiltinToolNames({
          preset,
          enabledBuiltinTools: agent.enabledBuiltinTools ?? [],
          disabledBuiltinTools: agent.disabledBuiltinTools ?? [],
        }),
      }),
      ...projectMcp({
        mcpServers: s.mcpServers ?? {},
        mcpTools: tools.filter((t) => t.source === "mcp"),
      }),
      ...projectSkills({
        skills: this.deps.scanSkills(this.deps.cwd, {}),
        disabledSkills: s.disabledSkills ?? [],
      }),
      ...projectPlugins({
        installed: this.deps.readInstalledPlugins().plugins,
        disabledPlugins: s.disabledPlugins ?? [],
      }),
    ];

    const overrides: CapabilityOverrides | undefined = cwd
      ? (this.deps.settings.getForScope("project", cwd).capabilityOverrides as CapabilityOverrides)
      : undefined;

    return base.map((d) => {
      const globalEnabled = d.enabled;
      const token = overrideTokenForId(d.id);
      const ov = cwd ? overrideFor(overrides, d.kind, token) : undefined;
      const enabled = applyOverride(globalEnabled, ov);
      return {
        ...d,
        enabled,
        globalEnabled,
        projectOverride: ov,
        effectiveSource: ov ? "project" : cwd ? "default" : "user",
      };
    });
  }
```

(c) Extend `setEnabled` with optional opts, and add `setOverride`. `setEnabled` user-scope body stays exactly as today (refactor existing body into a private `writeUserScope`):

```ts
  /**
   * Toggle a capability. Default scope is "user" (back-compat: old callers
   * pass no opts → global write, unchanged). scope:"project" maps on/off to a
   * tri-state override and writes capabilityOverrides (requires cwd).
   */
  setEnabled(id: string, on: boolean, opts?: { scope?: WriteScope; cwd?: string }): void {
    if (opts?.scope === "project") {
      this.setOverride(id, on ? "on" : "off", { scope: "project", cwd: opts.cwd ?? this.deps.cwd });
      return;
    }
    this.writeUserScope(id, on);
  }

  /**
   * Write a project tri-state override. "inherit" deletes the key (we never
   * persist the literal). builtin capabilities have no override bucket and
   * are rejected.
   */
  setOverride(
    id: string,
    state: CapabilityOverrideState,
    opts: { scope: "project"; cwd: string },
  ): void {
    const descriptor = this.list().find((c) => c.id === id);
    if (!descriptor) throw new CapabilityNotFoundError(id);
    const bucket = bucketForKind(descriptor.kind);
    if (!bucket) throw new Error(`Capability kind '${descriptor.kind}' has no project override`);
    if (!opts.cwd) throw new Error("project override requires cwd");
    const token = overrideTokenForId(id);
    const path = `capabilityOverrides.${bucket}.${token}`;
    if (state === "inherit") this.deps.settings.deleteProjectSetting(path, opts.cwd);
    else this.deps.settings.saveProjectSetting(path, state, opts.cwd);
  }

  private writeUserScope(id: string, on: boolean): void {
    const descriptor = this.list().find((c) => c.id === id);
    if (!descriptor) throw new CapabilityNotFoundError(id);
    const { settingsKey, mode, token } = descriptor.control;
    const s = this.deps.settings.get() as Record<string, any>;

    if (mode === "record-flag") {
      const servers = { ...(s.mcpServers ?? {}) };
      if (!servers[token]) return;
      servers[token] = { ...servers[token], enabled: on };
      this.deps.settings.saveUserSetting("mcpServers", servers);
      return;
    }

    const arr = new Set<string>(readArray(s, settingsKey));
    const wantPresent = mode === "allowlist" ? on : !on;
    if (wantPresent) arr.add(token);
    else arr.delete(token);
    this.deps.settings.saveUserSetting(settingsKey, [...arr]);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/capability-control/service.test.ts`
Expected: PASS (old setEnabled tests + new project tests).

- [ ] **Step 5: Run full core suite (no regressions)**

Run: `bun test packages/core`
Expected: PASS, count ≥ baseline 354.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capability-control/service.ts packages/core/src/capability-control/service.test.ts
git commit -m "feat(capability): scope-aware setEnabled + setOverride + overlay-aware list"
```

---

### Task 7: engine `readDisabledLists` applies project overlay

**Files:**
- Modify: `packages/core/src/engine/engine.ts`
- Test: `packages/core/src/engine/engine.test.ts` (append; create if the run-assembly test file differs — search for existing `readDisabledLists`/`disabledSkills` engine test first)

The run-time skill/plugin filter must honor project overlays. `readDisabledLists()` currently reads merged `get()`. Change it to compute effective disabled lists = baseline minus "on" overrides plus "off" overrides, reading the project overlay via `getForScope`.

- [ ] **Step 1: Write the failing test**

Search first: `grep -rn "readDisabledLists\|disabledSkills" packages/core/src/engine/*.test.ts`. Add a focused unit test. Because `readDisabledLists` is private, test it through the smallest public seam — extract the overlay merge into an exported pure helper and test that directly. Add to `packages/core/src/capability-control/overlay.ts` a helper and test it in `overlay.test.ts`:

```ts
// in overlay.test.ts
import { effectiveDisabledList } from "./overlay.js";

describe("effectiveDisabledList", () => {
  test("project 'on' removes from disabled; project 'off' adds", () => {
    const out = effectiveDisabledList(
      ["a", "b"],                       // global disabledSkills
      { a: "on", c: "off" },            // overrides.skills
    );
    expect(new Set(out)).toEqual(new Set(["b", "c"]));
  });
  test("undefined overrides returns the baseline unchanged", () => {
    expect(effectiveDisabledList(["a"], undefined)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/capability-control/overlay.test.ts`
Expected: FAIL — `effectiveDisabledList` not exported.

- [ ] **Step 3: Implement the helper**

Add to `packages/core/src/capability-control/overlay.ts`:

```ts
/**
 * Fold a project override bucket into a global "disabled" list, producing the
 * effective disabled list for run-time skill/plugin filtering. "on" un-disables
 * (removes from the list), "off" disables (adds to the list), inherit/absent
 * leaves the baseline.
 */
export function effectiveDisabledList(
  globalDisabled: string[],
  bucket: Record<string, CapabilityOverride> | undefined,
): string[] {
  const disabled = new Set(globalDisabled);
  if (bucket) {
    for (const [token, state] of Object.entries(bucket)) {
      if (state === "on") disabled.delete(token);
      else if (state === "off") disabled.add(token);
    }
  }
  return [...disabled];
}
```

(Add `import type { CapabilityOverride } from "../settings/schema.js";` if not already imported — it is, from Task 4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/capability-control/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the engine**

In `packages/core/src/engine/engine.ts`, update `readDisabledLists()` (~2002) to apply overlays. Read the project overlay via the engine's SettingsManager `getForScope`:

```ts
  private readDisabledLists(): {
    disabledSkills: string[];
    disabledPlugins: string[];
  } {
    if (this.config.isSubAgent === true) {
      return { disabledSkills: [], disabledPlugins: [] };
    }
    try {
      const sm = this.getSettingsManager();
      const settings = sm.get() as {
        disabledSkills?: string[];
        disabledPlugins?: string[];
      };
      const cwd = this.config.cwd;
      const overrides = cwd
        ? (sm.getForScope("project", cwd).capabilityOverrides as
            | import("../settings/schema.js").CapabilityOverrides
            | undefined)
        : undefined;
      return {
        disabledSkills: effectiveDisabledList(settings.disabledSkills ?? [], overrides?.skills),
        disabledPlugins: effectiveDisabledList(settings.disabledPlugins ?? [], overrides?.plugins),
      };
    } catch {
      return { disabledSkills: [], disabledPlugins: [] };
    }
  }
```

Add the import near the top of `engine.ts`:

```ts
import { effectiveDisabledList } from "../capability-control/overlay.js";
```

- [ ] **Step 6: Run the full core suite**

Run: `bun test packages/core`
Expected: PASS, count ≥ baseline. (Engine tests still green; overlay defaults to baseline when no project overrides exist → zero regression.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/capability-control/overlay.ts packages/core/src/capability-control/overlay.test.ts packages/core/src/engine/engine.ts
git commit -m "feat(engine): apply project capability overlay in readDisabledLists"
```

---

### Task 8: desktop capabilities-service + IPC + preload thread scope/cwd

**Files:**
- Modify: `packages/desktop/src/main/capabilities-service.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/index.ts`

The main process is the trust boundary; payloads carry `cwd`, `scope`, `state`. No core test here — verified by desktop typecheck. (Behavioral coverage lives in the core service tests, Task 6.)

- [ ] **Step 1: Update capabilities-service.ts**

In `packages/desktop/src/main/capabilities-service.ts`:

- `makeService(cwd)` already builds a `CapabilityService` with `SettingsManager(cwd, "full")`. The service's new methods (`saveProjectSetting`/`deleteProjectSetting`/`getForScope`) come from that same SettingsManager — no extra wiring needed since `CapabilityService` calls them through `deps.settings`. Confirm `makeService` passes the SettingsManager as `settings` (it does).
- `listCapabilities(cwd)` → call `.list(cwd || undefined)` so project view applies when a cwd is present:

```ts
export function listCapabilities(cwd: string): CapabilityDescriptor[] {
  return makeService(cwd).list(cwd || undefined);
}
```

- Replace `setCapabilityEnabled` and add `setCapabilityOverride`:

```ts
export function setCapabilityEnabled(
  cwd: string,
  id: string,
  on: boolean,
  opts?: { scope?: "user" | "project" },
): void {
  makeService(cwd).setEnabled(id, on, { scope: opts?.scope ?? "user", cwd });
}

export function setCapabilityOverride(
  cwd: string,
  id: string,
  state: "inherit" | "on" | "off",
): void {
  makeService(cwd).setOverride(id, state, { scope: "project", cwd });
}
```

- [ ] **Step 2: Update IPC handlers in main/index.ts**

In `packages/desktop/src/main/index.ts`, update the `capabilities:setEnabled` handler to accept an optional scope, and add `capabilities:setOverride`:

```ts
  ipcMain.handle(
    "capabilities:setEnabled",
    async (_e, cwd: string, id: string, on: boolean, opts?: { scope?: "user" | "project" }) => {
      if (typeof cwd !== "string") throw new Error("capabilities:setEnabled requires cwd");
      if (typeof id !== "string") throw new Error("capabilities:setEnabled requires id");
      setCapabilityEnabled(cwd, id, Boolean(on), opts);
    },
  );

  ipcMain.handle(
    "capabilities:setOverride",
    async (_e, cwd: string, id: string, state: "inherit" | "on" | "off") => {
      if (typeof cwd !== "string") throw new Error("capabilities:setOverride requires cwd");
      if (typeof id !== "string") throw new Error("capabilities:setOverride requires id");
      if (state !== "inherit" && state !== "on" && state !== "off")
        throw new Error("capabilities:setOverride requires state inherit|on|off");
      setCapabilityOverride(cwd, id, state);
    },
  );
```

Update the import to include `setCapabilityOverride`:

```ts
import { listCapabilities, setCapabilityEnabled, setCapabilityOverride } from "./capabilities-service.js";
```

- [ ] **Step 3: Update preload wrappers**

In `packages/desktop/src/preload/index.ts`, update/add:

```ts
  setCapabilityEnabled: (
    cwd: string,
    id: string,
    on: boolean,
    opts?: { scope?: "user" | "project" },
  ) => ipcRenderer.invoke("capabilities:setEnabled", cwd, id, on, opts),

  setCapabilityOverride: (cwd: string, id: string, state: "inherit" | "on" | "off") =>
    ipcRenderer.invoke("capabilities:setOverride", cwd, id, state),
```

If there's a typed `window.codeshell` declaration (search `grep -rn "setCapabilityEnabled" packages/desktop/src`), update its signature there too to match.

- [ ] **Step 4: Desktop typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/capabilities-service.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): thread scope/cwd through capability IPC + setCapabilityOverride"
```

---

## Phase 3 — project-level agent definitions + precedence reversal

### Task 9: reverse agent precedence to project > user (with regression test)

**Files:**
- Modify: `packages/core/src/engine/engine.ts` (`loadAgentDefinitionsForCwd`, ~226)
- Modify: `packages/core/src/agent/agent-definition.ts` (add `shadowedSources`)
- Modify: `packages/core/src/agent/agent-definition-registry.ts` (track shadowed sources)
- Test: `packages/core/src/agent/agent-definition-registry.test.ts` (create if absent)

Reversal mechanics: `loadFromDirs` is **last-dir-wins**. To make `project > user > plugin`, pass dirs in increasing-priority order ending with project: `[user, ...plugins, project]`. Also record `shadowedSources` so the UI can warn (spec §7.2).

- [ ] **Step 1: Write the failing regression test**

Create (or append to) `packages/core/src/agent/agent-definition-registry.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentDefinitionRegistry } from "./agent-definition-registry.js";

function writeAgent(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`, "utf-8");
}

describe("AgentDefinitionRegistry precedence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-agents-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("REGRESSION: project wins over user on name clash (was user-wins)", () => {
    const user = join(root, "user");
    const project = join(root, "project");
    writeAgent(user, "rev", "USER BODY");
    writeAgent(project, "rev", "PROJECT BODY");
    // increasing-priority order; LAST dir wins → project must be last
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [
        { dir: user, source: "user" },
        { dir: project, source: "project" },
      ],
      [],
    );
    const def = reg.get("rev")!;
    expect(def.systemPrompt).toBe("PROJECT BODY");
    expect(def.source).toBe("project");
  });

  test("override records shadowedSources of the defs it replaced", () => {
    const user = join(root, "user");
    const project = join(root, "project");
    writeAgent(user, "rev", "USER BODY");
    writeAgent(project, "rev", "PROJECT BODY");
    const reg = AgentDefinitionRegistry.loadFromDirs(
      [
        { dir: user, source: "user" },
        { dir: project, source: "project" },
      ],
      [],
    );
    const def = reg.get("rev")!;
    expect(def.shadowedSources).toContain("user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/agent/agent-definition-registry.test.ts`
Expected: The first test PASSES already (loadFromDirs is order-driven and we pass project last) — but the SECOND fails: `shadowedSources` is undefined. (If the first also fails, the order passed is the issue — keep project last.)

- [ ] **Step 3: Add `shadowedSources` to the type**

In `packages/core/src/agent/agent-definition.ts`, add to `AgentDefinition` (after `override?`):

```ts
  /** Sources whose same-named def this one shadows (runtime-only). Drives the
   *  UI "this project overrides your user version" warning (spec §7.2). */
  shadowedSources?: Array<"project" | "user" | "plugin">;
```

- [ ] **Step 4: Track shadowed sources in the registry**

In `packages/core/src/agent/agent-definition-registry.ts`, update the merge loop body (replace the `if (reg.defs.has(def.name)) def.override = true;` line):

```ts
          const prev = reg.defs.get(def.name);
          if (prev) {
            def.override = true;
            const shadowed = new Set<"project" | "user" | "plugin">(prev.shadowedSources ?? []);
            if (prev.source) shadowed.add(prev.source);
            def.shadowedSources = [...shadowed];
          }
          reg.defs.set(def.name, def);
```

Also update the class doc comment (currently says "user-level overrides project-level") to reflect that callers now pass increasing-priority order and the LAST dir still wins, but engine callers now pass project last.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/agent/agent-definition-registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Reverse the engine caller order**

In `packages/core/src/engine/engine.ts`, in `loadAgentDefinitionsForCwd` (~226), reorder the dirs array so project is LAST (highest priority). Replace the dirs array:

```ts
  return AgentDefinitionRegistry.loadFromDirs(
    [
      // Increasing priority; loadFromDirs is last-dir-wins. user is the
      // cross-project personal default (lowest of the three), plugins sit in
      // the middle as a reusable baseline, and the project def wins last so a
      // repo's in-tree agent overrides your user version (spec §7.2 reversal).
      { dir: `${home}/.code-shell/agents`, source: "user" },
      ...pluginAgentDirs(disabledPlugins),
      ...(cwd ? [{ dir: `${cwd}/.code-shell/agents`, source: "project" as const }] : []),
    ],
    disabledAgents,
  );
```

- [ ] **Step 7: Add engine-level reversal regression test**

Append to `packages/core/src/engine/engine.test.ts` (search for an existing agent-loading test; if `loadAgentDefinitionsForCwd` is exported, test it directly):

```ts
import { loadAgentDefinitionsForCwd } from "./engine.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadAgentDefinitionsForCwd precedence reversal", () => {
  test("project agent shadows same-named user agent", () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    process.env.HOME = home;
    try {
      const userDir = join(home, ".code-shell", "agents");
      const projDir = join(cwd, ".code-shell", "agents");
      mkdirSync(userDir, { recursive: true });
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(userDir, "dup.md"), "---\nname: dup\ndescription: u\n---\nUSER\n");
      writeFileSync(join(projDir, "dup.md"), "---\nname: dup\ndescription: p\n---\nPROJECT\n");
      const reg = loadAgentDefinitionsForCwd(cwd, [], []);
      expect(reg.get("dup")!.systemPrompt).toBe("PROJECT");
      expect(reg.get("dup")!.source).toBe("project");
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
```

Note: `loadAgentDefinitionsForCwd` resolves user dir via `homedir()` (not `process.env.HOME`); if the test shows user dir not picked up, the engine uses `homedir()` from `node:os`. In that case set the test to assert only that the project def wins given both dirs are passed — verify by checking how `home` is computed in `loadAgentDefinitionsForCwd` and, if it uses `homedir()`, adjust the test to drive `AgentDefinitionRegistry.loadFromDirs` directly with explicit dirs (already covered by Task 9 Step 1). If so, mark this engine-level test as covered-by-registry-test and skip duplicate.

- [ ] **Step 8: Run full core suite**

Run: `bun test packages/core`
Expected: PASS, count ≥ baseline + new tests. Watch for any existing test that asserted user-wins — if one fails, that's the intended reversal; update that test to the new semantics and note it in the commit.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/agent/agent-definition.ts packages/core/src/agent/agent-definition-registry.ts packages/core/src/agent/agent-definition-registry.test.ts packages/core/src/engine/engine.test.ts
git commit -m "feat(agent)!: reverse agent precedence to project > user; track shadowedSources

BREAKING: a repo's in-tree agent now overrides a same-named user agent (was user-wins). See spec §7.2."
```

---

### Task 10: project-scope agent write/delete in desktop agents-service

**Files:**
- Modify: `packages/desktop/src/main/agents-service.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/index.ts`

- [ ] **Step 1: Update agents-service.ts**

In `packages/desktop/src/main/agents-service.ts`, add a project-dir resolver and thread `opts` through `saveAgent`/`deleteAgent`. Keep the user path as default for back-compat.

Add helper after `userAgentsRoot`:

```ts
function projectAgentsRoot(cwd: string): string {
  if (!cwd || !cwd.trim()) throw new Error("project-scope agent write requires cwd");
  return path.join(cwd, ".code-shell", "agents");
}

function agentsRootFor(opts?: { scope?: "user" | "project"; cwd?: string }): string {
  if (opts?.scope === "project") return projectAgentsRoot(opts.cwd ?? "");
  return userAgentsRoot();
}
```

Update `saveAgent` signature + root resolution + returned `source`:

```ts
export async function saveAgent(
  def: AgentDefinition,
  opts?: { scope?: "user" | "project"; cwd?: string },
): Promise<AgentSummary> {
  const name = normalizeAgentName(def.name);
  const clean: AgentDefinition = {
    name,
    description: def.description,
    model: def.model || undefined,
    maxTurns: typeof def.maxTurns === "number" ? def.maxTurns : undefined,
    tools: Array.isArray(def.tools) && def.tools.length > 0 ? def.tools : undefined,
    systemPrompt: def.systemPrompt ?? "",
  };
  const root = agentsRootFor(opts);
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to write outside agents dir: ${target}`);
  }
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
    source: opts?.scope === "project" ? "project" : "user",
    override: false,
    filePath: target,
  };
}
```

Update `deleteAgent`:

```ts
export async function deleteAgent(
  name: string,
  opts?: { scope?: "user" | "project"; cwd?: string },
): Promise<void> {
  const safe = normalizeAgentName(name);
  const root = agentsRootFor(opts);
  const target = path.join(root, `${safe}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to delete outside agents dir: ${target}`);
  }
  await fs.rm(target, { force: true });
}
```

- [ ] **Step 2: Update IPC handlers**

In `packages/desktop/src/main/index.ts`, update the `agents:save` and `agents:delete` handlers to accept opts:

```ts
  ipcMain.handle(
    "agents:save",
    async (_e, def: AgentDefinition, opts?: { scope?: "user" | "project"; cwd?: string }) => {
      if (!def || typeof def !== "object") throw new Error("agents:save requires def");
      if (typeof def.name !== "string" || typeof def.description !== "string")
        throw new Error("agents:save: name and description are required");
      return saveAgent(def, opts);
    },
  );

  ipcMain.handle(
    "agents:delete",
    async (_e, name: string, opts?: { scope?: "user" | "project"; cwd?: string }) => {
      if (typeof name !== "string" || !name) throw new Error("agents:delete requires name");
      return deleteAgent(name, opts);
    },
  );
```

- [ ] **Step 3: Update preload wrappers**

In `packages/desktop/src/preload/index.ts`:

```ts
  saveAgent: (
    def: import("./types").AgentDefinitionInput,
    opts?: { scope?: "user" | "project"; cwd?: string },
  ) => ipcRenderer.invoke("agents:save", def, opts),

  deleteAgent: (name: string, opts?: { scope?: "user" | "project"; cwd?: string }) =>
    ipcRenderer.invoke("agents:delete", name, opts),
```

Update any typed `window.codeshell` declaration to match (search `grep -rn "saveAgent" packages/desktop/src`).

- [ ] **Step 4: Desktop typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/agents-service.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts
git commit -m "feat(desktop): project-scope agent save/delete (${cwd}/.code-shell/agents)"
```

---

## Phase 3.5 — Capabilities Overview tree UI

### Task 11: tree-navigable Capabilities Overview (user + projects, tri-state)

**Files:**
- Modify: `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx`
- Possibly modify the caller passing props (search `grep -rn "CapabilitiesOverviewSection" packages/desktop/src`).

Per `packages/desktop/CLAUDE.md`: use shadcn `Switch` / `Select` from `@/components/ui`, Tailwind semantic tokens, `cn()` — NO raw `<input type="checkbox">` / native `<select>`. The current file uses raw checkboxes; this task replaces them.

- [ ] **Step 1: Confirm shadcn components exist**

Run: `ls packages/desktop/src/renderer/components/ui` (look for `switch.tsx`, `select.tsx`). If `select.tsx` is missing, add it first by copying the shadcn Select source (per CLAUDE.md "add it first"). Note which exist before writing the component.

- [ ] **Step 2: Rewrite the component**

Replace `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx`. New props: a `repos: Repo[]` list + a selected node. Left tree (user + each repo), right panel = selected scope's capability list. User node renders a two-state `Switch`; project node renders a three-state `Select` (继承/开/关). agent rows with `shadowedSources` show a ⚠ overlay note.

```tsx
import { useEffect, useMemo, useState } from "react";
import type { CapabilityDescriptor } from "@cjhyy/code-shell-core";
import type { Repo } from "../repos";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ScopeNode = { kind: "user" } | { kind: "project"; repoPath: string; label: string };

interface Props {
  repos: Repo[];
}

const KIND_LABEL: Record<string, string> = {
  builtin: "Builtin",
  mcp: "MCP",
  skill: "Skills",
  plugin: "Plugins",
};
const GROUP_ORDER = ["mcp", "skill", "plugin", "builtin"];

export function CapabilitiesOverviewSection({ repos }: Props) {
  const [node, setNode] = useState<ScopeNode>({ kind: "user" });
  const [caps, setCaps] = useState<CapabilityDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const cwd = node.kind === "project" ? node.repoPath : "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await window.codeshell.listCapabilities(cwd);
        if (!cancelled) setCaps(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const groups = useMemo(() => {
    const m = new Map<string, CapabilityDescriptor[]>();
    for (const c of caps) {
      const arr = m.get(c.kind) ?? [];
      arr.push(c);
      m.set(c.kind, arr);
    }
    return GROUP_ORDER.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [caps]);

  const reload = async () => {
    try {
      setCaps(await window.codeshell.listCapabilities(cwd));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUserToggle = async (cap: CapabilityDescriptor, next: boolean) => {
    setSavingId(cap.id);
    setError(null);
    setCaps((cs) => cs.map((c) => (c.id === cap.id ? { ...c, enabled: next } : c)));
    try {
      await window.codeshell.setCapabilityEnabled("", cap.id, next, { scope: "user" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reload();
    } finally {
      setSavingId(null);
    }
  };

  const onProjectState = async (
    cap: CapabilityDescriptor,
    state: "inherit" | "on" | "off",
  ) => {
    setSavingId(cap.id);
    setError(null);
    try {
      await window.codeshell.setCapabilityOverride(cwd, cap.id, state);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="flex gap-4">
      <nav className="w-48 shrink-0 space-y-1 text-sm">
        <button
          className={cn(
            "block w-full rounded px-2 py-1 text-left hover:bg-muted",
            node.kind === "user" && "bg-muted font-medium",
          )}
          onClick={() => setNode({ kind: "user" })}
        >
          用户（全局）
        </button>
        <div className="px-2 pt-2 text-xs uppercase text-muted-foreground">项目</div>
        {repos.map((r) => {
          const label = r.displayName || r.name;
          const active = node.kind === "project" && node.repoPath === r.path;
          return (
            <button
              key={r.id}
              className={cn(
                "block w-full truncate rounded px-2 py-1 text-left hover:bg-muted",
                active && "bg-muted font-medium",
              )}
              title={r.path}
              onClick={() => setNode({ kind: "project", repoPath: r.path, label })}
            >
              {label}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1">
        {error && <div className="mb-2 text-sm text-status-err">{error}</div>}
        {loading && <div className="text-sm text-muted-foreground">加载中…</div>}
        {!loading &&
          groups.map(([kind, rows]) => (
            <section key={kind} className="mb-4">
              <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                {KIND_LABEL[kind] ?? kind}
              </h4>
              <ul className="space-y-1">
                {rows.map((cap) => (
                  <li
                    key={cap.id}
                    className="flex items-center justify-between rounded border border-border px-2 py-1"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm" title={cap.description}>
                      {cap.name}
                      {cap.effectiveSource === "project" && (
                        <span className="ml-2 text-xs text-status-warn">本项目覆盖</span>
                      )}
                    </span>
                    {node.kind === "user" ? (
                      <Switch
                        checked={cap.enabled}
                        disabled={savingId === cap.id}
                        onCheckedChange={(v) => onUserToggle(cap, v)}
                      />
                    ) : (
                      <Select
                        value={cap.projectOverride ?? "inherit"}
                        disabled={savingId === cap.id || cap.kind === "builtin"}
                        onValueChange={(v) =>
                          onProjectState(cap, v as "inherit" | "on" | "off")
                        }
                      >
                        <SelectTrigger className="h-7 w-24 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inherit">继承</SelectItem>
                          <SelectItem value="on">开</SelectItem>
                          <SelectItem value="off">关</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update the caller's props**

Search `grep -rn "CapabilitiesOverviewSection" packages/desktop/src`. The caller currently passes `scope` + `activeRepoPath`. Change it to pass `repos={loadRepos()}` (import `loadRepos` from `../repos`). If the caller renders it under a single-scope tab, replace those props with the repos list. Show the exact edit after finding the caller — replace:

```tsx
<CapabilitiesOverviewSection scope={...} activeRepoPath={...} />
```
with:
```tsx
<CapabilitiesOverviewSection repos={loadRepos()} />
```
and ensure `import { loadRepos } from "../repos";` (adjust relative path to the caller's location).

- [ ] **Step 4: Desktop typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: clean. (If `CapabilityDescriptor` isn't re-exported from `@cjhyy/code-shell-core`, the renderer can't import core — check: renderer is a thin client per CLAUDE.md. If core types aren't available to the renderer, define a local structural type for the descriptor fields used here instead of importing from core.)

- [ ] **Step 5: Desktop renderer build**

Run: `cd packages/desktop && bun run build:renderer`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx
git commit -m "feat(desktop): Capabilities Overview tree UI (user + projects, tri-state)"
```

---

## Phase 4 — verification + finish

### Task 12: full verification + acceptance spot-checks

- [ ] **Step 1: Full core suite**

Run: `bun test packages/core`
Expected: PASS, count ≥ baseline 354 plus all new tests, 0 fail.

- [ ] **Step 2: Desktop typecheck + renderer build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: both clean.

- [ ] **Step 3: Acceptance spot-check (spec §10, items 1–5)**

Manually reason through / write a focused integration-style test if feasible:
- (1) project A skill off ⇒ project B + user unaffected (overlay is per-cwd file).
- (2) global plugin off + project A `on` ⇒ enabled only in A (`effectiveDisabledList` removes it for A only).
- (3) project A MCP off ⇒ project B unaffected; no shared registry/manager mutation (overlay filters the view; we never touched MCPManager).
- (4) project agent shadows user agent; delete project agent ⇒ user agent returns; `shadowedSources` populated (Task 9 tests).
- (5) old IPC call without scope ⇒ defaults to user (Task 6 back-compat test).

Document the result of each in the commit / PR description.

- [ ] **Step 4: Lint (if part of CI)**

Run: `bun run lint` (repo root) — fix any new lint errors in touched files only.

### Task 13: finish the branch

- [ ] Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- [ ] **REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch — verify tests, present merge/PR/cleanup options, execute the user's choice.

---

## Out of scope (explicitly NOT in this plan)

- **Phase 4 (model/session isolation):** per-session `modelKey`, `auxModelKey` project overlay, `max_tokens` de-poisoning, `configure({sessionId, model})`. Split into a separate effort per the user's decision and spec §14 Q1.
- **agent on/off tri-state overlay (§7.3):** deferred. Requires adding an `"agent"` kind to `CapabilityService` (new projection). This plan ships agent *definition* project-write + precedence reversal only.
- **builtin tools in `capabilityOverrides`** (spec §4.2 note): out by design.
- **Hot-disconnecting shared MCP connections** (spec §6.3): not done; overlay filters the view only.
- **Session-layer tab in the overview UI** (spec §7.5.1): deferred until Phase 4.

---

## Self-Review notes

- **Spec coverage:** §4 schema → Task 1; §4.3/§6 overlay math → Tasks 4/5/6; §5.1 project write → Tasks 2/3; §5.2 setOverride → Task 6; §5.3 IPC scope → Task 8; §6.2 raw-scope read → Task 3; §6.3 MCP view-filter → Task 6 (no unregister); §7.1 project agent write → Task 10; §7.2 reversal + shadowedSources → Task 9; §7.5 tree UI → Task 11; §9 unknown-value→inherit → Task 4; §12.1/12.2/12.3 tests → Tasks 1/2/4/6/9. §7.3 agent overlay + §8 model = explicitly deferred (documented above).
- **Type consistency:** `WriteScope`/`CapabilityOverrideState` defined in types.ts (Task 5), used in service.ts (Task 6), desktop (Task 8). `effectiveDisabledList`/`applyOverride`/`bucketForKind`/`overrideTokenForId`/`overrideFor` all defined in overlay.ts (Tasks 4, 7), imported by service.ts + engine.ts. `shadowedSources` added in Task 9 (agent-definition.ts) and produced by the registry (Task 9).
- **Known investigation point flagged inline:** Task 9 Step 7 — `loadAgentDefinitionsForCwd` uses `homedir()` not `process.env.HOME`; the engine-level test may need to defer to the registry-level test. Flagged, not hidden.

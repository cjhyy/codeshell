# Plugin Runtime Loading + update/list/uninstall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish plugin system v1 — make installed plugins actually usable at runtime (skills/hooks/agents/MCP) and add `update`/`list`/`uninstall` commands.

**Architecture:** install registers the local plugin in `installed_plugins.json` (so existing `scanInstalledPlugins`/`loadPluginHooks` auto-discover skills+hooks). New `loadPluginAgents` extends agent dirs; new `loadPluginMcp` merges each plugin's `mcp-servers.json` into `settings.mcpServers` at the three EngineConfig-assembly sites (repl.ts, run.ts, agent-server-stdio.ts). Three more CLI subcommands wrap installer functions.

**Tech Stack:** TypeScript ESM, bun:test, existing `appendInstallEntry`/`pluginInstallKey`/`removeInstallEntries`, `AgentDefinitionRegistry`, `commander`.

Spec: `docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`
Prior plan (done): `docs/superpowers/plans/2026-05-29-plugin-cc-codex-installer.md`

## Key facts (verified)

- Registering an entry in `installed_plugins.json` with `installPath=~/.code-shell/plugins/<name>` makes `scanInstalledPlugins` (skills) + `loadPluginHooks` discover it automatically — no new loader needed for those two.
- `appendInstallEntry(key, entry)`, `pluginInstallKey(plugin, marketplace)`, `removeInstallEntries(key)` exist (`installedPlugins.ts`). `PluginInstallEntry = {scope:"user", installPath, version, installedAt, lastUpdated, gitCommitSha?}`.
- Agents: `loadAgentDefinitionsForCwd(cwd, disabledAgents)` builds dirs `[project, user]`. `AgentSourceDir.source`/`AgentDefinition.source` are `"project"|"user"` — must widen to include `"plugin"`.
- MCP assembled at `repl.ts:150`, `run.ts:168`, `agent-server-stdio.ts:140` (all `mcpServers: settings.mcpServers`).

---

### Task 1: install registers into installed_plugins.json

**Files:**
- Modify: `packages/core/src/plugins/installer/install.ts`
- Modify: `packages/core/src/plugins/installer/install.test.ts`

After the successful `renameSync`, register the install so existing loaders discover it. Marketplace tag = `"local"`.

- [ ] **Step 1: Add failing test** (append to install.test.ts)

```typescript
import { readInstalledPlugins } from "../installedPlugins.js";

test("registers the install in installed_plugins.json", () => {
  mkdirSync(join(src, "skills", "s"), { recursive: true });
  writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
  const dir = installPluginFromPath(src, "regplug", STAMP);
  const reg = readInstalledPlugins();
  const entry = reg.plugins["regplug@local"]?.[0];
  expect(entry?.installPath).toBe(dir);
  expect(entry?.version).toBeDefined();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/core && bun test src/plugins/installer/install.test.ts`
Expected: FAIL — `regplug@local` undefined.

- [ ] **Step 3: Implement** — in `install.ts`, add import + register after `renameSync(tmpDir, finalDir);`:

```typescript
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";
```

```typescript
    renameSync(tmpDir, finalDir);
    appendInstallEntry(pluginInstallKey(name, "local"), {
      scope: "user",
      installPath: finalDir,
      version: meta.version ?? "local",
      installedAt,
      lastUpdated: installedAt,
    });
    return finalDir;
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/core && bun test src/plugins/installer/install.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/install.ts packages/core/src/plugins/installer/install.test.ts
git commit -m "feat(plugin-installer): register local install in installed_plugins.json"
```

---

### Task 2: widen agent source union + loadPluginAgents

**Files:**
- Modify: `packages/core/src/agent/agent-definition.ts:18` (source union)
- Modify: `packages/core/src/agent/agent-definition-registry.ts:7` (AgentSourceDir union)
- Modify: `packages/core/src/engine/engine.ts:222-234` (loadAgentDefinitionsForCwd)
- Test: `packages/core/src/plugins/installer/loadPluginAgents.test.ts`

Plugin agent dirs come from each registered plugin's `<installPath>/agents`. Build them from `readInstalledPlugins()`, append AFTER user dirs (so user overrides plugin), filtered by disabledPlugins.

- [ ] **Step 1: Widen the two unions**

`agent-definition.ts:18`:
```typescript
  source?: "project" | "user" | "plugin";
```

`agent-definition-registry.ts:7`:
```typescript
  source: "project" | "user" | "plugin";
```

- [ ] **Step 2: Add a helper + failing test** — create `loadPluginAgents.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pluginAgentDirs } from "./loadPluginAgents.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";

describe("pluginAgentDirs", () => {
  let home: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-pa-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("returns agents dir for each registered plugin, skips disabled", () => {
    const p = join(home, ".code-shell", "plugins", "p1");
    mkdirSync(join(p, "agents"), { recursive: true });
    appendInstallEntry(pluginInstallKey("p1", "local"), {
      scope: "user", installPath: p, version: "1", installedAt: "t", lastUpdated: "t",
    });
    expect(pluginAgentDirs([])).toEqual([{ dir: join(p, "agents"), source: "plugin" }]);
    expect(pluginAgentDirs(["p1"])).toEqual([]);
  });

  test("omits plugins without an agents dir", () => {
    const p = join(home, ".code-shell", "plugins", "p2");
    mkdirSync(p, { recursive: true });
    appendInstallEntry(pluginInstallKey("p2", "local"), {
      scope: "user", installPath: p, version: "1", installedAt: "t", lastUpdated: "t",
    });
    expect(pluginAgentDirs([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `cd packages/core && bun test src/plugins/installer/loadPluginAgents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — create `packages/core/src/plugins/installer/loadPluginAgents.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import type { AgentSourceDir } from "../../agent/agent-definition-registry.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/** Agent source dirs contributed by installed plugins (each <installPath>/agents). */
export function pluginAgentDirs(disabledPlugins: string[] = []): AgentSourceDir[] {
  const disabled = new Set(disabledPlugins);
  const out: AgentSourceDir[] = [];
  const data = readInstalledPlugins();
  for (const [key, entries] of Object.entries(data.plugins)) {
    if (disabled.has(pluginNameFromKey(key))) continue;
    for (const entry of entries) {
      const dir = join(entry.installPath, "agents");
      if (existsSync(dir)) out.push({ dir, source: "plugin" });
    }
  }
  return out;
}
```

- [ ] **Step 5: Wire into engine.ts** — modify `loadAgentDefinitionsForCwd` (also needs disabledPlugins; the engine has `readDisabledLists()`). Update signature + body:

```typescript
import { pluginAgentDirs } from "../plugins/installer/loadPluginAgents.js";

export function loadAgentDefinitionsForCwd(
  cwd: string,
  disabledAgents: string[] = [],
  disabledPlugins: string[] = [],
): AgentDefinitionRegistry {
  const home = homedir();
  return AgentDefinitionRegistry.loadFromDirs(
    [
      { dir: `${cwd}/.code-shell/agents`, source: "project" },
      ...pluginAgentDirs(disabledPlugins),
      { dir: `${home}/.code-shell/agents`, source: "user" },
    ],
    disabledAgents,
  );
}
```

Then update the caller `getAgentDefinitions` (engine.ts ~1969) to pass `this.readDisabledLists().disabledPlugins` as the 3rd arg, and include it in the cache key.

- [ ] **Step 6: Run agent test + typecheck**

Run: `cd packages/core && bun test src/plugins/installer/loadPluginAgents.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent/agent-definition.ts packages/core/src/agent/agent-definition-registry.ts packages/core/src/engine/engine.ts packages/core/src/plugins/installer/loadPluginAgents.ts packages/core/src/plugins/installer/loadPluginAgents.test.ts
git commit -m "feat(plugin-runtime): load plugin agents/ into AgentDefinitionRegistry"
```

---

### Task 3: loadPluginMcp — merge mcp-servers.json into settings

**Files:**
- Create: `packages/core/src/plugins/installer/loadPluginMcp.ts`
- Test: `packages/core/src/plugins/installer/loadPluginMcp.test.ts`

Pure merge function: given a base `mcpServers` map + disabledPlugins, scan registered plugins' `mcp-servers.json` and return a merged map. User-configured servers (same key) win.

- [ ] **Step 1: Failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergePluginMcpServers } from "./loadPluginMcp.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";

describe("mergePluginMcpServers", () => {
  let home: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-pm-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  function regPlugin(name: string, servers: Record<string, unknown>) {
    const p = join(home, ".code-shell", "plugins", name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "mcp-servers.json"), JSON.stringify(servers));
    appendInstallEntry(pluginInstallKey(name, "local"), {
      scope: "user", installPath: p, version: "1", installedAt: "t", lastUpdated: "t",
    });
  }

  test("merges plugin servers into the base map", () => {
    regPlugin("p1", { "p1:fs": { command: "f", name: "p1:fs" } });
    const merged = mergePluginMcpServers({ user1: { command: "u" } as any }, []);
    expect(merged.user1).toBeDefined();
    expect(merged["p1:fs"]).toMatchObject({ command: "f" });
  });

  test("skips disabled plugins", () => {
    regPlugin("p2", { "p2:x": { command: "x", name: "p2:x" } });
    const merged = mergePluginMcpServers({}, ["p2"]);
    expect(merged["p2:x"]).toBeUndefined();
  });

  test("user-configured key wins over plugin same-key", () => {
    regPlugin("p3", { dup: { command: "plugin", name: "dup" } });
    const merged = mergePluginMcpServers({ dup: { command: "user", name: "dup" } as any }, []);
    expect(merged.dup.command).toBe("user");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/core && bun test src/plugins/installer/loadPluginMcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `loadPluginMcp.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import type { MCPServerConfig } from "../../types.js";

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Merge each registered plugin's mcp-servers.json into a copy of `base`.
 * Plugin keys are already `<plugin>:<server>`. A key already present in `base`
 * (user-configured) is NOT overwritten. Disabled plugins are skipped.
 */
export function mergePluginMcpServers(
  base: Record<string, MCPServerConfig>,
  disabledPlugins: string[] = [],
): Record<string, MCPServerConfig> {
  const disabled = new Set(disabledPlugins);
  const merged: Record<string, MCPServerConfig> = { ...base };
  const data = readInstalledPlugins();
  for (const [key, entries] of Object.entries(data.plugins)) {
    if (disabled.has(pluginNameFromKey(key))) continue;
    for (const entry of entries) {
      const path = join(entry.installPath, "mcp-servers.json");
      if (!existsSync(path)) continue;
      let servers: Record<string, MCPServerConfig>;
      try {
        servers = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        continue; // malformed plugin mcp file must not break startup
      }
      for (const [k, cfg] of Object.entries(servers)) {
        if (k in merged) continue; // user / earlier wins
        merged[k] = cfg;
      }
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/core && bun test src/plugins/installer/loadPluginMcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/installer/loadPluginMcp.ts packages/core/src/plugins/installer/loadPluginMcp.test.ts
git commit -m "feat(plugin-runtime): mergePluginMcpServers — plugin MCP into settings map"
```

---

### Task 4: wire mergePluginMcpServers + export

**Files:**
- Modify: `packages/core/src/index.ts` (export new fns)
- Modify: `packages/tui/src/cli/commands/repl.ts:150`
- Modify: `packages/tui/src/cli/commands/run.ts:168`
- Modify: `packages/core/src/cli/agent-server-stdio.ts:140`

- [ ] **Step 1: Export from barrel** — add after the installer export block in `index.ts`:

```typescript
export { mergePluginMcpServers } from "./plugins/installer/loadPluginMcp.js";
export { pluginAgentDirs } from "./plugins/installer/loadPluginAgents.js";
export {
  appendInstallEntry,
  pluginInstallKey,
  removeInstallEntries,
} from "./plugins/installedPlugins.js";
```

- [ ] **Step 2: agent-server-stdio.ts** — replace `mcpServers: settings.mcpServers,` (line ~140) with:

```typescript
      mcpServers: mergePluginMcpServers(
        settings.mcpServers ?? {},
        (settings as { disabledPlugins?: string[] }).disabledPlugins ?? [],
      ),
```
Add import at top: `import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";` (core-internal relative path).

- [ ] **Step 3: repl.ts and run.ts** — replace `mcpServers: settings.mcpServers,` with the merged form:

```typescript
    mcpServers: mergePluginMcpServers(
      settings.mcpServers ?? {},
      (settings as { disabledPlugins?: string[] }).disabledPlugins ?? [],
    ),
```
Add import from the package: `import { mergePluginMcpServers } from "@cjhyy/code-shell-core";`

- [ ] **Step 4: Build core + typecheck both packages**

Run: `cd packages/core && npx tsc --noEmit && bun run build && cd ../tui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/cli/agent-server-stdio.ts packages/tui/src/cli/commands/repl.ts packages/tui/src/cli/commands/run.ts
git commit -m "feat(plugin-runtime): merge plugin MCP into settings at all EngineConfig sites"
```

---

### Task 5: uninstall (core fn + CLI)

**Files:**
- Create: `packages/core/src/plugins/installer/uninstall.ts`
- Test: `packages/core/src/plugins/installer/uninstall.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/tui/src/cli/commands/plugin.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uninstallPluginByName } from "./uninstall.js";
import { installPluginFromPath } from "./install.js";
import { readInstalledPlugins } from "../installedPlugins.js";

describe("uninstallPluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-un-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-un-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("removes the dir and the registry entry", () => {
    const dir = installPluginFromPath(src, "gone", "t");
    expect(existsSync(dir)).toBe(true);
    uninstallPluginByName("gone");
    expect(existsSync(dir)).toBe(false);
    expect(readInstalledPlugins().plugins["gone@local"]).toBeUndefined();
  });

  test("throws on unknown plugin", () => {
    expect(() => uninstallPluginByName("nope")).toThrow(/no plugin/);
  });

  test("rejects unsafe names", () => {
    expect(() => uninstallPluginByName("../evil")).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/core && bun test src/plugins/installer/uninstall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `uninstall.ts`:

```typescript
import { existsSync, rmSync } from "node:fs";
import { pluginInstallDir, assertSafePluginName } from "./paths.js";
import { removeInstallEntries, pluginInstallKey } from "../installedPlugins.js";
import { PluginInstallError } from "./types.js";

/** Remove a locally-installed plugin dir + its installed_plugins.json entry. */
export function uninstallPluginByName(name: string): void {
  assertSafePluginName(name);
  const dir = pluginInstallDir(name);
  if (!existsSync(dir)) {
    throw new PluginInstallError(`no plugin named '${name}'`);
  }
  rmSync(dir, { recursive: true, force: true });
  removeInstallEntries(pluginInstallKey(name, "local"));
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/core && bun test src/plugins/installer/uninstall.test.ts`
Expected: PASS.

- [ ] **Step 5: Export + add CLI subcommand** — `index.ts`:
```typescript
export { uninstallPluginByName } from "./plugins/installer/uninstall.js";
```
`plugin.ts` — add inside `createPluginCommand`, before `return plugin;`:
```typescript
  plugin
    .command("uninstall")
    .description("Remove an installed plugin")
    .argument("<name>", "Installed plugin name")
    .action((name: string) => {
      try {
        uninstallPluginByName(name);
        console.log(`Uninstalled '${name}'`);
      } catch (err) {
        if (err instanceof PluginInstallError) {
          console.error(`uninstall failed: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
```
And add `uninstallPluginByName` to the `@cjhyy/code-shell-core` import in `plugin.ts`.

- [ ] **Step 6: Build core + typecheck tui + commit**

```bash
cd packages/core && bun run build && cd ../tui && npx tsc --noEmit && cd ../..
git add packages/core/src/plugins/installer/uninstall.ts packages/core/src/plugins/installer/uninstall.test.ts packages/core/src/index.ts packages/tui/src/cli/commands/plugin.ts
git commit -m "feat(plugin): uninstall command + core fn"
```

---

### Task 6: list (core fn + CLI)

**Files:**
- Create: `packages/core/src/plugins/installer/list.ts`
- Test: `packages/core/src/plugins/installer/list.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/tui/src/cli/commands/plugin.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listInstalledPlugins } from "./list.js";
import { installPluginFromPath } from "./install.js";

describe("listInstalledPlugins", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-ls-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-ls-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("lists local installs with name/format/version", () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "cx", version: "9.9" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    installPluginFromPath(src, "cx", "t");
    const rows = listInstalledPlugins();
    const row = rows.find((r) => r.name === "cx");
    expect(row).toMatchObject({ name: "cx", format: "codex", version: "9.9" });
  });

  test("empty when nothing installed", () => {
    expect(listInstalledPlugins()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/core && bun test src/plugins/installer/list.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `list.ts` (reads `.cs-meta.json` from each registered local install):

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPlugins } from "../installedPlugins.js";
import { CSMeta } from "./types.js";

export interface PluginListRow {
  name: string;
  format: "cc" | "codex";
  version?: string;
  source: string;
  installedAt: string;
}

/** Read .cs-meta.json from each registered plugin dir that has one (local installs). */
export function listInstalledPlugins(): PluginListRow[] {
  const rows: PluginListRow[] = [];
  const data = readInstalledPlugins();
  for (const entries of Object.values(data.plugins)) {
    for (const entry of entries) {
      const metaPath = join(entry.installPath, ".cs-meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = CSMeta.parse(JSON.parse(readFileSync(metaPath, "utf-8")));
        rows.push({
          name: meta.name, format: meta.format, version: meta.version,
          source: meta.source, installedAt: meta.installedAt,
        });
      } catch {
        // not a local cs-managed install; skip
      }
    }
  }
  return rows;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/core && bun test src/plugins/installer/list.test.ts`
Expected: PASS.

- [ ] **Step 5: Export + CLI subcommand** — `index.ts`:
```typescript
export { listInstalledPlugins, type PluginListRow } from "./plugins/installer/list.js";
```
`plugin.ts`:
```typescript
  plugin
    .command("list")
    .description("List installed plugins")
    .action(() => {
      const rows = listInstalledPlugins();
      if (rows.length === 0) { console.log("No plugins installed."); return; }
      for (const r of rows) {
        console.log(`${r.name}  [${r.format}]  v${r.version ?? "?"}  ${r.source}`);
      }
    });
```
Add `listInstalledPlugins` to the core import.

- [ ] **Step 6: Build + typecheck + commit**

```bash
cd packages/core && bun run build && cd ../tui && npx tsc --noEmit && cd ../..
git add packages/core/src/plugins/installer/list.ts packages/core/src/plugins/installer/list.test.ts packages/core/src/index.ts packages/tui/src/cli/commands/plugin.ts
git commit -m "feat(plugin): list command + core fn"
```

---

### Task 7: update (core fn + CLI)

**Files:**
- Create: `packages/core/src/plugins/installer/update.ts`
- Test: `packages/core/src/plugins/installer/update.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/tui/src/cli/commands/plugin.ts`

Reinstall from `.cs-meta.json.source` when version changed or `--force`. Uses uninstall + install. Codex compares manifest version; CC always requires force (no version) per spec §8.2 degraded path.

- [ ] **Step 1: Failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updatePluginByName } from "./update.js";
import { installPluginFromPath } from "./install.js";

describe("updatePluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-up-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-up-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "1.0.0" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    installPluginFromPath(src, "u", "t1");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("no-op when version unchanged", () => {
    const r = updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(false);
  });

  test("reinstalls when source version bumped", () => {
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "2.0.0" }));
    const r = updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(true);
    const meta = JSON.parse(readFileSync(join(home, ".code-shell", "plugins", "u", ".cs-meta.json"), "utf-8"));
    expect(meta.version).toBe("2.0.0");
  });

  test("force reinstalls even when unchanged", () => {
    const r = updatePluginByName("u", "t2", true);
    expect(r.updated).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/core && bun test src/plugins/installer/update.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `update.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPluginFormat } from "./detectFormat.js";
import { pluginInstallDir } from "./paths.js";
import { uninstallPluginByName } from "./uninstall.js";
import { installPluginFromPath } from "./install.js";
import { CodexPluginManifest, CSMeta, PluginInstallError } from "./types.js";

export interface UpdateResult {
  updated: boolean;
  reason: string;
}

/**
 * Reinstall a plugin from its recorded source when the source version changed,
 * or when `force`. CC plugins have no version → only `force` updates them.
 */
export function updatePluginByName(
  name: string,
  installedAt: string,
  force: boolean,
): UpdateResult {
  const dir = pluginInstallDir(name);
  const metaPath = join(dir, ".cs-meta.json");
  if (!existsSync(metaPath)) throw new PluginInstallError(`no plugin named '${name}'`);
  const meta = CSMeta.parse(JSON.parse(readFileSync(metaPath, "utf-8")));

  if (!existsSync(meta.source)) {
    throw new PluginInstallError(`source no longer exists: ${meta.source}`);
  }

  if (!force) {
    if (detectPluginFormat(meta.source) === "codex") {
      const manifest = CodexPluginManifest.parse(
        JSON.parse(readFileSync(join(meta.source, ".codex-plugin", "plugin.json"), "utf-8")),
      );
      if (manifest.version === meta.version) {
        return { updated: false, reason: "already up to date" };
      }
    } else {
      return { updated: false, reason: "CC plugin needs --force to reinstall" };
    }
  }

  uninstallPluginByName(name);
  installPluginFromPath(meta.source, name, installedAt);
  return { updated: true, reason: "reinstalled" };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/core && bun test src/plugins/installer/update.test.ts`
Expected: PASS.

- [ ] **Step 5: Export + CLI subcommand** — `index.ts`:
```typescript
export { updatePluginByName, type UpdateResult } from "./plugins/installer/update.js";
```
`plugin.ts`:
```typescript
  plugin
    .command("update")
    .description("Re-install a plugin from its source if changed")
    .argument("<name>", "Installed plugin name")
    .option("--force", "Reinstall even if unchanged")
    .action((name: string, opts: { force?: boolean }) => {
      try {
        const r = updatePluginByName(name, new Date().toISOString(), Boolean(opts.force));
        console.log(r.updated ? `Updated '${name}'` : `'${name}': ${r.reason}`);
      } catch (err) {
        if (err instanceof PluginInstallError) {
          console.error(`update failed: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
```
Add `updatePluginByName` to the core import.

- [ ] **Step 6: Build + typecheck + commit**

```bash
cd packages/core && bun run build && cd ../tui && npx tsc --noEmit && cd ../..
git add packages/core/src/plugins/installer/update.ts packages/core/src/plugins/installer/update.test.ts packages/core/src/index.ts packages/tui/src/cli/commands/plugin.ts
git commit -m "feat(plugin): update command (version/force) + core fn"
```

---

### Task 8: full regression + real plugin install test

**Files:** none (verification)

- [ ] **Step 1: Full core suite**

Run: `cd packages/core && bun test src 2>&1 | tail -5`
Expected: all pass, no regression.

- [ ] **Step 2: Typecheck core + tui**

Run: `cd packages/core && npx tsc --noEmit && cd ../tui && npx tsc --noEmit`
Expected: EXIT 0 both.

- [ ] **Step 3: Real-plugin end-to-end** — install a real CC plugin + a real Codex plugin, list, verify discovery, uninstall. (Concrete commands constructed at execution time — find a real CC plugin repo with skills/ and a real Codex plugin with .codex-plugin/plugin.json.)

- [ ] **Step 4: Final commit if any fixup needed**

---

## Self-Review notes

- **Spec coverage:** §M5 runtime → T1 (register) + T2 (agents) + T3/T4 (mcp merge at all 3 sites); §8.4 uninstall → T5; §8.3 list → T6; §6.7/§8.2 update → T7. Skills+hooks need no new code (auto-discovered via T1 registration).
- **Type consistency:** `mergePluginMcpServers(base, disabledPlugins)`, `pluginAgentDirs(disabledPlugins)`, `uninstallPluginByName(name)`, `listInstalledPlugins()`, `updatePluginByName(name, installedAt, force)` — stable across tasks. `installedAt`/timestamp passed in (Date.now unavailable in core); CLI stamps.
- **source union widened** to `"project"|"user"|"plugin"` in both agent-definition.ts and agent-definition-registry.ts — used consistently in T2.
- **Marketplace tag `"local"`** for all local installs — used in T1 register, T5 uninstall key, consistent.

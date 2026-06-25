# plugins

**One-line role.** Install, register, load, and inventory plugins/skills/marketplaces under `~/.code-shell/plugins/`, bridging both Claude Code (CC) and Codex on-disk formats into one runtime shape that the engine consumes.

## 职责 / Responsibility

This module owns the full lifecycle of a plugin: parse a source (local path or git URL), detect whether it is a CC or Codex plugin, convert Codex artifacts (agents TOML→MD, MCP map, skills, commands) into the CC-shaped layout, copy it atomically into `~/.code-shell/plugins/<name>/`, and record it in `installed_plugins.json` (V2). It also provides the read-side loaders the engine calls at session/turn build time — plugin hooks, plugin agent dirs, and plugin MCP servers — plus a marketplace registry and a read-only content inventory for the UI. It deliberately does **not** decide whether a plugin is *enabled*: disabling is layered on top via `disabledPlugins` lists passed in by `capability-control`; this module just reads/writes/loads.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `types.ts` | Marketplace + installed-plugins type defs: `InstalledPluginsV2`, `PluginInstallEntry`, `MarketplaceSource`, `PluginMarketplace`, `MarketplaceFormat`. |
| `installedPlugins.ts` | Read/write `~/.code-shell/plugins/installed_plugins.json` (V2). `readInstalledPlugins`, `appendInstallEntry`, `removeInstallEntries`, `pluginInstallKey`. |
| `loadPluginHooks.ts` | Scan each installed plugin's `hooks/hooks.json`, map CC PascalCase events → codeshell snake_case, and register command hooks with the engine `HookRegistry`. Also `listPluginHooks` (read-only) + `pluginHookKey`. |
| `pluginContent.ts` | `describePluginContent` — read-only inventory of one plugin's skills/commands/agents/hooks/MCP for the detail UI. |
| `pluginCommandsLoader.ts` | `scanPluginCommands` — discover `commands/*.md` slash commands across installed plugins (cached; `invalidatePluginCommandsCache`). |
| `marketplaceManager.ts` | Marketplace registry: clone/add/remove/load a `marketplace.json`, `detectMarketplaceFormat`, paths under `~/.code-shell/marketplaces/`. |
| `parseMarketplaceInput.ts` | Classify a `marketplace add <input>` arg into a `MarketplaceSource` + derive its name. |
| `pluginInstaller.ts` | Marketplace-driven install path: `installPlugin(pluginName, marketplaceName)`, `uninstallPlugin`, `listInstalled`, plus `${...}` var-rewrite + SHA-pinning helpers. |
| `gitOps.ts` | Thin git wrappers (`gitClone`, `gitLsRemote`, `gitRevParseHead`, `githubRepoToCloneUrl`) used by remote install/update. |
| `knownMarketplaces.ts` | Read/write the `known_marketplaces.json` registry file. |
| `schemas.ts` | Zod schemas for `marketplace.json` / manifest validation. |
| `varRewrite.ts` | Rewrite `${CODESHELL_PLUGIN_ROOT}`-style placeholders in installed plugin files. |
| `pluginCommandHook.ts` | Execute a single command-type plugin hook (env injection, timeout) — called by `loadPluginHooks`. |
| `installer/parseSource.ts` | Pure parse of a `plugin install <source>` arg → `ParsedSource` (`local` path \| `remote` git url + ref/subdir). No I/O. |
| `installer/detectFormat.ts` | `detectPluginFormat(dir)` → `"codex"` if `.codex-plugin/plugin.json` exists, else `"cc"`. |
| `installer/install.ts` | `installPluginFromPath` — local→installed dir; CC verbatim copy or Codex convert; writes `.cs-meta.json`; atomic temp→rename; registers install entry. |
| `installer/installFromSource.ts` | `installPluginFromSource` — clone remote to temp, delegate to `installPluginFromPath`, rewrite recorded source back to the git string + record HEAD sha. |
| `installer/loadPluginMcp.ts` | `mergePluginMcpServers(base, disabled?)` — fold every plugin's MCP servers (keyed `<plugin>:<server>`) into a base map; user/earlier keys win. |
| `installer/loadPluginAgents.ts` | `pluginAgentDirs(disabled?)` — list each installed plugin's `agents/` dir as agent sources. |
| `installer/list.ts` | `listInstalledPlugins` — read `.cs-meta.json` rows (cs-managed installs only). |
| `installer/uninstall.ts` | `uninstallPluginByName` — rm the dir + drop its `installed_plugins.json` entry. |
| `installer/update.ts` | `updatePluginByName(name, installedAt, force)` — re-clone a remote-sourced plugin. |
| `installer/checkUpdate.ts` | `checkPluginUpdate(name)` — compare recorded commit vs `git ls-remote` without cloning. |
| `installer/types.ts` | `CodexPluginManifest` + `CSMeta` zod schemas, `PluginInstallError`. |
| `installer/paths.ts` | `pluginsRoot`, `pluginInstallDir`, `pluginMetaPath`, `assertSafePluginName` (path-traversal guard). |
| `installer/codex/*` | Codex→CC converters: `convertAgents` (TOML→MD), `convertMcp`, `convertSkills`, `convertCommands`. |

## 公开接口 / Public API

Re-exported from `@codeshell/core` (`src/index.ts`). The two install paths are distinct: `installer/*` handles **local paths and arbitrary git sources**, while `pluginInstaller.ts` handles **marketplace-resolved** installs.

```ts
// installed_plugins.json (V2)
function readInstalledPlugins(): InstalledPluginsV2;
interface InstalledPluginsV2 { version: 2; plugins: Record<string, PluginInstallEntry[]>; }

// Source-based install (local dir or remote git)
function parseSource(input: string): ParsedSource;            // pure, no I/O
function detectPluginFormat(sourceDir: string): "codex" | "cc";
function installPluginFromPath(sourceDir: string, name: string, installedAt: string): Promise<string>; // returns installed dir
function installPluginFromSource(parsed: ParsedSource, name: string, installedAt: string): Promise<string>;
function uninstallPluginByName(name: string): void;
function listInstalledPlugins(): PluginListRow[];
function updatePluginByName(name: string, installedAt: string, force: boolean): Promise<UpdateResult>;
function checkPluginUpdate(name: string): Promise<UpdateCheck>;

// Marketplace-based install
function addMarketplace(/* ... */): Promise<AddMarketplaceResult>;
function loadMarketplace(name: string): PluginMarketplace | null;
function listMarketplaces(): ListedMarketplace[];
function installPlugin(pluginName: string, marketplaceName: string): Promise<InstallResult>;

// Read-side loaders the engine calls
function loadPluginHooks(registry: HookRegistry, disabledPlugins?: string[], disabledPluginHooks?: string[]): void;
function listPluginHooks(disabledPlugins?: string[]): PluginHookEntry[];
function pluginAgentDirs(disabledPlugins?: string[]): AgentSourceDir[];
function mergePluginMcpServers(base: Record<string, MCPServerConfig>, disabledPlugins?: string[]): Record<string, MCPServerConfig>;
function scanPluginCommands(): PluginCommand[];
function describePluginContent(pluginName: string, installPath: string): PluginContentInventory;
```

## 怎么用 / How to use

**1. Engine wires plugin contributions at build time** (real call sites in `engine/engine.ts`):

```ts
import { readInstalledPlugins } from "../plugins/installedPlugins.js";
import { loadPluginHooks } from "../plugins/loadPluginHooks.js";
import { pluginAgentDirs } from "../plugins/installer/loadPluginAgents.js";

// agent source dirs — disabledPlugins folded by capability-control's readDisabledLists
const agentDirs = [...pluginAgentDirs(disabledPlugins)];

// register plugin hooks into the engine's HookRegistry — called exactly once
// after the registry is created (HookRegistry has no de-dup).
loadPluginHooks(this.hooks, disabledPlugins, disabledPluginHooks);
```

`disk-defaults.ts` and the stdio/tcp agent servers similarly fold MCP servers:

```ts
import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";
const mcpServers = mergePluginMcpServers(userConfiguredServers, disabledPlugins);
// keys are "<plugin>:<server>"; user-configured keys are never overwritten.
```

**2. A host installs a local plugin directory** (the source-install path, e.g. extension upload):

```ts
import { parseSource } from "@codeshell/core";
import { installPluginFromPath, installPluginFromSource } from "@codeshell/core";

const parsed = parseSource(input);          // "github:org/repo#subdir@ref" or a local path
const installedAt = new Date().toISOString(); // caller stamps the timestamp (install fns are pure of Date.now)
const dir = parsed.kind === "remote"
  ? await installPluginFromSource(parsed, parsed.inferredName, installedAt)
  : await installPluginFromPath(parsed.path, /* name */ "my-plugin", installedAt);
// installPluginFromPath auto-detects CC vs Codex, converts if needed, writes
// .cs-meta.json, and appends an installed_plugins.json entry keyed "<name>@local".
```

## 注意 / Gotchas

- **`installedAt` is injected, not generated.** Install/update functions take the timestamp as a parameter (kept pure of `Date.now()` for replay/test determinism). The caller stamps it.
- **Atomic install.** `installPluginFromPath` builds into a `.tmp-<name>-<pid>` sibling and `rename`s into place; any conversion failure removes the temp dir, so a half-built plugin never lands. It refuses to overwrite an existing `<name>/` — uninstall first.
- **CC `cp` is intentionally async.** A recursive copy of a whole plugin dir is awaited so the Electron main process keeps answering IPC — do not switch it to a sync copy (see the "main 同步fs假死" lesson).
- **`detectPluginFormat` is purely structural:** the presence of `.codex-plugin/plugin.json` ⇒ Codex, everything else ⇒ CC. There is no manifest-version sniffing.
- **MCP key convention:** plugin MCP servers are always keyed `<plugin>:<server>` and the server's own `name` field is set to that same key (record key carries identity — see the "MCP名字=record key约定" lesson). `mergePluginMcpServers` never overwrites a key already in `base`.
- **Two install surfaces, don't confuse them.** `installPlugin(plugin, marketplace)` resolves a marketplace entry; `installPluginFromPath/Source` take a path/git source directly. They share the same on-disk result but different entry points.
- **`disabledPlugins` matches bare plugin names** (no `@marketplace`, no `:` suffix) — same semantics as `scanSkills`. A disabled plugin contributes zero hooks/agents/MCP/commands. The fine-grained per-hook switch (`disabledPluginHooks`) uses `pluginHookKey` = `plugin:RawEvent:command` (content-derived, survives reinstall).
- **Best-effort everywhere on the read side.** Malformed `hooks.json` / `.mcp.json` / `.cs-meta.json` from one plugin is swallowed (returns `{}`/skips) so it can't break engine startup or block other plugins.
- **`SubagentStop` is dropped.** The CC→codeshell event map sends it to `null` (codeshell sub-agents don't surface that event); unknown event names are silently skipped.
- **Must rebuild core** (`bun run build` in `packages/core`) for changes here to take effect in the TUI/desktop hosts, which import from `dist/`. Loaders run at session/turn build time, so most changes here are picked up by the next new session, not mid-turn.
- **`installedPluginsPath` honours `process.env.HOME` first** (test isolation); writes go to `~/.code-shell/plugins/installed_plugins.json`. Don't hardcode `homedir()` in tests against this module.

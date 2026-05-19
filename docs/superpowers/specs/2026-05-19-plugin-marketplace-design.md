# Plugin Marketplace MVP — Spec + Plan

**Status**: Approved (user directive: "都按照cc源代码来 不用brainstorming")
**Date**: 2026-05-19
**Approach**: Byte-for-byte alignment with Claude Code's plugin system, MVP subset.

## Goal

codeshell user can:

```
/plugin marketplace add https://github.com/anthropics/skills
/plugin install document-skills@anthropic-agent-skills
```

After install:
- `~/.code-shell/plugins/installed_plugins.json` records the install
- `~/.code-shell/plugins/cache/<marketplace>/<plugin>/<sha>/skills/<skill>/SKILL.md` is on disk
- `/skills` lists each plugin skill as `<plugin>:<skill>` under a "Plugin skills" group
- `Skill` tool can invoke `<plugin>:<skill>` and load the SKILL.md body

## In Scope (MVP)

Lifted from CC's MVP subset per Phase C survey:

1. **Source types**: `github` (`anthropics/skills`) and `git` (`https://github.com/...git`). NPM, pip, file, directory, hostPattern deferred.
2. **Marketplace persistence**: `~/.code-shell/plugins/known_marketplaces.json`. Schema: `Record<name, { source: MarketplaceSource, installLocation, lastUpdated }>`.
3. **Plugin install persistence**: `~/.code-shell/plugins/installed_plugins.json` V2 only (no V1 migration since codeshell starts fresh). Schema: `{ version: 2, plugins: Record<"<plugin>@<marketplace>", PluginInstallEntry[]> }`.
4. **Marketplace JSON** at `marketplaces/<name>/.claude-plugin/marketplace.json`, validated against the CC `PluginMarketplaceSchema` subset we support (name, owner, plugins[], optional metadata).
5. **Plugin entry source** subset: `path` (inline, relative to marketplace root) and `{ source: "git" | "github" | "git-subdir", url, path?, ref?, sha? }`. The Adobe-style `git-subdir` is essential since `anthropics/skills` uses it.
6. **Cache layout**: `~/.code-shell/plugins/cache/<marketplace>/<plugin>/<version>/` (version = git short SHA, "unknown" if local path).
7. **Skill discovery integration**: extend `scanSkills()` to also walk every installed plugin's `skills/` dir; namespace each as `<plugin>:<skill>`.
8. **Slash commands**: `/plugin marketplace add <git-url>`, `/plugin marketplace remove <name>`, `/plugin marketplace list`, `/plugin install <plugin>@<marketplace>`, `/plugin uninstall <plugin>@<marketplace>`, `/plugin list`. All non-interactive (no Dialog UI — codeshell's existing slash commands write to `ctx.addStatus`).
9. **Error handling**: git clone retry once, schema validation gives `marketplace-load-failed` with a clear message, missing plugin → `plugin-not-found`. Always recoverable; never throw out of slash-command execute.

## Out of Scope (deferred)

- Dependency closure resolution (plugin → plugin deps)
- Multi-scope installs (`project`, `local`, `managed`)
- npm / pip / hostPattern / directory source types
- Sparse-checkout / monorepo optimization
- Background reconciliation / autoupdate
- Policy blocking via managed settings
- Dialog UI (PluginSettings.tsx, ManagePlugins.tsx, DiscoverPlugins.tsx)
- Plugin trust / signing
- Plugin-provided commands, hooks, MCP servers, tools, agents (only `skills/` consumed)
- enable/disable toggle (every installed plugin is enabled)
- Plugin manifest `.claude-plugin/plugin.json` (lazily, only `skills/` directory matters for MVP)

## File Map

```
src/plugins/
  schemas.ts            ← CC-aligned Zod-ish validators (no Zod, lightweight)
  marketplaceManager.ts ← add/remove marketplace + load+cache
  pluginInstaller.ts    ← install/uninstall plugin from a known marketplace
  pluginLoader.ts       ← enumerate installed plugins for the scanner
  knownMarketplaces.ts  ← read/write known_marketplaces.json
  installedPlugins.ts   ← read/write installed_plugins.json (V2)
  gitOps.ts             ← thin wrapper over `git clone`, `git rev-parse HEAD`, etc.
  parseMarketplaceInput.ts ← github://, https://, ssh:// → MarketplaceSource
  types.ts              ← shared types

  loader.ts (existing)  ← DELETE (dead code from before Phase A)
  types.ts  (existing)  ← MERGE into new types.ts

src/skills/
  scanner.ts            ← extend bases() to include installed-plugin skill dirs; namespace name as <plugin>:<skill> when source==="plugin"

src/cli/commands/builtin/
  plugin-command.ts (new) ← /plugin ... slash command handler
  extra-commands.ts     ← register plugin-command + add it to the menu

src/tool-system/builtin/
  skill.ts              ← lookup must also try <plugin>:<skill> form
  skill-prompt.ts       ← buildSkillListing groups "Plugin skills" similarly to project/user

tests/
  plugins-marketplace.test.ts   ← knownMarketplaces, parseMarketplaceInput, marketplaceManager
  plugins-installer.test.ts     ← install/uninstall, installedPlugins
  plugins-skill-integration.test.ts ← scanner picks up plugin skills with namespace
  plugins-command.test.ts       ← /plugin slash command parsing + outputs
```

## Schemas (TypeScript)

```ts
// types.ts
export type MarketplaceSource =
  | { source: "github"; repo: string /* owner/name */ }
  | { source: "git"; url: string };

export interface KnownMarketplace {
  source: MarketplaceSource;
  installLocation: string;       // absolute path
  lastUpdated: string;            // ISO 8601
}

export type KnownMarketplaces = Record<string, KnownMarketplace>;

export type PluginEntrySource =
  | string                                                 // path relative to marketplace root
  | { source: "git";        url: string; ref?: string; sha?: string }
  | { source: "github";     repo: string; ref?: string; sha?: string }
  | { source: "git-subdir"; url: string; path: string; ref?: string; sha?: string };

export interface PluginMarketplaceEntry {
  name: string;
  description?: string;
  author?: { name: string; email?: string };
  category?: string;
  source: PluginEntrySource;
  homepage?: string;
}

export interface PluginMarketplace {
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: PluginMarketplaceEntry[];
}

export interface PluginInstallEntry {
  scope: "user";                  // MVP: only user
  installPath: string;            // absolute path to versioned cache dir
  version: string;                // git short SHA or "unknown"
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

export interface InstalledPluginsV2 {
  version: 2;
  plugins: Record<string, PluginInstallEntry[]>;  // key = "<plugin>@<marketplace>"
}
```

## Data Flow

### `/plugin marketplace add <git-url>`

1. `parseMarketplaceInput(input)` → `MarketplaceSource` (github vs git)
2. Derive `name` from repo (last path segment, strip `.git`)
3. If `known_marketplaces.json[name]` exists with same source → "already added", success
4. `git clone` into `~/.code-shell/plugins/marketplaces/<name>/`
5. Read `<dir>/.claude-plugin/marketplace.json`, validate
6. Write entry into `known_marketplaces.json`
7. Report success with marketplace name and plugin count

### `/plugin install <plugin>@<marketplace>`

1. Load `known_marketplaces.json[marketplace]`. Not found → error.
2. Load marketplace.json from `installLocation`, find `plugins[i].name === plugin`. Not found → error.
3. Resolve `entry.source`:
   - `string` (path): relative to marketplace install dir, copy that subdir into cache
   - `{source: "git" | "github"}`: `git clone` (use `ref` if present) into cache
   - `{source: "git-subdir"}`: `git clone` then keep only `path` subdir (or sparse-checkout — MVP: full clone then copy subdir, simpler)
4. `git rev-parse HEAD` to get short SHA → cache dir is `cache/<marketplace>/<plugin>/<sha>/`
5. Append entry to `installed_plugins.json[<plugin>@<marketplace>]`
6. Invalidate skill cache
7. Report installed skills count

### scanner integration

Currently `scanSkills(cwd)` walks two bases (`project`, `user`). Add a third pass:

```
for each (key, entries) in installed_plugins.json.plugins:
  for each entry in entries:
    pluginName = key.split("@")[0]
    walk <entry.installPath>/skills/<skillDir>/SKILL.md
    push { name: `${pluginName}:${skillDir}`, ..., source: "plugin" }
```

Memoize key extends to `cwd + HOME + installedPluginsMtime` so installs invalidate.

### `Skill` tool

`scanSkills().find(s => s.name === skillName)` already works since plugin skills carry their namespaced name. Zero changes inside `skill.ts` beyond what Task 4 of Phase A already does.

### `/skills` output

Add a third group "Plugin skills" rendered after project + user. Sorted by namespaced name.

## Test Targets

~30 cases total:

- `parseMarketplaceInput`: github shorthand `owner/repo`, https url, ssh url, derive name
- `knownMarketplaces`: read/write/upsert/remove; missing file → empty
- `installedPlugins`: V2 round trip; append multiple plugins; remove single entry
- `marketplaceManager.addMarketplace`: success, duplicate same source = no-op, duplicate different source = replace, invalid marketplace.json = clear error
- `pluginInstaller.installPlugin`: git source, github source, git-subdir source, path source; SHA captured; installed_plugins updated; idempotent
- `pluginInstaller.uninstallPlugin`: removes from manifest, rms cache dir
- scanner integration: plugin skill appears with namespaced name; uninstall makes it disappear; cache invalidation on install
- skill-prompt listing: "Plugin skills" group rendered when plugin skills present
- `/plugin` command: parse subcommands; non-existent marketplace; conflicting names

## Implementation Order

8 tasks, each TDD where it makes sense, each one commit.

1. **Task 1**: types.ts + schemas.ts (validators) + delete dead `src/plugins/loader.ts`, `src/plugins/types.ts`. Tests for schema validation positive/negative.
2. **Task 2**: `parseMarketplaceInput.ts` + tests (github shorthand, https, ssh, name derivation, invalid input).
3. **Task 3**: `gitOps.ts` (clone, rev-parse HEAD, fetch) + `knownMarketplaces.ts` + `installedPlugins.ts` round-trip persistence. Tests use temp dirs + a local bare-repo fixture for `git clone`.
4. **Task 4**: `marketplaceManager.ts` (add/remove/list/load). Tests against a fixture marketplace repo on disk.
5. **Task 5**: `pluginInstaller.ts` (install/uninstall, all four source types). Tests use the same fixture.
6. **Task 6**: scanner integration. Extend `bases()` + `SkillDefinition.source` to include `"plugin"`. Update memoize key. Tests: plugin skill discoverable with namespaced name, uninstall removes, install invalidates cache.
7. **Task 7**: `/plugin` slash command. `plugin-command.ts` parses subcommand and dispatches to managers. Tests assert addStatus contents for each subcommand.
8. **Task 8**: end-to-end smoke — actually `add https://github.com/anthropics/skills` and `install document-skills@anthropic-agent-skills`, run `/skills`, see `document-skills:pdf` in the listing, invoke `Skill(skill="document-skills:pdf")` and confirm body loads.

## Risks

- **`anthropics/skills` is a `github` source with multiple plugins**: marketplace.json `plugins[]` array has entries with `source: "./plugins/<name>"` (relative path) and `source: { source: "git-subdir", ... }`. Both forms must work in Task 5.
- **git clone latency**: ~10s for a typical marketplace repo. Slash command should print progress, but MVP: synchronous, single line "Cloning..." then result.
- **Filesystem case insensitivity (macOS)**: plugin names should be case-preserved but compared case-sensitively, matching CC.
- **Settings policy**: codeshell has `~/.code-shell/settings.json` but MVP skips `enabledPlugins` toggle — every install is implicitly enabled.

## Acceptance

When `/plugin install document-skills@anthropic-agent-skills` succeeds, `/skills` shows lines starting with `document-skills:` and the `Skill` tool can invoke them.

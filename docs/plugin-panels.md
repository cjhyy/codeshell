# Plugin panels v1

CodeShell plugins can contribute sandboxed panels to the Desktop right dock. The manifest is
validated and normalized by core during installation. Core loads panels as part of its trusted
installed-plugin catalog; Desktop consumes those declarations and only owns the UI sandbox host.

An installed plugin is a distribution package, not one runtime extension type. Core expands it
into typed contributions: skills/agents/hooks/MCP feed the agent runtime, while each `panels.entry`
becomes a separate `kind: "panel"` UI contribution. The Desktop Extensions page lists packages and
panels separately even when they were installed together.

## Package, agent contribution, and panel contribution

These names deliberately describe different layers:

| Layer              | Owned by                        | Meaning                                                                                |
| ------------------ | ------------------------------- | -------------------------------------------------------------------------------------- |
| Plugin package     | core installer/catalog          | One installed distribution and its canonical manifest.                                 |
| Agent contribution | core Engine                     | Skills, agents, MCP, tools/capabilities, and Engine hooks. It can run without Desktop. |
| Panel contribution | core contract + Desktop adapter | A panel instance with lifecycle and a view. It is not automatically an agent plugin.   |

Core now exposes two code boundaries for trusted in-process modules:

- `CapabilityModule.engineHooks` joins session/turn/tool handlers to the normal Engine hook chain.
- `PluginLifecycleRuntime` coordinates `activate`, `panel_mount`, `panel_context_changed`,
  `panel_visibility_changed`, `panel_unmount`, and `deactivate` without importing React or Electron.

Browser hosts import that coordinator from the reviewed
`@cjhyy/code-shell-core/browser/plugin-runtime` entry. The general
`@cjhyy/code-shell-core/plugin-runtime` path remains compatible for existing
Node/headless consumers, but Desktop renderer code intentionally uses only the
browser-named entry.

Desktop's `DesktopPanelPlugin` binds that lifecycle to a logical dock tab and supplies a scoped host
service plus a view adapter. QuickChat is the first built-in code-backed panel: its module ensures a
side session on mount/context change and releases the claimed session on unmount. `PanelRegistry`
does not contain QuickChat-specific rendering or startup logic.

### Agent tools and model-driven opening

A panel does not mutate the Engine tool registry when its React/webview body mounts. Tool
availability must remain stable when the dock is hidden, the renderer reloads, or an agent runs
headlessly. Instead, a trusted code extension contributes two siblings:

- a core `CapabilityModule` with `tools` and/or `engineHooks`;
- a Desktop panel module with lifecycle hooks and a view adapter.

The capability tool can call `ctx.panels.open(stablePanelId)`. Core's generic `Panel` tool exposes
the same bridge to the model with `action: "list" | "open"`. Desktop resolves list/open against the
live `PanelRegistry`, routes the request to the originating session bucket, opens the dock, and
focuses an existing tab or creates one. Core still has no React/Electron dependency.

```ts
const PANEL_ID = "plugin:build-insights@local:dashboard";

const capability: CapabilityModule = {
  id: "build-insights-agent",
  tools: [
    {
      definition: buildInsightsToolDefinition,
      exposure: { presetTags: ["general"] },
      execute: async (args, ctx) => {
        await ctx?.panels?.open(PANEL_ID);
        return runBuildInsights(args);
      },
    },
  ],
};
```

Installed, untrusted packages do not gain in-process code execution from `panels`. They can ship
MCP/skills/agents/hooks as separate agent contributions, and the generic `Panel` tool can still
open their manifest panel by the namespaced id returned from `Panel(action="list")`.

Manifest panels use the same conceptual split but remain untrusted: their JavaScript runs inside the
`csplugin://` guest and can do work only through the scoped bridge below. Desktop must never import
arbitrary installed JavaScript into the core/agent process. A future out-of-process controller can
implement the core lifecycle RPC contract without weakening this sandbox boundary.

## Manifest

For a Codex-compatible package, keep `.codex-plugin/plugin.json` standard and
put CodeShell-only UI contributions in `.codeshell-plugin/plugin.json`.
Legacy packages may still declare the same `panels` object directly in either
`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`.

```json
{
  "schemaVersion": 1,
  "panels": {
    "version": 1,
    "entries": [
      {
        "id": "dashboard",
        "title": {
          "default": "Build dashboard",
          "en": "Build dashboard",
          "zh-CN": "构建面板"
        },
        "entry": "panels/dashboard/index.html",
        "icon": "chart",
        "placement": "right-dock",
        "singleton": true,
        "permissions": ["context.workspace", "storage"]
      }
    ]
  }
}
```

`id` is a lowercase identifier local to the plugin. `entry` must be a relative `.html` path with
no dot segments, query, hash, backslash, or hidden path segment. The installed entry must resolve
to a real file inside the plugin root. Put entries in a dedicated directory when they use JS, CSS,
fonts, or images: the `csplugin://` host serves only the entry's containing tree. A root-level entry
can load only itself.

`icon` accepts the v1 semantic aliases (`panel`, `chart`, `table`) plus an explicit allowlist of
kebab-case [lucide](https://lucide.dev) icon names (for example `bar-chart-3`, `layout-dashboard`,
`git-branch`, `rocket`) — 87 validated names in total. The authoritative list is `PLUGIN_PANEL_ICONS`
in `packages/core/src/plugins/installer/types.ts`, mirrored for the renderer as
`PLUGIN_PANEL_ICON_NAMES` in `packages/desktop/src/shared/plugin-panels.ts`. Unknown names are
rejected at install time, and `resolvePluginPanelIcon` falls back to the generic panel icon for
anything stale. A plugin can declare at most 16 panels. Panel ids must be unique within one manifest.

## Sandbox

Each panel gets a separate, non-persistent Electron partition and opaque `csplugin://` authority.
The host is read-only, disables Electron permissions, rejects navigation and popups, and applies a
fixed CSP with no network, frames, forms, objects, or inline/eval scripts. Node.js and the normal
Desktop preload are unavailable.

Static assets may use `.html`, `.js`, `.mjs`, `.css`, `.json`, `.png`, `.jpg`, `.jpeg`, `.webp`,
`.woff`, `.woff2`, and `.ttf`. Every request is realpath-checked against the installed plugin root.

## Scoped API

The guest preload exposes one frozen object:

```ts
const context = await window.codeshellPanel.getContext();
const value = await window.codeshellPanel.call("storage.get", { key: "filters" });
const unsubscribe = window.codeshellPanel.on("context.changed", (next) => {
  // session, workspace, visibility, theme, or locale changed
});
```

No capability is granted by default. Manifest permissions map to the following context or methods:

| Permission           | Capability                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `context.session`    | Adds `sessionId` and `busy` to context.                                                                      |
| `context.workspace`  | Adds `cwd` and `trusted` to context.                                                                         |
| `storage`            | `storage.get`, `storage.set`, `storage.delete`; JSON-only, 256 KiB per panel.                                |
| `external.open`      | `external.open`; HTTPS only and always asks the user first.                                                  |
| `agent.submitPrompt` | `agent.submitPrompt`; requires `context.session`, uses that bound session, and is rejected while it is busy. |
| `workspace.info`     | `workspace.info`; read-only workspace metadata: folder name, root path, trust state, and a best-effort git branch (read from `.git/HEAD`, never executed). |
| `notifications.send` | `notifications.send`; shows a system notification. The panel's manifest title always prefixes the shown title (anti-spoofing), and sends are capped at 5 per rate window on top of the shared call limit. |

The host, not guest input, supplies the plugin identity, session, workspace, visibility, theme, and
locale. Calls are size-limited, rate-limited, time-bounded, and revoked when the panel is destroyed,
disabled, updated, or uninstalled.

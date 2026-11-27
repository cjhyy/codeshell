# Native plugins (plugin API 1)

A native plugin is an installed Agent Plugin whose code CodeShell runs. Its
entry module registers hooks, tools, presets, prompt sections, dynamic context
and background logic through a `ctx` object, and it runs in a process of its
own next to the agent worker.

Status: experimental. Only the Desktop agent worker loads native plugins, and
only while the user-level feature flag `native_plugins` is on (restart after
changing it). Installing, reviewing and approving them works everywhere.

## What makes a plugin native

Any Agent Plugin becomes native by adding `.codeshell-plugin/plugin.json` with
`schemaVersion: 2` and a `main` entry. Everything the entry may register is
declared there first, so it can be reviewed before any code runs; the runtime
refuses a registration the manifest did not announce.

```json
{
  "schemaVersion": 2,
  "apiVersion": 1,
  "main": "./dist/index.js",
  "contributes": {
    "hooks": ["pre_tool_use"],
    "tools": ["lookup"],
    "presets": ["reviewer"],
    "promptSections": ["role"],
    "context": ["status"],
    "background": false
  },
  "coreCapabilities": [],
  "hostCapabilities": []
}
```

| Field                                                | Meaning                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion`                                         | The `ctx` contract the plugin was written for. A plugin that needs a newer API than this CodeShell provides is shown as incompatible and never starts.         |
| `main`                                               | ES module (`.js` or `.mjs`) inside the plugin directory.                                                                                                       |
| `contributes.hooks`                                  | Engine events the plugin handles (the names in `PluginHookEventName`).                                                                                         |
| `contributes.tools`                                  | Short tool names: lower-case letters, digits and single underscores, at most 32 characters. The model sees `plugin__<plugin>__<tool>` (at most 64 characters). |
| `contributes.presets` / `promptSections` / `context` | Names offered as `<plugin>:<name>`; context sections use the ledger key `plugin-<plugin>-<name>`.                                                              |
| `contributes.background`                             | The plugin runs `ctx.effect` logic while it is loaded.                                                                                                         |
| `coreCapabilities` / `hostCapabilities`              | Declared for review. Plugin API 1 grants none of them.                                                                                                         |

The plugin's own name (the part of the install key before `@`) must match
`^[a-z][a-z0-9-]{0,31}$`, because it is embedded in every public name.

## Writing the entry

```ts
import { definePlugin } from "@cjhyy/code-shell-core/plugin";

export default definePlugin({
  setup(ctx) {
    ctx.tools.register({
      name: "lookup",
      description: "Look a ticket up by id",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      readOnly: true,
      async execute({ input }) {
        return { content: `ticket ${String(input.id)}` };
      },
    });
    ctx.hooks.on(
      "pre_tool_use",
      (event) =>
        event.data.toolName === "Write"
          ? { decision: "ask", messages: ["Writes need a look"] }
          : undefined,
      { timeoutMs: 2_000 },
    );
  },
});
```

`@cjhyy/code-shell-core/plugin` has no imports of its own: bundle `definePlugin`
into the entry, or import only its types (`import type`). The entry runs from a
copy of the plugin directory, so it cannot rely on packages resolved from
anywhere else.

Registrations are accepted only during `setup`. After it returns, the worker
learns what was registered (names and schemas, never code) and checks it
against the manifest. The handlers stay in the plugin process.

`ctx` provides:

- `ctx.plugin`: name, install key, `root` (the read-only copy), `dataDir` (a
  writable directory that survives updates) and `apiVersion`.
- `ctx.log.debug/info/warn/error`: written to the plugin's log, like stdout and
  stderr.
- `ctx.hooks.on(event, handler, { timeoutMs, onError })`.
- `ctx.tools.register({ name, description, inputSchema, readOnly, concurrencySafe, timeoutMs, exposure, execute })`.
- `ctx.presets.add(...)` and `ctx.presets.extend(target, tools)`. A target is a
  list of presets, the host's or the plugin's own (any other name is skipped),
  or `{ allExcept: [...] }`: every preset but the named ones, including presets
  other plugins add, as for the tools of a plugin with neither presets nor
  extensions.
- `ctx.prompt.section(name, text)` and `ctx.context.provide(name, provider)`.
- `ctx.effect(effect)`: background logic; it gets an abort signal and may return
  a cleanup function. When the plugin is stopped, updated, revoked or the worker
  exits, the signal is aborted and the cleanup runs, within 1.5 s. An update
  cleans up the old copy's effects before the new copy starts its own.
- `ctx.core.has(name)` and `ctx.host.has(name)`: always false in plugin API 1.

What a hook can change depends on the event (see `PluginHookReply` in
`packages/core/src/plugin-sdk.ts`). A hook can make a permission decision
stricter (`deny`, `ask`), never grant one. Native hooks run at priority 80, in
install order; a rewrite (`updatedInput`, `updatedPrompt`) is passed to the next
handler in the chain, and the strictest decision wins. `onError: "deny"` makes
an unanswered `pre_tool_use` or `on_permission_check` call refuse the tool.

Limits per call: hooks 5 s by default and at most 60 s, tools 120 s by default
and at most 600 s, context providers 2 s, `setup` 10 s. One message is at most
1 MiB, at most 16 calls run at once, and the process heap is capped at 256 MB.

## Approval

One decision covers the whole plugin: its native entry, its command hooks and
its MCP servers, including kinds it adds later. It covers the version that was
downloaded: installing or updating records a digest of every file, and a new
download needs approval again unless it is byte-identical to one already
approved. A plugin installed or updated from a directory on your own machine
keeps its approval. After that the files are yours: local edits do not touch
the approval, and what runs is what is on disk. The review compares the
current surface with the one approved last time and lists what was added or
removed.

- Desktop: Extensions, plugin detail, "Approve this plugin".
- Terminal: `/plugin native review <plugin>`, then `/plugin approve <plugin>`;
  `/plugin revoke <plugin>` withdraws it.

Revoking or uninstalling withdraws the plugin from every running session at
once. Uninstalling also removes its runtime copy and log.

## At run time

The Desktop worker starts each approved native plugin before it compiles its
composition (`CODE_SHELL_NATIVE_PLUGINS=host` in the worker environment; the
headless and Hub workers always clear it). A plugin that fails `setup`,
registers something it did not declare, or collides with another plugin's
public names is reported as failed; the others still load. When two plugins
collide, the one installed first wins.

- Code: a read-only copy of the plugin's files, taken and verified when it
  starts, at `~/.code-shell/plugin-runtime/<module id>/<digest>/`. Local edits
  run once the plugin is restarted from its detail page, or when the worker
  starts again.
- Data: `CODESHELL_PLUGIN_DATA` (also `ctx.plugin.dataDir`).
- Log: `~/.code-shell/plugin-runtime/.logs/<module id>.log`, readable from the
  plugin detail page.
- Environment: the same allowlist as sandboxed shells, plus
  `CODESHELL_PLUGIN_ROOT` and `CODESHELL_PLUGIN_DATA`. No credentials are passed.
- Permissions: none are taken away. The process runs with the user's operating
  system permissions; plugin API 1 is not a sandbox.

A call that times out is followed by a liveness check, and a process that does
not answer it is killed. A plugin whose process fails three times within a
minute, or whose calls fail five times in a row, is stopped until the user
restarts it from the plugin detail page; a call that could not be sent (larger
than one message, or too many calls waiting) does not count against it. A
plugin without background logic gives its process back after ten minutes
without calls and gets a new one on the next call; one with background logic is
restarted automatically after a crash. Processes the plugin started itself are
stopped together with its process. Processes left behind by a worker that was
killed are stopped when the next worker starts.

Approving, revoking, updating and switching plugins off all end in a settings
reload. An update, or a local edit applied by restarting the plugin, takes over
in place when it declares the same things; one that changes what the plugin
declares, and a plugin approved after the worker started, load when the worker
starts again. Until then the version this worker loaded keeps serving, and the
plugin detail page says why. A plugin switched off for a project
(`disabledPlugins`, project capability overrides) receives no calls from that
project's sessions; sub-agents follow the session that spawned them.

Hosts read the runtime state through three `agent/query` types:
`native_plugins_status`, `native_plugins_restart` and `native_plugins_log`.
Desktop asks only a worker that is already running.

## Not in plugin API 1

- Calling core or host capabilities (`ctx.core`, `ctx.host`).
- Restricting a plugin's file, network or process access.
- Allow rules in presets; plugins can only ask or deny.
- Loading a new plugin, or new declarations, without restarting the worker.

## Code map

| Area                             | Files                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Manifest, approval, snapshots    | `packages/core/src/plugins/native/`                                                                                           |
| Version digest                   | `packages/core/src/plugins/pluginTreeDigest.ts`                                                                               |
| Author SDK                       | `packages/core/src/plugin-sdk.ts` (`@cjhyy/code-shell-core/plugin`)                                                           |
| Process, protocol, child entry   | `packages/core/src/plugin-runtime/process.ts`, `protocol.ts`, `child-main.ts`                                                 |
| Generated modules and policy     | `packages/core/src/plugin-runtime/module-adapter.ts`, `runtime.ts`                                                            |
| Worker wiring and status queries | `packages/core/src/plugin-runtime/worker-integration.ts`, `queries.ts`, `packages/core/src/cli/agent-server-stdio.ts`         |
| Desktop                          | `packages/desktop/src/main/native-plugins-ipc.ts`, `capability-modules-env.ts`, `renderer/extensions/NativePluginSection.tsx` |
| Terminal                         | `packages/tui/src/cli/commands/builtin/plugin-handler.ts`                                                                     |

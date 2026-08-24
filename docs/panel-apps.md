# Panel Apps v1

CodeShell has two independent extension systems:

| System       | Purpose                                                             | Manifest                                                           | Install root                    | Registry                                  |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------- | ----------------------------------------- |
| Agent Plugin | Adds Skills, Agents, Commands, Hooks, MCP, and automation templates | `.codex-plugin/plugin.json` plus optional CodeShell agent metadata | `~/.claude/plugins`             | Plugin catalog                            |
| Panel App    | Adds one sandboxed Desktop application                              | `.codeshell-panel/panel.json`                                      | `~/.code-shell/panel-apps/<id>` | `~/.code-shell/panel-apps/installed.json` |

A Panel App is not a contribution inside an Agent Plugin. Installing, enabling,
updating, or uninstalling one system never changes the other system. The Panel
App installer rejects packages containing `.codex-plugin`, `.claude-plugin`,
`.codeshell-plugin`, `.mcp.json`, `skills`, `agents`, `commands`, or `hooks`.
The normal Plugin installer rejects `.codeshell-panel/panel.json`.

## Package format

```text
my-panel-app/
├── .codeshell-panel/
│   └── panel.json
├── app/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── README.md
```

```json
{
  "schemaVersion": 1,
  "id": "design-studio",
  "version": "0.1.0",
  "title": {
    "default": "Design Studio",
    "en": "Design Studio",
    "zh-CN": "设计工作台"
  },
  "description": "A repository-native design workspace.",
  "entry": "app/index.html",
  "icon": "palette",
  "placement": "right-dock",
  "singleton": true,
  "permissions": ["context.workspace", "workspace.read", "workspace.write", "storage"]
}
```

The manifest is strict: unknown fields, unsafe IDs, traversal paths, unknown
icons, and unsupported permissions are rejected. One package represents one app
identity and one HTML entry point. App files live beside the entry under the
same nested asset tree (for example `app/`); a package-root HTML entry is
rejected so manifests, install metadata, README files, and licenses can never
be served to the guest. README and license files may remain at the package root.

Local folders, zip archives, and public GitHub repositories follow the same
review flow:

1. Core validates the complete package and computes a review token over every
   file.
2. Desktop shows identity, version, entry, instance mode, and requested Host
   permissions.
3. Installation revalidates the source and requires the same review token.
4. Core atomically replaces the app directory and updates the dedicated
   registry. A failed update restores the previous directory.

Packages are bounded to 2,000 entries, 64 MiB total, 16 MiB per file, and 16
directory levels. Symlinks and unsupported file types are rejected.

GitHub installs accept `https://github.com/<owner>/<repo>` plus optional
branch/tag and app-subdirectory fields. A standard
`/tree/<ref>/<subdirectory>` URL is accepted as a shortcut. Only public HTTPS
GitHub repositories are accepted; Git runs without interactive credential
prompts, and the cloned tree is temporary. The reviewed app snapshot is copied
into the dedicated Panel App install root.

## Runtime and sandbox

Each Panel App runs in its own Electron guest with Node.js disabled and no
normal Desktop preload. The host serves static assets through an opaque,
read-only authority, blocks navigation and popups, denies Electron permission
requests, and applies a fixed Content Security Policy with no network, frames,
forms, objects, inline scripts, or `eval`.

The guest sees one frozen bridge:

```js
const context = await window.codeshellPanel.getContext();
const file = await window.codeshellPanel.call("workspace.readText", {
  path: "designs/home.codesign.json",
});
await window.codeshellPanel.call("agent.submitPrompt", {
  prompt: "Full model-facing context and instructions",
  displayText: "Short user-facing input shown in the current session",
});
const unsubscribe = window.codeshellPanel.on("context.changed", (next) => {
  // session, workspace, visibility, theme, or locale changed
});
```

No Host capability is granted by default.

| Permission            | Capability                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.session`     | Adds session ID and busy state to context.                                                                                                                                                                                       |
| `context.workspace`   | Adds workspace root and trust state to context.                                                                                                                                                                                  |
| `storage`             | JSON-only app storage, capped at 256 KiB per app.                                                                                                                                                                                |
| `external.open`       | Opens HTTPS links after user confirmation.                                                                                                                                                                                       |
| `agent.submitPrompt`  | Immediately queues work in the bound, idle session and renders `displayText` (or `prompt`) as an app-attributed user message; requires `context.session`.                                                                        |
| `agent.task`          | Starts, lists, reads, and cancels bounded AI Tasks owned by this app and project. Each Task uses a fresh process-local Session with no current-chat history; results return to the Panel instead of the conversation.            |
| `workspace.info`      | Reads safe workspace metadata and the current Git branch.                                                                                                                                                                        |
| `workspace.read`      | Lists and reads allowlisted repository text/data files; requires `context.workspace`.                                                                                                                                            |
| `workspace.write`     | Atomically writes allowlisted repository text/data files and can export the Panel's print view to a project-local PDF, with optimistic concurrency; requires `context.workspace`.                                                |
| `notifications.send`  | Sends rate-limited, app-attributed system notifications.                                                                                                                                                                         |
| `audio.transcribe`    | Lets the Panel capture microphone audio and send a bounded recording to the user's configured speech-to-text provider; requires `context.workspace`, explicit package review, and OS microphone consent.                         |
| `credentials.cookies` | Lists only masked Cookie-account metadata matching a requested HTTPS site, opens a host-owned isolated login-and-save window, and restores a selected saved login after confirmation. Cookie values never enter the Panel guest. |
| `automations.manage`  | Lists, creates, updates, pauses, resumes, runs, and deletes recurring jobs only when they are bound to the Panel's current workspace and task; requires both context permissions.                                                |
| `process`             | Resolves PATH executables to opaque app-scoped handles, grants Downloads or a user-selected directory as an opaque working-directory handle, and starts/cancels bounded local processes without a shell.                         |

Workspace calls reject traversal, hidden paths, `node_modules`, symlinks,
binary files, invalid UTF-8, control characters, Windows device names, and path
segments ending in a dot or space. Existing-file writes require the revision or
modification timestamp returned by the preceding read; blind overwrites are
rejected.

Panel API v3 adds a constrained PDF export. `workspace.exportPdf` renders the
calling Panel App's current print view as A4 and writes only to a safe relative
`.pdf` path inside the bound project. It requires `workspace.write` and the
same `expectedModifiedAt` / `expectedRevision` concurrency contract as text
writes. A new timestamped export should pass `expectedModifiedAt: null`.

Panel API v4 adds host-owned Cookie login calls for apps that declare
`credentials.cookies`: `credentials.cookies.list`,
`credentials.cookies.loginAndSave`, and `credentials.cookies.restore`. Login
capture, credential storage, and browser injection stay in Desktop main; the
Panel receives only masked account labels, domains, ids, and operation counts.

Panel API v5 adds project-and-task-scoped automation calls for apps that declare
`automations.manage`: `automations.list`, `automations.create`,
`automations.update`, `automations.pause`, `automations.resume`,
`automations.runNow`, and `automations.delete`. Creation always binds the
current trusted workspace and current task; follow-up calls reject an
automation from another workspace or task.

Panel API v6 adds opt-in microphone transcription for apps that declare
`audio.transcribe`: `audio.status`, `audio.requestMicrophoneAccess`, and
`audio.transcribe`. The Host accepts audio-only capture from the reviewed main
frame, caps each upload at 25 MiB, accepts only common recording MIME types,
and sends bytes directly to the user's configured OpenAI-compatible
transcription provider. Recordings are not written to Panel storage or the
workspace by the Host.

Panel API v7 adds the atomic local-process surface for apps that declare only
`process`: `process.find`, `process.spawn`, and `process.cancel`, plus
`filesystem.getKnownDirectory`, `filesystem.pickDirectory`, and
`filesystem.openDirectory` for opaque process working-directory handles. The
Host accepts only simple executable names from PATH, never invokes a shell,
passes arguments as separate strings, strips the child environment to a small
system allowlist, limits concurrency/lifetime/output, and terminates the child
tree when its Panel closes. The first execution of an executable is confirmed
by the user and approval is scoped to the app id, installed revision, and
resolved executable path. Domain operations such as video downloading remain
Panel code rather than new Host methods.

Panel API v8 adds isolated AI Tasks for apps that declare `agent.task`:
`agent.task.start`, `agent.task.list`, `agent.task.get`, and
`agent.task.cancel`. A Task is separate from the user's current Session. It is
created fresh, kept only in the Desktop process, omitted from normal Session
pickers, and closed after completion. It does not receive repository or user
instructions, persistent memory, capability context, bound sources, workspace
profiles, hooks, MCP servers, or unrelated Skills. The app supplies a hard
per-run tool allowlist and may select only a Skill bundled in its own reviewed
manifest. Normal tool permission and approval policy still applies.

Panel API v9 adds `agent.task.models`, which returns only secret-free configured
text connections as `{ id, providerId, provider, model, label }` rows plus the
effective `defaultModel`. Passing one returned connection `id` as the optional
`model` field of `agent.task.start` selects it for that Task; omitting `model`
continues to follow the effective CodeShell default. Provider credentials,
endpoints, and model parameter values never cross the Panel guest boundary.
It also adds secret-free `process.info` (`platform`, `arch`, and Linux `libc`) and the
`user-bin` known directory. The latter is a Host-owned per-user executable
directory automatically included in Panel process lookup and child `PATH`, so
reviewed apps can install a verified standalone tool without guessing a system
directory or changing the user's shell profile.

Panel API v10 adds `credentials.cookies.authorizeProcess` for apps that declare
both `credentials.cookies` and `process`. After explicit user confirmation, the
Host materializes a selected saved login into an owner-only temporary Netscape
Cookie file and returns only an opaque, executable-bound file-argument handle.
Passing that handle in `process.spawn.fileArgumentHandles` inserts the fixed
`--cookies` option and private file path inside Desktop main; neither the Cookie values
nor the path cross into the Panel guest. Grants are scoped to one guest and one
resolved executable, and their temporary files are removed when the Panel
closes.

```js
const task = await window.codeshellPanel.call("agent.task.start", {
  key: "repair",
  label: "Repair local dependency",
  model: "my-fast-model",
  prompt: "Use the bundled setup Skill and verify the result.",
  skill: "my-panel-app:setup",
  toolNames: ["Skill", "Bash"],
  maxTurns: 8,
  maxContextTokens: 16384,
});

const unsubscribe = window.codeshellPanel.on("agent.task.changed", (next) => {
  if (next.id !== task.id) return;
  renderActivity(next.activity ?? []);
  if (next.status === "completed") {
    renderResult(next.result.text);
  }
});
```

`key` optionally deduplicates one active operation per app and project. Task
statuses are `queued`, `running`, `cancelling`, `completed`, `failed`, and
`cancelled`. The optional bounded `activity` list exposes coarse `model`,
`plan`, `tool`, and `error` milestones with a status, message, and timestamp;
it never exposes hidden model reasoning or tool arguments/results. Completed
results and recent state are memory-only and disappear when CodeShell restarts.
Use `agent.submitPrompt` only when work intentionally belongs in the visible
current conversation; use `agent.task` for short, app-owned AI work whose result
belongs in the Panel.

## Enablement

Panel App policy is Desktop application state, not agent capability state.
Installed apps form a global catalog, but an app is **off everywhere until a
project binds it** — there is no global baseline to inherit:

- `panelAppBindings` is the project-owned list of bound app IDs and the
  canonical source of truth. Only an app in this list contributes panel UI,
  Agent tools, bundled Skills, or project-scoped storage.
- `panelAppOverrides` is legacy. It is still read so projects that opted in
  before `panelAppBindings` existed keep their app (`on` counts as a binding,
  `off` removes one), but every new write clears the entry.
- `disabledPanelApps` is a user-level denylist that still vetoes a bound app at
  runtime. It has **no UI**: it survives only for settings written before the
  global switch was removed, and as a hand-editable escape hatch in
  `~/.code-shell/settings.json`. To turn an app off normally, unbind the
  projects that use it, or uninstall it.
- `disabledPlugins` and `capabilityOverrides` do not affect Panel Apps.

Two screens edit the same `panelAppBindings` key from opposite directions:

- **Extensions → Panel Apps** is the app view. Each installed app's card shows
  how many of your tracked projects enable it (`3 / 5`) and expands into a
  per-project switch list, so bindings for any project can be changed without
  switching the active project. This screen also owns import, permission
  review, overwrite update, and uninstall.
- **Settings → (a project) → 能力总览** is the project view. Its Panel Apps
  group lists every installed app with a two-state switch for that one project.
  The group is project-scope only, and deliberately does not use the
  继承 / 启用 / 停用 control the other capability groups use — Panel Apps have
  no global baseline for an "inherit" position to mean anything.

Extensions → Plugins owns Agent Plugin packages and never lists Panel Apps.

## Add and iterate on an app

The quickest starting point is
[`examples/panel-apps/starter`](../examples/panel-apps/starter/README.md):

1. Copy the starter directory into the repository where you want to maintain
   the app.
2. Give `.codeshell-panel/panel.json` a unique `id`, title, version, and the
   smallest required permission set.
3. Keep all executable UI files under `app/`; the manifest entry normally
   remains `app/index.html`.
4. In CodeShell, open **Extensions → Panel Apps → Choose source folder**,
   select the app root, review it, and install it.
5. Open the app from the right dock's `+` menu.

Folder installs are immutable snapshots. CodeShell remembers the original
folder, so the development loop is still short: edit files in the repository,
then choose **Update from source** on the installed app card. Every update
re-runs package validation, produces a fresh content-bound review token, and
requires an explicit review before replacing the installed snapshot. If the
source folder moves, import it again from its new location.

To install from GitHub instead, choose **From GitHub** and enter:

- repository: `https://github.com/owner/repository`
- branch or tag: optional (for example `main` or `v1.2.0`)
- app subdirectory: optional (for example
  `examples/panel-apps/design-studio`)

After new commits are pushed, **Update from source** clones the same ref again
and presents a new review before replacing the installed snapshot.

## Reference apps

- [Starter](../examples/panel-apps/starter/README.md) is the minimal template
  for a new repository-maintained Panel App.
- [Design Studio](../examples/panel-apps/design-studio/README.md) is a
  repository-native visual editor with deterministic JSON/SVG documents,
  frames, hierarchy, layout tools, audits, recovery, and conflict-safe saves.
- [Quant Lab](../examples/panel-apps/quant-lab/README.md) is a separate stock
  research application for local OHLCV data, deterministic backtests, risk
  summaries, strategy files, and repository reports.

The [Video Editor Agent Plugin](../examples/plugins/video-editor/README.md)
remains an Agent Plugin example. Its Skills, Commands, scripts, and automation
content illustrate the other system and are not valid Panel App package
content.

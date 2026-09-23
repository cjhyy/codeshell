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

## Feature ownership

Panel functionality belongs to the independently versioned Panel package. A
model, installer, provider, template, workflow, or editor rule must not become a
new Desktop/Core branch merely to serve one Panel. Native Panel tools run in
separate processes through reviewed generic interfaces.

Host changes need evidence of a missing reusable capability; first check the
existing process, app-data, workspace, media, Agent Task, and credential surfaces.
Reusable client-side scheduling, event parsing, and installation helpers belong
in a Panel SDK/library. Only Host-enforced authority or lifecycle changes belong
in CodeShell. Domain-neutral APIs may still impose explicit resource budgets,
but a particular voice model's input length or an editor's fixed frame rate is
Panel policy.

Reusing an existing media service does not establish its ownership. Asset
catalogs, generation stages/progress, cleanup, and retry/recovery policy belong
to the Panel or shared SDK. The Host retains generic resource custody, event
transport, process termination/exit confirmation, and any explicitly supported
durable-task mechanism; it must not infer business retry safety or run bundled
Panel processors in its own process.

Current gaps, legacy coupling, and the proposed sequence are recorded in the
[Panel/Host capability audit](todo/panel-plugin-host-capability-audit-2026-09-12.md).

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

Project documents can use optimistic concurrency when `availableMethods` includes
both `storage.getSnapshot` and `storage.compareAndSet`:

```js
const before = await window.codeshellPanel.call("storage.getSnapshot", { key: "draft" });
const result = await window.codeshellPanel.call("storage.compareAndSet", {
  key: "draft", expectedRevision: before.revision, value: editedDocument,
});
if (!result.updated) {
  // Keep the local draft; show the conflict and explicitly reload/merge.
  // Do not adopt result.snapshot.revision and blindly retry the old draft.
}
```

A snapshot is `{ exists, value, revision }`. An absent key has `exists: false`,
`value: null`, and `revision: null`; a stored JSON null has a non-null revision.
The revision hashes the key and JSON content, not an edit counter: identical
content has the same revision, including an intervening change back to that content.
`compareAndSet` requires the observed revision (null for absence) and either
`value` or `remove: true`. It returns `{ updated, snapshot }`; conflicts do not
write. An unrelated key does not invalidate the document. Desktop and remote Web
share the existing per-app/per-project JSON file and per-file lock, including
cross-process writers. No format migration or new permission is required.

Older `storage.get/set/delete` remain compatible; old clients may still perform
unconditional writes. New clients detect their changed content on their next
conditional save. These methods do not synchronize the local draft automatically.
On a lost response, query the stored snapshot first; do not replay an uncertain
write. A new Host capability does not by itself migrate every Panel's storage.

No Host capability is granted by default.

| Permission                | Capability                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.session`         | Adds session ID and busy state to context.                                                                                                                                                                                                                           |
| `context.workspace`       | Adds workspace root and trust state to context.                                                                                                                                                                                                                      |
| `storage`                 | JSON-only app storage, capped at 256 KiB per app.                                                                                                                                                                                                                    |
| `external.open`           | Opens HTTPS links after user confirmation.                                                                                                                                                                                                                           |
| `agent.submitPrompt`      | Immediately queues work in the bound, idle session and renders `displayText` (or `prompt`) as an app-attributed user message; requires `context.session`.                                                                                                            |
| `agent.task`              | Starts, lists, reads, and cancels bounded AI Tasks owned by this app and project. Each Task uses a fresh process-local Session with no current-chat history; results return to the Panel instead of the conversation.                                                |
| `workspace.info`          | Reads safe workspace metadata and the current Git branch.                                                                                                                                                                                                            |
| `workspace.read`          | Lists and reads allowlisted repository text/data files; requires `context.workspace`.                                                                                                                                                                                |
| `workspace.write`         | Atomically writes allowlisted repository text/data files and can export the Panel's print view to a project-local PDF, with optimistic concurrency; requires `context.workspace`.                                                                                    |
| `resources`               | Scoped immutable binary resources, bounded upload/read and verified materialize/capture. Requires `context.workspace` and a trusted project; direct tool hand-off also requires `process`.                                                                           |
| `credentials.connections` | Public configured connection metadata and readiness; selected secrets are sealed to an approved process or task, never returned to the Guest. Requires `context.workspace`; hand-off also requires `process`.                                                        |
| `media`                   | Compatibility import/export, recording transport, managed resource preview, versioned JSON documents and historical job receipts. Processing runs in the Panel package. Requires `context.workspace` and a trusted project. See [Managed media API](panel-media.md). |
| `notifications.send`      | Sends rate-limited, app-attributed system notifications.                                                                                                                                                                                                             |
| `audio.transcribe`        | Lets the Panel capture microphone audio and send a bounded recording to the user's configured speech-to-text provider; requires `context.workspace`, explicit package review, and OS microphone consent.                                                             |
| `credentials.cookies`     | Lists only masked Cookie-account metadata matching a requested HTTPS site, opens a host-owned isolated login-and-save window, and restores a selected saved login after confirmation. Cookie values never enter the Panel guest.                                     |
| `automations.manage`      | Lists, creates, updates, pauses, resumes, runs, and deletes recurring jobs only when they are bound to the Panel's current workspace and task; requires both context permissions.                                                                                    |
| `process`                 | Resolves PATH executables to opaque app-scoped handles, grants persistent app-local data, Downloads, or a user-selected directory as an opaque working-directory handle, and starts/cancels bounded local processes without a shell.                                 |

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

An implementing Host can additionally advertise `automations.createUnique`
in `availableMethods`, under the same permission. It accepts the create fields
plus `key` (1–80 ASCII letters, digits, `.`, `_`, `:`, or `-`). The Host derives
the persisted identity from the app, bound workspace, bound task and key; Panels
cannot submit `creationKey` or workspace/task authority fields. Discover the
method explicitly, not from an API version. Paired Desktop Web exposes the same
automation methods when composed with main's live scheduler and a selected
durable task. Hub-authenticated HeadlessServer now composes a project-owned
scheduler with the same automation interface; generic HTTP runtime embedders
still need to inject an implementing Host.

Implementing Hosts also advertise `automations.updateIfRevision` and
`automations.deleteIfRevision`. Read the job's opaque `revision` from list/create
responses, then send the ordinary mutation fields plus `expectedRevision`.
The token identifies definition, binding, permission and enabled state; running
counters, next-run timestamps and execution receipts do not invalidate it.
The Host checks it inside the same CronStore transaction that writes the change.
An update returns `{ok:true, automation}` and deletion returns `{ok:true}`.
A changed or disappeared record returns `{ok:false, conflict:true}` without
applying the caller's mutation. Re-read and review before another decision;
never fall back to the unconditional method after a conflict or lost response.
This job revision is separate from the Panel package revision and is not an
authorization credential. Scope and package checks still
apply before the conditional mutation.

Desktop main, paired Web and Hub share this contract. Native guest operations
recheck the current guest, project selection, workspace trust and Session after
asynchronous authority lookup. Generic HTTP hosts must opt in with
`PanelAutomationHost.conditionalMutations`; otherwise the methods are neither
advertised nor dispatched. Older unconditional methods remain compatible and
do not promise concurrent-edit protection. Clients must discover the exact
method instead of assuming support from API version or a revision field alone.

Server `/panels` exports `createHubPanelAutomationHost` as a project scheduling
building block. The caller must supply a persistent package/binding authorizer
and an executor that honors the resolved approval/sandbox policy, reserves the
bound Session against interactive work, and waits for real teardown on abort.
It is not enabled just by constructing the HTTP runtime. Records live under
`<dataDir>/panel-automations/records/cron.json`; a separate lifetime lease limits
ownership to one live service using that private data directory. Startup rejects
corrupt snapshots or another project's records. Each new job retains its Host
selected Panel revision; a different revision cannot update, resume or manually
run it, while list/pause/delete remain available to the authorized source Panel.
Preparation and execution occupy the shared in-process Panel upgrade gate.
Call and await `close()` before disposing the executor. A disconnected page does
not own accepted jobs. Restart restores definitions without catch-up execution.

The Hub composition verifies the enabled, bound Panel's exact package revision
and permissions before dispatch, and borrows the project's live Core Worker.
It reserves the durable Session against concurrent interactive turns, uses the
configured default text model, routes unattended approvals through the job's
resolved policy, denies page-owned internal callbacks and disables background
shells for that turn. Logging out does not cancel an accepted automation.
Stopping the Host requests cancellation and waits for actual execution cleanup.

Before sending a run, the Host persists `lastExecution` with a unique id and
`running` status. List responses expose its timestamps, terminal status and
optional diagnostic detail. Cancellation remains distinct from successful
completion. Lost Worker outcomes become `interrupted` and disable the schedule;
startup does the same for a leftover running receipt. Inspect results before
explicitly resuming or retrying. Admission timeout terminates and awaits the
Worker before releasing ownership; an uncooperative child can delay shutdown.
These checkpoints prevent blind replay, not duplicate external side effects.
They retain the latest execution, while the bound Session holds its transcript.
All processes writing the same records must preserve the new receipt fields.
Browser notifications currently require an active connection; phone push
notifications and Panel-specific complete workflows are separate acceptance work.

The trusted Worker protocol now accepts per-turn `sandboxMode` and
`allowBackgroundShells`. These survive Session queueing and captured follow-up
options, without mutating the Engine defaults used by a later ordinary turn.
The sandbox mode override retains the resolved network/read/write restrictions;
`allowBackgroundShells: false` also narrows child execution and cannot be relaxed
by a caller when the Engine itself forbids background shells. Web serve rejects
these fields in browser `agent/run` requests: only Host code selects the policy.
`auto` retains Core's platform-dependent fallback behavior; passing that mode
alone is not proof that an OS sandbox was available.

The scheduler checks and creates under the same persistent store lock. An equal
definition returns the retained job without resetting its paused state, counters
or provenance. A different definition rejects; read and explicitly update the
existing job instead. Deletion releases the identity. This is retained-job
uniqueness, not an indefinite request receipt or an exactly-once execution
guarantee; different task bindings have separate identities. Existing unkeyed
jobs are not automatically consolidated. A failed response must not trigger
fallback to ordinary create. All processes writing the cron file must use a
compatible Core version: older writers normalize away the new identity field.

Paired Web verifies the selected task's persisted project/root authority against
the authenticated workspace; a task ID supplied to `prepare` is not authority.
It checks the paired owner and Panel binding again after asynchronous authority
reads. Update/pause/resume/delete check the latest job ownership inside the cron
store transaction. Manual run validates a freshly loaded job and dispatches to
the existing Desktop executor. Closing a page, logging out or stopping the Web
transport revokes control but does not delete accepted recurring jobs. Explicit
automation deletion stops future scheduling; an already running execution uses
the existing Desktop task lifecycle. No second scheduler is owned by Web.

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
tree when its Panel closes. On Desktop, installing the Panel with `process`
permission and binding it to a trusted project authorizes its local processes;
execution does not add a separate dialog for Node or other executables. The
Host still checks the live app binding, directory and executable handles,
reviewed entry hashes, arguments, and revocation at each spawn. Web retains
its per-guest execution confirmation. Domain
operations such as video downloading remain Panel code rather than new Host methods.

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

Panel API v14 adds [reviewed native entries, generic resources, process receipts/stdin,
Desktop background tasks, connection handoff and capability discovery](panel-native-tools.md).
The Host owns execution authority and file custody; the Panel owns its models and
workflows. Declare `process` and `resources` for Desktop `tasks.*`; the manifest's
`nativeEntries` identifies reviewed tool files by content hash. Discover methods
through `context.get.availableMethods` and transport limits through
`capabilities.bridge`. Ordinary guest processes stop on guest closure; opted-in
Desktop tasks retain scoped progress and results independently of the window.

Video Studio's former Host processors, model installers and templates now live
in its Panel package. Existing media IDs, documents and history remain compatible;
[legacy media](panel-media.md) describes the narrow retained methods. Web exposes
the supported resource/process interfaces but does not claim Desktop background
tasks or the complete native Video Studio UI workflow.

Panel API v11 adds the `app-data` known directory to
`filesystem.getKnownDirectory` for apps that declare `process`. The Host creates
one persistent owner-only directory below CodeShell's user-data root, keyed by
the reviewed Panel App id, and returns an opaque process working-directory
handle. Data survives app updates, never lands in the bound project or Git by
default, and cannot be shared across Panel App ids. The Panel still needs an
approved local executable to read, write, index, or migrate files in this
directory; arbitrary host filesystem access is not exposed to guest code.

Hosts also support `filesystem.getKnownDirectory({ name: "project" })` for apps
with `process`. It returns a process directory handle for the Panel's bound,
trusted project root, resolved by the Host; the caller cannot provide or override
the path. An unbound, untrusted, or unavailable project is rejected. Panels can
use this for a project-local output destination without needing raw workspace
context. Older Hosts reject this additive known-directory name; callers should
handle that response and offer a directory picker instead of silently choosing
a different output location.

Desktop `filesystem.pickDirectory` also returns a random `bookmark` after the
user chooses a folder. A Panel can persist that token and call
`filesystem.restoreDirectory({ bookmark })` when it reopens. The Host binds the
bookmark to the installed Panel id and trusted project, checks that the exact
directory still exists with the same filesystem identity, and returns a fresh
short-lived process handle. Guest-stored paths alone never restore access.
Older Hosts reject the restore call; Panels should offer the picker then.

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

### Version update notices

Opening **Extensions → Panel Apps** checks installed apps in the background.
Cards show **Update available** and the installed → source version when the
source has a newer semantic version. **Check for updates** refreshes the results
manually. Checks also refresh when this page regains focus and every five minutes
while open; successful results are cached for five minutes and failures for
thirty seconds. Installation, removal, or a source change invalidates old results.

GitHub checks read only `.codeshell-panel/panel.json` at the recorded branch/tag
and subdirectory; an omitted ref follows the repository's default branch. A
pinned tag or commit therefore follows that pinned source, not the latest release.
Local folder checks read that folder's manifest. ZIP installs retain manual
source review. The card identifies its source, and failed checks or older source
versions are shown separately from an up-to-date result. Authors must increase
the manifest version to advertise a new version; same-version development edits
can still be installed with **Update from source**.

Discovery does not install or execute app code, change project bindings, or
grant permissions. Choosing an update downloads and reviews the complete package
through the existing content-bound installer, and the review shows both versions.

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

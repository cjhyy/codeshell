# Native Panel tools (API 14)

A Panel ships standalone Node programs in its installation package. The Host
validates permissions, files, executable approvals and lifetimes. It never
imports a Panel's JavaScript into the Host process. Model installers, providers,
media formats, project schemas, templates and workflow decisions remain in the
Panel package.

## Reviewed entries

The optional manifest field `nativeEntries` maps up to 16 names to
`{entry: "app/tools/<name>.mjs", sha256: "<64 lowercase hex>"}`. Declaring entries
requires `process`. Installation checks each declared file's digest; the same
review token covers the manifest and all package bytes. The process service
checks the installed revision, file identity and hash again at launch.

`process.resolveEntry({name, executableHandle})` returns an opaque entry handle.
Pass it to `process.spawn` with the approved executable and working-directory
handles. The Host inserts the reviewed script path. A Guest does not need to
copy script source into its data directory or discover the installation path.

## Resources

`resources` requires `context.workspace` and a trusted project. It provides
`resources.list`, `get`, `read`, `upload.begin/write/get/finish/cancel`,
`materialize` and `capture`. Binary resources include documents, fonts, CSV,
images and audio/video; format interpretation belongs to the Panel.

- `list({offset?,limit?})` returns `{assets,total}`; `get({id})` returns `{asset}`.
- `read({assetId,offset,length})` returns bounded Base64 bytes and `eof`.
- `materialize({assetId,directoryHandle,path})` copies an authorized immutable
  resource into a relative tool-input path.
- `capture({directoryHandle,path,name?,mimeType?,expectedBytes?,expectedSha256?})`
  validates a complete tool output and atomically returns `{asset}`.

Materialization and capture also require `process`. Directory grants retain
filesystem identity; each path component, source identity, digest and scope is
checked. Existing `asset-<sha256>` IDs, resource scopes and storage paths remain
compatible. Desktop stores resources and tasks under the stable bound project;
a worktree's current directory is checked for trust and used for relative source
selection, without creating a separate resource store. A different bound project
or Panel app cannot read those resources. The preview endpoint limits active-content rendering independently
of the Panel's MIME declaration. Process approval is not an OS sandbox.

## Lifetimes and results

Ordinary `process.spawn` still belongs to a Guest. Closing it terminates its
processes. `process.get({processId,afterSequence?,limit?})` returns running,
stopping or exited state, ordered retained events and the terminal receipt.
Cancellation requests termination; only the exit receipt confirms completion.
Receipts have advertised retention and capacity limits. `stdin: "pipe"` enables
bounded `process.write` and `process.end`; stdin is ignored by default.

Desktop also provides opt-in `tasks.start/list/get/cancel/retry`, independent of
Guest lifetime. Start with `{entry,input,recovery,requestKey?}`. The entry is an
installed name, not a path or source string. Input is a generic tool envelope:

```json
{
  "request": { "action": "the-panel-operation" },
  "resources": [{ "assetId": "asset-<digest>", "path": "inputs/source.bin" }],
  "directoryArguments": [
    { "argumentName": "--job-dir", "directory": "job" },
    { "argumentName": "--runtime-dir", "directory": "app-data", "path": "runtime" }
  ]
}
```

The Host freezes input resources before admitting the task, starts the reviewed
entry as a child process, and writes request JSON to stdin with Host-bound
`jobId` and `scopeKey`. Directory arguments are sealed launch arguments. Tools
write NDJSON `progress`, `result` or `error` messages. Progress content and
fractions come from the tool. A result's optional `artifacts` inventory names
relative files and their sizes/digests; the Host captures them before publishing
the successful receipt, adding each captured `asset` to its inventory entry.

Jobs bind app, workspace, installation revision and entry hash. Guest closure
allows them to continue; uninstall/update/revocation stops execution. Host
shutdown waits for native exit and records interruption. `recovery: "retry"`
permits explicit retries after interruption; it never blindly resumes or repeats
an external operation. Old-revision history is readable but cannot execute as
the new version. Retry compatibility decisions belong to the Panel.

`tasks.list({offset?,limit?})` returns recent summaries (maximum 50 per page),
while `tasks.get({id})` returns input and result. `tasks.changed` delivers a
summary with a monotonically increasing sequence; readers reconcile with get.
Bounded retention evicts old terminal task directories, so permanent outputs
must be captured into resource custody.

## Existing connections

With `credentials.connections`, `credentials.connections.list` returns public
configured connection metadata, model parameters and credential readiness.
No API key is returned. `authorizeProcess` seals only explicitly selected
connections to an approved executable. Tools can request the equivalent task
handoff through `connectionIds` and `connectionArgument` in the input envelope.
Keys are neither stored in task JSON nor sent to the Guest. A Panel interprets
its provider-specific model parameters and constructs its own requests.

## Discovery and transport

Desktop and Web contexts advertise `availableMethods`, `capabilities` and
`limitations`. Method availability reflects the host and current permissions;
model readiness is reported by the Panel tool. Clients should inspect these
fields instead of assuming all methods from an API version.

`capabilities.bridge` contains call/payload/result/rate budgets;
`capabilities.process`, `resources`, and `tasks` advertise their respective stdin,
event/receipt, transfer, and background-task limits. Clients use the returned
values rather than hardcoding Desktop or Web defaults. Optional
`callResult` returns `{ok:true,value}` or `{ok:false,error:{code,message,retryAfterMs?}}`
without losing structured errors across Electron isolation. `retryAfterMs` is an optional retry hint, not a successful result. Existing `call`
continues to throw for compatibility. Admission queues and task/event decoding
belong in the shared Panel SDK.

Web supports native entry grants, process receipts/stdin, resources and selected
connection handoff. Desktop background tool tasks and the legacy media picker,
preview and document bridge are not advertised on Web. The full Video Studio
workflow currently requires Desktop; unsupported features must be explained
before starting work.

## Validation and release status

The API 14 implementation is complete in the published 0.9.11 release. Local
resource, process/task, isolation, and Desktop bridge checks pass. Package-release
smoke checks cover 10 tarballs, 47 typed entry points and 45 runtime entry points.
The Video Studio 0.5.0 package has also run a real reviewed-entry chain through
import, inspection, preprocessing, three-second audio extraction and verified
capture, including persisted results and cross-project denial. Those runtime
checks missed its complete manifest's installation constraints; use Panel 0.5.1,
which also passes the published 0.9.11 installer's discovery and package preflight.
The correction, compatible releases and remote CI are recorded in the
[release acceptance matrix](todo/panel-plugin-runtime-implementation.md).


### Desktop / paired Web task ownership

Desktop composes `createSharedPanelToolHost` into its paired Web facade. The
Electron bridge is the sole owner of `panel-tool-jobs`; Web handlers never open
that store themselves and cannot shut down the coordinator. The Host binds the
reviewed installed package and canonical project to a frozen native revision;
HTTP callers cannot choose that scope or substitute their Web catalog revision.
Both interfaces use the same IDs, request-key deduplication and resources.

`capabilities.tasks` reports `ownership`, `executionRevision`,
`sharedAcrossDevices`, `continuesAfterDisconnect` and `continuesAfterLogout`.
For Desktop and its paired Web interface ownership is `project`: after admission,
closing the page, logout, device revocation, remote-server stop or HTTP-handler
eviction detaches the viewer without cancelling the project task. Logout aborts
pending input preparation; a request whose reply was lost may already have been
admitted, so reconnect and inspect task snapshots first. Any explicit resubmission
must retain the same request key and input to deduplicate. Explicit task
cancellation, project/app authorization revocation and Desktop shutdown keep their
respective cancellation/interruption semantics. Standalone Hub currently reports
session ownership and does cancel tasks on login-owner revocation; do not assume
identical logout behavior without probing capabilities.

Shared events contain summaries only, check both native and viewer authorization,
and detach with the Panel grant. Reconnect via `tasks.list/get`, then follow
`tasks.changed` and its task `sequence`. A transport cache eviction must not own
the process lifetime. Binding changes invalidate only the affected project's Web
handlers; package replacement/removal still invalidates all affected projects.

Existing per-workspace `panel-web-tool-jobs` stores are not deleted or moved. On
first access their unfinished records become interrupted and their records appear
with `readOnly: true` and `historySource: "desktop-web-legacy"`. They cannot be
retried/cancelled through the new coordinator; start a reviewed new request.
No browser-side queue migration or project-specific package pinning is implied.

Run `bun run --cwd packages/desktop test:e2e:shared-panel-tasks` after building
Server and Desktop. It launches real Electron with a temporary canonical profile,
a synthetic reviewed Node entry and an isolated paired device, checks native
progress, bidirectional task identity/cancellation, duplicate submission, logout,
remote shutdown and result recovery, then closes its processes and deletes the
fixture. It does not replace physical-phone or Panel business-flow acceptance.

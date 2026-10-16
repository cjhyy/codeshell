# Local model observability

Activity → Execution traces inspects actual model calls. An execution uses the
Engine `runId`; a session may contain many executions. Each native call contains its
physical transport attempts, inputs, outputs, errors, token usage, timings and
available bundled price estimates. Tool, approval and execution events share
that execution identity. The obsolete run page is removed. Historical transcripts
remain in conversation management; old run links resolve to their conversation
or execution, and historical objectives are never presented as complete prompts.

Browsing starts with sessions: conversation → executions → model calls and their
recorded Prompt/response, retries and tool events. The native view resolves saved
conversation titles, with IDs as secondary metadata. A Panel call with an actual
session joins that session; calls without a session stay in separate execution
groups and are never assigned to a synthetic conversation. Session counts and
pagination are computed from all matching metadata before paging, so a session
with hundreds of calls is one list item. Filters apply to those counts; selecting
a native session opens its execution history, including sibling executions of a
deep-linked call.

Calls also have a readable type: execution or subtask Prompt, Panel call, summary /
compaction, context preparation, title, goal check, memory, follow-up suggestion,
speech synthesis, transcription, audio processing, external CLI entry or other.
The Host derives `callType` from recorded purpose/source/parent attribution when
reading metadata, including older records; it never classifies Prompt text or
trusts a saved/client-supplied category. Unknown purposes retain their raw value
and show as other. Type filtering applies before pagination and session counts,
and also filters calls inside the selected session.

The default input view is the assembled runtime snapshot. Provider-wire attempts
show the actual request for that attempt, subject to redaction and recording
bounds. System instructions, user-role messages, model history, developer
instructions and tool results have separate labels; a user role may also contain
an internally generated helper input. Tool events show tool arguments/results.
Media calls show text, parameters and resource metadata instead of being labelled
as chat Prompts. External CLI input retains its narrower entry-only boundary.

## Recording

Hosts explicitly initialize `configureModelTracing` from the Core internal entry.
The public Core SDK does not enable diagnostic persistence implicitly. Desktop,
worker CLI, TUI and the standalone Server initialize their own store under
`sessionsRoot()/.model-traces` (or their configured session root).

Default configuration:

```json
{
  "enabled": true,
  "captureContent": true,
  "includeEphemeral": true,
  "retentionDays": 7
}
```

Desktop exposes recording controls in Execution traces. Prompt, response and
temporary-call recording are enabled by default, including isolated Panel tasks.
The v2 defaults migrate pre-v2 Prompt/temporary recording settings once; later
explicit opt-outs remain in effect. The overall recording switch and retention
are preserved. Missing historical content cannot be recovered by turning recording
on. Re-enabling recording does not resume body capture for
a call already in progress. Previously saved content remains subject to retention;
turning recording off stops further body capture. Settings apply without restarting
workers. Recorded content is local and bounded; credentials, sensitive tool results
and media payloads are redacted or omitted.

The collector wraps `LLMClientBase` and configured fetch, so it also covers title,
summary, goal and other auxiliary calls independently of billing. Native image
generation records its logical input and observable provider JSON; multipart
requests retain logical-input coverage. Logging failures do not authorize,
retry or fail model calls.

External CLI calls record submitted input, available developer instructions and
visible CLI events with `external-cli-input` coverage. The CLI's private provider
requests, system prompt and internal retries are unavailable. DriveAgent exposes
its submitted prompt and visible final result. Remote CLI rooms group overlapping
accepted submissions into an explicitly limited batch when the CLI supplies no
per-request event identity; observed external transcripts do not fabricate inputs.
Room approval requests can appear as events without a full decision lifecycle.
Panel Agent submissions and independent AI tasks use the native Engine collector,
with a Host-authored `panel:<appId>` source. Independent Panel inference uses a
write-only channel tied to its reviewed package, process/task and workspace.
This covers online speech JSON requests, multipart transcription fields, local
Audio8/Qwen/Kokoro/Edge/macOS speech, Whisper transcription, voice separation and
actual setup samples. Cache hits do not fabricate model calls. Binary inputs and
outputs are represented by metadata, and local/multipart inference is explicitly
`logical-input` coverage. Provider-internal steps are not invented.

Reviewed native Panel entries receive FD 3 and `CODESHELL_MODEL_TRACE_FD=3`.
The shared Panel helper reports bounded start/finish observations separately from
stdout/stderr. Large frames use atomic fragments and bounded reassembly so sibling
CLI processes cannot corrupt each other's prompts. Agent foreground/background
shells expose the same channel for packaged native CLIs. Independent terminals
without a Host channel keep their existing behavior and do not write private Host
files. Older installed Panel packages must be updated to include the helper.

Future browser/native Panels can use advertised `modelTraces.start/finish` methods
or the reviewed native channel. These are write-only: the Host fixes identity,
workspace, record IDs, timestamps, recording policy and storage location. A Panel
cannot read model history or alter another call. Revocation, cancellation and
process exit close pending observations; recording failures never retry inference.

## Reading

Desktop uses `window.codeshell.modelTraces`. Authenticated Web and mobile clients
use read-only `GET /api/v1/model-traces`, `/sessions`, `/:id` and `/config`. Hosts enforce the
selected workspace; unknown workspace attribution and other workspaces are
excluded. An independently authorized project root can additionally expose its
project-owned Panel calls from a worktree, without including ordinary root chats.
Clients cannot select storage paths/scopes or change remote recording policy.

Background work lists delegated tasks, subagents, background processes and
operations requiring verification. Ordinary sessions and schedule definitions
are managed through their dedicated pages.

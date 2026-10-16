# Local model observability

Activity → Execution traces inspects actual model calls. An execution uses the
Engine `runId`; a session may contain many executions. Each native call contains its
physical transport attempts, inputs, outputs, errors, token usage, timings and
available bundled price estimates. Tool, approval and execution events share
that execution identity. Legacy run objectives and transcripts are retained in
their own views and are not reconstructed into model prompts.

## Recording

Hosts explicitly initialize `configureModelTracing` from the Core internal entry.
The public Core SDK does not enable diagnostic persistence implicitly. Desktop,
worker CLI, TUI and the standalone Server initialize their own store under
`sessionsRoot()/.model-traces` (or their configured session root).

Default configuration:

```json
{
  "enabled": true,
  "captureContent": false,
  "includeEphemeral": false,
  "retentionDays": 7
}
```

Desktop exposes recording controls in Execution traces. Prompt and output content
require the separate content switch. Temporary sessions require an additional
explicit persistence switch. Missing historical content cannot be recovered by
turning either switch on. Re-enabling recording does not resume body capture for
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
Independent Panel processes making their own model calls are outside this collector; submitted
native Agent work goes through the usual Engine instrumentation.

## Reading

Desktop uses `window.codeshell.modelTraces`. Authenticated Web and mobile clients
use read-only `GET /api/v1/model-traces`, `/:id` and `/config`. Hosts enforce the
selected workspace; unknown workspace attribution and other workspaces are
excluded. Clients cannot select storage paths or change remote recording policy.

Background work lists delegated tasks, subagents, background processes and
operations requiring verification. Ordinary sessions and schedule definitions
are managed through their dedicated pages.

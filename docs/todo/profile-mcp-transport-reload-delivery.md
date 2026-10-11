# MCP transport configuration reload

MCP transport declarations are captured for each Run. Changing the command,
arguments, declared environment, transport URL, headers, credential reference,
or initialization policy takes effect on the next Run. The current Run keeps
its captured declaration through finalization and `on_agent_end` hooks.

The shared pool keys a connection by server name, canonical workspace scope,
and a normalized declaration. Identical declarations share a pending handshake
and connection. Different declarations can coexist for the same Engine and
workspace. Each Run has its own cancellation and release boundary; closing one
Run or Engine preserves transports still retained by another Run, Engine, or
explicit SDK connection. The Engine keeps its latest configuration warm until
replacement or Engine disposal.

Changing cwd within the Run's original roots uses that same declaration.
Concurrent calls share the new handshake, and a failed handshake leaves the
prior source available for retry. Changing roots requires a new Run. Registered
MCP tools, generic MCP tools, and resource reads resolve through the bound Run;
ambiguous SDK calls require an explicit context.

The declaration identity is held only in private memory and is never logged or
persisted. Tool enablement and permissions remain per-Run policy. HTTP
`credentialRef`, environment-backed headers, and bearer credentials retain
their existing per-request lookup behavior; this change does not snapshot
credential values. Request cancellation and SDK deadlines remain in force.

Direct SDK callers retain replacement behavior. `connectAll`'s optional
`retainRun` mode requires a distinct context for each retained Run, followed by
`releaseRun(context)`; Engine consumers manage this automatically. Ownerless
`reconcile` replaces the SDK's direct configuration, while one Engine's
reconciliation or disposal cannot revoke another direct selection.

Local acceptance uses the existing MCP manager/workspace/startup/tooling shards,
configuration snapshot tests, and `tests/mcp-transport-reload.test.ts`. The latter
compiles an isolated fixture and runs nine cases in an actual Node process with
real local stdio servers, including two Engine cases with an in-memory provider.
It checks configuration reuse/replacement, same-owner overlap, cwd changes and
retry, cancellation, SDK selections, finalization hooks, initialization failure,
and actual child close events. No model HTTP request or third-party MCP service
is used. Guards reject the tested JavaScript HTTP APIs before Core imports;
they are not an OS sandbox. Local Node acceptance is version-specific, and
workspace build, typecheck, final combined CI, and publication remain separate
delivery gates.

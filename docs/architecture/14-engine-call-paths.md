# Engine Call Paths (ADR)

**Date:** 2026-05-19
**Status:** Accepted
**Context:** Phase 1 of the LLM/UI decoupling roadmap

## Decision

All internal codeshell paths that need to run an engine must route through
the protocol layer — `AgentServer` wraps the `Engine`, `AgentClient` is the
consumer-facing handle, and `createInProcessClient` packages both behind a
single import. Direct `new Engine + await engine.run` is forbidden in
application code.

## Rationale

Before this decision the codebase had three otherwise-identical entry
points calling `engine.run` in three different ways:

| Path                       | Approach                          |
|----------------------------|-----------------------------------|
| REPL (`cli/commands/repl.ts`) | `new AgentServer + new AgentClient` |
| Headless CLI (`cli/commands/run.ts`) | (same, ~6 lines inline)             |
| RunManager (`run/EngineRunner.ts`)   | `new Engine + await engine.run`  |

This produced silent behavioral drift. `EngineRunner` lost three side
effects that the protocol-routed paths got for free:

1. **TaskManager stream subscription** — `AgentServer.handleRun` calls
   `taskManager.setStreamCallback(streamToClient)` before `engine.run`
   and clears it in finally. Without this, `TaskCreate` / `TaskUpdate`
   tool calls produced events that went nowhere — the run's UI never
   saw the task list update.
2. **Status notifications** — `running` / `ready` / `shutdown` were
   broadcast only when the request went through `AgentServer`.
3. **In-process running lock** — `AgentServer` rejects a concurrent
   `Run` request with `AlreadyRunning`. Direct `engine.run` callers
   could re-enter and clobber the module-level singletons that the
   first run owned (taskManager callback, plan-mode flag, logger sid).

OpenAI's Codex CLI hit the same problem and resolved it with the same
recipe ([PR #13636](https://github.com/openai/codex/pull/13636)):

> "TUI and exec each duplicated initialize handshake logic, session-source
> selection, event dispatch, server-request resolution, and shutdown
> sequencing… it was easy for in-process behavior to drift from
> app-server semantics."

Their fix: route every caller through the same JSON-RPC `MessageProcessor`,
even when the caller is in-process. The protocol is the contract; the
transport is a deployment detail.

We adopted the same shape. Our protocol layer (`src/protocol/`) was already
in place and already used by REPL — Phase 1 finished the job by migrating
the two remaining direct callers (`run.ts`, `EngineRunner.ts`).

## Allowlist (where `new Engine(` is permitted)

- **`src/engine/engine.ts`** — the Engine class itself, and the
  `subAgentSpawner.spawn(...)` path that clones the parent engine for
  background sub-agents. This is an Engine-internal implementation
  detail, not a parallel call site.
- **`src/cli/commands/repl.ts`** — REPL entry. Constructs Engine then
  wraps in `new AgentServer + new AgentClient` (REPL builds them
  explicitly because it needs the long-lived `AgentClient` instance to
  drive the React UI's lifecycle).
- **`src/cli/commands/run.ts`** — headless CLI entry. Constructs Engine
  then immediately wraps with `createInProcessClient`.
- **`src/run/EngineRunner.ts`** — RunManager runner. Constructs Engine
  then immediately wraps with `createInProcessClient`. Approval flow
  stays on the existing `RunApprovalBackend` injection — RunManager has
  its own approval surface and we don't double-dispatch through the
  server's interactive-approval hook.
- **`tests/**`** — test code constructs `Engine` directly for unit
  setup; not in scope of the guard.

External users of the package (`import { Engine } from "@cjhyy/code-shell"`)
remain free to use Engine however they like. The constraint is
**internal**, on codeshell's own call sites, where consistency matters.

## Enforcement

`scripts/check-no-engine-bypass.sh` (also runnable via
`bun run lint:engine-bypass`) greps `src/` for `new Engine(` and fails
if any match falls outside the allowlist. The guard is intentionally
simple — a path-level allowlist, not a code-pattern matcher — because
the rule it enforces is "construction site, not call pattern."

If a future change needs a new construction site:

1. Verify the new site really needs `new Engine` directly (most don't —
   they can pass an existing `engine` argument or use
   `createInProcessClient`).
2. If it does, add the path to `scripts/check-no-engine-bypass.sh` AND
   document the exception in the PR description so the next reader
   understands why it's allowed.

## Helper: `createInProcessClient`

`src/protocol/helpers.ts` exports `createInProcessClient(engine, { onStream })`
that returns `{ client, close }`. This is the recommended way for any new
internal caller to use the engine. It encapsulates the 6-line
"transport + server + client + wire onStream + close" boilerplate and
ensures the correct teardown order (server first so the final `shutdown`
status notification reaches the client; client last to drain pending
requests).

## What this does NOT do

- It does not change the public `Engine` export. External users can
  still `import { Engine }` and call `engine.run` directly.
- It does not collapse the sub-agent spawn path into the protocol.
  Sub-agents inside `engine.ts` are Engine-internal cloning, not
  parallel callers; running them through a nested `AgentServer` would
  add overhead without removing drift risk (they already share the
  Engine class implementation).
- It does not introduce a cross-process transport. Stdio / WebSocket
  transports exist in `src/protocol/transport.ts` but are not yet
  wired into a public entry point. That is Phase 2 work (multi-end
  expansion: VS Code, desktop, web).

## Related

- Spec: `docs/superpowers/specs/2026-05-17-llm-ui-decoupling-design.md`
- Plan: `docs/superpowers/plans/2026-05-17-llm-ui-decoupling.md`
- Reference: OpenAI Codex CLI `codex-app-server/src/in_process.rs`
  ("transport-local but not protocol-free")

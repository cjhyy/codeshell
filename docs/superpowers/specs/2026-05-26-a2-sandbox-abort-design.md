# A2 — Sandbox fail-closed + Subprocess Abort

**Date:** 2026-05-26
**Status:** Approved — implementation in progress
**Closes:** [Gate 0](../../architecture/16-core-overall-design-standard.md#gate-0-safety-gate) bullets 5–6 + [§S6](../../architecture/16-core-overall-design-standard.md#s6-cancellation-reaches-real-work)
**Plan reference:** [Phase A — A2](../plans/2026-05-26-core-stabilization.md#a2-sandbox-fail-closed--cancellation)

---

## Problem

Audit findings (2026-05-26):

1. **Sandbox already fail-closes** on explicit `seatbelt`/`bwrap` modes when the platform doesn't support them (`sandbox/index.ts:192-195` throws). However the backend is **resolved per turn** rather than cached on `EngineRuntime`, so the same probe runs on every tool call.
2. **Bash uses `spawn`** (`bash.ts:121`) and already implements a SIGTERM→SIGKILL escalation on timeout (`bash.ts:137-140`). It receives `ctx.signal` through `ToolContext` but **never listens to it** — a user-initiated cancel does not kill the child.
3. **REPL and PowerShell use `execSync`**, a blocking call that cannot be cancelled mid-flight. `ctx` is in scope but unusable.
4. **LSP, MCP** call into client SDKs (`client.request`, `client.callTool`) whose API does not accept an `AbortSignal`. Closing this requires upstream SDK support and is out of scope for A2.
5. **Plugin shell-runner** (`hooks/shell-runner.ts`) already uses `spawn` with timeout escalation but ignores `AbortSignal`.
6. **Sub-agent (`Agent` tool)** already cascades `parentSignal` correctly.

## Approach

Split A2 into four sub-changes:

### A2.1 — Sandbox backend cached on `EngineRuntime`

Move the resolved backend from "per-turn re-resolve" to "lazy + cached on Runtime."

- Add `sandbox?: SandboxBackend` field to `EngineRuntime` (or a `resolveSandbox()` lazy method).
- `Engine.buildToolContext()` reads `runtime.resolveSandbox()` instead of calling `resolveSandboxBackend()` directly.
- The `auto` downgrade warning fires once per Runtime, not once per turn.
- Explicit mode failures throw at Runtime construction (or first resolve) and stay thrown — no silent re-attempt per call.

This is mostly code motion; the fail-closed semantics already exist.

### A2.2 — Bash honors `ctx.signal`

In `bash.ts`, after `spawn(...)`:

```ts
const onAbort = () => {
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
};
if (ctx?.signal) {
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener("abort", onAbort, { once: true });
}
// On child exit, remove the listener to avoid leaking on long-running signals.
child.once("exit", () => {
  ctx?.signal?.removeEventListener("abort", onAbort);
});
```

Same SIGTERM→SIGKILL escalation pattern Bash already uses for timeouts.

### A2.3 — REPL and PowerShell switch from `execSync` to `spawn`

`execSync` can't honor `AbortSignal`. We rewrite both tools using `spawn` with the same kill cascade Bash uses.

The change is mostly mechanical: pipe stdout/stderr through buffers, await `child.on('exit')`, propagate timeout via the same listener pattern as Bash.

This also fixes a long-standing UX wart — `execSync` blocks the event loop for tens of seconds while a tool runs.

### A2.4 — Document deferred work for LSP / MCP

The client SDKs we use (`@modelcontextprotocol/sdk`, the LSP wrapper) don't accept `AbortSignal` on their request methods. To honor `ctx.signal` end-to-end, we would need to:

- patch the SDK,
- or wrap each call in `Promise.race([call, signalPromise])` and accept that the call still runs in the background until the SDK times out internally.

Neither option is cheap, and `Promise.race` doesn't satisfy §S6 ("Abort the in-flight promise" — the call is *still* in-flight, we just stop waiting). We mark these as **deferred** and document them in the gate.

Plugin shell-runner (already uses `spawn`) — we add `AbortSignal` support in the same pass since the change is local and small.

## Tests

New `tests/sandbox-cache.test.ts`:

1. `EngineRuntime.resolveSandbox()` returns the same backend on consecutive calls (identity check).
2. `EngineRuntime` constructed with explicit `mode: "seatbelt"` on a platform where it's unavailable throws on first resolve (regression: confirms no silent downgrade to `off`).
3. `auto` mode downgrades to `off` exactly once per Runtime (warning fires once).

New `tests/bash-abort.test.ts`:

4. Run a Bash command that sleeps; abort `ctx.signal`; assert the tool returns within ~2 seconds and the child process is dead (verify by polling `kill -0 <pid>`).
5. Pre-aborted signal (`ctx.signal.aborted === true` before spawn): tool returns "aborted" without spawning.

New `tests/repl-abort.test.ts`:

6. REPL running a sleep loop is killed by `ctx.signal` (same as Bash test).
7. REPL timeout still works (SIGTERM→SIGKILL after grace period).
8. REPL output captured correctly through new `spawn`-based path (regression on existing behavior).

`tests/sandbox.test.ts` and existing REPL tests must keep passing — we don't change semantics, only mechanism.

## Out of scope

- LSP / MCP request cancellation (upstream SDK limitation; documented).
- `Promise.race` workaround (doesn't satisfy §S6).
- Plugin shell-runner full overhaul — minimal `AbortSignal` integration only.
- Cleanup of temporary sandbox files (separate concern, low priority).

## Verification

- All new tests pass.
- Existing `tests/sandbox.test.ts`, `tests/tools.test.ts`, and REPL tests continue to pass.
- `bun run lint:engine-bypass` OK.
- Manual: running `bash -c "sleep 60"` in the TUI and pressing Esc kills the sleep child.

## Risk and rollback

- Risk: REPL / PowerShell rewrite could change the exact stdout/stderr capture behavior for some edge cases (carriage returns, very large outputs). Mitigation: keep the same buffer-and-return semantics; test against existing `tools.test.ts` REPL cases.
- Risk: `signal.addEventListener` leaks if we forget the cleanup on the happy path. Mitigation: use `{ once: true }` plus `child.once('exit', cleanup)`.
- Rollback: each sub-change (A2.1 / A2.2 / A2.3) is independent and lives in its own commit.

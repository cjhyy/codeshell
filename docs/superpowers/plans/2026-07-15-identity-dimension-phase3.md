# Identity Dimension Foundations (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the two hard blockers the server roadmap identified in core: session addressing has no identity dimension, and settings/data roots are hard-bound to the OS user. This phase lays foundations (injectable roots + identity-scoped session management); real multi-user isolation still lands as per-user workers in server Phase 2 (per the roadmap), so no cross-identity enforcement inside one process is attempted beyond keying.

**Architecture:** (1) A single injectable "data root" seam: `codeShellHome()` already honors `CODE_SHELL_HOME`; make SessionManager/SettingsManager/credential/memory stores accept an explicit root option that defaults to it (constructor injection wins over env). (2) `ChatSessionManager` gains an optional `identity: string` scope — one manager instance per identity (factory), not composite keys inside one map: `createChatSessionManager({ identity, dataRoot })`; the default local host keeps a single "local" manager, so desktop/tui behavior is unchanged. `LiveChatSessionSnapshot` carries `identity`. (3) `AgentServer` accepts an optional `resolveIdentity(connectionContext)` hook (default → "local") so a future auth gateway can partition sessions per authenticated user without forking core.

**Verification baseline:** core 0 fail (count reported by pet-extraction task), desktop 1640 / 0 fail, tui/coding/chat/arena 0 fail.

---

### Task 1: Injectable data roots

- [x] Audit `codeShellHome()` (utils/paths) + every module that computes `~/.code-shell` on its own (settings/manager.ts `userHome()` usages, session-manager sessions root, credentials store paths, memory/services, automation defaultCronStorePath). List them.
- [x] Add explicit `root`/`home` constructor options where missing, defaulting to the current behavior (`CODE_SHELL_HOME` env → `~/.code-shell`). No call-site behavior change.
- [x] Tests: one new test per store proving a custom root is honored (mkdtemp).

### Task 2: Identity-scoped ChatSessionManager

- [x] `ChatSessionManagerOptions` gains `identity?: string` (default "local"); snapshot type gains `identity`; log/telemetry lines include it.
- [x] Factory `createChatSessionManager(opts)` exported; AgentServer takes `resolveIdentity?: (ctx: { connectionId: string }) => string` — when provided and ≠ "local", the server routes getOrCreate/get through a per-identity manager map (lazy-created, each with its own dataRoot subpath `<root>/identities/<id>` for session persistence). Default path (no hook) is byte-for-byte today's behavior.
- [x] Guard: sessions listed/streamed to a connection are filtered to that connection's identity when the hook is present.
- [x] Tests: two-identity in-process server test — same sessionId under two identities resolves to two isolated sessions; identity B cannot fetch A's session (SessionNotFound).

### Task 3: Wire-through + docs

- [x] `agent-server-stdio` accepts `CODE_SHELL_DATA_ROOT` env → data root injection (worker-level identity isolation for server Phase 2 per-user workers).
- [x] Update CODESHELL.md architecture notes + TODO.md server item's 现状 paragraph (identity hooks now exist; remaining work is the auth gateway itself).
- [x] Full suites green; `git stash create` snapshot.

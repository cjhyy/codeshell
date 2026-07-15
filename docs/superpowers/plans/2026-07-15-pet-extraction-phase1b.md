# Pet Extraction from Core (Phase 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core becomes pet-free: `packages/pet` (@cjhyy/code-shell-pet) owns the Pet domain (types, projection state machine, DelegateWork tool, Mimi behavior profile); core gains four domain-neutral extension hooks that any product capability can use.

**Architecture:** Follow the recon's 5-stage order — (P1) scaffold pet package with copied domain code + repoint desktop type imports; (P2) add generic hooks to core (behavior-profile registry, run profileParams slot + validation hook, protocol lifecycle observer + extension notify channel, result extension slot, ExtensionTool metadata upgrade, SessionKind open-string); (P3) implement PetExtension in packages/pet on those hooks; (P4) delete all pet code/branches/exports from core; (P5) desktop worker loads pet via `CODE_SHELL_CAPABILITY_MODULES`, wire compat. Wire-level compat: keep method names `agent/getPetProjectionSnapshot` / `agent/petProjectionDelta` (desktop agent-bridge intercepts by name) — the snapshot RPC stays routed via the extension query default branch under a compat alias, and deltas go out through the new notify channel using the legacy method name.

**Tech Stack:** bun workspaces, bun test. Anchors from recon (line numbers pre-Phase-1c; re-grep before editing).

**Safety rails:** pet behavior tests must stay green at every stage: `engine.pet-behavior.test.ts` (139), `server.pet-projection.test.ts` (249), `server.pet-pending.test.ts` (242), `builtin/delegate-work.test.ts` (52), `tool-guards.test.ts:59-82`, desktop `main/pet/**` tests (1304). They migrate with the code they test in P3/P4. No commits; `git stash create` snapshot per stage.

---

### P1: Scaffold packages/pet (pure copy, core untouched)

- [x] P1.1 Create `packages/pet/package.json` (`@cjhyy/code-shell-pet`, private:false, deps: `@cjhyy/code-shell-core: workspace:*`), `tsconfig.json` mirroring packages/arena's, `src/` with `types.ts`, `delegation.ts`, `session-index.ts`, `pending-decision-index.ts` copied verbatim from `packages/core/src/pet/` plus their two test files. Fix imports: `../types.js` (core root types) → `import type { SessionOrigin, SessionStatus, StreamEvent } from "@cjhyy/code-shell-core/extension"` (add those type re-exports to index.extension.ts if missing); `../protocol/types.js` `PendingApprovalMetadata` → same route.
- [x] P1.2 `src/index.ts` barrel exporting everything; add package to root build filter chain (before tui, after core — mirror arena's position in root package.json build script).
- [x] P1.3 Repoint desktop's 6 type-only pet imports (`main/agent-bridge.ts:40-46` types only — `Methods` stays on core, `main/pet/pet-state-aggregator.ts:1-6`, `pet-dispatch-service.ts:7`, `pet-worker-generation.ts:1`, 4 test files) from `@cjhyy/code-shell-core` to `@cjhyy/code-shell-pet`.
- [x] P1.4 Verify: `bun test packages/pet packages/desktop` green; `bun run --filter '@cjhyy/code-shell-pet' build` (add build script) works.

### P2: Domain-neutral hooks in core

- [x] P2.1 **ExtensionModule upgrade** (`tool-system/capability-module.ts`): extend `ExtensionTool` with optional `availability?: (ctx: ToolVisibilityContext) => boolean`, `defaultPermissionRules?: string[]`, `exposureTags?: readonly string[]`, `rewriteDefinition?: (def: ToolDefinition, toolCtx: ToolContext) => ToolDefinition`. Wire availability/rewrite where builtin registration handles the same concepts (builtin/index.ts availability guard pattern at :898; dynamic-tool-defs.ts:30-48 generalizes to "each registered extension tool may rewrite its def per turn").
- [x] P2.2 **Behavior profile registry**: new `RunBehaviorProfile` interface in `engine/run-types.ts`:

```ts
export interface RunBehaviorProfile {
  id: string;
  systemPromptAppend?: string;
  /** When set, only these tools are visible for the run. */
  allowedToolNames?: ReadonlySet<string>;
  forcePermissionMode?: PermissionMode;
  disablePlanMode?: boolean;
  disableMcp?: boolean;
  /** Wraps host-supplied runtime context (profileParams.runtimeContext) into a system-prompt tail block. */
  runtimeContextTag?: string;
  /** Per-run service injection: returns values merged into ToolContext.runScopedServices. */
  createRunServices?: (opts: {
    profileParams: Readonly<Record<string, unknown>>;
    reportResult: (key: string, value: unknown) => void;
  }) => Record<string, unknown>;
}
```

`RunBehaviorMode` becomes `string` (keep literal exports for "quickChatRestricted"). `EngineConfig.behaviorProfiles?: readonly RunBehaviorProfile[]` (also contributable via `ExtensionModule.behaviorProfiles`). Engine keeps a `Map<string, RunBehaviorProfile>`; the 12 `petProfile` branch points in engine.ts (:1187-1196, :1385-1394, :1813, :1839, :1873-1874, :1905-1914, :1952, :1960-1961, :1975-1977, :2811) become generic profile lookups. `sessionKind === "pet"` implying the profile moves to the pet package via a `sessionKindProfiles?: Record<string,string>` mapping on the profile contribution.
- [x] P2.3 **Run param slot + validation**: `RunParams.profileParams?: Record<string, unknown>` (protocol/types.ts) flowing through TurnOpts (chat-session.ts:44-49, :380-382) and EngineRunOptions (run-types.ts:50-54) as one opaque field. `ExtensionModule.validateRunParams?: (params: RunParams) => string | null`; server validateRunParams calls each module's validator; **fail-closed**: `behaviorMode`/`profileParams` naming a profile no module registered → InvalidParams. Legacy wire fields `petRuntimeContext`/`petWorkspaces` are mapped into `profileParams: { runtimeContext, workspaces }` at the server boundary during the compat window (desktop still sends them).
- [x] P2.4 **Protocol observer + notify channel**: in capability-module.ts:

```ts
export interface ProtocolObserver {
  onSessionStream?: (sessionId: string, event: StreamEvent) => void;
  onRunBoundary?: (sessionId: string, phase: "start" | "end" | "error") => void;
  onApprovalCreated?: (metadata: PendingApprovalMetadata) => void;
  onApprovalTransition?: (metadata: PendingApprovalMetadata, status: string) => void;
  onSessionClosed?: (sessionId: string) => void;
  onServerClose?: () => void;
}
export interface ProtocolObserverHost {
  getLiveSessionSnapshot: () => LiveChatSessionSnapshot[];
  notify: (method: string, params: Record<string, unknown>) => void;
  queryAlias: (type: string, handler: ExtensionQueryHandler) => void;
}
export interface ExtensionModule {
  // …existing…
  createProtocolObserver?: (host: ProtocolObserverHost) => ProtocolObserver;
}
```

server.ts instantiates observers at construction and calls them at the exact anchors the pet state machine uses today (:1011/:1056/:1070/:1072/:1090 run+stream, :1303/:2952-2960/:3026-3030/:3716-3740/:3749/:3797 approvals, :1919 close, :3466 server close).
- [x] P2.5 **Result slot**: `EngineResult.extensions?: Record<string, unknown>` populated from `reportResult` (P2.2); RunResult forwards it. Legacy `petWorkDelegation` stays as a compat mirror of `extensions.pet?.workDelegation` until P5 flips desktop.
- [x] P2.6 **SessionKind open**: `types.ts:219` → `export type SessionKind = "work" | (string & {})`; `session-manager.ts:1626` list filter → `list(opts?: { excludeKinds?: readonly string[] })` with the server passing configured hidden kinds (contributed via `ExtensionModule.hiddenSessionKinds?: readonly string[]`).
- [x] P2.7 Verify after each sub-step: `bun test packages/core` green (pet tests still pass because pet code still in core, now routed through the generic paths).

### P3: PetExtension in packages/pet

- [x] P3.1 Move (not copy) `session-index.ts`/`pending-decision-index.ts`/tests from core to pet package (they were copied in P1 — now core's originals are deleted and server.ts stops importing them, replaced by the observer wiring below).
- [x] P3.2 `packages/pet/src/capability.ts`: `createPetCapability(): ExtensionModule` with id "pet"; DelegateWork as ExtensionTool (definition from builtin/delegate-work.ts + availability + rewriteDefinition from dynamic-tool-defs.ts:45-48); behaviorProfiles: the "pet" profile (PET_SYSTEM_PROMPT, allowed tools {DelegateWork}, forcePermissionMode default, disableMcp, runtimeContextTag "pet-world", createRunServices provides workspaces + one-shot requestPetWorkDelegation reporting to `extensions.pet`); validateRunParams (server.ts:105-158 logic); createProtocolObserver returning the projection machine (server.ts:292-297 fields + :3520-3746 methods, using host.getLiveSessionSnapshot/notify with legacy method name `agent/petProjectionDelta`, queryAlias for the snapshot under the legacy `agent/getPetProjectionSnapshot` — server keeps a thin compat case delegating to the alias registry); hiddenSessionKinds ["pet"].
- [x] P3.3 Move `engine.pet-behavior.test.ts`, `server.pet-projection.test.ts`, `server.pet-pending.test.ts`, `delegate-work.test.ts` into packages/pet (rewired to compose core + createPetCapability explicitly — this also proves the hooks are sufficient).
- [x] P3.4 Verify: `bun test packages/pet` green (all migrated suites), `bun test packages/core` green.

### P4: Core cleanup

- [x] P4.1 Delete `packages/core/src/pet/`, `tool-system/builtin/delegate-work.ts` (+ registration :887-900, dynamic-tool-defs pet branch), PET_* constants in run-types.ts, all petProfile remnants, server.ts pet fields/methods, protocol/types.ts pet types + `PetProjectionDelta`/`PetProjectionSnapshotResult`/two Methods entries (keep the two method-name string constants under compat aliases if desktop bridge references `Methods.*`), client.ts:399-460 pet conveniences (move equivalents to pet package or desktop), protocol/index.ts re-exports, index.ts pet exports (:49-70, :96-99, :240-241), context.ts:241-243 pet fields (replaced by runScopedServices), tool-guards pet cases.
- [x] P4.2 grep gates: `grep -rni "pet" packages/core/src --include='*.ts' | grep -v test` → only incidental words (e.g. "carpet") or compat-alias comments; `grep -rn "DelegateWork" packages/core/src` → empty.
- [x] P4.3 Verify: `bun test packages/core packages/pet packages/tui packages/coding` green.

### P5: Desktop wiring + compat flip

- [x] P5.1 AgentBridge spawn env: append `CODE_SHELL_CAPABILITY_MODULES=@cjhyy/code-shell-pet#createPetCapability` (main process, where the stdio worker is spawned); desktop package.json adds `@cjhyy/code-shell-pet` dep.
- [x] P5.2 `pet-dispatch-service.ts:207-229`: send `profileParams: { runtimeContext, workspaces }` alongside legacy fields (compat both ways), read delegation from `extensions.pet` with fallback to legacy `petWorkDelegation`.
- [x] P5.3 `agent-bridge.ts:40-46,880,935`: keep method-name interception (names unchanged); `Methods` import may need the compat aliases from P4.1.
- [x] P5.4 Verify: `bun test packages/desktop` green; desktop typecheck no new errors; full `bun test packages/core packages/pet packages/desktop packages/tui packages/coding packages/chat packages/arena` green. `git stash create` snapshot.

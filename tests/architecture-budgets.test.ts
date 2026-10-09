import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

function lines(path: string): number {
  return source(path).split("\n").length - 1;
}

function matches(path: string, pattern: RegExp): number {
  return [...source(path).matchAll(pattern)].length;
}

describe("architecture growth budgets", () => {
  test("large composition roots cannot grow without an extraction", () => {
    // Exact 2026-08-13 post-security-audit baselines: decreases are welcome;
    // any growth must extract a module or consciously update this decision.
    // The IPC count stayed flat; the line increase is the reviewed per-channel
    // renderer ownership, path-containment, bounded-input enforcement, and the
    // extracted PTY composite-id assertion at the IPC boundary. The Panel task
    // host and saved-cookie authorization then landed in v0.8.17; the follow-up
    // security pass removed nine lines while retaining those reviewed seams.
    // Panel App submissions that target an external runtime are then wired
    // through main: the bridge receives the runtime service and the transcript
    // handoff builder (implemented in external-runtime-handoff.ts), and the
    // service reports session start/stop to the owning window through the
    // shared sendToOwnerWindow helper that emit already uses (+9 lines). The
    // service also receives main's exact-root project resolver so external
    // runtime sessions persist the same stable project identity as native
    // Engine sessions (+9 lines). Concurrent IM messages on one route are then
    // folded into the running Mimi turn via steer: the dispatch source carries
    // senderId so the route key can distinguish two people in one group chat,
    // and a steered follower returns early instead of emitting a second IM
    // reply for the same turn (+9 lines). Both are early-exit branches inside
    // the existing dispatchGatewayPetChat, so extracting them would split one
    // request path across two files for no gain; the steer/unsteer scheduler
    // itself already lives in pet-dispatch-service.ts.
    // Entering a Work Session from a chat then adds its composition root
    // (+26): the store, bridge, bind executor, reply delivery, runner and
    // health probe all live in pet/session-bridge-wiring.ts, so this file
    // only names collaborators it already owns, registers one host-action
    // key, and answers one control-plane route. Extracting further would
    // split the host-action table itself. (The rationale above was written
    // when the change landed but the number was never raised; 7_002 is the
    // measured size of that reviewed wiring.)
    // v0.9.7 adds model-service and activity-history adapter wiring, the delivered
    // reply body, and parentSessionId validation at the existing IPC boundary
    // (+25). Their service implementations remain outside the composition root.
    // v0.9.8 adds two calls to clear browser grants when deleting a Session;
    // cleanup remains in the existing browser-runtime services (+2 wiring).
    // The 2026-09-18 consolidation adds external-goal service wiring, reload
    // approval replay and IM reply delivery (+108 over origin/main's 7_006).
    // Goal persistence/RPC handlers remain in external-runtime-goals.ts and
    // external-runtime-goal-rpc.ts; main supplies its live window ownership,
    // trusted project resolver and service lifecycle. Approval replay combines
    // the existing native/external queues at the IPC boundary. This reviewed
    // baseline keeps both IPC-count and public-export budgets unchanged.
    // The 2026-09-20 media preview authority adds 42 lines of composition-only
    // wiring. Path validation, scoped authorization, Range streaming and
    // lifecycle cleanup remain extracted in media-preview-{authority,service}.
    // Project review ownership/caches and remote Link window lifetimes live in
    // focused IPC modules. Usage history adds only its import and one local IPC
    // registration; validation, Session identity and bounded receipt reads stay
    // in usage-history-service.ts and core/cost-ledger. The formatted Lab host
    // registration accounts for the remaining two lines over the extracted
    // 7_152-line root. Pin this reviewed composition-only result exactly.
    // Request evidence adds eleven composition lines for the Host signer,
    // actual OS encryption availability and native Quick Chat ownership. Key
    // custody and worker-generation checks stay in model-request-signing-service.
    // Signing uses private worker messages, with no renderer IPC registration.
    // +9 composition-only lines register reviewed Profile preview/CAS adoption.
    // Target authority, planning and locking stay in the extracted registrar/service.
    // +9 composition lines for the extracted, owner-scoped static export registrar.
    // +2 composition lines advertise native Mobile recovery and revoke retired viewers.
    expect(lines("packages/desktop/src/main/index.ts")).toBeLessThanOrEqual(7_188);
    expect(lines("packages/desktop/src/main/project-panel-ipc.ts")).toBeLessThanOrEqual(322);
    // The five generic Link authorization operations reuse the window/project
    // owner and live reauthorization guard here. Challenge state, provider
    // protocols and native browser handoff remain in server/links and
    // remote-link-{manager,window}; this registrar holds no provider tokens.
    expect(lines("packages/desktop/src/main/remote-link-ipc.ts")).toBeLessThanOrEqual(173);
    // Count extracted registrations too: moving a route cannot hide API growth.
    // New explicit project-package, remote-Link and Cloud-window operations are
    // part of this feature's reviewed transport contract, total 295 routes.
    // +1 authenticated, owner-scoped cancelRestore route releases abandoned
    // version reviews. Count the extracted version registrar in the same budget.
    // +3 reviewed device registration/status/forget operations, no credential read.
    // +2 main-frame-only Desktop file metadata/preview operations. These read an
    // explicitly selected file without granting access to its parent directory.
    // Count the full session transcript registrar, including its two previously
    // extracted routes, and three reviewed Task Center list/get/act routes.
    // The reviewed additions are five Link challenge operations, four Lab
    // operations and one usage-history query. Count every registration, including
    // the extracted modules, with no allowance for future routes.
    expect(
      matches("packages/desktop/src/main/index.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/project-panel-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/project-panel-version-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/remote-link-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/device-relay-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/local-file-preview-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/session-transcript-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/profile-switch-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/profile-plugin-export-ipc.ts", /ipcMain\.handle\(/g) +
        matches("packages/desktop/src/main/task-inbox/task-inbox-ipc.ts", /handle\("taskInbox:/g) +
        // Nine local-only Lab routes: eight existing operations plus P2 native
        // adoption. Exact body/scope review and post-dialog revalidation remain
        // in this owner-scoped registrar; ordinary RPC cannot approve adoption.
        matches("packages/desktop/src/main/optimization-lab-ipc.ts", /handle\("optimizationLab:/g),
      // +1 read-only, bounded Session output-journal page route. Its file/owner
      // validation and recovery algorithm stay in Core and the extracted adapters.
      // +2 metadata-only Profile preview and revision-checked adoption routes.
      // +3 preview/cancel/reviewed-save operations, without installation authority.
    ).toBeLessThanOrEqual(327);
    // v0.8.17 added the reviewed Panel catalog/task bridge to both preload
    // surfaces. Mimi's bounded transcript pagination adds one typed invoke;
    // the validation and file-reading implementation remain extracted in main.
    // Reload recovery adds the pending-approval invoke and acknowledged
    // external answers; goal inputs and answer mirroring use existing routes.
    // These are transport adapters (+26 over the 1_802-line main baseline).
    // Media preview adds two typed invokes and one shared request/result import;
    // authority and streaming remain in the extracted main-process service (+5).
    // Project package reviews/restores, independent Link and Cloud window APIs
    // add only typed invoke adapters; ownership lives in the extracted IPC modules.
    // The project-version bridge is extracted without changing its exposed methods.
    // Count those invokes too, preserving the existing transport surface ceiling.
    // Session history invokes remain counted after extraction. Task Center adds
    // three reviewed invokes; its changed-event subscription adds no invoke.
    // Link challenge start/get/respond/cancel/open are typed invoke adapters;
    // challenge custody remains in the Host. Usage history adds one invoke to
    // the extracted read-only service. The actual combined root is 1_871 lines.
    // +7 typed Profile review/adoption adapter lines, with no renderer file access.
    // +2 import/composition lines for the extracted static export contract.
    expect(lines("packages/desktop/src/preload/index.ts")).toBeLessThanOrEqual(1_880);
    // Include all nine extracted Lab invokes and the five generic Link
    // challenge invokes plus usage history. Main-only routes remain counted
    // above even when no renderer adapter exists; do not equate the totals.
    expect(
      matches("packages/desktop/src/preload/device-relay-api.ts", /ipcRenderer\.invoke\(/g) +
        matches("packages/desktop/src/preload/index.ts", /ipcRenderer\.invoke\(/g) +
        matches(
          "packages/desktop/src/preload/project-panel-version-api.ts",
          /ipcRenderer\.invoke\(/g,
        ) +
        matches("packages/desktop/src/preload/session-transcript-api.ts", /ipc\.invoke\(/g) +
        matches("packages/desktop/src/preload/task-inbox-api.ts", /ipc\.invoke\(/g) +
        matches("packages/desktop/src/preload/profile-plugin-export-api.ts", /ipc\.invoke\(/g) +
        matches("packages/desktop/src/preload/optimization-lab-api.ts", /ipc\.invoke\(/g),
    ).toBeLessThanOrEqual(320);
    // GitHub skill previews and Panel task hosting carry main-issued review and
    // ownership fields across the typed preload boundary. The optional Mimi
    // transcript-page method adds its bounded response shape without widening
    // the renderer's direct imports.
    // Pending approval recovery, external goal inputs and resolved answer text
    // add nine declaration lines; no renderer runtime import is introduced.
    // Media playback adds the narrow get/release preview contract and shared
    // request/result types while all file access stays in main (+11).
    // +55 declaration lines for those explicit project/version/Link contracts.
    // Main-branch integration retains the detailed run-trace declarations (+11).
    // Lab adds its extracted API type import and one typed capability property (+2).
    // Generic Link challenge contracts, the bounded UsageQuery/Summary method
    // and Profile sourceAccess transport fields add declarations only. Host
    // authorization and source-permission intersection remain outside preload.
    // +9 declaration lines for the optional bounded output-journal adapter.
    // +9 typed Profile metadata preview and CAS adoption declarations.
    // Static export API is composed through one type-only import/extends seam.
    expect(lines("packages/desktop/src/preload/types.d.ts")).toBeLessThanOrEqual(2_974);
    // The responsive-sidebar work extracts ResponsiveSidebar (132),
    // useResponsiveSidebar (61) and useSessionHistorySync (127) into
    // renderer/app/, so the 320 lines of behaviour live outside this file and
    // the +64 here is the composition root naming them plus the narrow-window
    // view transitions it already owns.
    // Consolidation adds review-availability hook wiring and waits for answer
    // acknowledgement before updating this component's transcript state (+25
    // over 2_748). Availability checks remain in useReviewAvailability.ts;
    // per-session approval policy remains in app/approvalPermission.ts.
    // +6 generation checks keep stale project refreshes out of live UI state.
    expect(lines("packages/desktop/src/renderer/App.tsx")).toBeLessThanOrEqual(2_779);
    // Goal-extension and pre-turn archive inputs now fail closed at protocol
    // ingress instead of trusting arbitrary numeric/object payloads. Manual
    // Mimi clears also validate their host-authored summary at this boundary.
    // Routing an IM message into a bound Work Session adds its protocol
    // ingress here (+87): the outcome shapes and workspace resolution are
    // extracted to session-message-result.ts (59) and
    // session-message-workspace.ts (84), so this file validates and dispatches
    // rather than implementing the routing.
    // v0.9.7's child-host lifecycle adds activation/disposal, not just wiring
    // (+210 total). It owns this connection's generation, pending approvals,
    // notification targets and timers, so cleanup stays with AgentServer's
    // private state. Approval policy/queues and child-run creation remain in
    // ApprovalRouter/InteractiveApprovalBackend and subagent-spawner respectively.
    // v0.9.8 forwards inspect and explicit resume through BrowserBridge (+2);
    // implementations and authorization stay in the host browser backends.
    // Shared Desktop/Hub transports add a pending-start cancellation fence
    // (+70): the manager keys cross-connection cancellation, while AgentServer
    // owns each connection's controllers until ChatSession accepts the turn.
    // Cancel, close and disconnect must cover that pre-queue lifetime here;
    // queued/running turn cancellation stays in ChatSession. Settings refresh
    // also invalidates the extracted skill scanner's discovery cache (+5), so
    // an edited SKILL.md is visible on the next turn without a worker restart.
    // Nonblocking questions add registration and acknowledged answer handling
    // (+180 over 4_824). AgentServer owns the route generation, cancellation
    // fence, pending approval entry/timer and transport response, so admission
    // and retirement stay together here. Follow-up turn delivery is extracted
    // to async-user-answer.ts; no published entry-point budget is widened.
    // Per-turn sandbox/background-shell policy is validated and forwarded at
    // protocol ingress; enforcement remains in the run environment and tools.
    // Runtime lifecycle adds awaited host activation, owner-scoped observer
    // shutdown and a single close promise. Lifetime/activation algorithms stay
    // in composition/{lifetime,activation,protocol-attach}; AgentServer retains
    // connection ownership and transport cancellation. The usage query reuses
    // resolveEngineForSessionQuery, rejects aggregation without an explicit
    // trusted local Host, and delegates receipt reads to Engine/UsageLedger.
    // +12 reviewed lifecycle lines retain a cloned, resolver-free final pending
    // decision snapshot after owner disconnect and before observer disposal.
    // Full close flushes terminal notifications before closing transport, then
    // drops this metadata cache; no observer, tool resolver or grant is retained.
    // +32 ingress lines resolve the existing Session owner and forward bounded
    // journal queries; persistence, cursor validation and paging remain extracted.
    expect(lines("packages/core/src/protocol/server.ts")).toBeLessThanOrEqual(5_170);
    // Topic-boundary archival stays inside run startup. Synthetic worktree
    // authority is only a public delegation seam here; its implementation was
    // extracted to engine-workspace-authority.ts. The run-yield visibility
    // filter then moved from a construction-time spread to per-reason
    // peek/consume closures sharing one suppressesRunYield predicate, so a
    // committed host reply stays terminal in headless and sub-agent runs and
    // peek/consume can never disagree (+12 reviewed lines).
    // A behavior profile's maxTurns is now frozen for the live run so Goal
    // extension cannot raise a ceiling the profile set (+44). This is engine
    // state with an engine lifetime — it is cleared when the turn loop it
    // belongs to ends — so there is nothing to extract without separating the
    // value from the loop that owns it.
    // v0.9.7 threads context-note strategy and retained messages through runs,
    // synchronizes private compaction caches/usage anchors, and installs child
    // host bindings (+91). Note persistence/rollover/replay lives in context/notes
    // and the builtin tools; Engine retains ownership of its per-run state.
    // v0.9.8 retains lastCompletionKind in Engine's own session snapshot (+1),
    // so a yielded background turn is not projected as completed by hosts.
    // v0.9.20 threads current-run MCP connection health into dynamic context
    // (+15 net). Connection policy, retries and user-facing formatting remain
    // extracted under tool-system; Engine only places the result for this run.
    // +3 lines pass the frozen per-turn policy into the existing child spawner.
    // The reviewed 259-line net growth owns Engine/Session/run lifetime scopes,
    // awaited readiness and shutdown; implementation lives in composition's
    // lifetime/activation modules. Cost accounting binds the current Session,
    // run and ancestry to UsageLedger; storage/pricing/summary logic is extracted
    // under cost-ledger and physical request receipts stay in llm. Workspace
    // Profile/source guards and the trusted document executable are ToolContext
    // wiring; source parsing/authorization stay under sources. Per-run operation
    // controller binding and finalization fences delegate to operations/{ledger,
    // controller,resolver}. Keep these private owner boundaries together and
    // pin the actual combined Engine size, with no future-feature allowance.
    // P2 adds 131 lines binding frozen instructions to Engine-owned run/watch/
    // abort/cache lifetimes. Snapshot selection, revision comparison and
    // checkpoint persistence are extracted to engine-instruction-context.ts.
    // The real no-tools Lab and ordinary Session consumers exercise this seam.
    // Skill metadata adds 20 reviewed wiring lines: the current model window,
    // task and up to 32 recent requests enter existing prompt composition, and
    // registry/allowlist gates suppress unusable listings. Budgeting, ranking
    // and discovery remain in builtin/skill-prompt.ts; no new Host API is added.
    // Request evidence adds 42 owner-binding lines: the current Session
    // incarnation/storage scope, composition/config versions and borrowed or
    // owned Host signer enter the existing model facade. Provider projection,
    // validation, custody and durable event writes remain in dedicated modules.
    // +5 net lines bind persist-before-publish and the workspace path used
    // by the shared input display projection for queued attachment steering. Journal
    // ownership/failure fencing remain in run-stream.ts and session/output-journal.ts.
    // Progressive tools add exactly 10 wiring lines: a run-local surface wraps
    // the existing catalog assembler and supplies active/eligible callbacks.
    // Selection, immutable snapshots and execution gates stay in their owners.
    // Active-close adds exactly 126 reviewed owner-wiring lines: stable actual
    // run identity, private own-usage checkpoint and settled close handoff.
    // Permission projection, durable ledger and CAS/epoch validation stay in
    // their existing owners. Fourteen actual Engine cases cover immediate
    // revocation, progress/late accounting and successor isolation; keeping this
    // private run state together avoids adding another mutable ownership seam.
    // Pin the concrete result, with no allowance for future features.
    expect(lines("packages/core/src/engine/engine.ts")).toBeLessThanOrEqual(5_021);
  });

  test("published entry points cannot silently expand their compatibility surface", () => {
    const exportBudgets: Record<string, number> = {
      // Re-tightened after the composition cutover deleted the legacy
      // registerCapability/registerPreset/registerSection export surface.
      // The remote Link client is an intentional public SDK capability consumed
      // by standalone Hosts; tokens stay in their credential authority.
      // +2 LifetimeScope runtime/type statements for standalone SDK module
      // owners; +2 Local OAuth and reviewed remote-provider adapters for external
      // Hosts; +2 UsageLedger runtime/type statements for durable SDK accounting.
      // Profile sourceAccess extends the existing source export statement.
      // Parser executables and cache invalidation remain Host-only below.
      // +1 type-only signer contract lets an SDK Host supply custody without
      // exposing the key store, worker IPC or mutable default signer authority.
      "packages/core/src/index.ts": 131,
      // +3 reviewed Optimization Lab foundations: read-only Skill snapshots,
      // the shared file lock, and text-connection resolution (§5.2 of the plan).
      // +1 type-only LifetimeScope/Disposable contract lets capability modules
      // declare owned resources without exposing Host parser/runtime authority.
      // +3 P2 declarations: Host binding/hash/types and the isolated instruction
      // runner, consumed by optimization-lab. The stable SDK stays unchanged.
      // +4 reviewed extension statements: memory-only ephemeral signer factory,
      // read-only current logical/physical attempt identities, and signer type.
      // Isolated capability Hosts own the ephemeral signer's disposal.
      "packages/core/src/index.extension.ts": 57,
      // Shared crash-safe persistence primitives and the Desktop-owned
      // background job registry are host-only API.
      // Speech model resolution adds one reviewed host-only module, shared by
      // transcription, voice generation and Desktop media capability checks.
      // It remains outside the stable public SDK and extension surfaces.
      // Panel connection discovery and sealed tool hand-offs share the existing
      // catalog resolver (+1); credentials remain on the reviewed Host surface.
      // Verified application-owned runtime discovery adds one Host-only module;
      // it neither selects executables for consumers nor grants execution.
      // Offline project settings inspection, reviewed repair and exact rollback
      // add one Host-only module for the administrator CLI. The public SDK and
      // extension contracts do not expose configuration recovery authority.
      // Task Center requires one source-fenced background lifecycle module for
      // Host registries. Listing/cancellation stay off public and extension APIs.
      // +2 reviewed upload Host seams: exact-file index invalidation for the
      // upload lifecycle, and a verified managed parser executable resolver for
      // Desktop/stdio. Neither is exported by the public/extension entries.
      // +4 Host-only statements provide durable key custody, persisted owner
      // validation, private worker/default-signer adapters and their types.
      // None grants renderer or model RPC access to signing keys.
      // +1 Host-only journal reader/writer/type statement. No stable SDK growth.
      // +2 Host-only statements expose the pure Profile switch planner and
      // existing direct-override fold; stable SDK and extension exports are unchanged.
      // +1 static export snapshot/type Host seam, with no stable SDK growth.
      // +1 existing canonical input projection shared by Core and Desktop's
      // owned external Runtime journal; avoids divergent input/attachment rules.
      // It adds no stable public SDK or extension surface or execution authority.
      "packages/core/src/index.internal.ts": 97,
      "packages/coding/src/index.ts": 12,
      "packages/arena/src/index.ts": 19,
      // +1 for conversation-session.ts, which re-exports the four modules
      // behind entering a Work Session from a chat (route record, IM list,
      // visit receipt, deterministic commands). They are one feature and are
      // consumed together, so the barrel gains a single line rather than four.
      "packages/pet/src/index.ts": 25,
      // Desktop and Hub share the extracted desktop-web, links and panels
      // entry points (+3); their HTTP/service implementations remain in server
      // so Desktop adapters no longer own separate copies of those services.
      "packages/server/src/index.ts": 7,
      // Shared transcript replay (+1) folds persisted records through the web
      // stream reducer, giving reconnecting clients the same message state.
      // Environment identity and project-reference contracts are shared by the
      // desktop remote entry and standalone Web; no platform authority is exported.
      // +2 browser-safe Link challenge controller/presentation modules shared by
      // Desktop and Web; transport custody, token refresh and grants remain Host
      // responsibilities. These modules import no native/credential authority.
      // +1 shared bounded output-journal recovery reducer statement.
      "packages/web/src/index.ts": 20,
    };
    for (const [path, budget] of Object.entries(exportBudgets)) {
      expect(matches(path, /^export /gm), path).toBeLessThanOrEqual(budget);
    }
  });
});

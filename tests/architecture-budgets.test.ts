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
    expect(lines("packages/desktop/src/main/index.ts")).toBeLessThanOrEqual(7_027);
    expect(matches("packages/desktop/src/main/index.ts", /ipcMain\.handle\(/g)).toBeLessThanOrEqual(
      290,
    );
    // v0.8.17 added the reviewed Panel catalog/task bridge to both preload
    // surfaces. Mimi's bounded transcript pagination adds one typed invoke;
    // the validation and file-reading implementation remain extracted in main.
    expect(lines("packages/desktop/src/preload/index.ts")).toBeLessThanOrEqual(1_825);
    expect(
      matches("packages/desktop/src/preload/index.ts", /ipcRenderer\.invoke\(/g),
    ).toBeLessThanOrEqual(300);
    // GitHub skill previews and Panel task hosting carry main-issued review and
    // ownership fields across the typed preload boundary. The optional Mimi
    // transcript-page method adds its bounded response shape without widening
    // the renderer's direct imports.
    expect(lines("packages/desktop/src/preload/types.d.ts")).toBeLessThanOrEqual(2_852);
    // The responsive-sidebar work extracts ResponsiveSidebar (132),
    // useResponsiveSidebar (61) and useSessionHistorySync (127) into
    // renderer/app/, so the 320 lines of behaviour live outside this file and
    // the +64 here is the composition root naming them plus the narrow-window
    // view transitions it already owns.
    expect(lines("packages/desktop/src/renderer/App.tsx")).toBeLessThanOrEqual(2_750);
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
    expect(lines("packages/core/src/protocol/server.ts")).toBeLessThanOrEqual(4_803);
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
    expect(lines("packages/core/src/engine/engine.ts")).toBeLessThanOrEqual(4_409);
  });

  test("published entry points cannot silently expand their compatibility surface", () => {
    const exportBudgets: Record<string, number> = {
      // Re-tightened after the composition cutover deleted the legacy
      // registerCapability/registerPreset/registerSection export surface.
      "packages/core/src/index.ts": 123,
      "packages/core/src/index.extension.ts": 46,
      // Shared crash-safe persistence primitives and the Desktop-owned
      // background job registry are host-only API.
      "packages/core/src/index.internal.ts": 81,
      "packages/coding/src/index.ts": 12,
      "packages/arena/src/index.ts": 19,
      // +1 for conversation-session.ts, which re-exports the four modules
      // behind entering a Work Session from a chat (route record, IM list,
      // visit receipt, deterministic commands). They are one feature and are
      // consumed together, so the barrel gains a single line rather than four.
      "packages/pet/src/index.ts": 25,
      "packages/server/src/index.ts": 4,
      "packages/web/src/index.ts": 14,
    };
    for (const [path, budget] of Object.entries(exportBudgets)) {
      expect(matches(path, /^export /gm), path).toBeLessThanOrEqual(budget);
    }
  });
});

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
    expect(lines("packages/desktop/src/main/index.ts")).toBeLessThanOrEqual(6_951);
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
    expect(lines("packages/desktop/src/renderer/App.tsx")).toBeLessThanOrEqual(2_686);
    // Goal-extension and pre-turn archive inputs now fail closed at protocol
    // ingress instead of trusting arbitrary numeric/object payloads. Manual
    // Mimi clears also validate their host-authored summary at this boundary.
    expect(lines("packages/core/src/protocol/server.ts")).toBeLessThanOrEqual(4_506);
    // Topic-boundary archival stays inside run startup. Synthetic worktree
    // authority is only a public delegation seam here; its implementation was
    // extracted to engine-workspace-authority.ts. The run-yield visibility
    // filter then moved from a construction-time spread to per-reason
    // peek/consume closures sharing one suppressesRunYield predicate, so a
    // committed host reply stays terminal in headless and sub-agent runs and
    // peek/consume can never disagree (+12 reviewed lines).
    expect(lines("packages/core/src/engine/engine.ts")).toBeLessThanOrEqual(4_274);
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

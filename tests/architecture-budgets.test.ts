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
    expect(lines("packages/desktop/src/main/index.ts")).toBeLessThanOrEqual(6_925);
    expect(matches("packages/desktop/src/main/index.ts", /ipcMain\.handle\(/g)).toBeLessThanOrEqual(
      290,
    );
    // v0.8.17 added the reviewed Panel catalog/task bridge to both preload
    // surfaces, including one new invoke without widening renderer imports.
    expect(lines("packages/desktop/src/preload/index.ts")).toBeLessThanOrEqual(1_823);
    expect(
      matches("packages/desktop/src/preload/index.ts", /ipcRenderer\.invoke\(/g),
    ).toBeLessThanOrEqual(299);
    // GitHub skill previews and Panel task hosting carry main-issued review and
    // ownership fields across the typed preload boundary.
    expect(lines("packages/desktop/src/preload/types.d.ts")).toBeLessThanOrEqual(2_842);
    expect(lines("packages/desktop/src/renderer/App.tsx")).toBeLessThanOrEqual(2_686);
    // Goal-extension and pre-turn archive inputs now fail closed at protocol
    // ingress instead of trusting arbitrary numeric/object payloads.
    expect(lines("packages/core/src/protocol/server.ts")).toBeLessThanOrEqual(4_497);
    // Topic-boundary archival is deliberately inside run startup so it cannot
    // race the current turn's exclusive-end anchor.
    expect(lines("packages/core/src/engine/engine.ts")).toBeLessThanOrEqual(4_251);
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
      "packages/pet/src/index.ts": 24,
      "packages/server/src/index.ts": 4,
      "packages/web/src/index.ts": 14,
    };
    for (const [path, budget] of Object.entries(exportBudgets)) {
      expect(matches(path, /^export /gm), path).toBeLessThanOrEqual(budget);
    }
  });
});

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
    // renderer ownership, path-containment, and bounded-input enforcement.
    expect(lines("packages/desktop/src/main/index.ts")).toBeLessThanOrEqual(6_842);
    expect(matches("packages/desktop/src/main/index.ts", /ipcMain\.handle\(/g)).toBeLessThanOrEqual(
      289,
    );
    expect(lines("packages/desktop/src/preload/index.ts")).toBeLessThanOrEqual(1_814);
    expect(
      matches("packages/desktop/src/preload/index.ts", /ipcRenderer\.invoke\(/g),
    ).toBeLessThanOrEqual(298);
    // GitHub skill previews now carry one main-issued review token field.
    expect(lines("packages/desktop/src/preload/types.d.ts")).toBeLessThanOrEqual(2_830);
    expect(lines("packages/desktop/src/renderer/App.tsx")).toBeLessThanOrEqual(2_686);
    // Goal-extension and pre-turn archive inputs now fail closed at protocol
    // ingress instead of trusting arbitrary numeric/object payloads.
    expect(lines("packages/core/src/protocol/server.ts")).toBeLessThanOrEqual(4_492);
    // Topic-boundary archival is deliberately inside run startup so it cannot
    // race the current turn's exclusive-end anchor.
    expect(lines("packages/core/src/engine/engine.ts")).toBeLessThanOrEqual(4_251);
  });

  test("published entry points cannot silently expand their compatibility surface", () => {
    const exportBudgets: Record<string, number> = {
      "packages/core/src/index.ts": 124,
      "packages/core/src/index.extension.ts": 46,
      // Shared crash-safe persistence primitives are host-only API.
      "packages/core/src/index.internal.ts": 80,
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

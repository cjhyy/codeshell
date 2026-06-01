/**
 * Regression coverage for stream-event bucket routing after a renderer remount.
 *
 * Bug: when the renderer remounts (refresh / HMR / crash recovery), the
 * in-memory `engineToBucketRef` route table is wiped. A worker that resumed
 * the same engine session keeps emitting events, but App.tsx:632-634 looked
 * the sessionId up ONLY in that wiped table (plus the soft `runningBucket`
 * hint) and `return`ed on a miss — silently dropping every event. The UI for
 * that turn stayed blank even though the worker was producing output and
 * writing files.
 *
 * `resolveBucket` adds the missing fallback: on a route-table miss, reverse
 * look up the engine sessionId in the on-disk session indices (which DO
 * survive a remount, loaded from localStorage) to reconstruct the bucket.
 */
import { describe, it, expect } from "bun:test";
import { resolveBucket } from "./streamRouting";
import type { SessionIndex } from "./transcripts";

const GLOBAL_KEY = "__global__";

function idx(sessions: SessionIndex["sessions"]): SessionIndex {
  return { sessions, activeSessionId: null };
}

describe("resolveBucket", () => {
  it("returns the bucket from the route table when present (fast path)", () => {
    const table = new Map([["eng-1", "repoA::ui-1"]]);
    const result = resolveBucket("eng-1", table, {}, null);
    expect(result).toBe("repoA::ui-1");
  });

  it("falls back to the running-bucket hint when sessionId is empty", () => {
    const result = resolveBucket("", new Map(), {}, "repoA::ui-1");
    expect(result).toBe("repoA::ui-1");
  });

  it("reverse-looks-up the engine sessionId in session indices on a table miss", () => {
    // This is THE bug: route table empty (remounted), but the session exists
    // on disk with engineSessionId === the incoming event's sessionId.
    const indices: Record<string, SessionIndex> = {
      repoA: idx([
        { id: "ui-1", title: "t", createdAt: 0, updatedAt: 0, engineSessionId: "eng-1" },
      ]),
    };
    const result = resolveBucket("eng-1", new Map(), indices, null);
    expect(result).toBe("repoA::ui-1");
  });

  it("reconstructs a global-repo bucket on reverse lookup", () => {
    const indices: Record<string, SessionIndex> = {
      [GLOBAL_KEY]: idx([
        { id: "ui-9", title: "t", createdAt: 0, updatedAt: 0, engineSessionId: "eng-9" },
      ]),
    };
    const result = resolveBucket("eng-9", new Map(), indices, null);
    expect(result).toBe(`${GLOBAL_KEY}::ui-9`);
  });

  it("matches legacy sessions where engineSessionId !== uiSessionId", () => {
    const indices: Record<string, SessionIndex> = {
      repoA: idx([
        { id: "ui-old", title: "t", createdAt: 0, updatedAt: 0, engineSessionId: "legacy-engine-id" },
      ]),
    };
    const result = resolveBucket("legacy-engine-id", new Map(), indices, null);
    expect(result).toBe("repoA::ui-old");
  });

  it("returns null when the sessionId is unknown everywhere (drop is correct)", () => {
    const indices: Record<string, SessionIndex> = {
      repoA: idx([
        { id: "ui-1", title: "t", createdAt: 0, updatedAt: 0, engineSessionId: "eng-1" },
      ]),
    };
    const result = resolveBucket("eng-unknown", new Map(), indices, null);
    expect(result).toBeNull();
  });

  it("prefers the route table over a reverse lookup (no double work)", () => {
    const table = new Map([["eng-1", "repoA::ui-1"]]);
    const indices: Record<string, SessionIndex> = {
      // Stale/conflicting index entry that should NOT win over the live table.
      repoB: idx([
        { id: "ui-2", title: "t", createdAt: 0, updatedAt: 0, engineSessionId: "eng-1" },
      ]),
    };
    const result = resolveBucket("eng-1", table, indices, null);
    expect(result).toBe("repoA::ui-1");
  });
});

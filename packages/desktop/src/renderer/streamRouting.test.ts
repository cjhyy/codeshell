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
import { resolveBucket, findAskUserOrigin } from "./streamRouting";
import { bucketKey, NO_REPO_KEY, type SessionIndex } from "./transcripts";

const GLOBAL_KEY = "__global__";

describe("bucketKey", () => {
  it("composes repoId::sessionId for a real repo", () => {
    expect(bucketKey("repoA", "ui-1")).toBe("repoA::ui-1");
  });

  it("uses NO_REPO_KEY for a null repoId (byte-identical to legacy)", () => {
    expect(bucketKey(null, "ui-1")).toBe(`${NO_REPO_KEY}::ui-1`);
  });

  it("uses _none_ for a null sessionId", () => {
    expect(bucketKey("repoA", null)).toBe("repoA::_none_");
    expect(bucketKey(null, null)).toBe(`${NO_REPO_KEY}::_none_`);
  });
});

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
        {
          id: "ui-old",
          title: "t",
          createdAt: 0,
          updatedAt: 0,
          engineSessionId: "legacy-engine-id",
        },
      ]),
    };
    const result = resolveBucket("legacy-engine-id", new Map(), indices, null);
    expect(result).toBe("repoA::ui-old");
  });

  it("routes the first automatic turn of a Session that has no engineSessionId yet", () => {
    const indices: Record<string, SessionIndex> = {
      repoA: idx([{ id: "ui-planned", title: "UI design", createdAt: 0, updatedAt: 0 }]),
    };
    const result = resolveBucket("ui-planned", new Map(), indices, null);
    expect(result).toBe("repoA::ui-planned");
  });

  it("does not fall back to the UI id after a distinct engineSessionId is bound", () => {
    const indices: Record<string, SessionIndex> = {
      repoA: idx([
        {
          id: "ui-old",
          title: "legacy",
          createdAt: 0,
          updatedAt: 0,
          engineSessionId: "engine-authoritative",
        },
      ]),
    };
    expect(resolveBucket("ui-old", new Map(), indices, null)).toBeNull();
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

  it("does not route an unknown non-empty sessionId through the soft running-bucket hint", () => {
    const result = resolveBucket("eng-unknown", new Map(), {}, "repoA::ui-1");
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

describe("findAskUserOrigin", () => {
  const ask = (requestId: string, engineSessionId?: string) => ({
    kind: "ask_user",
    requestId,
    engineSessionId,
  });

  it("finds the prompt in a BACKGROUND bucket, not the active one", () => {
    const transcripts = {
      // active bucket has an unrelated message
      "repoA::ui-active": { messages: [{ kind: "text" }] },
      // the prompt lives in a different (background) bucket
      "repoB::ui-bg": { messages: [ask("req-1", "eng-bg")] },
    };
    const origin = findAskUserOrigin(transcripts, "req-1");
    expect(origin).toEqual({ bucket: "repoB::ui-bg", engineSessionId: "eng-bg" });
  });

  it("returns undefined when no prompt matches the requestId", () => {
    const transcripts = {
      "repoA::ui-1": { messages: [ask("req-1", "eng-1")] },
    };
    expect(findAskUserOrigin(transcripts, "req-missing")).toBeUndefined();
  });

  it("recovers a prompt with no stamped engineSessionId (legacy) — bucket only", () => {
    const transcripts = {
      "repoA::ui-1": { messages: [ask("req-1")] },
    };
    expect(findAskUserOrigin(transcripts, "req-1")).toEqual({
      bucket: "repoA::ui-1",
      engineSessionId: undefined,
    });
  });

  it("ignores non-ask_user messages sharing the requestId field", () => {
    const transcripts = {
      "repoA::ui-1": {
        messages: [{ kind: "tool", requestId: "req-1" }, ask("req-1", "eng-1")],
      },
    };
    expect(findAskUserOrigin(transcripts, "req-1")).toEqual({
      bucket: "repoA::ui-1",
      engineSessionId: "eng-1",
    });
  });
});

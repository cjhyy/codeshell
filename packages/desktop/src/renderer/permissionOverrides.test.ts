/**
 * Tests for the #11 PRIMARY fix (permission 档位 cross-session "粘连").
 *
 * Drafts have a null sessionId, so every draft in a repo shares the
 * `<repo>::_none_` override slot. Left unmanaged it made one draft's choice
 * carry onto the next 新对话 / other drafts. migrateBucketOverride (on first
 * send) and clearBucketOverride (on new draft) keep that slot honest. These
 * pure helpers are what App.tsx's send()/handleNewConversationForRepo call.
 */
import { describe, it, expect } from "bun:test";
import { bucketKey, migrateBucketOverride, clearBucketOverride } from "./transcripts";

type Mode = "default" | "bypassPermissions" | "acceptEdits";

describe("migrateBucketOverride (draft → real session on first send)", () => {
  it("moves the draft slot's value onto the real bucket and drops the draft slot", () => {
    const draft = bucketKey("repoA", null); // <repo>::_none_
    const real = bucketKey("repoA", "s1");
    const before: Record<string, Mode> = { [draft]: "bypassPermissions" };
    const after = migrateBucketOverride(before, draft, real);
    expect(after[real]).toBe("bypassPermissions"); // choice follows the session
    expect(draft in after).toBe(false); // shared slot cleared → no 粘连
  });

  it("no-ops (same reference) when the draft slot has no override", () => {
    const draft = bucketKey("repoA", null);
    const real = bucketKey("repoA", "s1");
    const before: Record<string, Mode> = {};
    const after = migrateBucketOverride(before, draft, real);
    expect(after).toBe(before); // unchanged reference → setState no-op
  });

  it("does not disturb OTHER sessions' overrides", () => {
    const draft = bucketKey("repoA", null);
    const real = bucketKey("repoA", "s2");
    const other = bucketKey("repoA", "s1");
    const before: Record<string, Mode> = { [other]: "acceptEdits", [draft]: "bypassPermissions" };
    const after = migrateBucketOverride(before, draft, real);
    expect(after[other]).toBe("acceptEdits"); // untouched
    expect(after[real]).toBe("bypassPermissions");
  });
});

describe("clearBucketOverride (新对话 resets the shared draft slot)", () => {
  it("drops the draft slot so a previous draft's choice doesn't carry over", () => {
    const draft = bucketKey("repoA", null);
    const before: Record<string, Mode> = { [draft]: "bypassPermissions" };
    const after = clearBucketOverride(before, draft);
    expect(draft in after).toBe(false);
  });

  it("no-ops (same reference) when the slot is empty", () => {
    const draft = bucketKey("repoA", null);
    const before: Record<string, Mode> = {};
    expect(clearBucketOverride(before, draft)).toBe(before);
  });
});

describe("the 粘连 repro, end to end on the override map", () => {
  it("a draft choice migrated onto session A does NOT leak into a fresh draft", () => {
    const draft = bucketKey("repoA", null);
    // 1. user picks bypass on a draft → stored under _none_
    let perms: Record<string, Mode> = { [draft]: "bypassPermissions" };
    // 2. first send solidifies into session sA → migrate off the shared slot
    const sA = bucketKey("repoA", "sA");
    perms = migrateBucketOverride(perms, draft, sA);
    expect(perms[sA]).toBe("bypassPermissions");
    expect(draft in perms).toBe(false);
    // 3. 新对话 → fresh draft must start clean (no inherited bypass)
    perms = clearBucketOverride(perms, draft);
    expect(perms[draft]).toBeUndefined(); // the new draft reads the default, not bypass
    // 4. session A still keeps its own choice
    expect(perms[sA]).toBe("bypassPermissions");
  });
});

import { describe, expect, test } from "bun:test";
import {
  markSessionUnread,
  clearUnreadSession,
  pruneUnreadSessions,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/src/hooks/remoteAppSync.ts";

describe("round18 ordinary unread set leaf helpers", () => {
  test("mark preserves identity for empty, current and already unread sessions", () => {
    const original = new Set(["background"]);
    expect(markSessionUnread(original, "", "active")).toBe(original);
    expect(markSessionUnread(original, "active", "active")).toBe(original);
    expect(markSessionUnread(original, "background", "active")).toBe(original);
    expect([...original]).toEqual(["background"]);
  });

  test("mark clones a background session and permits marking while a room is current", () => {
    const original = new Set(["old"]);
    const next = markSessionUnread(original, "background", "active");
    expect(next).not.toBe(original);
    expect([...next]).toEqual(["old", "background"]);
    expect([...original]).toEqual(["old"]);
    expect([...markSessionUnread(original, "active")]).toEqual(["old", "active"]);
  });

  test("clear preserves identity when no matching member exists", () => {
    const original = new Set(["background"]);
    expect(clearUnreadSession(original)).toBe(original);
    expect(clearUnreadSession(original, "")).toBe(original);
    expect(clearUnreadSession(original, "missing")).toBe(original);
    expect([...original]).toEqual(["background"]);
  });

  test("clear clones and removes only the selected member", () => {
    const original = new Set(["old", "selected", "background"]);
    const next = clearUnreadSession(original, "selected");
    expect(next).not.toBe(original);
    expect([...next]).toEqual(["old", "background"]);
    expect([...original]).toEqual(["old", "selected", "background"]);
    expect(clearUnreadSession(next, "selected")).toBe(next);
  });

  test("prune retains identity for arrays, sets and generators without stale members", () => {
    const original = new Set(["background"]);
    expect(pruneUnreadSessions(original, ["active", "background"])).toBe(original);
    expect(pruneUnreadSessions(original, new Set(["background", "active"]))).toBe(original);
    function* ids() { yield "active"; yield "background"; }
    expect(pruneUnreadSessions(original, ids())).toBe(original);
    expect([...original]).toEqual(["background"]);
  });

  test("prune consumes a generator once, preserves order and leaves the old set untouched", () => {
    const original = new Set(["stale", "background", "other"]);
    let yields = 0;
    function* ids() { yields += 1; yield "other"; yields += 1; yield "background"; }
    const next = pruneUnreadSessions(original, ids());
    expect(next).not.toBe(original);
    expect([...next]).toEqual(["background", "other"]);
    expect([...original]).toEqual(["stale", "background", "other"]);
    expect(yields).toBe(2);
  });

  test("empty known sessions clear members without mutating the old set", () => {
    const original = new Set(["background"]);
    const next = pruneUnreadSessions(original, []);
    expect(next).not.toBe(original);
    expect([...next]).toEqual([]);
    expect([...original]).toEqual(["background"]);
  });

  test("an empty unread set needs no new identity even for an empty inventory", () => {
    const original = new Set<string>();
    expect(pruneUnreadSessions(original, [])).toBe(original);
    expect(pruneUnreadSessions(original, ["active"])).toBe(original);
  });

  test("the statically mirrored list recipe can clear an unread id outside the browser binding", () => {
    // This mirrors only pure helper composition; it does not execute useRemoteApp.
    const browserBinding = "browser-active";
    const conversationRevision = 1;
    const listActive = "background";
    const initial = new Set<string>();
    const unread = markSessionUnread(initial, listActive, browserBinding);
    const pruned = pruneUnreadSessions(unread, [browserBinding, listActive]);
    const result = clearUnreadSession(pruned, listActive);
    const navigationAllowed = conversationRevision === 0 || listActive === browserBinding;
    expect([...unread]).toEqual([listActive]);
    expect(pruned).toBe(unread);
    expect([...result]).toEqual([]);
    expect([...unread]).toEqual([listActive]);
    expect(navigationAllowed).toBe(false);
    expect(clearUnreadSession(pruned, browserBinding)).toBe(pruned);
  });
});

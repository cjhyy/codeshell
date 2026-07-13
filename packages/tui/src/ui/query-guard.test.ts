import { describe, expect, it } from "bun:test";
import { QueryGuard } from "./query-guard.js";

describe("QueryGuard ownership fencing", () => {
  it("does not let an external terminal event release a client-owned run", () => {
    const guard = new QueryGuard();
    const token = guard.reserve();
    expect(token).not.toBeNull();
    expect(guard.tryStart(new AbortController(), token!)).toBe(true);

    expect(guard.endExternal()).toBe(false);
    expect(guard.getSnapshot()).toBe(true);

    guard.end(token!);
    expect(guard.getSnapshot()).toBe(false);
  });

  it("does not let a cancelled run's stale finally release a newer external run", () => {
    const guard = new QueryGuard();
    const oldToken = guard.reserve();
    expect(oldToken).not.toBeNull();
    expect(guard.tryStart(new AbortController(), oldToken!)).toBe(true);

    guard.forceEnd("cancel old run");
    expect(guard.startExternal()).not.toBeNull();
    expect(guard.getSnapshot()).toBe(true);

    guard.end(oldToken!);
    expect(guard.getSnapshot()).toBe(true);

    expect(guard.endExternal()).toBe(true);
    expect(guard.getSnapshot()).toBe(false);
  });

  it("hands off to an external turn synchronously at the local transport response", () => {
    const guard = new QueryGuard();
    const localToken = guard.reserve();
    expect(localToken).not.toBeNull();
    expect(guard.tryStart(new AbortController(), localToken!)).toBe(true);

    expect(guard.endLocalResponse(localToken!)).toBe(true);
    expect(guard.getSnapshot()).toBe(false);
    expect(guard.startExternal()).not.toBeNull();
    expect(guard.getSignal()).toBeNull();
    guard.end(localToken!);
    expect(guard.getSnapshot()).toBe(true);
    expect(guard.endExternal()).toBe(true);
    expect(guard.getSnapshot()).toBe(false);
  });

  it("does not let a local response release an existing external owner", () => {
    const guard = new QueryGuard();
    expect(guard.startExternal()).not.toBeNull();
    expect(guard.endLocalResponse(999)).toBe(false);
    expect(guard.getSnapshot()).toBe(true);

    expect(guard.endExternal()).toBe(true);
    expect(guard.getSnapshot()).toBe(false);
  });

  it("does not let an old Run response release a newer local owner", () => {
    const guard = new QueryGuard();
    const oldToken = guard.reserve()!;
    expect(guard.tryStart(new AbortController(), oldToken)).toBe(true);
    guard.forceEnd("cancel old run");

    const newToken = guard.reserve()!;
    expect(guard.tryStart(new AbortController(), newToken)).toBe(true);
    expect(guard.endLocalResponse(oldToken)).toBe(false);
    expect(guard.getSnapshot()).toBe(true);

    guard.end(newToken);
    expect(guard.getSnapshot()).toBe(false);
  });

  it("reports whether forceEnd cancelled a local or external owner", () => {
    const guard = new QueryGuard();
    const localToken = guard.reserve()!;
    expect(guard.tryStart(new AbortController(), localToken)).toBe(true);
    expect(guard.forceEnd("local")).toBe("local");

    expect(guard.startExternal()).not.toBeNull();
    expect(guard.forceEnd("external")).toBe("external");
    expect(guard.forceEnd("idle")).toBeNull();
  });
});

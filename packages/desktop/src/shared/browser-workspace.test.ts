import { describe, expect, test } from "bun:test";
import { BrowserWorkspaceRegistry, workspaceIdForBucket } from "./browser-workspace";
import { browserProfileIdForBucket } from "./browser-profile";

describe("workspace identity", () => {
  test("each Session gets its own workspace inside a shared profile", () => {
    // This is the shared-auth split: two Sessions in one project share LOGIN
    // (same profile) but must not fight over each other's PAGES.
    const a = "proj-1::s-aaa";
    const b = "proj-1::s-bbb";
    expect(workspaceIdForBucket(a)).not.toBe(workspaceIdForBucket(b));
    expect(browserProfileIdForBucket(a)).toBe(browserProfileIdForBucket(b));
  });

  test("the same bucket always maps to the same workspace", () => {
    expect(workspaceIdForBucket("proj-1::s-aaa")).toBe(workspaceIdForBucket("proj-1::s-aaa"));
  });
});

describe("BrowserWorkspaceRegistry", () => {
  test("binds a Session to a workspace and resolves it back", () => {
    const reg = new BrowserWorkspaceRegistry();
    reg.bind("s-aaa", "proj-1::s-aaa");
    const binding = reg.bindingFor("s-aaa");
    expect(binding?.workspaceId).toBe(workspaceIdForBucket("proj-1::s-aaa"));
    expect(binding?.profileId).toBe(browserProfileIdForBucket("proj-1::s-aaa"));
  });

  test("an unbound Session resolves to nothing rather than a guess", () => {
    // Guessing a workspace would silently point a Session at someone else's
    // pages; failing closed is the whole point of the binding layer.
    expect(new BrowserWorkspaceRegistry().bindingFor("never-bound")).toBeUndefined();
  });

  test("rebinding a Session moves it and leaves no stale entry", () => {
    const reg = new BrowserWorkspaceRegistry();
    reg.bind("s-aaa", "proj-1::s-aaa");
    reg.bind("s-aaa", "proj-2::s-aaa");
    expect(reg.bindingFor("s-aaa")?.workspaceId).toBe(workspaceIdForBucket("proj-2::s-aaa"));
    expect(reg.sessionsFor(workspaceIdForBucket("proj-1::s-aaa"))).toEqual([]);
  });

  test("tracks which Sessions share a workspace", () => {
    // Needed before shared-workspace is a real feature: the single-writer rule
    // has to know who the other candidates are.
    const reg = new BrowserWorkspaceRegistry();
    const ws = workspaceIdForBucket("proj-1::s-aaa");
    reg.bind("s-aaa", "proj-1::s-aaa");
    reg.bindTo("s-bbb", ws, browserProfileIdForBucket("proj-1::s-aaa"));
    expect(reg.sessionsFor(ws).sort()).toEqual(["s-aaa", "s-bbb"]);
  });

  test("unbinding removes the Session but keeps the workspace's other members", () => {
    const reg = new BrowserWorkspaceRegistry();
    const ws = workspaceIdForBucket("proj-1::s-aaa");
    reg.bind("s-aaa", "proj-1::s-aaa");
    reg.bindTo("s-bbb", ws, browserProfileIdForBucket("proj-1::s-aaa"));
    reg.unbind("s-aaa");
    expect(reg.bindingFor("s-aaa")).toBeUndefined();
    expect(reg.sessionsFor(ws)).toEqual(["s-bbb"]);
  });

  test("unbinding an unknown Session is a no-op, not an error", () => {
    const reg = new BrowserWorkspaceRegistry();
    expect(() => reg.unbind("never-bound")).not.toThrow();
  });

  test("an explicit profile is carried into the binding", () => {
    // Binding must record the profile actually in use, not re-derive the
    // project default, or an isolated Session would be reported as sharing.
    const reg = new BrowserWorkspaceRegistry();
    reg.bind("s-aaa", "proj-1::s-aaa", "second-account");
    expect(reg.bindingFor("s-aaa")?.profileId).toBe("u:second-account");
  });
});

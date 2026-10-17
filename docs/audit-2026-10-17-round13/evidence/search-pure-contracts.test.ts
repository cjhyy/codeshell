import { describe, expect, test } from "bun:test";
import { parseContentQuery, resolveContentMatch } from "../../../packages/desktop/src/renderer/shell/sessionContentSearch";
import { persistDefaultTextModel } from "../../../packages/desktop/src/renderer/modelSelection";

describe("round13 search and selection pure observations", () => {
  test("readiness counts trailing whitespace before Main's documented trimming", () => {
    const withTrailingSpace = parseContentQuery("> a ");
    expect(withTrailingSpace).toEqual({ contentMode: true, term: "a ", ready: true });
    expect(withTrailingSpace.term.trim()).toBe("a");
    expect(withTrailingSpace.term.trim().length).toBe(1);
    expect(parseContentQuery("> a").ready).toBe(false);
    expect(parseContentQuery("> ab ").ready).toBe(true);
    expect(parseContentQuery("> ab ").term.trim().length).toBe(2);
  });

  test("readiness has no upper bound, while the exact original term remains preserved", () => {
    const acceptedBoundary = "x".repeat(128);
    const overBoundary = "x".repeat(129);
    expect(parseContentQuery(`> ${acceptedBoundary}`)).toEqual({ contentMode: true, term: acceptedBoundary, ready: true });
    expect(parseContentQuery(`> ${overBoundary}`)).toEqual({ contentMode: true, term: overBoundary, ready: true });
    expect(parseContentQuery("ordinary title")).toEqual({ contentMode: false, term: "", ready: false });
  });

  test("ordinary resolution excludes archived entries and preserves immutable inputs", () => {
    const archived = Object.freeze({ id: "local-archived", engineSessionId: "engine-old", archived: true, title: "Archived", createdAt: 1, updatedAt: 2 });
    const visible = Object.freeze({ id: "local-visible", engineSessionId: "engine-visible", title: "Visible", createdAt: 1, updatedAt: 2 });
    const localOnly = Object.freeze({ id: "local-unbound", title: "Legacy", createdAt: 1, updatedAt: 2 });
    const projects = Object.freeze([{ id: "project-a" }]);
    const entries = Object.freeze([archived, visible, localOnly]);
    const sessions = Object.freeze({ "project-a": Object.freeze({ sessions: entries, activeSessionId: null }) });
    // readonly inputs are runtime contracts; the production signature is mutable.
    expect(resolveContentMatch({ sessionId: "engine-visible" }, projects as any, sessions as any)).toEqual({ projectId: "project-a", sessionId: "local-visible" });
    expect(resolveContentMatch({ sessionId: "local-unbound" }, projects as any, sessions as any)).toEqual({ projectId: "project-a", sessionId: "local-unbound" });
    expect(resolveContentMatch({ sessionId: "engine-old" }, projects as any, sessions as any)).toBeNull();
    expect(resolveContentMatch({ sessionId: "disk-only" }, projects as any, sessions as any)).toBeNull();
    expect(entries).toEqual([archived, visible, localOnly]);
  });

  test("pure settings callback updates only text while preserving ordinary defaults and input", async () => {
    const defaults = Object.freeze({ text: "old-text", image: "image-connection", audio: "audio-connection" });
    const settings = Object.freeze({ defaults, other: "unchanged" });
    const calls: unknown[] = [];
    await persistDefaultTextModel({ key: "new-text", getSettings: async (scope) => { calls.push(["read", scope]); return settings; }, writeSettings: async (scope, patch) => { calls.push(["write", scope, patch]); } });
    expect(calls).toEqual([["read", "user"], ["write", "user", { defaults: { text: "new-text", image: "image-connection", audio: "audio-connection" } }]]);
    expect(defaults.text).toBe("old-text");
    expect(settings.other).toBe("unchanged");
  });

  test("absent settings yield a text-only patch without real persistence", async () => {
    const calls: unknown[] = [];
    await persistDefaultTextModel({ key: "selected", getSettings: async () => null, writeSettings: async (scope, patch) => { calls.push([scope, patch]); } });
    expect(calls).toEqual([["user", { defaults: { text: "selected" } }]]);
  });
});

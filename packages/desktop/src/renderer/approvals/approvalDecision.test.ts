import { describe, expect, test } from "bun:test";
import { decisionFromChoice, approveOptionsFor, offeredApproveOptions } from "./approvalDecision";

describe("decisionFromChoice", () => {
  test("once is the legacy payload — no always, no scope", () => {
    expect(decisionFromChoice("once")).toEqual({ approved: true });
  });

  test("session carries always + scope", () => {
    expect(decisionFromChoice("session")).toEqual({
      approved: true,
      always: true,
      scope: "session",
    });
  });

  test("project carries always + scope", () => {
    expect(decisionFromChoice("project")).toEqual({
      approved: true,
      always: true,
      scope: "project",
    });
  });

  test("session + dir path scope rides along", () => {
    expect(decisionFromChoice("session", "dir")).toEqual({
      approved: true,
      always: true,
      scope: "session",
      pathScope: "dir",
    });
  });

  test('pathScope "tool" is omitted (it is the default)', () => {
    expect(decisionFromChoice("session", "tool")).toEqual({
      approved: true,
      always: true,
      scope: "session",
    });
  });

  test("pathScope on a once choice is ignored", () => {
    expect(decisionFromChoice("once", "file")).toEqual({ approved: true });
  });
});

describe("approveOptionsFor", () => {
  test("non-file tool → plain once/session/project, no path scopes", () => {
    const opts = approveOptionsFor("Bash", undefined);
    expect(opts.map((o) => o.scope)).toEqual(["once", "session", "project"]);
    expect(opts.every((o) => o.pathScope === undefined)).toBe(true);
  });

  test("file tool with no path falls back to plain three", () => {
    const opts = approveOptionsFor("Write", undefined);
    expect(opts).toHaveLength(3);
    expect(opts.every((o) => o.pathScope === undefined)).toBe(true);
  });

  test("Write with a path → once + (session,project)×(file,dir,tool)", () => {
    const opts = approveOptionsFor("Write", "/repo/src/foo.ts");
    expect(opts[0]!.scope).toBe("once");
    // 1 once + 3 session + 3 project = 7 rows
    expect(opts).toHaveLength(7);
    const session = opts.filter((o) => o.scope === "session");
    expect(session.map((o) => o.pathScope)).toEqual(["file", "dir", "tool"]);
    // labels reference the basename and dir.
    expect(session.find((o) => o.pathScope === "file")!.label).toContain("foo.ts");
    expect(session.find((o) => o.pathScope === "dir")!.label).toContain("src/");
  });

  test("Edit is path-scoped like Write", () => {
    expect(approveOptionsFor("Edit", "/a/b.ts")).toHaveLength(7);
  });
});

describe("offeredApproveOptions", () => {
  const all = approveOptionsFor("browser_act", undefined);
  const envelope = (source: "external-runtime" | undefined, extra: Record<string, unknown> = {}) =>
    ({ ...(source ? { source } : {}), request: { toolName: "browser_act", ...extra } }) as const;

  test("a native session keeps every scope", () => {
    expect(offeredApproveOptions(all, envelope(undefined), true)).toEqual(all);
  });

  test("an external session offers what it honors: once and this session", () => {
    expect(
      offeredApproveOptions(all, envelope("external-runtime"), true).map((o) => o.scope),
    ).toEqual(["once", "session"]);
    const write = approveOptionsFor("Write", "/repo/src/foo.ts");
    expect(
      offeredApproveOptions(write, envelope("external-runtime"), true).map(
        (o) => `${o.scope}:${o.pathScope ?? ""}`,
      ),
    ).toEqual(["once:", "session:file", "session:dir", "session:tool"]);
  });

  test("a request Main marks once-only, and a remote transport, offer only once", () => {
    expect(
      offeredApproveOptions(all, envelope("external-runtime", { onceOnly: true }), true).map(
        (o) => o.scope,
      ),
    ).toEqual(["once"]);
    // The mark is Main's; a native request cannot be narrowed by tool arguments.
    expect(offeredApproveOptions(all, envelope(undefined, { onceOnly: true }), true)).toEqual(all);
    expect(offeredApproveOptions(all, envelope(undefined), false).map((o) => o.scope)).toEqual([
      "once",
    ]);
  });
});

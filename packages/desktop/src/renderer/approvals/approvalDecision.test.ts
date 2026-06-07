import { describe, expect, test } from "bun:test";
import { decisionFromChoice, approveOptionsFor } from "./approvalDecision";

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

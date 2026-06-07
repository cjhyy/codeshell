import { describe, expect, test } from "bun:test";
import { decisionFromChoice, APPROVE_CHOICES } from "./approvalDecision";

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
});

describe("APPROVE_CHOICES", () => {
  test("lists the three scopes in order with once first", () => {
    expect(APPROVE_CHOICES.map((c) => c.choice)).toEqual(["once", "session", "project"]);
  });

  test("only the project choice advertises where the grant is persisted", () => {
    const hints = APPROVE_CHOICES.filter((c) => c.hint);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.choice).toBe("project");
    expect(hints[0]!.hint).toContain("settings.local.json");
  });
});

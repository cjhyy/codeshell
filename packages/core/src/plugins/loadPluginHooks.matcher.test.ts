import { describe, expect, test } from "bun:test";
import { matcherAccepts } from "./loadPluginHooks.js";
import type { HookContext } from "../hooks/events.js";

function ctx(data: Record<string, unknown>): HookContext {
  return { eventName: "notification", data };
}

describe("plugin hook matcher — notification kind filtering", () => {
  test("matches against ctx.data.kind", () => {
    expect(matcherAccepts("notification", "^approval_", ctx({ kind: "approval_requested" }))).toBe(
      true,
    );
    expect(matcherAccepts("notification", "^approval_", ctx({ kind: "agent_completed" }))).toBe(
      false,
    );
    expect(matcherAccepts("notification", "mcp_server_failed", ctx({ kind: "mcp_server_failed" })))
      .toBe(true);
  });

  test("the implied SubagentStop matcher accepts exactly the agent terminal kinds", () => {
    const implied = "^agent_(completed|failed|cancelled)$";
    for (const kind of ["agent_completed", "agent_failed", "agent_cancelled"]) {
      expect(matcherAccepts("notification", implied, ctx({ kind }))).toBe(true);
    }
    for (const kind of ["approval_requested", "mcp_server_connected", "agent_started"]) {
      expect(matcherAccepts("notification", implied, ctx({ kind }))).toBe(false);
    }
  });

  test("no matcher or no kind stays permissive", () => {
    expect(matcherAccepts("notification", undefined, ctx({ kind: "anything" }))).toBe(true);
    expect(matcherAccepts("notification", "^approval_", ctx({}))).toBe(true);
  });
});

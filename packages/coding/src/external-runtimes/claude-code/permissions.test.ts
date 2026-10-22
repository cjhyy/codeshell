import { describe, expect, test } from "bun:test";
import type { BridgeToolHost } from "../shared/mcp-bridge.js";
import {
  CLAUDE_PERMISSION_PROMPT_TOOL,
  claudeModeUsesPermissionPrompt,
  claudePermissionModeFor,
  withClaudePermissionPrompt,
  type ClaudePermissionPromptRequest,
} from "./permissions.js";

describe("claudePermissionModeFor (E08)", () => {
  test.each([
    { permissionMode: "default", planMode: false, expected: "default" },
    { permissionMode: undefined, planMode: false, expected: "default" },
    { permissionMode: "acceptEdits", planMode: false, expected: "acceptEdits" },
    { permissionMode: "dontAsk", planMode: false, expected: "dontAsk" },
    { permissionMode: "bypassPermissions", planMode: false, expected: "bypassPermissions" },
    // Plan wins, including over full access.
    { permissionMode: "default", planMode: true, expected: "plan" },
    { permissionMode: "acceptEdits", planMode: true, expected: "plan" },
    { permissionMode: "bypassPermissions", planMode: true, expected: "plan" },
    { permissionMode: "plan", planMode: false, expected: "plan" },
    // Claude's `auto` is classifier auto-approval: never an escalation target.
    { permissionMode: "auto", planMode: false, expected: "default" },
  ] as const)("$permissionMode (plan=$planMode) → $expected", (row) => {
    expect(
      claudePermissionModeFor({ permissionMode: row.permissionMode, planMode: row.planMode }),
    ).toBe(row.expected);
  });

  test("only modes that ask route asks to the host", () => {
    expect(claudeModeUsesPermissionPrompt("default")).toBe(true);
    expect(claudeModeUsesPermissionPrompt("acceptEdits")).toBe(true);
    expect(claudeModeUsesPermissionPrompt("plan")).toBe(false);
    expect(claudeModeUsesPermissionPrompt("dontAsk")).toBe(false);
    expect(claudeModeUsesPermissionPrompt("bypassPermissions")).toBe(false);
  });
});

describe("withClaudePermissionPrompt (E08)", () => {
  const executed: string[] = [];
  const inner: BridgeToolHost = {
    businessSessionId: "sess-perm",
    listTools: () => [{ name: "Panel", description: "panel", inputSchema: {} }],
    execute: async (call) => {
      executed.push(call.name);
      return { result: "inner" };
    },
  };

  function wrap(
    decide: (
      request: ClaudePermissionPromptRequest,
    ) => Promise<{ approved: boolean; reason?: string }>,
  ) {
    return withClaudePermissionPrompt(inner, decide, "codeshell_tools");
  }

  async function ask(host: BridgeToolHost, input: unknown) {
    const outcome = await host.execute({ id: "c1", name: CLAUDE_PERMISSION_PROMPT_TOOL, input });
    expect(outcome.isError).toBeUndefined();
    return JSON.parse(String(outcome.result)) as Record<string, unknown>;
  }

  test("lists the prompt tool beside the host's own tools and routes the rest", async () => {
    const host = wrap(async () => ({ approved: false }));
    expect(host.listTools().map((tool) => tool.name)).toEqual([
      "Panel",
      CLAUDE_PERMISSION_PROMPT_TOOL,
    ]);
    expect(await host.execute({ id: "c0", name: "Panel", input: {} })).toEqual({ result: "inner" });
    expect(executed).toEqual(["Panel"]);
  });

  test("asks the host for a native tool and returns Claude's allow shape", async () => {
    const seen: ClaudePermissionPromptRequest[] = [];
    const host = wrap(async (request) => {
      seen.push(request);
      return { approved: true };
    });
    const input = { command: "git status" };
    expect(await ask(host, { tool_name: "Bash", input, tool_use_id: "toolu_1" })).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
    expect(seen).toEqual([{ toolName: "Bash", input, toolUseId: "toolu_1" }]);
  });

  test("a denial carries the user's reason", async () => {
    const host = wrap(async () => ({ approved: false, reason: "not now" }));
    expect(await ask(host, { tool_name: "Write", input: { file_path: "/x" } })).toEqual({
      behavior: "deny",
      message: "not now",
    });
  });

  test("fails closed when the approval backend throws", async () => {
    const host = wrap(async () => {
      throw new Error("renderer gone");
    });
    expect((await ask(host, { tool_name: "Bash", input: {} })).behavior).toBe("deny");
  });

  test("never asks for its own server's tools, itself, ExitPlanMode or malformed input", async () => {
    let asked = 0;
    const host = wrap(async () => {
      asked += 1;
      return { approved: true };
    });
    // ToolExecutor authorizes host tools; a second approval would double-ask.
    expect(await ask(host, { tool_name: "mcp__codeshell_tools__Panel", input: { a: 1 } })).toEqual({
      behavior: "allow",
      updatedInput: { a: 1 },
    });
    for (const toolName of [
      `mcp__codeshell_tools__${CLAUDE_PERMISSION_PROMPT_TOOL}`,
      CLAUDE_PERMISSION_PROMPT_TOOL,
      "ExitPlanMode",
    ]) {
      expect((await ask(host, { tool_name: toolName, input: {} })).behavior).toBe("deny");
    }
    expect((await ask(host, { tool_name: "Bash" })).behavior).toBe("deny");
    expect((await ask(host, null)).behavior).toBe("deny");
    expect(asked).toBe(0);
  });

  test("an aborted request is denied even if the user later approves", async () => {
    const controller = new AbortController();
    const host = wrap(async () => {
      controller.abort();
      return { approved: true };
    });
    const outcome = await host.execute(
      { id: "c2", name: CLAUDE_PERMISSION_PROMPT_TOOL, input: { tool_name: "Bash", input: {} } },
      controller.signal,
    );
    expect(JSON.parse(String(outcome.result)).behavior).toBe("deny");
  });
});

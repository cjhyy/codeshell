/**
 * External runtime exposure review, part two.
 *
 * `external-runtime-exposure-review.test.ts` pins which CodeShell tools cross
 * the bridge. Until Computer Use was opened to external sessions the bridge was
 * also their ONLY tool channel. The invariant is now:
 *
 *   An external session's tool channels are the bridge, plus at most the one
 *   Host-declared Computer Use server — the same gated proxy a native Session
 *   uses, pinned to that Session, never pre-approved, and absent from every
 *   capability-restricted session.
 *
 * These tests are that invariant's review. Widening any "not offered" case, or
 * declaring anything other than the gated proxy, must change a test here.
 */
import { describe, expect, test } from "bun:test";
import { CuaDriverHost } from "./computer-use/cua-driver-host.js";
import {
  EXTERNAL_COMPUTER_USE_INSTRUCTIONS,
  EXTERNAL_COMPUTER_USE_SERVER_NAME,
  claudeNativeApprovalRequest,
  presentCodexHostMcpApproval,
  externalComputerUse,
  externalComputerUseFor,
  type ExternalComputerUseInputs,
} from "./external-runtime-computer-use.js";

const PROXY = {
  command: "/app/electron",
  entryPath: "/app/out/cua-activity-proxy.cjs",
  socketPath: "/tmp/cs-act/activity.sock",
  token: "ACTIVITY-SECRET",
  appProfilesDir: "/app/resources/computer-use/apps",
};

function host(state: string, proxy: typeof PROXY | null = PROXY) {
  const real = new CuaDriverHost({
    driverPath: "/app/CodeShell Computer Use.app/Contents/Resources/cua-driver",
    helperPath: "/app/CodeShell Computer Use.app/Contents/MacOS/codeshell-computer-use",
    socketPath: "/tmp/cs-cua/driver.sock",
    ...(proxy ? { mcpProxy: proxy } : {}),
  });
  return {
    status: () => ({ ...real.status(), state: state as never }),
    mcpDeclaration: () => real.mcpDeclaration(),
  };
}

const ON = { computer_use_cua: true, external_host_tools: true };

function inputs(overrides: Partial<ExternalComputerUseInputs> = {}): ExternalComputerUseInputs {
  return {
    sessionId: "s-ext-1",
    flags: ON,
    hostToolsEnabled: true,
    restricted: false,
    planMode: false,
    permissionMode: "default",
    canPrompt: true,
    host: host("running"),
    ...overrides,
  };
}

describe("Computer Use for external runtime sessions", () => {
  test("the server name forms a valid mcp__<server>__<tool> prefix in one constant", () => {
    // `host:cua-driver` (the native name) is not usable: Claude Code accepts
    // only [a-z0-9_] in the server part of a tool name.
    expect(EXTERNAL_COMPUTER_USE_SERVER_NAME).toBe("codeshell_computer");
    expect(`mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__click`).toMatch(
      /^mcp__[a-z0-9_]+__[A-Za-z0-9_]+$/,
    );
    expect(EXTERNAL_COMPUTER_USE_INSTRUCTIONS).toContain("mcp__codeshell_computer__*");
  });

  test("an ordinary session gets the Host's own gated proxy, pinned to that Session", () => {
    const decision = externalComputerUseFor(inputs());
    if (!decision.offered) throw new Error(`not offered: ${decision.reason}`);
    const native = host("running").mcpDeclaration();
    expect(decision.servers).toHaveLength(1);
    const [server] = decision.servers;
    // Same process, same driver socket, same activity channel as a native Session.
    expect(server!.name).toBe("codeshell_computer");
    expect(server!.command).toBe(native.command);
    expect(server!.args).toEqual(native.args);
    expect(server!.args[0]).toBe(PROXY.entryPath);
    expect(server!.env).toEqual({
      CUA_DRIVER_EMBEDDED: "1",
      ELECTRON_RUN_AS_NODE: "1",
      CODE_SHELL_CUA_ACTIVITY_SOCKET: PROXY.socketPath,
      CODE_SHELL_CUA_APP_PROFILES: PROXY.appProfilesDir,
      // The one addition: the identity a native worker sends as `_meta`.
      CODE_SHELL_CUA_SESSION_ID: "s-ext-1",
    });
    // The activity token is a secret: separate, so it never lands in argv.
    expect(server!.secretEnv).toEqual({ CODE_SHELL_CUA_ACTIVITY_TOKEN: "ACTIVITY-SECRET" });
    expect(JSON.stringify([server!.args, server!.env])).not.toContain("ACTIVITY-SECRET");
  });

  test("each session is pinned to its own id", () => {
    const a = externalComputerUseFor(inputs({ sessionId: "s-a" }));
    const b = externalComputerUseFor(inputs({ sessionId: "s-b" }));
    if (!a.offered || !b.offered) throw new Error("not offered");
    expect(a.servers[0]!.env.CODE_SHELL_CUA_SESSION_ID).toBe("s-a");
    expect(b.servers[0]!.env.CODE_SHELL_CUA_SESSION_ID).toBe("s-b");
  });

  test("full access is offered without a prompt path, as bypassPermissions is natively", () => {
    expect(
      externalComputerUseFor(inputs({ permissionMode: "bypassPermissions", canPrompt: false }))
        .offered,
    ).toBe(true);
    expect(externalComputerUseFor(inputs({ permissionMode: "acceptEdits" })).offered).toBe(true);
  });

  test.each([
    ["the setting is off", { flags: { external_host_tools: true } }, "setting_off"],
    ["the driver is not running", { host: host("starting") }, "driver_not_running"],
    ["the driver failed", { host: host("failed") }, "driver_not_running"],
    ["the driver was stopped", { host: host("stopped") }, "driver_not_running"],
    ["there is no gated proxy", { host: host("running", null) }, "gate_unavailable"],
    ["Host tools are off", { hostToolsEnabled: false }, "host_tools_off"],
    ["a tool profile restricts the session", { restricted: true }, "restricted_profile"],
    ["the session is in plan mode", { planMode: true }, "plan_mode"],
    ["the permission mode is plan", { permissionMode: "plan" }, "plan_mode"],
    ["the mode never asks (dontAsk)", { permissionMode: "dontAsk" }, "no_approval_path"],
    ["nobody can be asked", { canPrompt: false }, "no_approval_path"],
    ["the session id cannot be pinned", { sessionId: "bad id" }, "invalid_session"],
  ] as Array<[string, Partial<ExternalComputerUseInputs>, string]>)(
    "not offered when %s",
    (_label, overrides, reason) => {
      expect(externalComputerUseFor(inputs(overrides))).toEqual({ offered: false, reason });
    },
  );

  test("the bare driver (no input gate) is never declared, even if it is running", () => {
    const bare = host("running", null);
    expect(bare.mcpDeclaration().args).toContain("mcp");
    expect(externalComputerUseFor(inputs({ host: bare })).offered).toBe(false);
  });

  test("a start request maps onto the decision: profile, plan mode and flags all gate it", () => {
    const running = host("running");
    const request = { sessionId: "s-ext-1", permissionMode: "default" as const };
    expect(externalComputerUse(request, ON, true, running)?.servers[0]?.name).toBe(
      "codeshell_computer",
    );
    // Mimi-hosted, read-only and manager sessions all carry a toolProfile.
    expect(externalComputerUse({ ...request, toolProfile: {} }, ON, true, running)).toBeUndefined();
    expect(externalComputerUse({ ...request, planMode: true }, ON, true, running)).toBeUndefined();
    expect(
      externalComputerUse(request, { ...ON, external_host_tools: false }, true, running),
    ).toBeUndefined();
    expect(
      externalComputerUse(request, { ...ON, computer_use_cua: false }, true, running),
    ).toBeUndefined();
    expect(externalComputerUse(request, ON, false, running)).toBeUndefined();
    // No process-wide host registered (tests, non-macOS, flag off at startup).
    expect(externalComputerUse(request, ON, true)).toBeUndefined();
  });

  test("the guidance separates the built-in browser from the rest of the desktop", () => {
    const text = EXTERNAL_COMPUTER_USE_INSTRUCTIONS;
    for (const phrase of [
      "browser_navigate",
      "built-in browser",
      "their own browser",
      "computer_input_refused",
      "set_value",
    ])
      expect(text).toContain(phrase);
  });
});

describe("the approval card of a computer-use call", () => {
  test("Claude Code: names the action and its target, not a native tool", () => {
    const input = { pid: 412, window_id: 7, element_index: 3 };
    const request = claudeNativeApprovalRequest({
      toolName: `mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__click`,
      input,
    });
    expect(request).toEqual({
      toolName: "Computer use: click",
      description: "Claude Code 想操控电脑：click（pid 412, window 7）",
      args: input,
      riskLevel: "high",
      computerUse: { runtime: "claude-code", action: "click", pid: 412, windowId: 7 },
    });
    expect(JSON.stringify(request)).not.toContain("native");
    // The window may also be given as `target`; an app name outranks a pid.
    expect(
      claudeNativeApprovalRequest({
        toolName: `mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__type_text`,
        input: { target: { pid: 9, window_id: 2 }, text: "hello" },
      }).computerUse,
    ).toEqual({ runtime: "claude-code", action: "type_text", pid: 9, windowId: 2 });
    expect(
      claudeNativeApprovalRequest({
        toolName: `mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__launch_app`,
        input: { bundle_id: "com.apple.Notes" },
      }),
    ).toMatchObject({
      description: "Claude Code 想操控电脑：launch_app（com.apple.Notes）",
      computerUse: { action: "launch_app", app: "com.apple.Notes" },
    });
  });

  test("Claude Code's own tools and other MCP servers keep the native-tool card", () => {
    for (const toolName of ["Bash", "mcp__other__click", "mcp__codeshell_computer_evil__click"]) {
      const request = claudeNativeApprovalRequest({ toolName, input: { command: "ls" } });
      expect(request).toEqual({
        toolName: `Claude Code ${toolName}`,
        args: { command: "ls" },
        description: `Claude Code wants to use its native ${toolName} tool.`,
        riskLevel: "high",
      });
    }
  });

  test("Codex: its bare MCP tool ask is re-presented; everything else passes through", () => {
    const asked = {
      sessionId: "s-1",
      toolName: `mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__press_key`,
      args: {},
      description: "Allow the codeshell_computer MCP server to run tool press_key?",
      riskLevel: "high" as const,
    };
    expect(presentCodexHostMcpApproval(asked)).toEqual({
      sessionId: "s-1",
      toolName: "Computer use: press_key",
      description: "Codex 想操控电脑：press_key",
      args: {},
      riskLevel: "high",
      computerUse: { runtime: "codex", action: "press_key" },
    });
    const governed = {
      toolName: "Bash",
      args: { command: "ls" },
      description: "Run",
      riskLevel: "low",
    };
    expect(presentCodexHostMcpApproval(governed)).toBe(governed);
  });
});

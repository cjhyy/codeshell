/**
 * Phase 1 acceptance: "a fake MCP caller can invoke a Host Tool, and the
 * behavior matches a Native Engine call."
 *
 * The fake caller speaks the shape a real Codex MCP `tools/call` arrives in —
 * verified against codex-cli 0.145.0, see docs/todo/evidence/:
 *
 *   { name, arguments, _meta: { threadId, "x-codex-turn-metadata": { thread_id, turn_id, … } } }
 *
 * Two things are being proven here, and they are different:
 *
 *  1. A tool reached over MCP produces the same result as the same tool invoked
 *     directly through ToolExecutor — no second policy path, no divergence.
 *  2. Thread identity comes from `_meta`, which the HOST binds to a
 *     SessionToolHost out of band. Tool *arguments* are untrusted: a model that
 *     puts a different session id in `arguments` must not reach another
 *     session's host. (§22.4 — "从 tool args 读取 session ID" is a rejected
 *     alternative precisely because the model can forge it.)
 */
import { describe, expect, test } from "bun:test";
import { createSessionToolHost, type SessionToolHost } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import { buildToolVisibility } from "../engine/run-tooling.js";
import type { BuiltinTool } from "./builtin/index.js";
import type { ToolContext } from "./context.js";

function catalog(record: string[]): BuiltinTool[] {
  return [
    {
      definition: {
        name: "WhereAmI",
        description: "Report the session and cwd the tool ran in.",
        inputSchema: {
          type: "object",
          properties: { note: { type: "string" } },
        },
        source: "builtin",
        permissionDefault: "allow",
        isReadOnly: true,
        isConcurrencySafe: true,
      },
      execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
        record.push(`${ctx?.sessionId}:${String(args.note ?? "-")}`);
        return `session=${ctx?.sessionId} note=${String(args.note ?? "-")}`;
      },
      exposure: {
        presetTags: ["general"],
        defaultPermissionRules: [{ tool: "WhereAmI", decision: "allow" }],
      },
    },
  ] as unknown as BuiltinTool[];
}

/**
 * One rule set, used by BOTH the host and the native comparator below.
 *
 * Earlier this test hand-fed the native side `[{tool:"WhereAmI",decision:"allow"}]`
 * while giving the host an auto-approving backend — both returned the same string
 * for DIFFERENT reasons, which masked the real divergence (the host was dropping
 * per-tool rules entirely). Sharing the rules is what makes the comparison mean
 * something.
 */
const SHARED_RULES = [{ tool: "WhereAmI", decision: "allow" as const }];

function makeHost(sessionId: string, record: string[]): SessionToolHost {
  return createSessionToolHost({
    businessSessionId: sessionId,
    cwd: process.cwd(),
    registry: new ToolRegistry({ toolCatalog: catalog(record) }),
    permissionMode: "default",
    permissionRules: SHARED_RULES,
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set(["WhereAmI"]) },
    visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
    // Deliberately DENY-everything: if the shared allow-rule is honored the call
    // never reaches this backend. If the rules were dropped, the mode default
    // would ask, hit this, and fail — which is exactly the divergence to catch.
    approvalBackend: {
      requestApproval: async () => ({ approved: false, reason: "backend must not be consulted" }),
    },
  });
}

/** A Codex-shaped `tools/call` params object. */
interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: {
    threadId?: string;
    "x-codex-turn-metadata"?: { thread_id?: string; turn_id?: string };
  };
}

/**
 * Minimal stand-in for the loopback MCP bridge: routes a `tools/call` to a
 * SessionToolHost using ONLY `_meta`, and fails closed exactly where §11.3 says
 * it must.
 */
function makeBridge(hosts: Map<string, SessionToolHost>) {
  return async (call: McpToolCall): Promise<{ ok: boolean; text: string }> => {
    const threadId =
      call._meta?.threadId ?? call._meta?.["x-codex-turn-metadata"]?.thread_id ?? undefined;
    // fail closed: no thread id, or a thread nobody registered
    if (!threadId) return { ok: false, text: "missing thread id" };
    const host = hosts.get(threadId);
    if (!host) return { ok: false, text: `unregistered thread ${threadId}` };

    const result = await host.execute({
      id: call._meta?.["x-codex-turn-metadata"]?.turn_id ?? "call-1",
      name: call.name,
      input: call.arguments,
    });
    return { ok: !result.isError, text: String(result.result ?? result.error ?? "") };
  };
}

describe("SessionToolHost via a fake MCP caller", () => {
  test("an MCP call matches a direct ToolExecutor call", async () => {
    // --- via SessionToolHost / MCP ---
    const mcpRecord: string[] = [];
    const host = makeHost("sess-mcp", mcpRecord);
    const hosts = new Map([["thread-A", host]]);
    const bridge = makeBridge(hosts);
    const viaMcp = await bridge({
      name: "WhereAmI",
      arguments: { note: "hello" },
      _meta: {
        threadId: "thread-A",
        "x-codex-turn-metadata": { thread_id: "thread-A", turn_id: "turn-1" },
      },
    });

    // --- the same tool, straight through ToolExecutor (the Native Engine path) ---
    const nativeRecord: string[] = [];
    const registry = new ToolRegistry({ toolCatalog: catalog(nativeRecord) });
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([...SHARED_RULES], "default"),
      new HookRegistry(),
    );
    executor.setContext({
      cwd: process.cwd(),
      sessionId: "sess-mcp",
      toolRegistry: registry,
      planMode: false,
      toolVisibility: buildToolVisibility({ cwd: process.cwd(), hasGoal: false, host: "desktop" }),
    } as unknown as ToolContext);
    const viaNative = await executor.executeSingle({
      id: "turn-1",
      toolName: "WhereAmI",
      args: { note: "hello" },
    });

    expect(viaMcp.ok).toBe(true);
    expect(viaNative.isError).toBeFalsy();
    // Identical model-facing result, and the tool observed the same session.
    expect(viaMcp.text).toBe(String(viaNative.result));
    expect(mcpRecord).toEqual(nativeRecord);
  });

  test("routes by _meta, so two threads never cross", async () => {
    const recA: string[] = [];
    const recB: string[] = [];
    const hosts = new Map([
      ["thread-A", makeHost("sess-A", recA)],
      ["thread-B", makeHost("sess-B", recB)],
    ]);
    const bridge = makeBridge(hosts);

    await bridge({
      name: "WhereAmI",
      arguments: { note: "from-A" },
      _meta: { threadId: "thread-A" },
    });
    await bridge({
      name: "WhereAmI",
      arguments: { note: "from-B" },
      _meta: { threadId: "thread-B" },
    });

    expect(recA).toEqual(["sess-A:from-A"]);
    expect(recB).toEqual(["sess-B:from-B"]);
  });

  test("a session id in tool ARGUMENTS cannot redirect the call", async () => {
    // §22.4: identity must come from the closure / trusted metadata, never from
    // model-supplied args. Verified against real Codex behavior — the model can
    // set arguments freely but cannot touch `_meta` (docs/todo/evidence/).
    const recA: string[] = [];
    const recB: string[] = [];
    const hosts = new Map([
      ["thread-A", makeHost("sess-A", recA)],
      ["thread-B", makeHost("sess-B", recB)],
    ]);
    const bridge = makeBridge(hosts);

    const result = await bridge({
      name: "WhereAmI",
      // The model tries to reach session B from thread A.
      arguments: { note: "spoof", sessionId: "sess-B", threadId: "thread-B" },
      _meta: { threadId: "thread-A" },
    });

    expect(result.ok).toBe(true);
    // It landed in A regardless of what the arguments claimed.
    expect(recA).toEqual(["sess-A:spoof"]);
    expect(recB).toEqual([]);
  });

  test("fails closed on missing and on unknown thread ids", async () => {
    const rec: string[] = [];
    const hosts = new Map([["thread-A", makeHost("sess-A", rec)]]);
    const bridge = makeBridge(hosts);

    const noThread = await bridge({ name: "WhereAmI", arguments: {} });
    expect(noThread.ok).toBe(false);
    expect(noThread.text).toMatch(/missing thread/i);

    const unknown = await bridge({
      name: "WhereAmI",
      arguments: {},
      _meta: { threadId: "thread-ZZZ" },
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toMatch(/unregistered/i);

    // Neither reached a tool.
    expect(rec).toEqual([]);
  });

  test("a closed session's thread stops answering", async () => {
    const rec: string[] = [];
    const host = makeHost("sess-A", rec);
    const hosts = new Map([["thread-A", host]]);
    const bridge = makeBridge(hosts);

    await host.dispose();
    const after = await bridge({
      name: "WhereAmI",
      arguments: { note: "late" },
      _meta: { threadId: "thread-A" },
    });
    expect(after.ok).toBe(false);
    expect(rec).toEqual([]);
  });
});

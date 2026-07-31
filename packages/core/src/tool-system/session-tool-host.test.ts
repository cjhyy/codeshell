/**
 * SessionToolHost — the session-scoped surface that exposes a filtered set of
 * CodeShell tools to an external Agent Runtime (Codex / Claude Code) over MCP.
 *
 * Its whole reason to exist is that `ToolRegistry` is NOT a security boundary.
 * Every call must land in `ToolExecutor.executeSingle()` so visibility,
 * plan mode, path policy, permission, sandbox and hooks all still apply.
 * These tests pin that, plus the two invariants the design calls out as
 * easy to get wrong:
 *
 *  - a tool the caller can NAME but that is not exposed must fail closed
 *    (`listTools()` is not merely a hint to the model);
 *  - the CodeShell-side permission mode must never be `bypassPermissions`
 *    or `dontAsk`, because those short-circuit the classifier entirely and
 *    would make "everything goes through ToolExecutor" vacuously true.
 */
import { describe, expect, test } from "bun:test";
import { createSessionToolHost } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import type { BuiltinTool } from "./builtin/index.js";
import type { ToolContext } from "./context.js";

/** Two trivial tools: one read-only, one that "writes". */
function catalog(record: string[]): BuiltinTool[] {
  return [
    {
      definition: {
        name: "EchoRead",
        description: "Echo back a value. Read-only.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        source: "builtin",
        permissionDefault: "allow",
        isReadOnly: true,
        isConcurrencySafe: true,
      },
      execute: async (args: Record<string, unknown>) => {
        record.push(`EchoRead:${String(args.value)}`);
        return `echo:${String(args.value)}`;
      },
      exposure: {
        presetTags: ["general"],
        defaultPermissionRules: [{ tool: "EchoRead", decision: "allow" }],
      },
    },
    {
      definition: {
        name: "PretendWrite",
        description: "Pretend to write something.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        source: "builtin",
        permissionDefault: "ask",
        isReadOnly: false,
        isConcurrencySafe: false,
      },
      execute: async (args: Record<string, unknown>) => {
        record.push(`PretendWrite:${String(args.path)}`);
        return "written";
      },
      exposure: {
        presetTags: ["general"],
        defaultPermissionRules: [{ tool: "PretendWrite", decision: "ask" }],
      },
    },
    {
      definition: {
        name: "SecretTool",
        description: "Never exposed to external runtimes.",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
        isReadOnly: true,
        isConcurrencySafe: true,
      },
      execute: async () => {
        record.push("SecretTool");
        return "secret";
      },
      exposure: {
        presetTags: ["general"],
        defaultPermissionRules: [{ tool: "SecretTool", decision: "allow" }],
      },
    },
  ] as unknown as BuiltinTool[];
}

function makeHost(
  opts: {
    expose?: string[];
    argsPatterns?: Map<string, Record<string, string>>;
    permissionMode?: "default" | "acceptEdits" | "auto" | "plan";
    planMode?: boolean;
    signal?: AbortSignal;
    approve?: boolean;
  } = {},
) {
  const record: string[] = [];
  const registry = new ToolRegistry({ toolCatalog: catalog(record) });
  const host = createSessionToolHost({
    businessSessionId: "sess-1",
    cwd: process.cwd(),
    registry,
    permissionMode: opts.permissionMode ?? "default",
    planMode: opts.planMode ?? false,
    exposure: {
      mode: "allowlist",
      toolNames: new Set(opts.expose ?? ["EchoRead", "PretendWrite"]),
      ...(opts.argsPatterns ? { argsPatterns: opts.argsPatterns } : {}),
    },
    visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
    approvalBackend: {
      requestApproval: async () => ({ approved: opts.approve ?? true }),
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { host, record, registry };
}

describe("SessionToolHost", () => {
  test("lists only the allowlisted tools", () => {
    const { host } = makeHost();
    const names = host.listTools().map((t) => t.name);
    expect(names.sort()).toEqual(["EchoRead", "PretendWrite"]);
    expect(names).not.toContain("SecretTool");
  });

  test("executes an exposed tool through the real pipeline", async () => {
    const { host, record } = makeHost();
    const result = await host.execute({ id: "c1", name: "EchoRead", input: { value: "hi" } });
    expect(result.isError).toBeFalsy();
    expect(result.result).toContain("echo:hi");
    expect(record).toEqual(["EchoRead:hi"]);
  });

  test("knowing a hidden tool's name is not enough to run it", async () => {
    // listTools() is a security boundary, not a hint. The registry still HOLDS
    // SecretTool, so without a gate a caller that names it would run it.
    const { host, record } = makeHost();
    const result = await host.execute({ id: "c2", name: "SecretTool", input: {} });
    expect(result.isError).toBe(true);
    expect(String(result.error)).toMatch(/not exposed|not available|not allowed/i);
    expect(record).toEqual([]);
  });

  test("BOTH exposure layers block a hidden tool independently", async () => {
    // Two layers guard this: the host's own `exposure.toolNames` check, and
    // `toolCtx.allowedToolNames` which ToolExecutor enforces. They are
    // deliberately redundant — but redundancy means neither is pinned by the
    // test above (removing either one alone still passes). Assert each in
    // isolation so a refactor that drops one is caught while the other still
    // masks the failure.
    const record: string[] = [];
    const registry = new ToolRegistry({ toolCatalog: catalog(record) });
    const base = {
      businessSessionId: "sess-layers",
      cwd: process.cwd(),
      registry,
      permissionMode: "default" as const,
      planMode: false,
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
    };

    // Layer 2 alone: the host's own allowlist deliberately PERMITS SecretTool
    // here, so the call reaches ToolExecutor and only `allowedToolNames` can
    // stop it. Without this, layer 2 is untestable — the host gate would reject
    // first and mask whether the executor gate exists at all.
    const executorOnly = createSessionToolHost({
      ...base,
      exposure: { mode: "allowlist", toolNames: new Set(["EchoRead", "SecretTool"]) },
      contextOverrides: { allowedToolNames: new Set(["EchoRead"]) } as never,
    });
    const viaExecutor = await executorOnly.execute({ id: "l2", name: "SecretTool", input: {} });
    expect(viaExecutor.isError).toBe(true);
    expect(String(viaExecutor.error)).toMatch(/not allowed by this run profile/i);
    expect(record).toEqual([]);

    // Layer 1 alone: the host's exposure check rejects before ToolExecutor is
    // even reached, so it must not depend on allowedToolNames being set.
    const hostOnly = createSessionToolHost({
      ...base,
      exposure: { mode: "allowlist", toolNames: new Set(["EchoRead"]) },
      contextOverrides: { allowedToolNames: undefined } as never,
    });
    const viaHost = await hostOnly.execute({ id: "l1", name: "SecretTool", input: {} });
    expect(viaHost.isError).toBe(true);
    expect(String(viaHost.error)).toMatch(/not exposed/i);
    expect(record).toEqual([]);
  });

  test("the executor-side belt is populated from the exposure allowlist by default", () => {
    // The two checks above can each be satisfied by the OTHER layer, so neither
    // pins the default wiring. Assert the wiring itself: a host built with no
    // contextOverrides must still hand ToolExecutor an allowedToolNames set
    // derived from the exposure allowlist. Without this, dropping that line is
    // invisible until some future refactor also removes the host-side gate.
    const record: string[] = [];
    const registry = new ToolRegistry({ toolCatalog: catalog(record) });
    const host = createSessionToolHost({
      businessSessionId: "sess-belt",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(["EchoRead"]) },
      visibility: { cwd: process.cwd(), hasGoal: false },
    });
    const ctx: ToolContext = host.toolContext;
    expect([...(ctx.allowedToolNames ?? [])]).toEqual(["EchoRead"]);
    // And the visibility the executor's guard reads is populated, not undefined —
    // an absent toolVisibility makes ToolExecutor SKIP its guard entirely.
    expect(ctx.toolVisibility).toBeDefined();
    expect(ctx.sessionId).toBe("sess-belt");
  });

  test("an unknown tool name fails closed rather than throwing", async () => {
    const { host } = makeHost();
    const result = await host.execute({ id: "c3", name: "NoSuchTool", input: {} });
    expect(result.isError).toBe(true);
    expect(record0(result)).toBe(true);
  });

  test("rejects bypassPermissions and dontAsk at construction", () => {
    // The whole "ToolExecutor is the single authorization point" claim is
    // vacuous if the classifier is short-circuited. Fail loudly rather than
    // silently downgrading — a silent downgrade turns a security decision into
    // an invisible behavior difference.
    for (const mode of ["bypassPermissions", "dontAsk"] as const) {
      expect(() =>
        createSessionToolHost({
          businessSessionId: "sess-x",
          cwd: process.cwd(),
          registry: new ToolRegistry({ toolCatalog: catalog([]) }),
          permissionMode: mode as never,
          planMode: false,
          exposure: { mode: "allowlist", toolNames: new Set(["EchoRead"]) },
          visibility: { cwd: process.cwd(), hasGoal: false },
        }),
      ).toThrow(/bypassPermissions|dontAsk|permission mode/i);
    }
  });

  test("a denied approval reports failure and does not run the tool", async () => {
    const { host, record } = makeHost({ approve: false });
    const result = await host.execute({ id: "c4", name: "PretendWrite", input: { path: "a.txt" } });
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("plan mode blocks a write tool but allows a read", async () => {
    const { host, record } = makeHost({ planMode: true, permissionMode: "plan" });
    const write = await host.execute({ id: "c5", name: "PretendWrite", input: { path: "a.txt" } });
    expect(write.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("an aborted signal short-circuits execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const { host, record } = makeHost({ signal: controller.signal });
    const result = await host.execute({ id: "c6", name: "EchoRead", input: { value: "x" } });
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("argsPatterns narrows a multi-action tool on BOTH list and execute", async () => {
    // A single tool with several actions (Panel: list/open/tools/invoke) can't be
    // narrowed by tool name alone. Narrowing must bite at execute() too —
    // describing the limit only in the schema would leave it advisory.
    const { host, record } = makeHost({
      expose: ["EchoRead"],
      argsPatterns: new Map([["EchoRead", { value: "^allowed$" }]]),
    });
    const ok = await host.execute({ id: "c7", name: "EchoRead", input: { value: "allowed" } });
    expect(ok.isError).toBeFalsy();

    const blocked = await host.execute({ id: "c8", name: "EchoRead", input: { value: "denied" } });
    expect(blocked.isError).toBe(true);
    expect(record).toEqual(["EchoRead:allowed"]);
  });

  test("dispose makes further calls fail closed", async () => {
    const { host, record } = makeHost();
    await host.dispose();
    const result = await host.execute({ id: "c9", name: "EchoRead", input: { value: "x" } });
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("exposes the business session id it was created for", () => {
    const { host } = makeHost();
    expect(host.businessSessionId).toBe("sess-1");
  });
});

function record0(result: { isError?: boolean }): boolean {
  return result.isError === true;
}

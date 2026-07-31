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
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
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

/**
 * The same per-tool rules the catalog declares. The Native Engine gets these via
 * PermissionController.build(); an external session must be given the equivalent
 * set, or its behavior silently diverges (read-only calls start prompting).
 */
const CATALOG_RULES = [
  { tool: "EchoRead", decision: "allow" as const },
  { tool: "PretendWrite", decision: "ask" as const },
  { tool: "SecretTool", decision: "allow" as const },
];

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
    presetRules: CATALOG_RULES,
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
      presetRules: CATALOG_RULES,
      planMode: false,
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
    };

    // Layer 1: the host's exposure check rejects before ToolExecutor is reached.
    const hostOnly = createSessionToolHost({
      ...base,
      exposure: { mode: "allowlist", toolNames: new Set(["EchoRead"]) },
    });
    const viaHost = await hostOnly.execute({ id: "l1", name: "SecretTool", input: {} });
    expect(viaHost.isError).toBe(true);
    expect(String(viaHost.error)).toMatch(/not exposed/i);
    expect(record).toEqual([]);

    // Layer 2: `allowedToolNames` on the context ToolExecutor holds. Drive the
    // executor DIRECTLY with the host's own assembled context — contextOverrides
    // deliberately can no longer widen it (that was the vulnerability), so this
    // is the only honest way to isolate the second layer.
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([...CATALOG_RULES], "default"),
      new HookRegistry(),
    );
    executor.setContext(hostOnly.toolContext);
    const viaExecutor = await executor.executeSingle({
      id: "l2",
      toolName: "SecretTool",
      args: {},
    });
    expect(viaExecutor.isError).toBe(true);
    expect(String(viaExecutor.error)).toMatch(/not allowed by this run profile/i);
    expect(record).toEqual([]);
  });

  test("contextOverrides cannot weaken security-relevant context fields", async () => {
    // Host seams (panels, browser, askUser…) are caller-supplied, but they must
    // not be able to reach past the policy. Spreading them LAST used to let a
    // caller set `toolVisibility: undefined` — which makes ToolExecutor skip its
    // availability guard outright — or widen allowedToolNames, or re-introduce a
    // permission mode the constructor just rejected.
    const record: string[] = [];
    const registry = new ToolRegistry({ toolCatalog: catalog(record) });
    const host = createSessionToolHost({
      businessSessionId: "sess-override",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      presetRules: CATALOG_RULES,
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(["EchoRead"]) },
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
      contextOverrides: {
        toolVisibility: undefined,
        allowedToolNames: new Set(["EchoRead", "SecretTool"]),
        sessionId: "attacker-session",
        planMode: true,
        permissionMode: "bypassPermissions",
      } as never,
    });

    const ctx = host.toolContext;
    expect(ctx.toolVisibility).toBeDefined();
    expect([...(ctx.allowedToolNames ?? [])]).toEqual(["EchoRead"]);
    expect(ctx.sessionId).toBe("sess-override");
    expect(ctx.planMode).toBe(false);
    expect(ctx.permissionMode).toBe("default");

    // …and the widened allowlist really did not take effect.
    const blocked = await host.execute({ id: "o1", name: "SecretTool", input: {} });
    expect(blocked.isError).toBe(true);
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
      presetRules: CATALOG_RULES,
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
          presetRules: CATALOG_RULES,
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

  test("argsPatterns are anchored, so a narrowing rule cannot widen by accident", async () => {
    // An unanchored `value: "allowed"` would also admit "allowed_extra" and
    // "not_allowed". A rule whose whole job is to NARROW must never widen
    // because its author forgot `^…$`.
    const { host, record } = makeHost({
      expose: ["EchoRead"],
      argsPatterns: new Map([["EchoRead", { value: "allowed" }]]),
    });

    const exact = await host.execute({ id: "a1", name: "EchoRead", input: { value: "allowed" } });
    expect(exact.isError).toBeFalsy();

    for (const sneaky of ["allowed_extra", "not_allowed", "xallowedx"]) {
      const blocked = await host.execute({ id: "a2", name: "EchoRead", input: { value: sneaky } });
      expect(blocked.isError).toBe(true);
    }
    expect(record).toEqual(["EchoRead:allowed"]);
  });

  test("argsPatterns reject non-primitive and prototype-borne values", async () => {
    const { host, record } = makeHost({
      expose: ["EchoRead"],
      argsPatterns: new Map([["EchoRead", { value: "list" }]]),
    });

    // `String(["list"])` is "list" — an array must not satisfy a scalar pattern.
    const arrayArg = await host.execute({
      id: "a3",
      name: "EchoRead",
      input: { value: ["list"] as never },
    });
    expect(arrayArg.isError).toBe(true);

    // An object with a crafted toString must not coerce its way through.
    const objectArg = await host.execute({
      id: "a4",
      name: "EchoRead",
      input: { value: { toString: () => "list" } as never },
    });
    expect(objectArg.isError).toBe(true);

    // A value reachable only via the prototype chain is not an own property.
    const viaProto = Object.create({ value: "list" }) as Record<string, unknown>;
    const protoArg = await host.execute({ id: "a5", name: "EchoRead", input: viaProto });
    expect(protoArg.isError).toBe(true);

    expect(record).toEqual([]);
  });

  test("a malformed argsPattern denies rather than permits", async () => {
    const { host, record } = makeHost({
      expose: ["EchoRead"],
      argsPatterns: new Map([["EchoRead", { value: "([unclosed" }]]),
    });
    const result = await host.execute({ id: "a6", name: "EchoRead", input: { value: "x" } });
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("dispose makes further calls fail closed", async () => {
    const { host, record } = makeHost();
    await host.dispose();
    const result = await host.execute({ id: "c9", name: "EchoRead", input: { value: "x" } });
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("dispose aborts work that is already in flight", async () => {
    // §13.4 requires close to cancel active calls, not merely refuse new ones.
    // Marking a flag without aborting lets a call that is mid-execution — or
    // parked on an approval prompt — run to completion after the session is gone.
    const record: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const registry = new ToolRegistry({
      toolCatalog: [
        {
          definition: {
            name: "SlowTool",
            description: "Blocks until released.",
            inputSchema: { type: "object", properties: {} },
            source: "builtin",
            permissionDefault: "allow",
            isReadOnly: true,
            isConcurrencySafe: true,
          },
          execute: async (_args: Record<string, unknown>, ctx?: ToolContext) => {
            await gate;
            if (ctx?.signal?.aborted) throw new Error("aborted");
            record.push("SlowTool");
            return "done";
          },
          exposure: {
            presetTags: ["general"],
            defaultPermissionRules: [{ tool: "SlowTool", decision: "allow" }],
          },
        },
      ] as unknown as BuiltinTool[],
    });
    const host = createSessionToolHost({
      businessSessionId: "sess-dispose",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      presetRules: [{ tool: "SlowTool", decision: "allow" }],
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(["SlowTool"]) },
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
    });

    const inFlight = host.execute({ id: "d1", name: "SlowTool", input: {} });
    await host.dispose();
    // The session's lifetime signal must now be aborted, so the parked call sees
    // cancellation rather than completing into a closed session.
    expect(host.toolContext.signal?.aborted).toBe(true);
    release();
    const result = await inFlight;
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("a per-call signal cancels that call mid-flight", async () => {
    // The per-call signal used to be checked only at entry, so an MCP
    // cancellation arriving after the call started was a no-op.
    const record: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const registry = new ToolRegistry({
      toolCatalog: [
        {
          definition: {
            name: "SlowTool",
            description: "Blocks until released.",
            inputSchema: { type: "object", properties: {} },
            source: "builtin",
            permissionDefault: "allow",
            isReadOnly: true,
            isConcurrencySafe: true,
          },
          execute: async (_args: Record<string, unknown>, ctx?: ToolContext) => {
            await gate;
            if (ctx?.signal?.aborted) throw new Error("aborted");
            record.push("SlowTool");
            return "done";
          },
          exposure: {
            presetTags: ["general"],
            defaultPermissionRules: [{ tool: "SlowTool", decision: "allow" }],
          },
        },
      ] as unknown as BuiltinTool[],
    });
    const host = createSessionToolHost({
      businessSessionId: "sess-callsignal",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      presetRules: [{ tool: "SlowTool", decision: "allow" }],
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(["SlowTool"]) },
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
    });

    const controller = new AbortController();
    const inFlight = host.execute({ id: "cs1", name: "SlowTool", input: {} }, controller.signal);
    controller.abort(); // cancellation arrives AFTER the call began
    release();
    const result = await inFlight;
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);

    // The session itself is unaffected — only that one call was cancelled.
    expect(host.toolContext.signal?.aborted).toBe(false);
  });

  test("exposes the business session id it was created for", () => {
    const { host } = makeHost();
    expect(host.businessSessionId).toBe("sess-1");
  });
});

function record0(result: { isError?: boolean }): boolean {
  return result.isError === true;
}

import { describe, expect, test } from "bun:test";
import { compileComposition } from "../composition/compiler.js";
import { presetInjectedTools } from "../composition/resolve-preset.js";
import type { AgentModule } from "../composition/types.js";
import { HookRegistry } from "../hooks/registry.js";
import {
  parseNativePluginManifest,
  type NativePluginManifest,
} from "../plugins/native/manifest.js";
import {
  buildNativeModule,
  hookResultFrom,
  nativeDeclarationsDigest,
  plainData,
  validateNativeDeclarations,
  type NativeCallBlock,
  type NativePluginCalls,
} from "./module-adapter.js";
import { PluginCallError } from "./process.js";
import type { NativeDeclarations, PluginInvocationKind } from "./protocol.js";

function manifest(contributes: Record<string, unknown> = {}): NativePluginManifest {
  const read = parseNativePluginManifest({
    schemaVersion: 2,
    apiVersion: 1,
    main: "./index.js",
    contributes: {
      hooks: ["pre_tool_use", "on_stop", "user_prompt_submit", "post_tool_use"],
      tools: ["lookup", "always_on"],
      presets: ["reviewer"],
      promptSections: ["role"],
      context: ["status"],
      background: true,
      ...contributes,
    },
  });
  if (read.kind !== "native") throw new Error(JSON.stringify(read));
  return read.manifest;
}

function declarations(overrides: Partial<NativeDeclarations> = {}): NativeDeclarations {
  return {
    hooks: [{ event: "pre_tool_use", timeoutMs: 5000, onError: "ignore" }],
    tools: [
      {
        name: "lookup",
        description: "Look a ticket up",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        concurrencySafe: false,
        timeoutMs: 120_000,
        exposure: "preset",
      },
    ],
    presets: [],
    presetExtensions: [],
    promptSections: [],
    context: [],
    background: false,
    ...overrides,
  };
}

interface Call {
  kind: PluginInvocationKind;
  name: string;
  payload: any;
  timeoutMs: number;
}

function fakeCalls(
  answer: (call: Call) => unknown = () => null,
  options: { blocked?: NativeCallBlock; cwd?: string } = {},
): NativePluginCalls & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async invoke(kind, name, payload, { timeoutMs }) {
      const call = { kind, name, payload, timeoutMs };
      calls.push(call);
      return answer(call);
    },
    blocked: () => options.blocked,
    sessionCwd: (sessionId) => (sessionId ? options.cwd : undefined),
  };
}

function build(
  plugin: string,
  declared: NativeDeclarations,
  calls: NativePluginCalls,
  hostPresets = new Set(["general"]),
): AgentModule {
  return buildNativeModule({
    moduleId: `plugin-${plugin}-00000000`,
    plugin,
    declarations: declared,
    calls,
    hostPresets,
  });
}

describe("validating what a plugin registered", () => {
  test("accepts registrations the manifest announced", () => {
    expect(validateNativeDeclarations(manifest(), declarations())).toBeNull();
  });

  test.each<[string, Partial<NativeDeclarations>, string]>([
    [
      "an undeclared hook",
      { hooks: [{ event: "on_session_start", timeoutMs: 5000, onError: "ignore" }] },
      "on_session_start",
    ],
    [
      "an unknown hook event",
      { hooks: [{ event: "on_everything", timeoutMs: 5000, onError: "ignore" }] },
      "unknown hook event",
    ],
    [
      "a hook registered twice",
      {
        hooks: [
          { event: "on_stop", timeoutMs: 5000, onError: "ignore" },
          { event: "on_stop", timeoutMs: 5000, onError: "ignore" },
        ],
      },
      "twice",
    ],
    [
      "failing closed on an event that is not a tool gate",
      { hooks: [{ event: "on_stop", timeoutMs: 5000, onError: "deny" }] },
      "cannot fail closed",
    ],
    [
      "an undeclared tool",
      { tools: [{ ...declarations().tools[0]!, name: "shell" }] },
      'tool "shell"',
    ],
    [
      "a tool without a description",
      { tools: [{ ...declarations().tools[0]!, description: " " }] },
      "description",
    ],
    ["an undeclared prompt section", { promptSections: [{ name: "extra", text: "x" }] }, "extra"],
    ["an undeclared context provider", { context: [{ name: "extra" }] }, "extra"],
    [
      "an undeclared preset",
      {
        presets: [
          {
            name: "other",
            label: "",
            description: "",
            promptSections: [],
            builtinTools: [],
            defaultPermissionRules: [],
          },
        ],
      },
      'preset "other"',
    ],
    [
      "a preset that lowers the confirmation bar",
      {
        presets: [
          {
            name: "reviewer",
            label: "",
            description: "",
            promptSections: [],
            builtinTools: ["lookup"],
            defaultPermissionRules: [{ tool: "lookup", decision: "allow" }],
          },
        ],
      },
      "allow rule",
    ],
    [
      "a preset that depends on another plugin",
      {
        presets: [
          {
            name: "reviewer",
            label: "",
            description: "",
            promptSections: [],
            builtinTools: ["plugin__other__tool"],
            defaultPermissionRules: [],
          },
        ],
      },
      "another plugin",
    ],
    [
      "an extension that adds a tool it does not own",
      { presetExtensions: [{ target: { presets: ["general"] }, tools: ["Bash"] }] },
      "Bash",
    ],
  ])("rejects %s", (_label, overrides, mention) => {
    expect(validateNativeDeclarations(manifest(), declarations(overrides))).toContain(mention);
  });

  test("background logic must be announced", () => {
    expect(
      validateNativeDeclarations(
        manifest({ background: false }),
        declarations({ background: true }),
      ),
    ).toContain("background");
  });

  test("the digest ignores key order and changes with anything the model can see", () => {
    const first = declarations();
    const reordered = {
      ...first,
      tools: [Object.fromEntries(Object.entries(first.tools[0]!).reverse())],
    };
    expect(nativeDeclarationsDigest(reordered as NativeDeclarations)).toBe(
      nativeDeclarationsDigest(first),
    );
    expect(
      nativeDeclarationsDigest(
        declarations({ tools: [{ ...first.tools[0]!, description: "Changed" }] }),
      ),
    ).not.toBe(nativeDeclarationsDigest(first));
  });
});

describe("the generated module", () => {
  test("compiles with the host's modules and carries the plugin's name everywhere", () => {
    const module = build(
      "reviewer",
      declarations({
        tools: [
          declarations().tools[0]!,
          { ...declarations().tools[0]!, name: "always_on", exposure: "always" },
        ],
        presets: [
          {
            name: "reviewer",
            label: "Reviewer",
            description: "Read only",
            promptSections: ["role"],
            builtinTools: ["Read", "lookup"],
            defaultPermissionRules: [{ tool: "lookup", decision: "ask" }],
          },
        ],
        promptSections: [{ name: "role", text: "You review code." }],
        context: [{ name: "status" }],
      }),
      fakeCalls(),
    );
    const composition = compileComposition({ modules: [module] });
    const mine = (item: { moduleId: string }) => item.moduleId === "plugin-reviewer-00000000";

    expect(
      composition.engine.tools
        .filter(mine)
        .map((tool) => `${tool.kind}:${tool.tool.definition.name}`),
    ).toEqual(["preset-tags:plugin__reviewer__lookup", "always:plugin__reviewer__always_on"]);
    expect(composition.engine.presets.find(mine)?.value).toMatchObject({
      name: "reviewer:reviewer",
      promptSections: ["reviewer:role"],
      builtinTools: ["Read", "plugin__reviewer__lookup"],
      defaultPermissionRules: [{ tool: "plugin__reviewer__lookup", decision: "ask" }],
    });
    expect(composition.engine.promptSections.find(mine)).toMatchObject({
      key: "reviewer:role",
      value: "You review code.",
    });
    expect(composition.engine.hooks.find(mine)).toMatchObject({
      event: "pre_tool_use",
      priority: 80,
      name: "capability:plugin-reviewer-00000000:reviewer:pre_tool_use",
    });
    // A plugin with its own preset keeps its tools there.
    expect(presetInjectedTools(composition, "general").map((t) => t.definition.name)).not.toContain(
      "plugin__reviewer__lookup",
    );
  });

  test("a plugin without presets offers its tools to every preset; an extension targets some", () => {
    const everywhere = compileComposition({
      modules: [build("reviewer", declarations(), fakeCalls())],
    });
    expect(presetInjectedTools(everywhere, "general").map((t) => t.definition.name)).toContain(
      "plugin__reviewer__lookup",
    );

    const extended = build(
      "reviewer",
      declarations({
        presetExtensions: [
          { target: { presets: ["general", "not-installed"] }, tools: ["lookup"] },
        ],
      }),
      fakeCalls(),
    );
    // The missing target is skipped instead of failing the whole plugin.
    expect(extended.engine?.presetExtensions).toEqual([
      { target: { presets: ["general"] }, tools: ["plugin__reviewer__lookup"] },
    ]);
    expect(() => compileComposition({ modules: [extended] })).not.toThrow();
  });

  test("two plugins with the same tool name do not collide", () => {
    expect(() =>
      compileComposition({
        modules: [
          build("first", declarations(), fakeCalls()),
          build("second", declarations(), fakeCalls()),
        ],
      }),
    ).not.toThrow();
  });
});

describe("hook stubs", () => {
  function registryWith(...modules: AgentModule[]): HookRegistry {
    const registry = new HookRegistry();
    registry.setIdentity(() => ({ preset: "general", isSubAgent: false, sessionId: "s-1" }));
    for (const module of modules)
      for (const hook of module.engine?.hooks ?? [])
        registry.register(hook.event, hook.handler, hook.priority, hook.name);
    return registry;
  }

  test("send plain event data with the session identity lifted out", async () => {
    const calls = fakeCalls(() => ({ decision: "deny", messages: ["read only"] }), {
      cwd: "/repo",
    });
    const registry = registryWith(build("reviewer", declarations(), calls));

    const result = await registry.emit("pre_tool_use", {
      toolName: "Write",
      args: { file_path: "a.ts" },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ decision: "deny", messages: ["[reviewer] read only"] });
    expect(calls.calls).toEqual([
      {
        kind: "hook",
        name: "pre_tool_use",
        timeoutMs: 5000,
        payload: {
          name: "pre_tool_use",
          sessionId: "s-1",
          cwd: "/repo",
          preset: "general",
          isSubAgent: false,
          data: { toolName: "Write", args: { file_path: "a.ts" } },
        },
      },
    ]);
  });

  test("keep only what each event lets a plugin change", () => {
    const everything = {
      decision: "allow",
      messages: ["note", 7, ""],
      updatedInput: { a: 1 },
      updatedPrompt: "rewritten",
      additionalContext: "lint ok",
      continueSession: true,
      stop: true,
      data: { injected: true },
      goalTermination: "completed",
    };
    expect(hookResultFrom("pre_tool_use", "p", everything)).toEqual({
      messages: ["[p] note"],
      updatedInput: { a: 1 },
    });
    expect(hookResultFrom("pre_tool_use", "p", { decision: "ask" })).toEqual({ decision: "ask" });
    expect(hookResultFrom("on_permission_check", "p", { ...everything, decision: "deny" })).toEqual(
      { decision: "deny", messages: ["[p] note"] },
    );
    expect(hookResultFrom("user_prompt_submit", "p", everything)).toEqual({
      messages: ["[p] note"],
      updatedPrompt: "rewritten",
    });
    expect(hookResultFrom("post_tool_use", "p", everything)).toEqual({
      additionalContext: "[p] lint ok",
    });
    expect(hookResultFrom("on_stop", "p", everything)).toEqual({
      continueSession: true,
      messages: ["[p] note"],
    });
    expect(hookResultFrom("on_session_start", "p", everything)).toEqual({ messages: ["[p] note"] });
    expect(hookResultFrom("on_tool_end", "p", everything)).toEqual({});
    expect(hookResultFrom("pre_tool_use", "p", "not an object")).toEqual({});
  });

  test("an unanswered call follows the policy the hook registered", async () => {
    const failing = () => {
      throw new PluginCallError("TIMEOUT", "late");
    };
    const lenient = registryWith(build("reviewer", declarations(), fakeCalls(failing)));
    expect(await lenient.emit("pre_tool_use", { toolName: "Write", args: {} })).toEqual({});

    const strict = registryWith(
      build(
        "reviewer",
        declarations({ hooks: [{ event: "pre_tool_use", timeoutMs: 5000, onError: "deny" }] }),
        fakeCalls(failing),
      ),
    );
    const denied = await strict.emit("pre_tool_use", { toolName: "Write", args: {} });
    expect(denied.decision).toBe("deny");
    expect(denied.messages?.[0]).toContain("[reviewer]");
    expect(denied.messages?.[0]).toContain("TIMEOUT");
  });

  test("a blocked plugin is not called at all", async () => {
    const calls = fakeCalls(() => ({ decision: "deny" }), { blocked: "revoked" });
    const registry = registryWith(
      build(
        "reviewer",
        declarations({ hooks: [{ event: "pre_tool_use", timeoutMs: 5000, onError: "deny" }] }),
        calls,
      ),
    );
    expect(await registry.emit("pre_tool_use", { toolName: "Write", args: {} })).toEqual({});
    expect(calls.calls).toEqual([]);
  });

  test("rewrites pass down the chain in registration order instead of replacing each other", async () => {
    const first = fakeCalls((call) => ({
      updatedInput: { ...call.payload.data.args, redacted: true },
    }));
    const second = fakeCalls((call) => ({
      updatedInput: { ...call.payload.data.args, dryRun: true },
    }));
    const registry = registryWith(
      build("redactor", declarations(), first),
      build("dry-runner", declarations(), second),
    );

    const result = await registry.emit("pre_tool_use", {
      toolName: "Bash",
      args: { command: "deploy" },
    });

    expect(second.calls[0]!.payload.data.args).toEqual({ command: "deploy", redacted: true });
    expect(result.updatedInput).toEqual({ command: "deploy", redacted: true, dryRun: true });
  });

  test("a rewritten prompt reaches the next plugin too", async () => {
    const hooks = [{ event: "user_prompt_submit", timeoutMs: 5000, onError: "ignore" as const }];
    const first = fakeCalls((call) => ({
      updatedPrompt: `${call.payload.data.prompt} [expanded]`,
    }));
    const second = fakeCalls((call) => ({
      updatedPrompt: `${call.payload.data.prompt} [checked]`,
    }));
    const registry = registryWith(
      build("expander", declarations({ hooks }), first),
      build("checker", declarations({ hooks }), second),
    );
    const result = await registry.emit("user_prompt_submit", { prompt: "fix it" });
    expect(result.updatedPrompt).toBe("fix it [expanded] [checked]");
  });
});

describe("tool and context stubs", () => {
  function tool(calls: NativePluginCalls) {
    const contribution = build("reviewer", declarations(), calls).engine!.tools![0]!;
    return contribution.tool;
  }

  test("a tool call carries its input and session and returns the plugin's text", async () => {
    const calls = fakeCalls(() => ({ content: "ticket T-1" }));
    const lookup = tool(calls);
    expect(lookup.definition).toMatchObject({
      name: "plugin__reviewer__lookup",
      isReadOnly: true,
      permissionDefault: "ask",
      timeoutMs: 120_000,
    });
    expect(
      await lookup.execute({ id: "T-1" }, { sessionId: "s-1", cwd: "/repo" } as never),
    ).toEqual({ ok: true, result: "ticket T-1" });
    expect(calls.calls[0]).toMatchObject({
      kind: "tool",
      name: "lookup",
      payload: { input: { id: "T-1" }, sessionId: "s-1", cwd: "/repo" },
      timeoutMs: 120_000,
    });
  });

  test("a tool reports its own errors, failed calls and a blocked plugin as tool failures", async () => {
    expect(
      await tool(fakeCalls(() => ({ content: "not found", isError: true }))).execute({}),
    ).toEqual({
      ok: false,
      error: "not found",
    });
    expect(await tool(fakeCalls(() => "plain text")).execute({})).toEqual({
      ok: true,
      result: "plain text",
    });
    const thrown = (await tool(
      fakeCalls(() => {
        throw new PluginCallError("PLUGIN_UNAVAILABLE", "exited");
      }),
    ).execute({})) as { ok: boolean; error: string };
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toContain("PLUGIN_UNAVAILABLE");
    expect(
      ((await tool(fakeCalls(() => ({ wrong: true }))).execute({})) as { ok: boolean }).ok,
    ).toBe(false);

    const blocked = fakeCalls(() => "never", { blocked: "disabled" });
    expect(await tool(blocked).execute({})).toEqual({
      ok: false,
      error: 'Plugin "reviewer" is disabled for this session.',
    });
    expect(blocked.calls).toEqual([]);
  });

  test("a context provider becomes its own ledger section and keeps the last text on failure", async () => {
    const context = {
      cwd: "/repo",
      preset: { name: "general" },
      session: { id: "s-1", isSubAgent: false },
    } as never;
    const declared = declarations({ context: [{ name: "status" }] });

    const answering = fakeCalls(() => "branch main");
    const provider = build("reviewer", declared, answering).engine!.dynamicContextProviders![0]!;
    expect(await provider(context)).toEqual({ key: "plugin-reviewer-status", text: "branch main" });
    expect(answering.calls[0]).toMatchObject({
      kind: "context",
      name: "status",
      payload: { sessionId: "s-1", cwd: "/repo", preset: "general", isSubAgent: false },
      timeoutMs: 2000,
    });

    const failing = build(
      "reviewer",
      declared,
      fakeCalls(() => {
        throw new PluginCallError("TIMEOUT", "late");
      }),
    ).engine!.dynamicContextProviders![0]!;
    expect(await failing(context)).toEqual({ key: "plugin-reviewer-status", unchanged: true });

    const silent = build(
      "reviewer",
      declared,
      fakeCalls(() => null),
    ).engine!.dynamicContextProviders![0]!;
    expect(await silent(context)).toBeUndefined();

    const blocked = build(
      "reviewer",
      declared,
      fakeCalls(() => "x", { blocked: "revoked" }),
    ).engine!.dynamicContextProviders![0]!;
    expect(await blocked(context)).toBeUndefined();
  });
});

test("a sub-agent follows the session that spawned it", async () => {
  const asked: Array<string | undefined> = [];
  const calls = fakeCalls(() => "ok", { cwd: "/repo" });
  const watched: NativePluginCalls = {
    ...calls,
    blocked(sessionId) {
      asked.push(sessionId);
      return undefined;
    },
  };
  const module = build("reviewer", declarations({ context: [{ name: "status" }] }), watched);

  const registry = new HookRegistry();
  registry.setIdentity(() => ({
    preset: "general",
    isSubAgent: true,
    parentSessionId: "s-parent",
    sessionId: "s-child",
  }));
  for (const hook of module.engine!.hooks!)
    registry.register(hook.event, hook.handler, hook.priority, hook.name);
  await registry.emit("pre_tool_use", { toolName: "Read", args: {} });
  await module.engine!.tools![0]!.tool.execute({}, {
    sessionId: "s-child",
    rootSessionId: "s-parent",
    cwd: "/worktree",
  } as never);
  await module.engine!.dynamicContextProviders![0]!({
    cwd: "/worktree",
    preset: { name: "general" },
    session: { id: "s-child", isSubAgent: true, parentId: "s-parent" },
  } as never);

  // Whether the plugin is switched off is the parent Session's decision.
  expect(asked).toEqual(["s-parent", "s-parent", "s-parent"]);
  expect(calls.calls[0]!.payload).toEqual({
    name: "pre_tool_use",
    sessionId: "s-child",
    parentSessionId: "s-parent",
    cwd: "/repo",
    preset: "general",
    isSubAgent: true,
    data: { toolName: "Read", args: {} },
  });
  expect(calls.calls[1]!.payload).toMatchObject({ sessionId: "s-child", cwd: "/worktree" });
  expect(calls.calls[2]!.payload).toMatchObject({ sessionId: "s-child", isSubAgent: true });
});

test("plainData keeps JSON and drops everything a process boundary cannot carry", () => {
  class Custom {
    value = 1;
  }
  expect(
    plainData({
      text: "a",
      n: 1,
      nan: Number.NaN,
      nested: { list: [1, undefined, () => 1] },
      signal: new AbortController().signal,
      custom: new Custom(),
      fn() {},
      nothing: undefined,
      nil: null,
    }),
  ).toEqual({ text: "a", n: 1, nan: null, nested: { list: [1, null, null] }, nil: null });
});

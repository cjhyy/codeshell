import { afterEach, expect, test } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import type { ToolContext } from "./context.js";
import { ToolRegistry } from "./registry.js";
import {
  createSessionToolHost,
  type SessionToolHost,
  type SessionToolHostRunContext,
} from "./session-tool-host.js";

const hosts: SessionToolHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function lease(runId: string) {
  const abort = new AbortController();
  let current = true;
  const context: SessionToolHostRunContext = {
    operations: { runId } as NonNullable<ToolContext["operations"]>,
    originClientMessageId: `user-${runId}`,
    signal: abort.signal,
    assertCurrent() {
      if (!current) throw new Error("Submission changed");
    },
  };
  return { context, abort, revoke: () => (current = false) };
}

function probe(captureRunContext: () => SessionToolHostRunContext | undefined) {
  const observed: Array<{ value: unknown; runId: string | undefined; origin: unknown }> = [];
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool(
    {
      name: "RunProbe",
      description: "Records the trusted submission context",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      source: "builtin",
      permissionDefault: "allow",
    },
    async (args, context) => {
      observed.push({
        value: args.value,
        runId: context?.operations?.runId,
        origin: context?.originClientMessageId,
      });
      return "executed";
    },
  );
  const hooks = new HookRegistry();
  const host = createSessionToolHost({
    businessSessionId: "run-probe",
    cwd: process.cwd(),
    registry,
    permissionMode: "default",
    projectTrusted: false,
    presetRules: [{ tool: "RunProbe", decision: "allow" }],
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set(["RunProbe"]) },
    visibility: { cwd: process.cwd(), host: "desktop", isSubAgent: false },
    hooks,
    captureRunContext,
  });
  hosts.push(host);
  return { host, hooks, observed };
}

test("run custody permits ordinary tools and their input sanitizing hooks", async () => {
  const run = lease("one");
  const { host, hooks, observed } = probe(() => run.context);
  hooks.register("pre_tool_use", () => ({ updatedInput: { value: "sanitized" } }));
  const result = await host.execute({
    id: "ordinary",
    name: "RunProbe",
    input: { value: "original", runId: "forged", originClientMessageId: "forged" },
  });
  expect(result.isError).toBe(false);
  expect(observed).toEqual([{ value: "sanitized", runId: "one", origin: "user-one" }]);
});

test("an advertised tool cannot execute outside an active submission", async () => {
  const { host, observed } = probe(() => undefined);
  expect(host.listTools().some((tool) => tool.name === "RunProbe")).toBe(true);
  const result = await host.execute({ id: "idle", name: "RunProbe", input: {} });
  expect(result.isError).toBe(true);
  expect(result.error).toContain("no longer active");
  expect(observed).toEqual([]);
});

test("a hook await cannot transfer an old call to the next submission", async () => {
  const first = lease("one");
  const second = lease("two");
  let active = first.context;
  const { host, hooks, observed } = probe(() => active);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const barrier = new Promise<void>((resolve) => (release = resolve));
  hooks.register("pre_tool_use", async (context) => {
    if (context.data.toolCallId === "old") {
      entered();
      await barrier;
    }
    return {};
  });
  const old = host.execute({ id: "old", name: "RunProbe", input: { value: "old" } });
  await waiting;
  first.revoke();
  active = second.context;
  const next = await host.execute({ id: "new", name: "RunProbe", input: { value: "new" } });
  release();
  expect((await old).isError).toBe(true);
  expect(next.isError).toBe(false);
  expect(observed).toEqual([{ value: "new", runId: "two", origin: "user-two" }]);
});

test("the captured submission abort stops a call parked in a hook", async () => {
  const run = lease("one");
  const { host, hooks, observed } = probe(() => run.context);
  hooks.register("pre_tool_use", async () => {
    run.abort.abort("Submission stopped");
    return {};
  });
  const result = await host.execute({ id: "stop", name: "RunProbe", input: {} });
  expect(result.isError).toBe(true);
  expect(observed).toEqual([]);
});

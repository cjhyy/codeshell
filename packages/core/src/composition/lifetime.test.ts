import { describe, expect, test } from "bun:test";
import { LifetimeScope } from "./lifetime.js";
import { HookRegistry } from "../hooks/registry.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { registerProtocolQuery } from "./protocol-attach.js";

describe("LifetimeScope", () => {
  test("children precede parent resources; acquisition order reverses, including async cleanup", async () => {
    const calls: string[] = [];
    const host = new LifetimeScope("host", "test");
    host.own(() => {
      calls.push("host-first");
    });
    const engine = host.child("engine", "engine");
    engine.own(() => {
      calls.push("engine-first");
    });
    const session = engine.child("session", "session");
    const run = session.child("run", "run");
    run.own(async () => {
      calls.push("run-start");
      await Promise.resolve();
      calls.push("run-end");
    });
    engine.own(() => {
      calls.push("engine-last");
    });
    host.own(() => {
      calls.push("host-last");
    });
    const pending = host.dispose();
    expect(host.dispose()).toBe(pending);
    expect(() => host.own(() => {})).toThrow("disposed");
    expect(() => host.child("engine", "late")).toThrow("disposed");
    await pending;
    expect(calls).toEqual([
      "run-start",
      "run-end",
      "engine-last",
      "engine-first",
      "host-last",
      "host-first",
    ]);
    await host.dispose();
    expect(calls).toHaveLength(6);
  });

  test("all resources release before AggregateError is reported", async () => {
    const calls: string[] = [];
    const scope = new LifetimeScope("engine", "errors");
    scope.own(() => {
      calls.push("first");
      throw new Error("first error");
    });
    scope.own(async () => {
      calls.push("second");
      throw new Error("second error");
    });
    scope.own(() => {
      calls.push("third");
    });
    let error: unknown;
    try {
      await scope.dispose();
    } catch (caught) {
      error = caught;
    }
    expect(calls).toEqual(["third", "second", "first"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    await expect(scope.dispose()).rejects.toBe(error);
  });

  test("a disposed child detaches from its long-lived owner", async () => {
    const scope = new LifetimeScope("host", "many-runs");
    for (let i = 0; i < 100; i++) await scope.child("run", String(i)).dispose();
    expect((scope as any).children.size).toBe(0);
    await scope.dispose();
  });
});

describe("identity-bound registration disposers", () => {
  test("hook disposer removes exactly one registration of the same function", async () => {
    const hooks = new HookRegistry();
    let count = 0;
    const handler = () => {
      count++;
      return {};
    };
    const first = hooks.register("on_stop", handler);
    const second = hooks.register("on_stop", handler);
    await first();
    await first();
    await hooks.emit("on_stop");
    expect(count).toBe(1);
    await second();
    expect(hooks.hasHooks("on_stop")).toBe(false);
  });

  test("old tool disposal cannot remove a replacement, even if the definition object is reused", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    const definition = {
      name: "test",
      description: "test",
      inputSchema: { type: "object" },
      source: "builtin",
      permissionDefault: "ask",
    } as const;
    const old = registry.registerTool(definition, async () => "old");
    const next = registry.registerTool(definition, async () => "next");
    await old();
    expect((await registry.executeTool("test", {})).result).toBe("next");
    await next();
    await next();
    expect(registry.hasTool("test")).toBe(false);
  });

  test("query disposer is identity-bound even when the handler function is reused", async () => {
    const queries = new Map();
    const handler = () => "value";
    const old = registerProtocolQuery(queries, "query", handler);
    const next = registerProtocolQuery(queries, "query", handler);
    await old();
    expect(await queries.get("query")({})).toBe("value");
    await next();
    expect(queries.size).toBe(0);
  });
});

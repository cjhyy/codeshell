import { describe, expect, test } from "bun:test";
import { compileComposition } from "./compiler.js";
import { LifetimeScope } from "./lifetime.js";
import { attachProtocolContributions } from "./protocol-attach.js";
import { activateEngineModules, createPrivateServices } from "./activation.js";
import type { AgentModule } from "./types.js";

const host = {
  getLiveSessionSnapshot: () => [],
  projectionGeneration: () => 1,
  getSessionKind: () => undefined,
  isTransportDisconnected: () => false,
  notify() {},
};

describe("composition activation ownership", () => {
  test("failed observer rolls back its queries; other modules remain available", async () => {
    const composition = compileComposition({
      modules: [
        {
          id: "broken",
          protocol: {
            queries: { broken: () => "fallback" },
            createObserver(ctx) {
              ctx.registerQuery("broken", () => "partial");
              throw new Error("observer failed");
            },
          },
        },
        { id: "healthy", protocol: { queries: { healthy: () => "ready" } } },
      ],
    });
    const scope = new LifetimeScope("host", "test");
    const queries = new Map();
    const warnings: string[] = [];
    await attachProtocolContributions({
      composition,
      scope,
      host,
      observers: [],
      queryHandlers: queries,
      closeObserver() {},
      warn: (text) => warnings.push(text),
    });
    expect(queries.has("broken")).toBe(false);
    expect(await queries.get("healthy")({})).toBe("ready");
    expect(warnings).toHaveLength(1);
    await scope.dispose();
    expect(queries.size).toBe(0);
  });

  test("observer cannot register an undeclared query or replace another module's query", async () => {
    const scope = new LifetimeScope("host", "test");
    const composition = compileComposition({
      modules: [
        {
          id: "bad",
          protocol: {
            createObserver(ctx) {
              ctx.registerQuery("healthy", () => "stolen");
              return {};
            },
          },
        },
        { id: "good", protocol: { queries: { healthy: () => "correct" } } },
      ],
    });
    const queries = new Map();
    await attachProtocolContributions({
      composition,
      scope,
      host,
      observers: [],
      queryHandlers: queries,
      closeObserver() {},
      warn() {},
    });
    expect(await queries.get("healthy")({})).toBe("correct");
    await scope.dispose();
  });

  test("async host activation failure rolls back observers, queries and already acquired resources", async () => {
    const calls: string[] = [];
    const composition = compileComposition({
      modules: [
        {
          id: "first",
          activateHost(ctx) {
            expect("registerQuery" in ctx.host).toBe(false);
            ctx.own(() => {
              calls.push("first");
            });
          },
          protocol: {
            queries: { first: () => 1 },
            createObserver: () => ({
              onServerClose() {
                calls.push("observer");
              },
            }),
          },
        },
        {
          id: "second",
          async activateHost(ctx) {
            ctx.own(() => {
              calls.push("second");
            });
            throw new Error("activation failed");
          },
        },
      ],
    });
    const queries = new Map();
    const observers: any[] = [];
    const scope = new LifetimeScope("host", "test");
    await expect(
      attachProtocolContributions({
        composition,
        scope,
        host,
        observers,
        queryHandlers: queries,
        closeObserver: (observer) => observer.onServerClose?.(),
        warn() {},
      }),
    ).rejects.toThrow("activation failed");
    expect(calls).toEqual(["second", "first", "observer"]);
    expect(queries.size).toBe(0);
    expect(observers).toHaveLength(0);
  });

  test("engine activation failure unwinds pre-existing declarations and module resources", async () => {
    const calls: string[] = [];
    const scope = new LifetimeScope("engine", "test");
    scope.own(() => {
      calls.push("declarations");
    });
    const composition = compileComposition({
      modules: [
        {
          id: "first",
          activateEngine(ctx) {
            ctx.own(() => {
              calls.push("first");
            });
          },
        },
        {
          id: "second",
          activateEngine(ctx) {
            ctx.own(() => {
              calls.push("second");
            });
            throw new Error("failed");
          },
        },
      ],
    });
    await expect(activateEngineModules(composition, scope, {} as never)).rejects.toThrow("failed");
    expect(calls).toEqual(["second", "first", "declarations"]);
  });

  test("an async private service resolving after close is released instead of being installed", async () => {
    let finish!: (value: unknown) => void;
    const released: unknown[] = [];
    const scope = new LifetimeScope("session", "test");
    const values = {};
    const pending = createPrivateServices(
      [
        {
          key: "test",
          moduleId: "test",
          value: {
            scope: "session",
            create: () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
            dispose(value) {
              released.push(value);
            },
          },
        },
      ],
      "session",
      scope,
      {} as never,
      values,
    );
    await scope.dispose();
    finish("late");
    await pending;
    expect(released).toEqual(["late"]);
    expect(values).toEqual({});
  });

  test("compiled declaration topology is a frozen copy, including Sets", () => {
    const allowed = new Set(["Read"]);
    const module: AgentModule = {
      id: "test",
      engine: { behaviorProfiles: [{ id: "test", allowedToolNames: allowed }] },
    };
    const composition = compileComposition({ modules: [module] });
    allowed.add("Write");
    const profile = composition.engine.behaviorProfiles.find(
      (entry) => entry.key === "test",
    )!.value;
    expect(profile.allowedToolNames?.has("Write")).toBe(false);
    expect(() => (profile.allowedToolNames as Set<string>).add("Bash")).toThrow("immutable");
    expect(() =>
      profile.allowedToolNames?.forEach((_name, _key, set) => (set as Set<string>).clear()),
    ).toThrow("immutable");
    expect(() => (profile.allowedToolNames?.valueOf() as Set<string>).add("Bash")).toThrow(
      "immutable",
    );
    expect(() => (composition.engine.tools as unknown[]).push({})).toThrow();
    expect(Object.isFrozen(module)).toBe(false);
  });

  test("compiler rejects an invalid private service lifetime before invoking a factory", () => {
    let created = false;
    expect(() =>
      compileComposition({
        modules: [
          {
            id: "bad",
            engine: {
              privateService: {
                scope: "run" as never,
                create() {
                  created = true;
                },
              },
            },
          },
        ],
      }),
    ).toThrow("Invalid private service scope");
    expect(created).toBe(false);
  });

  test("a failed private service immediately rolls back acquired resources while another factory is pending", async () => {
    const scope = new LifetimeScope("engine", "partial");
    const released: string[] = [];
    const values = {};
    let finish!: (value: unknown) => void;
    const pending = createPrivateServices(
      [
        {
          key: "ready",
          moduleId: "ready",
          value: {
            scope: "engine",
            create: () => "ready",
            dispose() {
              released.push("ready");
            },
          },
        },
        {
          key: "bad",
          moduleId: "bad",
          value: {
            scope: "engine",
            async create() {
              throw new Error("factory failed");
            },
          },
        },
        {
          key: "late",
          moduleId: "late",
          value: {
            scope: "engine",
            create: () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
            dispose() {
              released.push("late");
            },
          },
        },
      ],
      "engine",
      scope,
      {} as never,
      values,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(scope.disposed).toBe(true);
    expect(released).toEqual(["ready"]);
    expect(values).toEqual({});
    finish("late");
    await expect(pending).rejects.toThrow("Private service activation failed");
    expect(released).toEqual(["ready", "late"]);
  });

  test("already-cancelled private service initialization does not start factories", async () => {
    const scope = new LifetimeScope("session", "already-cancelled");
    const controller = new AbortController();
    const reason = new Error("cancelled before initialization");
    controller.abort(reason);
    let created = 0;
    const values = {};
    const pending = createPrivateServices(
      [
        {
          key: "not-started",
          moduleId: "not-started",
          value: {
            scope: "session",
            create() {
              created++;
            },
          },
        },
      ],
      "session",
      scope,
      {} as never,
      values,
      controller.signal,
    );
    const error = await pending.catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([reason]);
    expect(created).toBe(0);
    expect(scope.disposed).toBe(true);
    expect(values).toEqual({});
  });

  test("cancellation retains simultaneous factory and cleanup failures without starting later services", async () => {
    const scope = new LifetimeScope("session", "cancel-and-fail");
    const controller = new AbortController();
    const cancelled = new Error("initialization cancelled");
    const failed = new Error("factory failed during cancellation");
    const cleanup = new Error("owned cleanup failed");
    let released = 0;
    let laterCreated = 0;
    const values = {};
    const pending = createPrivateServices(
      [
        {
          key: "ready",
          moduleId: "ready",
          value: {
            scope: "session",
            create: () => "owned",
            dispose() {
              released++;
              throw cleanup;
            },
          },
        },
        {
          key: "cancel-and-fail",
          moduleId: "cancel-and-fail",
          value: {
            scope: "session",
            async create() {
              controller.abort(cancelled);
              throw failed;
            },
          },
        },
        {
          key: "later",
          moduleId: "later",
          value: {
            scope: "session",
            create() {
              laterCreated++;
            },
          },
        },
      ],
      "session",
      scope,
      {} as never,
      values,
      controller.signal,
    );
    const error = await pending.catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failed);
    expect(error.errors).toContain(cancelled);
    expect(error.errors.find((entry: unknown) => entry instanceof AggregateError)?.errors).toEqual([
      cleanup,
    ]);
    expect(released).toBe(1);
    expect(laterCreated).toBe(0);
    expect(values).toEqual({});
    await expect(scope.dispose()).rejects.toThrow("Disposal failed");
    expect(released).toBe(1);
  });

  test("an observer's captured query callback cannot leave a registration after its owner closes", async () => {
    const scope = new LifetimeScope("host", "late-observer");
    const queries = new Map();
    let register!: (type: string, handler: () => unknown) => unknown;
    const composition = compileComposition({
      modules: [
        {
          id: "observer",
          protocol: {
            queries: { owned: () => "fallback" },
            createObserver(ctx) {
              register = ctx.registerQuery;
              return {};
            },
          },
        },
      ],
    });
    await attachProtocolContributions({
      composition,
      scope,
      host,
      observers: [],
      queryHandlers: queries,
      closeObserver() {},
      warn() {},
    });
    await scope.dispose();
    expect(() => register("owned", () => "late")).toThrow("disposed");
    expect(queries.size).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileComposition } from "../composition/compiler.js";
import { appendInstallEntry, readInstalledPlugins } from "../plugins/installedPlugins.js";
import { installPluginFromPath } from "../plugins/installer/install.js";
import { updatePluginByName } from "../plugins/installer/update.js";
import { approvePlugin, revokePlugin } from "../plugins/native/approval.js";
import { nativeRuntimeRoot, removeNativeSnapshot } from "../plugins/native/snapshot.js";
import type { HookResult } from "../hooks/events.js";
import { NativePluginRuntime } from "./runtime.js";

const source = (version: string, extra = "") => `
export default { setup(ctx) {
  ctx.tools.register({ name: "lookup", description: "Look a ticket up",
    inputSchema: { type: "object", properties: {} },
    async execute(call) {
      if (call.input.mode === "exit") process.exit(3);
      if (call.input.mode === "root") return { content: ctx.plugin.root + "|" + process.env.CODESHELL_PLUGIN_ROOT };
      return { content: "${version}:" + (call.sessionId ?? "") };
    } });
  ctx.hooks.on("pre_tool_use", async (event) => {
    if (event.data.toolName === "Write") return { decision: "deny", messages: ["${version}"] };
    if (event.data.toolName === "Loop") { while (true) {} }
  }, { onError: "deny", timeoutMs: 300 });
  ${extra}
} };
`;

describe("native plugin runtime", () => {
  let home: string;
  let previousHome: string | undefined;
  let runtimeRoot: string;
  let runtime: NativePluginRuntime | undefined;
  let disabled: Map<string | undefined, string[]>;
  let clock: number | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "native-runtime-"));
    process.env.HOME = home;
    // Captured while HOME is the temporary one; cleanup never re-derives it.
    runtimeRoot = nativeRuntimeRoot();
    expect(runtimeRoot.startsWith(home)).toBe(true);
    disabled = new Map();
    clock = undefined;
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.close();
    removeNativeSnapshot(runtimeRoot);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeSource(name: string, code: string, tools = ["lookup", "extra"]): string {
    const dir = join(home, "sources", name);
    mkdirSync(join(dir, ".codeshell-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: 1,
        main: "./index.js",
        contributes: { hooks: ["pre_tool_use"], tools },
      }),
    );
    writeFileSync(join(dir, "index.js"), code);
    return dir;
  }

  async function install(name: string, code = source("v1"), approve = true): Promise<string> {
    const dir = writeSource(name, code);
    const installed = await installPluginFromPath(dir, name, "t1");
    if (approve) approvePlugin(name);
    return installed;
  }

  async function start(): Promise<NativePluginRuntime> {
    runtime = new NativePluginRuntime({
      hostKind: "desktop",
      baseModules: [],
      disabledPlugins: (sessionId) => disabled.get(sessionId) ?? [],
      sessionCwd: () => "/repo",
      pingTimeoutMs: 200,
      idleReapMs: 1_000,
      backgroundReviveMs: 50,
      now: () => clock ?? Date.now(),
    });
    await runtime.start();
    return runtime;
  }

  async function installBackground(name: string): Promise<void> {
    const dir = writeSource(name, source("v1", `ctx.effect(() => {});`));
    writeFileSync(
      join(dir, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: 1,
        main: "./index.js",
        contributes: { hooks: ["pre_tool_use"], tools: ["lookup"], background: true },
      }),
    );
    await installPluginFromPath(dir, name, "t1");
    approvePlugin(name);
  }

  function moduleOf(index = 0) {
    return runtime!.pluginModules()[index]!.module;
  }

  function hook(toolName: string, sessionId = "s-1", index = 0): Promise<HookResult> {
    return Promise.resolve(
      moduleOf(index).engine!.hooks![0]!.handler({
        eventName: "pre_tool_use",
        data: { toolName, args: {}, sessionId, preset: "general", isSubAgent: false },
      }),
    );
  }

  function tool(input: Record<string, unknown> = {}, sessionId = "s-1", index = 0) {
    return moduleOf(index).engine!.tools![0]!.tool.execute(input, {
      sessionId,
      cwd: "/repo",
    } as never);
  }

  const state = (installKey: string) =>
    runtime!.status().find((status) => status.installKey === installKey);

  test("loads an approved plugin into the composition and serves its hook and tool", async () => {
    await install("demo");
    await start();

    const modules = runtime!.pluginModules();
    expect(modules).toHaveLength(1);
    expect(modules[0]!.revision).toMatch(/^[a-f0-9]{64}$/);
    const composition = compileComposition({ pluginModules: modules });
    expect(composition.engine.tools.map((t) => t.tool.definition.name)).toContain(
      "plugin__demo__lookup",
    );

    expect(await hook("Write")).toEqual({ decision: "deny", messages: ["[demo] v1"] });
    expect(await hook("Read")).toEqual({});
    expect(await tool()).toEqual({ ok: true, result: "v1:s-1" });
    expect(state("demo@local")).toMatchObject({ state: "running", calls: 3, failures: 0 });
    expect(state("demo@local")?.pid).toBeGreaterThan(1);
  });

  test("runs the verified snapshot, not the install directory", async () => {
    const installed = await install("demo");
    await start();
    const reply = (await tool({ mode: "root" })) as { result: string };
    const [root, env] = reply.result.split("|");
    expect(root).toBe(env);
    expect(root!.startsWith(runtimeRoot)).toBe(true);
    expect(root).not.toBe(installed);
  });

  test("a plugin that was never approved gets no process", async () => {
    await install("demo", source("v1"), false);
    await start();
    expect(runtime!.pluginModules()).toEqual([]);
    expect(state("demo@local")).toMatchObject({ state: "pending", calls: 0 });
    expect(existsSync(join(runtimeRoot, ".pids"))).toBe(false);
  });

  test("a plugin that registers more than it announced is refused; the others still load", async () => {
    await install(
      "greedy",
      source(
        "v1",
        `ctx.tools.register({ name: "shell", description: "x", inputSchema: {}, execute() {} });`,
      ),
    );
    await install("demo");
    await start();
    expect(runtime!.pluginModules().map((m) => m.module.id)).toEqual([
      expect.stringMatching(/^plugin-demo-/),
    ]);
    expect(state("greedy@local")).toMatchObject({ state: "failed" });
    expect(state("greedy@local")?.error).toContain('tool "shell"');
    expect(await tool()).toEqual({ ok: true, result: "v1:s-1" });
  });

  test("two installs whose public names collide: the earlier one wins", async () => {
    const installed = await install("demo");
    appendInstallEntry("demo@other", readInstalledPlugins().plugins["demo@local"]![0]!);
    expect(installed).toBeTruthy();
    await start();
    expect(runtime!.pluginModules()).toHaveLength(1);
    expect(state("demo@local")?.state).toBe("running");
    expect(state("demo@other")).toMatchObject({ state: "failed" });
    expect(state("demo@other")?.error).toContain("plugin__demo__lookup");
  });

  test("a crashed process fails the call in flight and is started again by the next one", async () => {
    await install("demo");
    await start();
    const failed = (await tool({ mode: "exit" })) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("PLUGIN_UNAVAILABLE");

    expect(await tool()).toEqual({ ok: true, result: "v1:s-1" });
    expect(state("demo@local")).toMatchObject({ state: "running", restarts: 1 });
  });

  test("a handler stuck in a loop is denied by its own policy, killed, then given up on", async () => {
    await install("demo");
    await start();
    for (let round = 0; round < 3; round += 1) {
      const result = await hook("Loop");
      expect(result.decision).toBe("deny");
      // Wait for the liveness check to kill the process before the next round.
      const deadline = Date.now() + 5_000;
      while (state("demo@local")?.pid !== undefined && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state("demo@local")?.state).toBe("circuit-open");
    // A stopped plugin still fails closed where it asked to.
    expect((await hook("Write")).decision).toBe("deny");
    expect(((await tool()) as { error: string }).error).toContain("CIRCUIT_OPEN");

    expect(await runtime!.restart("demo@local")).toBe(true);
    expect(await hook("Write")).toEqual({ decision: "deny", messages: ["[demo] v1"] });
    expect(state("demo@local")?.state).toBe("running");
  }, 30_000);

  test("revoking takes effect at once in running sessions, without a restart", async () => {
    await install("demo");
    await start();
    expect((await hook("Write")).decision).toBe("deny");

    revokePlugin("demo");
    await runtime!.refresh();
    expect(await hook("Write")).toEqual({});
    expect(await tool()).toEqual({ ok: false, error: 'Plugin "demo" is no longer approved.' });
    expect(state("demo@local")?.state).toBe("pending");
    expect(state("demo@local")?.pid).toBeUndefined();

    approvePlugin("demo");
    await runtime!.refresh();
    expect((await hook("Write")).decision).toBe("deny");
    expect(state("demo@local")?.state).toBe("running");
  });

  test("a file changed in the install directory withdraws the plugin on refresh", async () => {
    const installed = await install("demo");
    await start();
    writeFileSync(join(installed, "index.js"), source("tampered"));
    await runtime!.refresh();
    expect(state("demo@local")?.state).toBe("changed");
    expect(await hook("Write")).toEqual({});
  });

  test("a plugin switched off for one session is silent there and unchanged elsewhere", async () => {
    await install("demo");
    await start();
    disabled.set("s-off", ["demo"]);
    expect(await hook("Write", "s-off")).toEqual({});
    expect(await tool({}, "s-off")).toEqual({
      ok: false,
      error: 'Plugin "demo" is disabled for this session.',
    });
    expect((await hook("Write", "s-1")).decision).toBe("deny");
  });

  test("an update that only changes code takes over in place", async () => {
    await install("demo");
    await start();
    const module = moduleOf();
    expect((await hook("Write")).messages).toEqual(["[demo] v1"]);

    writeSource("demo", source("v2"));
    await updatePluginByName("demo", "t2", true);
    // Updated but not yet approved: the old approved version is withdrawn.
    await runtime!.refresh();
    expect(state("demo@local")?.state).toBe("pending");
    expect(await hook("Write")).toEqual({});

    approvePlugin("demo");
    await runtime!.refresh();
    // The same module object, now served by the new code.
    expect(moduleOf()).toBe(module);
    expect((await hook("Write")).messages).toEqual(["[demo] v2"]);
    expect(await tool()).toEqual({ ok: true, result: "v2:s-1" });
    expect(state("demo@local")).toMatchObject({ state: "running" });
  });

  test("an update that declares something new waits for the next start", async () => {
    await install("demo");
    await start();
    writeSource(
      "demo",
      source(
        "v2",
        `ctx.tools.register({ name: "extra", description: "New", inputSchema: {}, execute() { return "x"; } });`,
      ),
    );
    await updatePluginByName("demo", "t2", true);
    approvePlugin("demo");
    await runtime!.refresh();

    expect(state("demo@local")).toMatchObject({ state: "restart-required" });
    // The version this composition was built with keeps serving.
    expect((await hook("Write")).messages).toEqual(["[demo] v1"]);
  });

  test("a plugin approved after the worker started is reported, not half-loaded", async () => {
    await install("demo");
    await start();
    await install("late");
    await runtime!.refresh();
    expect(state("late@local")).toMatchObject({ state: "restart-required" });
    expect(runtime!.pluginModules()).toHaveLength(1);
  });

  test("an idle plugin gives its process back and gets one again on the next call", async () => {
    await install("demo");
    await start();
    await tool();
    expect(state("demo@local")?.pid).toBeGreaterThan(1);

    clock = Date.now() + 60_000;
    runtime!.sweepIdle();
    const deadline = Date.now() + 5_000;
    while (state("demo@local")?.pid !== undefined && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state("demo@local")).toMatchObject({ state: "running" });
    expect(state("demo@local")?.pid).toBeUndefined();

    expect(await tool()).toEqual({ ok: true, result: "v1:s-1" });
    expect(state("demo@local")).toMatchObject({ state: "running", restarts: 0 });
  });

  test("a plugin with background logic is never reaped for being idle", async () => {
    const dir = writeSource("bg", source("v1", `ctx.effect(() => {});`));
    writeFileSync(
      join(dir, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: 1,
        main: "./index.js",
        contributes: { hooks: ["pre_tool_use"], tools: ["lookup"], background: true },
      }),
    );
    await installPluginFromPath(dir, "bg", "t1");
    approvePlugin("bg");
    await start();
    clock = Date.now() + 60_000;
    runtime!.sweepIdle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state("bg@local")?.pid).toBeGreaterThan(1);
  });

  test("a plugin with background logic comes back by itself after its process died", async () => {
    await installBackground("bg");
    await start();
    const first = state("bg@local")!.pid;
    expect(first).toBeGreaterThan(1);

    expect(((await tool({ mode: "exit" })) as { ok: boolean }).ok).toBe(false);
    // Nothing calls the plugin again; it is expected to be running anyway.
    const deadline = Date.now() + 5_000;
    while (
      (state("bg@local")?.pid === undefined || state("bg@local")?.pid === first) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state("bg@local")?.pid).toBeGreaterThan(1);
    expect(state("bg@local")?.pid).not.toBe(first);
    expect(state("bg@local")).toMatchObject({ state: "running", restarts: 1 });
  });

  test("closing stops every plugin process and leaves no record behind", async () => {
    await install("demo");
    await start();
    await tool();
    await runtime!.close();
    expect(readdirSync(join(runtimeRoot, ".pids"))).toEqual([]);
  });

  test("a call that arrives after closing is refused instead of starting a process again", async () => {
    await install("demo");
    await start();
    await runtime!.close();

    expect(((await tool()) as { error: string }).error).toContain("shutting down");
    // The gate still fails closed, as the plugin asked.
    expect((await hook("Write")).decision).toBe("deny");
    await runtime!.refresh();
    expect(state("demo@local")?.pid).toBeUndefined();
    expect(readdirSync(join(runtimeRoot, ".pids"))).toEqual([]);
  });
});

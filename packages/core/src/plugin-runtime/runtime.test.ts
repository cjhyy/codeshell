import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  /** A plugin with background logic, from `code`; installing it again updates it. */
  function writeBackgroundSource(name: string, code: string): string {
    const dir = writeSource(name, code);
    writeFileSync(
      join(dir, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: 1,
        main: "./index.js",
        contributes: { hooks: ["pre_tool_use"], tools: ["lookup"], background: true },
      }),
    );
    return dir;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

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

  test("a local edit leaves the plugin running; restarting it runs the edited code in place", async () => {
    const installed = await install("demo");
    await start();
    const module = moduleOf();
    const firstPid = state("demo@local")?.pid;
    writeFileSync(join(installed, "index.js"), source("edited"));
    await runtime!.refresh();
    // A settings reload does not pick up local edits on its own.
    expect(state("demo@local")?.state).toBe("running");
    expect((await hook("Write")).messages).toEqual(["[demo] v1"]);

    expect(await runtime!.restart("demo@local")).toBe(true);
    expect(moduleOf()).toBe(module);
    expect((await hook("Write")).messages).toEqual(["[demo] edited"]);
    expect(state("demo@local")).toMatchObject({ state: "running" });
    expect(state("demo@local")?.pid).not.toBe(firstPid);
    // One process serves; the one it replaced is gone.
    await waitFor(() => readdirSync(join(runtimeRoot, ".pids")).length === 1);
    expect(readdirSync(join(runtimeRoot, ".pids"))).toHaveLength(1);
  });

  test("a local edit that declares something new is reported on restart; the old code serves on", async () => {
    const installed = await install("demo");
    await start();
    writeFileSync(
      join(installed, "index.js"),
      source(
        "v2",
        `ctx.tools.register({ name: "extra", description: "New", inputSchema: {}, execute() { return "x"; } });`,
      ),
    );
    await runtime!.restart("demo@local");
    expect(state("demo@local")).toMatchObject({ state: "restart-required" });
    expect((await hook("Write")).messages).toEqual(["[demo] v1"]);
    await runtime!.refresh();
    expect(state("demo@local")).toMatchObject({ state: "restart-required" });
  });

  test("a broken local edit is reported and the old code keeps serving", async () => {
    const installed = await install("demo");
    await start();
    writeFileSync(
      join(installed, "index.js"),
      `export default { setup() { throw new Error("half-finished edit"); } };`,
    );
    await runtime!.restart("demo@local");
    expect(state("demo@local")).toMatchObject({ state: "failed" });
    expect(state("demo@local")?.error).toContain("half-finished edit");
    expect((await hook("Write")).messages).toEqual(["[demo] v1"]);
  });

  test("an update that takes over while a call waits for the old process to leave serves that call", async () => {
    // This plugin takes a while to leave once it is told to.
    const lingering = (version: string) =>
      source(
        version,
        `process.on("disconnect", () => { const end = Date.now() + 1200; while (Date.now() < end) {} });`,
      );
    await installPluginFromPath(writeSource("demo", lingering("v1")), "demo", "t1");
    approvePlugin("demo");
    await start();
    await tool();

    clock = Date.now() + 60_000;
    runtime!.sweepIdle();
    // The idle process is on its way out; this call waits for it to be gone.
    const waiting = tool();
    writeSource("demo", lingering("v2"));
    await updatePluginByName("demo", "t2", true);
    await runtime!.refresh();

    expect(await waiting).toEqual({ ok: true, result: "v2:s-1" });
    // The process that took over is the one serving; no second copy runs.
    await waitFor(() => readdirSync(join(runtimeRoot, ".pids")).length === 1, 8_000);
    expect(readdirSync(join(runtimeRoot, ".pids"))).toHaveLength(1);
  }, 20_000);

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
    // From the user's own directory, so the approval carries over.
    await updatePluginByName("demo", "t2", true);
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

    // Further reloads report it without starting the new version again.
    const log = join(runtimeRoot, ".logs", `${state("demo@local")!.moduleId}.log`);
    const starts = () => readFileSync(log, "utf8").split("started pid").length;
    const before = starts();
    await runtime!.refresh();
    await runtime!.refresh();
    expect(state("demo@local")).toMatchObject({ state: "restart-required" });
    expect(starts()).toBe(before);
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

  test("revoking a plugin while its process is starting stops that process too", async () => {
    const pids = join(home, "pids.log");
    const dir = writeBackgroundSource(
      "bg",
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default { async setup(ctx) {
  appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
  const marker = join(ctx.plugin.dataDir, "started-once");
  // Every start after the first takes a while: long enough to revoke meanwhile.
  if (existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 800));
  writeFileSync(marker, "");
  ctx.tools.register({ name: "lookup", description: "Look a ticket up",
    inputSchema: { type: "object", properties: {} },
    async execute(call) { if (call.input.mode === "exit") process.exit(3); return { content: "ok" }; } });
  ctx.hooks.on("pre_tool_use", async () => {});
  ctx.effect(() => {});
} };`,
    );
    await installPluginFromPath(dir, "bg", "t1");
    approvePlugin("bg");
    await start();
    const started = () =>
      existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : [];

    expect(((await tool({ mode: "exit" })) as { ok: boolean }).ok).toBe(false);
    // It comes back by itself; the user revokes it while its setup still runs.
    await waitFor(() => started().length === 2);
    revokePlugin("bg");
    await runtime!.refresh();
    // A start that slipped through would be serving well within this.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(alive(started()[1]!)).toBe(false);
    expect(state("bg@local")?.pid).toBeUndefined();
  }, 15_000);

  test("an update hands background logic over: the old copy cleans up before the new one starts", async () => {
    const log = join(home, "effects.log");
    const versioned = (version: string) =>
      `import { appendFileSync } from "node:fs";\n` +
      source(
        version,
        `ctx.effect(() => {
          appendFileSync(${JSON.stringify(log)}, "start ${version}\\n");
          return () => appendFileSync(${JSON.stringify(log)}, "cleanup ${version}\\n");
        });`,
      );
    await installPluginFromPath(writeBackgroundSource("bg", versioned("v1")), "bg", "t1");
    approvePlugin("bg");
    await start();
    await waitFor(() => existsSync(log));

    writeBackgroundSource("bg", versioned("v2"));
    await updatePluginByName("bg", "t2", true);
    approvePlugin("bg");
    await runtime!.refresh();
    await waitFor(() => readFileSync(log, "utf8").includes("start v2"));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "start v1",
      "cleanup v1",
      "start v2",
    ]);
  });

  test("calls this side cannot send do not count against the plugin", async () => {
    await install("demo");
    await start();
    const oversized = "x".repeat(1024 * 1024);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await moduleOf().engine!.hooks![0]!.handler({
        eventName: "pre_tool_use",
        data: {
          toolName: "Write",
          args: { content: oversized },
          sessionId: "s-1",
          preset: "general",
          isSubAgent: false,
        },
      });
      // Still fails closed, as the plugin asked.
      expect(result.decision).toBe("deny");
    }
    expect(state("demo@local")?.state).toBe("running");
    expect(await tool()).toEqual({ ok: true, result: "v1:s-1" });
  });

  test("a call that arrives while an idle process is leaving gets a fresh one", async () => {
    await install("demo");
    await start();
    await tool();
    clock = Date.now() + 60_000;
    runtime!.sweepIdle();
    // No wait: the reaped process is still on its way out.
    expect(await tool()).toEqual({ ok: true, result: "v1:s-1" });
    expect(state("demo@local")).toMatchObject({ state: "running", restarts: 0, failures: 0 });
  });

  test("a plugin that failed to load keeps its reason across a settings reload", async () => {
    await install("broken", `export default { setup() { throw new Error("cannot start"); } };`);
    await start();
    expect(state("broken@local")).toMatchObject({ state: "failed" });
    expect(state("broken@local")?.error).toContain("cannot start");

    await runtime!.refresh();
    expect(state("broken@local")).toMatchObject({ state: "failed" });
    expect(state("broken@local")?.error).toContain("cannot start");
  });

  test("registrations that skip the SDK are checked again: a timeout past the maximum is refused", async () => {
    await install(
      "odd",
      `export default { async setup() {
        // Answers the handshake itself instead of returning from setup.
        process.send({ t: "ready", declarations: {
          hooks: [{ event: "pre_tool_use", timeoutMs: 2000000000, onError: "ignore" }],
          tools: [], presets: [], presetExtensions: [], promptSections: [], context: [],
          background: false } });
        await new Promise(() => {});
      } };`,
    );
    await start();
    expect(state("odd@local")).toMatchObject({ state: "failed" });
    expect(state("odd@local")?.error).toContain("timeout");
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

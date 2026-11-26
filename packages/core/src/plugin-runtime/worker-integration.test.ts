import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileComposition } from "../composition/compiler.js";
import type { AgentModule } from "../composition/types.js";
import { installPluginFromPath } from "../plugins/installer/install.js";
import { approvePlugin, revokePlugin } from "../plugins/native/approval.js";
import { nativeRuntimeRoot, removeNativeSnapshot } from "../plugins/native/snapshot.js";
import {
  createNativePluginSessions,
  NATIVE_PLUGINS_LOG_QUERY,
  NATIVE_PLUGINS_MODULE_ID,
  NATIVE_PLUGINS_RESTART_QUERY,
  NATIVE_PLUGINS_STATUS_QUERY,
  nativePluginsRequested,
  startWorkerNativePlugins,
  type NativePluginsLogReply,
  type NativePluginsRestartReply,
  type NativePluginsStatusReply,
  type WorkerNativePlugins,
} from "./worker-integration.js";

const PLUGIN = `
export default { setup(ctx) {
  ctx.log.info("ready to look things up");
  ctx.tools.register({ name: "lookup", description: "Look a ticket up",
    inputSchema: { type: "object", properties: {} },
    async execute(call) { return { content: "found:" + (call.sessionId ?? "") }; } });
} };
`;

test("only a host that asks for it gets native plugins", () => {
  expect(nativePluginsRequested({})).toBe(false);
  expect(nativePluginsRequested({ CODE_SHELL_NATIVE_PLUGINS: "1" })).toBe(false);
  expect(nativePluginsRequested({ CODE_SHELL_NATIVE_PLUGINS: "host" })).toBe(true);
});

describe("per-session answers", () => {
  test("come from the live session, else from the user's list, and are reused briefly", () => {
    let clock = 1_000;
    let reads = 0;
    let projectList = ["demo"];
    const sessions = createNativePluginSessions({
      session: (sessionId) =>
        sessionId === "s-live"
          ? {
              cwd: "/repo",
              disabledPlugins: () => {
                reads += 1;
                return projectList;
              },
            }
          : undefined,
      userDisabledPlugins: () => ["everywhere"],
      now: () => clock,
    });

    expect(sessions.disabledPlugins("s-live")).toEqual(["demo"]);
    expect(sessions.disabledPlugins("s-gone")).toEqual(["everywhere"]);
    expect(sessions.disabledPlugins(undefined)).toEqual(["everywhere"]);
    expect(sessions.cwd("s-live")).toBe("/repo");
    expect(sessions.cwd("s-gone")).toBeUndefined();
    expect(sessions.cwd(undefined)).toBeUndefined();

    // A tool gate asks on every tool call; settings are not read each time.
    projectList = [];
    clock += 500;
    expect(sessions.disabledPlugins("s-live")).toEqual(["demo"]);
    expect(reads).toBe(1);

    clock += 2_000;
    expect(sessions.disabledPlugins("s-live")).toEqual([]);
    expect(reads).toBe(2);

    projectList = ["demo"];
    sessions.forget?.();
    expect(sessions.disabledPlugins("s-live")).toEqual(["demo"]);
  });

  test("settings that cannot be read keep the last answer", () => {
    let clock = 0;
    let broken = false;
    const sessions = createNativePluginSessions({
      session: () => ({
        cwd: "/repo",
        disabledPlugins: () => {
          if (broken) throw new Error("unreadable");
          return ["demo"];
        },
      }),
      userDisabledPlugins: () => [],
      now: () => clock,
    });
    expect(sessions.disabledPlugins("s-1")).toEqual(["demo"]);
    broken = true;
    clock += 10_000;
    expect(sessions.disabledPlugins("s-1")).toEqual(["demo"]);
  });
});

describe("native plugins in a worker", () => {
  let home: string;
  let previousHome: string | undefined;
  let runtimeRoot: string;
  let plugins: WorkerNativePlugins | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "native-worker-"));
    process.env.HOME = home;
    // Captured while HOME is the temporary one; cleanup never re-derives it.
    runtimeRoot = nativeRuntimeRoot();
    expect(runtimeRoot.startsWith(home)).toBe(true);
    plugins = undefined;
  });

  afterEach(async () => {
    await plugins?.close();
    removeNativeSnapshot(runtimeRoot);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function install(name: string): Promise<void> {
    const dir = join(home, "sources", name);
    mkdirSync(join(dir, ".codeshell-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: 1,
        main: "./index.js",
        contributes: { tools: ["lookup"] },
      }),
    );
    writeFileSync(join(dir, "index.js"), PLUGIN);
    await installPluginFromPath(dir, name, "t1");
    approvePlugin(name);
  }

  const hostModule: AgentModule = {
    id: "host-fixture",
    engine: { promptSections: { fixture: "A host section." } },
  };

  async function query<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    const composition = compileComposition({
      modules: plugins!.modules,
      pluginModules: plugins!.pluginModules,
    });
    const handler = composition.protocol.queries.find((q) => q.key === type)!.value;
    return (await handler(params)) as T;
  }

  test("a worker without native plugins still gets the status module, and an empty answer", async () => {
    plugins = await startWorkerNativePlugins({ hostKind: "desktop", modules: [hostModule] });
    expect(plugins.modules.map((module) => module.id)).toEqual([
      "host-fixture",
      NATIVE_PLUGINS_MODULE_ID,
    ]);
    expect(plugins.pluginModules).toEqual([]);
    expect(await query<NativePluginsStatusReply>(NATIVE_PLUGINS_STATUS_QUERY)).toEqual({
      plugins: [],
    });
  });

  test("an approved plugin joins the composition and can be inspected, restarted and read", async () => {
    await install("demo");
    plugins = await startWorkerNativePlugins({ hostKind: "desktop", modules: [hostModule] });

    const composition = compileComposition({
      modules: plugins.modules,
      pluginModules: plugins.pluginModules,
    });
    expect(composition.modules.map((module) => [module.id, module.source])).toEqual([
      ["core", "core"],
      ["host-fixture", "host"],
      [NATIVE_PLUGINS_MODULE_ID, "host"],
      [expect.stringMatching(/^plugin-demo-/), "plugin"],
    ]);
    const lookup = composition.engine.tools.find(
      (tool) => tool.tool.definition.name === "plugin__demo__lookup",
    )!;
    expect(await lookup.tool.execute({}, { sessionId: "s-1", cwd: "/repo" } as never)).toEqual({
      ok: true,
      result: "found:s-1",
    });

    const status = await query<NativePluginsStatusReply>(NATIVE_PLUGINS_STATUS_QUERY);
    expect(status.plugins).toHaveLength(1);
    expect(status.plugins[0]).toMatchObject({
      installKey: "demo@local",
      plugin: "demo",
      state: "running",
      calls: 1,
    });
    const pid = status.plugins[0]!.pid;
    expect(pid).toBeGreaterThan(1);

    const log = await query<NativePluginsLogReply>(NATIVE_PLUGINS_LOG_QUERY, {
      installKey: "demo@local",
    });
    expect(log.text).toContain(`started pid ${pid}`);
    expect(log.text).toContain("[info] ready to look things up");
    // A caller names a plugin, never a file.
    expect(
      await query<NativePluginsLogReply>(NATIVE_PLUGINS_LOG_QUERY, { installKey: "../../etc" }),
    ).toEqual({ text: "" });
    await expect(query(NATIVE_PLUGINS_LOG_QUERY, {})).rejects.toThrow("installKey is required");

    const restarted = await query<NativePluginsRestartReply>(NATIVE_PLUGINS_RESTART_QUERY, {
      installKey: "demo@local",
    });
    expect(restarted.restarted).toBe(true);
    expect(restarted.plugins[0]?.pid).toBeUndefined();
    expect(
      (await query<NativePluginsRestartReply>(NATIVE_PLUGINS_RESTART_QUERY, { installKey: "x@y" }))
        .restarted,
    ).toBe(false);
    // The next call starts it again.
    expect(await lookup.tool.execute({}, { sessionId: "s-2", cwd: "/repo" } as never)).toEqual({
      ok: true,
      result: "found:s-2",
    });
  });

  test("sessions bound later decide who a plugin is switched off for; a refresh applies a revoke", async () => {
    await install("demo");
    plugins = await startWorkerNativePlugins({ hostKind: "desktop", modules: [] });
    const lookup = plugins.pluginModules[0]!.module.engine!.tools![0]!.tool;
    const call = (sessionId: string) =>
      lookup.execute({}, { sessionId, rootSessionId: sessionId, cwd: "/repo" } as never);

    // Before any session exists nothing is switched off.
    expect(await call("s-off")).toEqual({ ok: true, result: "found:s-off" });

    plugins.bindSessions(
      createNativePluginSessions({
        session: (sessionId) =>
          sessionId === "s-off" ? { cwd: "/repo", disabledPlugins: () => ["demo"] } : undefined,
        userDisabledPlugins: () => [],
      }),
    );
    expect(await call("s-off")).toEqual({
      ok: false,
      error: 'Plugin "demo" is disabled for this session.',
    });
    expect(await call("s-on")).toEqual({ ok: true, result: "found:s-on" });

    revokePlugin("demo");
    plugins.refresh();
    const deadline = Date.now() + 5_000;
    while (plugins.status()[0]?.state === "running" && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plugins.status()[0]?.state).toBe("pending");
    expect(await call("s-on")).toEqual({
      ok: false,
      error: 'Plugin "demo" is no longer approved.',
    });
  });
});

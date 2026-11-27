import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginCallError,
  PluginProcess,
  reapLeftoverPluginProcesses,
  type PluginExitReason,
  type PluginProcessSpec,
} from "./process.js";

const PLUGIN = `
let cancelled = 0;
export default {
  setup(ctx) {
    globalThis.ctx = ctx;
    ctx.prompt.section("role", "You review code.");
    ctx.presets.add({ name: "reviewer", label: "Reviewer", builtinTools: ["Read", "lookup"],
      promptSections: ["role"], defaultPermissionRules: [{ tool: "lookup", decision: "allow" }] });
    ctx.presets.extend(["general"], ["lookup"]);
    ctx.context.provide("status", async (info) => "cwd=" + info.cwd);
    ctx.tools.register({ name: "lookup", description: "Look a ticket up",
      inputSchema: { type: "object", properties: { id: { type: "string" } } }, readOnly: true,
      async execute(call) { return { content: "ticket " + call.input.id }; } });
    ctx.hooks.on("pre_tool_use", async (event, { signal }) => {
      const tool = event.data.toolName;
      if (tool === "Write") return { decision: "deny", messages: ["read only"] };
      if (tool === "Throw") throw new Error("boom");
      if (tool === "Env") return { messages: Object.keys(process.env).sort() };
      if (tool === "Late") { ctx.hooks.on("on_stop", () => {}); }
      if (tool === "Slow") {
        signal.addEventListener("abort", () => { cancelled += 1; });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (tool === "Cancelled") return { messages: [String(cancelled)] };
      if (tool === "Loop") { while (true) {} }
      if (tool === "Print") { console.log("printed line"); ctx.log.warn("logged line"); }
      if (tool === "Exit") process.exit(7);
    }, { onError: "deny", timeoutMs: 1000 });
    ctx.effect(() => {});
  },
};
`;

describe("plugin process", () => {
  let home: string;
  let processes: PluginProcess[];
  let exits: PluginExitReason[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plugin-process-"));
    processes = [];
    exits = [];
  });

  afterEach(async () => {
    await Promise.all(processes.map((process) => process.stop()));
    rmSync(home, { recursive: true, force: true });
  });

  function spec(source = PLUGIN): PluginProcessSpec {
    const root = join(home, `root-${processes.length}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.js"), source);
    return {
      moduleId: "plugin-demo-0123abcd",
      plugin: "demo",
      installKey: "demo@local",
      root,
      main: "index.js",
      dataDir: join(home, "data"),
      logFile: join(home, "logs", "demo.log"),
      pidDir: join(home, "pids"),
      apiVersion: 1,
      hostKind: "desktop",
    };
  }

  function create(source?: string, options: { setupTimeoutMs?: number } = {}): PluginProcess {
    const process = new PluginProcess(spec(source), {
      pingTimeoutMs: 200,
      ...options,
      onExit: (info) => exits.push(info.reason),
    });
    processes.push(process);
    return process;
  }

  const hook = (process: PluginProcess, toolName: string, timeoutMs = 2_000) =>
    process.invoke(
      "hook",
      "pre_tool_use",
      { name: "pre_tool_use", isSubAgent: false, data: { toolName } },
      { timeoutMs },
    );

  async function rejection(promise: Promise<unknown>): Promise<PluginCallError> {
    try {
      await promise;
    } catch (error) {
      return error as PluginCallError;
    }
    throw new Error("expected the call to fail");
  }

  test("setup reports everything the plugin registered as plain data", async () => {
    const declarations = await create().start();
    expect(declarations).toEqual({
      hooks: [{ event: "pre_tool_use", timeoutMs: 1000, onError: "deny" }],
      tools: [
        {
          name: "lookup",
          description: "Look a ticket up",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          readOnly: true,
          concurrencySafe: false,
          timeoutMs: 120_000,
          exposure: "preset",
        },
      ],
      presets: [
        {
          name: "reviewer",
          label: "Reviewer",
          description: "",
          promptSections: ["role"],
          builtinTools: ["Read", "lookup"],
          defaultPermissionRules: [{ tool: "lookup", decision: "allow" }],
        },
      ],
      presetExtensions: [{ target: { presets: ["general"] }, tools: ["lookup"] }],
      promptSections: [{ name: "role", text: "You review code." }],
      context: [{ name: "status" }],
      background: true,
    });
  });

  test("serves hook, tool and context calls", async () => {
    const process = create();
    await process.start();
    expect(await hook(process, "Write")).toEqual({ decision: "deny", messages: ["read only"] });
    expect(await hook(process, "Read")).toBeNull();
    expect(
      await process.invoke("tool", "lookup", { input: { id: "T-1" } }, { timeoutMs: 2_000 }),
    ).toEqual({ content: "ticket T-1" });
    expect(await process.invoke("context", "status", { cwd: "/repo" }, { timeoutMs: 2_000 })).toBe(
      "cwd=/repo",
    );
  });

  test("a handler error or an unknown name fails that call only", async () => {
    const process = create();
    await process.start();
    expect(await rejection(hook(process, "Throw"))).toMatchObject({
      code: "HANDLER_ERROR",
      message: "boom",
    });
    expect(
      await rejection(process.invoke("tool", "missing", {}, { timeoutMs: 2_000 })),
    ).toMatchObject({ code: "NOT_REGISTERED" });
    expect(await rejection(hook(process, "Late"))).toMatchObject({ code: "NOT_REGISTERING" });
    expect(await hook(process, "Write")).toMatchObject({ decision: "deny" });
  });

  test("the process only sees allowlisted environment plus its own root and data paths", async () => {
    globalThis.process.env.PLUGIN_TEST_API_TOKEN = "must-not-leak";
    try {
      const process = create();
      await process.start();
      const reply = (await hook(process, "Env")) as { messages: string[] };
      expect(reply.messages).toContain("CODESHELL_PLUGIN_ROOT");
      expect(reply.messages).toContain("CODESHELL_PLUGIN_DATA");
      expect(reply.messages).toContain("PATH");
      expect(reply.messages).not.toContain("PLUGIN_TEST_API_TOKEN");
    } finally {
      delete globalThis.process.env.PLUGIN_TEST_API_TOKEN;
    }
  });

  test("a slow handler times out, is told to cancel and the process keeps serving", async () => {
    const process = create();
    await process.start();
    expect(await rejection(hook(process, "Slow", 150))).toMatchObject({ code: "TIMEOUT" });
    // It answered the liveness check, so it was not killed.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(process.isReady).toBe(true);
    expect(await hook(process, "Cancelled")).toEqual({ messages: ["1"] });
    expect(process.stats.timeouts).toBe(1);
  });

  test("an aborted call is cancelled without waiting for its deadline", async () => {
    const process = create();
    await process.start();
    const controller = new AbortController();
    const pending = process.invoke(
      "hook",
      "pre_tool_use",
      { name: "pre_tool_use", isSubAgent: false, data: { toolName: "Slow" } },
      { timeoutMs: 10_000, signal: controller.signal },
    );
    controller.abort();
    expect(await rejection(pending)).toMatchObject({ code: "CANCELLED" });
    expect(await hook(process, "Cancelled")).toEqual({ messages: ["1"] });
  });

  test("a handler stuck in a synchronous loop gets the process killed", async () => {
    const process = create();
    await process.start();
    const started = Date.now();
    expect(await rejection(hook(process, "Loop", 150))).toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
    const deadline = Date.now() + 5_000;
    while (process.isReady && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(process.isReady).toBe(false);
    expect(exits).toEqual(["unresponsive"]);
    expect(await rejection(hook(process, "Read"))).toMatchObject({ code: "PLUGIN_UNAVAILABLE" });
  });

  test("a process that exits on its own fails what was in flight and reports a crash", async () => {
    const process = create();
    await process.start();
    expect(await rejection(hook(process, "Exit"))).toMatchObject({ code: "PLUGIN_UNAVAILABLE" });
    expect(exits).toEqual(["crashed"]);
  });

  test("more calls than fit in flight wait their turn and all complete", async () => {
    const process = create(`export default { setup(ctx) {
      ctx.hooks.on("pre_tool_use", async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { messages: [String(event.data.n)] };
      });
    } };`);
    await process.start();
    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, n) =>
        process.invoke(
          "hook",
          "pre_tool_use",
          { name: "pre_tool_use", isSubAgent: false, data: { n } },
          { timeoutMs: 5_000 },
        ),
      ),
    );
    expect(replies.map((reply) => (reply as { messages: string[] }).messages[0])).toEqual(
      Array.from({ length: 40 }, (_, n) => String(n)),
    );
    expect(process.inFlight).toBe(0);
  });

  test("a setup that throws, or never returns, fails the start and leaves no process", async () => {
    const throwing = create(`export default { setup() { throw new Error("bad setup"); } };`);
    expect((await rejection(throwing.start())).message).toContain("bad setup");
    expect(throwing.isReady).toBe(false);

    const hanging = create(`export default { setup() { while (true) {} } };`, {
      setupTimeoutMs: 300,
    });
    expect((await rejection(hanging.start())).message).toContain("did not finish setup");

    const shapeless = create(`export default 42;`);
    expect((await rejection(shapeless.start())).message).toContain("default export");
    // The start fails as soon as the kill is sent; the exits follow.
    const deadline = Date.now() + 5_000;
    while (exits.length < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual(["setup", "setup", "setup"]);
  });

  test("stdout and ctx.log end up in the plugin's log file, not on the channel", async () => {
    const process = create();
    await process.start();
    await hook(process, "Print");
    await process.stop();
    const log = readFileSync(join(home, "logs", "demo.log"), "utf8");
    expect(log).toContain("[stdout] printed line");
    expect(log).toContain("[warn] logged line");
    expect(log).toContain("exited code=0");
  });

  test("stopping closes the channel, the process leaves and its record is removed", async () => {
    const process = create();
    await process.start();
    expect(readdirSync(join(home, "pids"))).toHaveLength(1);
    await process.stop();
    expect(process.isReady).toBe(false);
    expect(exits).toEqual(["requested"]);
    expect(readdirSync(join(home, "pids"))).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "a process left spinning by a killed worker is stopped by the next one",
    async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const root = join(home, "orphan-root");
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "index.js"),
        `export default { setup(ctx) { ctx.hooks.on("pre_tool_use", () => { while (true) {} }); } };`,
      );
      const script = join(home, "worker.ts");
      writeFileSync(
        script,
        `import { PluginProcess } from ${JSON.stringify(join(here, "process.ts"))};
         const plugin = new PluginProcess(${JSON.stringify({
           ...spec(),
           root,
         })});
         await plugin.start();
         plugin.invoke("hook", "pre_tool_use", { data: {} }, { timeoutMs: 60000 }).catch(() => {});
         setTimeout(() => { console.log("spinning " + plugin.stats.pid); }, 300);
         setInterval(() => {}, 1000);`,
      );
      const worker = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
      const pid = await new Promise<number>((resolve, reject) => {
        worker.stdout.on("data", (chunk: Buffer) => {
          const match = /spinning (\d+)/.exec(chunk.toString());
          if (match) resolve(Number(match[1]));
        });
        worker.once("exit", () => reject(new Error("worker exited early")));
      });
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      worker.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The plugin never saw the channel close: it is still burning a core.
      expect(alive()).toBe(true);

      expect(await reapLeftoverPluginProcesses(join(home, "pids"))).toEqual([
        "plugin-demo-0123abcd",
      ]);
      expect(alive()).toBe(false);
      expect(readdirSync(join(home, "pids"))).toEqual([]);
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "another worker starting does not stop a live worker's plugin",
    async () => {
      const plugin = create();
      await plugin.start();
      // What a second worker sharing this home directory does when it starts.
      expect(await reapLeftoverPluginProcesses(join(home, "pids"))).toEqual([]);
      expect(plugin.isReady).toBe(true);
      expect(readdirSync(join(home, "pids"))).toHaveLength(1);
      expect(await hook(plugin, "Write")).toEqual({ decision: "deny", messages: ["read only"] });
    },
  );

  const EFFECTS = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default { setup(ctx) {
  const note = (line) => appendFileSync(join(ctx.plugin.dataDir, "effects.log"), line + "\\n");
  ctx.effect((signal) => {
    note("started");
    signal.addEventListener("abort", () => note("aborted"));
    return () => note("cleaned up");
  });
} };
`;

  const effects = () => {
    try {
      return readFileSync(join(home, "data", "effects.log"), "utf8")
        .trim()
        .split("\n");
    } catch {
      return [];
    }
  };

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

  test("stopping aborts the plugin's background logic and runs its cleanup", async () => {
    const plugin = create(EFFECTS);
    await plugin.start();
    plugin.setBackground(true);
    await waitFor(() => effects().includes("started"));
    await plugin.stop();
    expect(effects()).toEqual(["started", "aborted", "cleaned up"]);
  });

  test("background logic can be stopped on its own, and the call returns once it is cleaned up", async () => {
    const plugin = create(EFFECTS);
    await plugin.start();
    plugin.setBackground(true);
    await waitFor(() => effects().includes("started"));
    await plugin.stopBackground();
    expect(effects()).toEqual(["started", "aborted", "cleaned up"]);
    // The process itself keeps serving.
    expect(plugin.isReady).toBe(true);
  });

  const SPAWNS = `
import { spawn } from "node:child_process";
export default { setup(ctx) {
  ctx.hooks.on("pre_tool_use", async (event) => {
    if (event.data.toolName === "Spawn") {
      const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      return { messages: [String(child.pid)] };
    }
    if (event.data.toolName === "Crash") {
      // Longer than one log message holds: the line is cut, not lost.
      setTimeout(() => { throw new Error("async boom " + "x".repeat(9000)); }, 10);
    }
    return null;
  });
} };
`;

  test.skipIf(process.platform === "win32")(
    "what a plugin started does not outlive it, whether it was stopped or crashed",
    async () => {
      const stopped = create(SPAWNS);
      await stopped.start();
      const first = Number(((await hook(stopped, "Spawn")) as { messages: string[] }).messages[0]);
      expect(alive(first)).toBe(true);
      await stopped.stop();
      await waitFor(() => !alive(first));
      expect(alive(first)).toBe(false);

      const crashing = create(SPAWNS);
      await crashing.start();
      const second = Number(
        ((await hook(crashing, "Spawn")) as { messages: string[] }).messages[0],
      );
      await hook(crashing, "Crash");
      await waitFor(() => exits.length === 2);
      expect(exits).toEqual(["requested", "crashed"]);
      await waitFor(() => !alive(second));
      expect(alive(second)).toBe(false);
    },
    15_000,
  );

  test("a plugin that crashes says why in its log before it goes", async () => {
    const plugin = create(SPAWNS);
    await plugin.start();
    await hook(plugin, "Crash");
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual(["crashed"]);
    const log = readFileSync(join(home, "logs", "demo.log"), "utf8");
    expect(log).toContain("uncaught exception");
    expect(log).toContain("async boom");
  });

  test("reaping never signals a process whose record does not match it", async () => {
    mkdirSync(join(home, "pids"), { recursive: true });
    // This test process's own id with a token it does not carry.
    writeFileSync(
      join(home, "pids", "self.json"),
      JSON.stringify({
        pid: process.pid,
        token: "00000000-0000-0000-0000-000000000000",
        moduleId: "plugin-other-00000000",
      }),
    );
    writeFileSync(join(home, "pids", "broken.json"), "{ not json");
    expect(await reapLeftoverPluginProcesses(join(home, "pids"))).toEqual([]);
    expect(existsSync(join(home, "pids", "self.json"))).toBe(false);
    expect(await reapLeftoverPluginProcesses(join(home, "missing"))).toEqual([]);
  });
});

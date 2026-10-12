import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateMessageOptions } from "../../packages/core/src/llm/types.js";
import type { ContentBlock, LLMResponse, Message } from "../../packages/core/src/types.js";

const [scenario, directory] = process.argv.slice(2);
const socketPath = join(directory, "driver.sock");
const logPath = join(directory, "events.jsonl");
assert.equal(realpathSync(homedir()), process.env.HOME);
assert.equal(process.env.CODE_SHELL_HOME, join(process.env.HOME!, ".code-shell"));
let unexpectedNetworkCalls = 0;
const deny = () => {
  unexpectedNetworkCalls++;
  throw new Error("Cua integration denies network");
};
globalThis.fetch = deny as unknown as typeof fetch;
for (const transport of [http, https]) {
  transport.request = deny as typeof transport.request;
  transport.get = deny as typeof transport.get;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const address = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { path?: string } | string;
  if ((typeof address === "string" ? address : address?.path) !== socketPath) return deny();
  return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();
// Check the guards before importing Core or constructing a provider.
assert.throws(() => fetch("https://example.invalid"), /denies network/);
assert.throws(() => http.get("http://127.0.0.1:9"), /denies network/);
assert.throws(() => net.createConnection({ port: 9, host: "127.0.0.1" }), /denies network/);
unexpectedNetworkCalls = 0;

const { Engine } = await import("../../packages/core/src/engine/engine.js");
const { LLMClientBase } = await import("../../packages/core/src/llm/client-base.js");
const { registerProvider, PROVIDER_REGISTRY } =
  await import("../../packages/core/src/llm/client-factory.js");
const { mergePluginMcpServers } =
  await import("../../packages/core/src/plugins/installer/loadPluginMcp.js");
const { HOST_MCP_SERVERS_ENV } =
  await import("../../packages/core/src/tool-system/host-mcp-servers.js");
const { CuaDriverHost } =
  await import("../../packages/desktop/src/main/computer-use/cua-driver-host.js");
const { initCuaComputerUse, hostMcpServersEnv, resetCuaComputerUse } =
  await import("../../packages/desktop/src/main/computer-use/service.js");

function nodeExecutable(): string {
  for (const part of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const candidate = realpathSync(join(part, "node"));
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Use only an already installed Node. */
    }
  }
  throw new Error("The simulated Cua executable requires installed Node");
}

const source = readFileSync(
  fileURLToPath(new URL("./cua-driver-spike-driver.mjs", import.meta.url)),
  "utf8",
);
const driverPath = join(directory, "cua-driver.mjs");
writeFileSync(driverPath, `#!${nodeExecutable()}\n${source}`, { mode: 0o700 });
writeFileSync(
  join(directory, "control.json"),
  JSON.stringify({
    readyDelayMs: scenario === "delayed" ? 1000 : 0,
    holdObservation: scenario === "cancel",
    holdClick: scenario === "restart",
  }),
);
const cwd = join(directory, "workspace");
mkdirSync(cwd);
const provider = "cua-spike-local-fixture";
const toolPrefix = "mcp_host_cua-driver_";
const calls: Array<{ messages: Message[]; tools: string[] }> = [];
let script: Array<{ tool: string; args?: Record<string, unknown> }> = [];
let finalText = "15";
let operationCount = 0;

function resultBlocks(messages: Message[]): ContentBlock[] {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "tool_result");
}

class CalculatorClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    if (options.requestVisible === false) throw new Error("Unexpected auxiliary model request");
    const snapshot = {
      messages: structuredClone(options.messages),
      tools: (options.tools ?? []).map((tool) => tool.name),
    };
    calls.push(snapshot);
    const requiredTools = ["check_permissions", "observe", "click"].map(
      (tool) => `${toolPrefix}${tool}`,
    );
    if (scenario === "generic") requiredTools.push("MCPTool");
    if (scenario !== "disabled" && !requiredTools.every((tool) => snapshot.tools.includes(tool))) {
      assert.ok(snapshot.tools.includes("ToolSearch"));
      const response: LLMResponse = {
        text: "",
        toolCalls: [
          {
            id: "discover-cua",
            toolName: "ToolSearch",
            args: { query: `select:${requiredTools.join(",")}` },
          },
        ],
        stopReason: "tool_use",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
      this.recordUsage(response.usage!, options);
      return response;
    }
    if (scenario === "restart" && operationCount === 3) {
      const failure = resultBlocks(snapshot.messages).find(
        (block) => block.tool_use_id === "cua-3",
      )!;
      assert.equal(failure.is_error, true, "Interrupted action must reach the model as an error");
      await waitFor(
        () => host!.status().generation === 2 && host!.status().state === "running",
        "replacement daemon at the model boundary",
      );
      assert.equal(events().filter((event) => event.phase === "clicked").length, 1);
      assert.equal(
        events().filter((event) => event.phase === "started" && event.mode === "mcp").length,
        1,
        "A closed transport must reconnect only for the next explicit invocation",
      );
    }
    const step = script.shift();
    if (scenario !== "disabled") {
      assert.ok(
        snapshot.tools.includes(`${toolPrefix}check_permissions`),
        JSON.stringify(snapshot.tools),
      );
      assert.ok(snapshot.tools.includes(`${toolPrefix}observe`));
      assert.ok(snapshot.tools.includes(`${toolPrefix}click`));
    } else assert.ok(snapshot.tools.every((tool) => !tool.startsWith(toolPrefix)));
    const result: LLMResponse = {
      text: step ? "" : finalText,
      toolCalls: step
        ? [
            {
              id: `cua-${++operationCount}`,
              toolName: scenario === "generic" ? "MCPTool" : `${toolPrefix}${step.tool}`,
              args:
                scenario === "generic"
                  ? { server: "host:cua-driver", tool: step.tool, arguments: step.args ?? {} }
                  : (step.args ?? {}),
            },
          ]
        : [],
      stopReason: step ? "tool_use" : "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    this.recordUsage(result.usage!, options);
    return result;
  }
}
registerProvider(provider, CalculatorClient);
const engines: InstanceType<typeof Engine>[] = [];
let host: InstanceType<typeof CuaDriverHost> | undefined;

function createEngine() {
  const merged = mergePluginMcpServers({});
  if (scenario === "disabled") assert.deepEqual(merged, {});
  else {
    assert.equal(merged["host:cua-driver"].inlineImages, true);
    assert.equal(merged["host:cua-driver"].command, driverPath);
    assert.equal(mergePluginMcpServers(merged)["host:cua-driver"].command, driverPath);
    const user = { name: "host:cua-driver", command: "/user-choice", enabled: false };
    assert.equal(mergePluginMcpServers({ "host:cua-driver": user })["host:cua-driver"], user);
  }
  const engine = new Engine({
    cwd,
    settingsScope: "isolated",
    projectTrusted: true,
    sessionStorageDir: join(directory, "sessions-" + engines.length),
    llm: {
      provider,
      providerKind: "openai",
      model: "gpt-5",
      apiKey: "synthetic-local",
    },
    enabledBuiltinTools: scenario === "generic" ? ["MCPTool"] : [],
    permissionMode: "bypassPermissions",
    sandbox: { mode: "off", writableRoots: [], deniedReads: [], network: "deny" },
    clientDefaults: { fetch: deny as unknown as typeof fetch },
    headless: true,
    maxTurns: 12,
    mcpServers: merged,
    behaviorProfiles: [
      {
        id: "cua-fixture",
        disableInstructions: true,
        disableMemoryContext: true,
        disableSessionTitle: true,
        disableHooks: true,
      },
    ],
  });
  engines.push(engine);
  return engine;
}

function events(): Array<Record<string, any>> {
  return existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
async function waitFor(predicate: () => boolean, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}: ${JSON.stringify(events())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  try {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  } finally {
    await host?.stop();
    await resetCuaComputerUse();
    delete process.env[HOST_MCP_SERVERS_ENV];
  }
}
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(1));
});

try {
  const decision = initCuaComputerUse({
    flags: scenario === "disabled" ? {} : { computer_use_cua: true },
    platform: "darwin",
    isPackaged: false,
    env: { CODESHELL_CUA_DRIVER_PATH: driverPath },
    createHost: (options) =>
      new CuaDriverHost({
        ...options,
        socketPath,
        parentEnv: { ...process.env, CODESHELL_CUA_TEST_SECRET: "fixture-sentinel" },
      }),
  });
  if (scenario === "disabled") {
    assert.deepEqual(decision, { enabled: false, reason: "flag_off" });
    assert.equal(hostMcpServersEnv(), undefined);
    // The worker spawn applies undefined as deletion; an inherited value must
    // not survive an off decision.
    process.env[HOST_MCP_SERVERS_ENV] = '{"host:inherited":{"command":"must-not-run"}}';
    const declaration = hostMcpServersEnv();
    if (declaration === undefined) delete process.env[HOST_MCP_SERVERS_ENV];
    script = [{ tool: "click", args: { key: "7" } }];
    finalText = "Cua unavailable";
    const result = await createEngine().run("Attempt the hidden Cua click", {
      behaviorMode: "cua-fixture",
    });
    assert.equal(result.reason, "completed");
    const failure = resultBlocks(calls.at(-1)!.messages).at(-1)!;
    assert.equal(failure.is_error, true);
    assert.match(String(failure.content), /not found|not available|unknown tool/i);
    assert.deepEqual(events(), []);
  } else {
    assert.equal(decision.enabled, true);
    if (!decision.enabled) throw new Error("Expected host");
    host = decision.host;
    const startup = host.start();
    if (scenario === "delayed") {
      assert.equal(host.status().state, "starting");
      assert.equal(hostMcpServersEnv(host), undefined);
      assert.deepEqual(mergePluginMcpServers({}), {});
    }
    await startup;
    process.env[HOST_MCP_SERVERS_ENV] = hostMcpServersEnv(host)!;
    const engine = createEngine();
    if (scenario === "cancel") {
      script = [{ tool: "observe" }];
      const abort = new AbortController();
      const running = engine.run("Wait for the simulated screenshot", {
        behaviorMode: "cua-fixture",
        signal: abort.signal,
      });
      await waitFor(
        () => events().some((event) => event.phase === "observation-blocked"),
        "pending observation",
      );
      abort.abort();
      const result = await running;
      assert.equal(result.reason, "aborted_streaming");
      assert.equal(calls.length, 2);
      await waitFor(
        () => events().some((event) => event.phase === "cancelled"),
        "MCP cancellation notification",
      );
      assert.ok(events().every((event) => event.phase !== "clicked"));
    } else if (scenario === "restart") {
      script = [
        { tool: "check_permissions" },
        { tool: "observe" },
        { tool: "click", args: { key: "7" } },
        { tool: "observe" },
      ];
      finalText = "reobserved after restart";
      const running = engine.run(
        "Click 7 once; if interrupted, observe again without repeating the click",
        {
          behaviorMode: "cua-fixture",
          onStream: (event) => {
            if (event.type === "error") console.error(event.error);
          },
        },
      );
      await waitFor(
        () => events().some((event) => event.phase === "action-blocked"),
        "in-flight click",
      );
      const firstDaemon = events().find(
        (event) => event.phase === "started" && event.mode === "serve",
      )!;
      const firstProxy = events().find(
        (event) => event.phase === "started" && event.mode === "mcp",
      )!;
      process.kill(firstDaemon.pid, "SIGKILL");
      const result = await running;
      assert.equal(result.reason, "completed", result.text);
      assert.equal(result.text, finalText);
      assert.equal(script.length, 0);
      const blocks = resultBlocks(calls.at(-1)!.messages);
      assert.equal(blocks.find((block) => block.tool_use_id === "cua-3")!.is_error, true);
      const observation = blocks.find((block) => block.tool_use_id === "cua-4")!;
      assert.ok(!observation.is_error, String(observation.content));
      assert.ok(Array.isArray(observation.content));
      assert.match(observation.content[0].text!, /"display":"0"/);
      assert.ok(observation.content.some((block) => block.type === "image" && block.source?.data));
      assert.deepEqual(
        events()
          .filter((event) => event.phase === "clicked")
          .map((event) => event.key),
        ["7"],
      );
      assert.deepEqual(
        events()
          .filter((event) => event.phase === "tool")
          .map((event) => event.tool),
        ["check_permissions", "observe", "click", "observe"],
      );
      const proxies = events().filter((event) => event.phase === "started" && event.mode === "mcp");
      assert.equal(proxies.length, 2);
      assert.notEqual(proxies[0].pid, proxies[1].pid);
      assert.ok(
        events().some(
          (event) => event.pid === firstProxy.pid && event.phase === "control-disconnected",
        ),
      );
      assert.equal(alive(firstProxy.pid), false);
    } else {
      script = [
        { tool: "check_permissions" },
        { tool: "observe" },
        ...["7", "+", "8", "="].map((key) => ({ tool: "click", args: { key } })),
        { tool: "observe" },
      ];
      const result = await engine.run("Use Calculator to compute 7 + 8 and observe the result", {
        behaviorMode: "cua-fixture",
        onStream: (event) => {
          if (event.type === "error") console.error(event.error);
        },
      });
      await startup;
      assert.equal(result.reason, "completed", result.text);
      assert.equal(result.text, "15");
      assert.equal(script.length, 0);
      const blocks = resultBlocks(calls.at(-1)!.messages);
      const permission = blocks.find((block) => block.tool_use_id === "cua-1")!;
      assert.match(String(permission.content), /"attribution":"host"/);
      assert.match(String(permission.content), /"permissionMode":"standard"/);
      for (const id of ["cua-2", "cua-7"]) {
        const content = blocks.find((block) => block.tool_use_id === id)!.content;
        assert.ok(Array.isArray(content), `Model must receive image content for ${id}`);
        assert.equal(content[0].type, "text");
        assert.match(content[0].text!, /trust="untrusted"/);
        assert.ok(
          content.some(
            (block) =>
              block.type === "image" &&
              block.source?.media_type === "image/png" &&
              block.source?.data,
          ),
        );
        assert.ok(!content[0].text!.includes("iVBOR"), "Base64 must not enter text");
      }
      const lastObservation = blocks.find((block) => block.tool_use_id === "cua-7")!
        .content as ContentBlock[];
      assert.match(lastObservation[0].text!, /"display":"15"/);
      assert.deepEqual(
        events()
          .filter((event) => event.phase === "clicked")
          .map((event) => event.key),
        ["7", "+", "8", "="],
      );
      if (scenario === "delayed") {
        const recorded = events();
        assert.ok(
          recorded.findIndex((event) => event.phase === "listening") <
            recorded.findIndex((event) => event.phase === "started" && event.mode === "mcp"),
        );
      }
    }
    const daemon = events().find((event) => event.phase === "started" && event.mode === "serve")!;
    assert.equal(daemon.ppid, process.pid);
    assert.equal(daemon.home, process.env.HOME);
    assert.equal(daemon.secretInherited, false);
    assert.equal(daemon.permissionMode, "standard");
    assert.equal(daemon.hostBundleId, "com.cjhyy.codeshell");
  }
} finally {
  await cleanup();
  PROVIDER_REGISTRY.delete(provider);
}
await waitFor(
  () =>
    events()
      .filter((event) => event.phase === "started")
      .every((event) => !alive(event.pid)),
  "all fixture children to exit",
);
assert.equal(unexpectedNetworkCalls, 0);
assert.ok(events().every((event) => event.phase !== "network-denied"));
assert.equal(existsSync(socketPath), false);
writeFileSync(
  join(directory, "completion.json"),
  JSON.stringify({
    scenario,
    unexpectedNetworkCalls,
    children: events()
      .filter((event) => event.phase === "started")
      .map((event) => ({ pid: event.pid, mode: event.mode, alive: alive(event.pid) })),
    socketRemoved: !existsSync(socketPath),
    modelCalls: calls.length,
  }) + "\n",
);
console.log("Cua integration completed: " + scenario);

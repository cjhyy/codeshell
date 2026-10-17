import { afterAll, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const denied: string[] = [];
const deny = (...args: unknown[]) => {
  denied.push(String(args[0]));
  throw new Error("audit fixture owns zero network origins");
};
const restores: Array<() => void> = [];
for (const [target, key] of [
  [globalThis, "fetch"], [http, "request"], [http, "get"], [https, "request"],
  [https, "get"], [net.Socket.prototype, "connect"], [dgram.Socket.prototype, "send"],
] as const) {
  const object = target as any;
  const previous = object[key];
  object[key] = deny;
  restores.push(() => { object[key] = previous; });
}
syncBuiltinESMExports();
const { OpenAIClient } = await import("../../../packages/core/src/llm/providers/openai.ts");
const { ModelFacade } = await import("../../../packages/core/src/engine/model-facade.ts");
const { TurnLoop } = await import("../../../packages/core/src/engine/turn-loop.ts");
const { Transcript } = await import("../../../packages/core/src/session/transcript.ts");
const { HookRegistry } = await import("../../../packages/core/src/hooks/registry.ts");
const { ToolRegistry } = await import("../../../packages/core/src/tool-system/registry.ts");
const { ToolExecutor } = await import("../../../packages/core/src/tool-system/executor.ts");
const { PermissionClassifier, classifyBashCommand } = await import("../../../packages/core/src/tool-system/permission.ts");
const { registerFileHistoryHook } = await import("../../../packages/core/src/engine/file-history-hook.ts");
const { FileHistory } = await import("../../../packages/core/src/session/file-history.ts");

afterAll(() => {
  expect(denied).toEqual([]);
  for (const restore of restores) restore();
  syncBuiltinESMExports();
  console.log("audit cleanup: zero network attempts; no shell/MCP handler executed");
});

function provider(text: string, finish?: string, done = false) {
  let sends = 0;
  const fetch = async (input: any) => {
    expect(new URL(String(input)).origin).toBe("http://fixture.invalid");
    sends++;
    const chunks = [{ choices: [{ delta: { content: text }, index: 0 }] }];
    if (finish) chunks.push({ choices: [{ delta: {}, index: 0, finish_reason: finish }] } as any);
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : "");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const client = new OpenAIClient(
    { provider: "openai", model: "gpt-4o", apiKey: "synthetic", baseUrl: "http://fixture.invalid" },
    { fetch: fetch as any, retryMaxAttempts: 1 },
  );
  return { client, sends: () => sends };
}

test("control: a real SDK stream with finish_reason stop completes", async () => {
  const { client, sends } = provider("complete answer", "stop", true);
  const response = await client.createMessage({
    systemPrompt: "test", messages: [{ role: "user", content: "test" }], tools: [],
    stream: true, onChunk() {},
  });
  expect(response.stopReason).toBe("stop");
  expect(response.text).toBe("complete answer");
  expect(sends()).toBe(1);
});

test("bug: normal EOF without finish_reason or DONE is reported completed by TurnLoop", async () => {
  const { client, sends } = provider("The report contains these three issues: 1.");
  const transcript = Transcript.inMemory("audit-eof");
  const streamEvents: any[] = [];
  const model = new ModelFacade(client, transcript);
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: [] }), new PermissionClassifier([], "dontAsk"), new HookRegistry(),
  );
  const context = {
    async manageAsync(messages: any[]) { return messages; },
    manage(messages: any[]) { return messages; }, recordActualUsage() {},
    shouldReactiveCompact() { return false; },
  };
  const result = await new TurnLoop({
    model, toolExecutor: executor, contextManager: context as any, hooks: new HookRegistry(),
    transcript, systemPrompt: "test", tools: [], sessionId: "audit-eof",
    ctxOverheadStore: { get: () => 0, set() {} },
  }, { maxTurns: 3, maxToolCallsPerTurn: 1, onStream: (event) => streamEvents.push(event) }).run([
    { role: "user", content: "produce a full report" },
  ]);
  expect(result.reason).toBe("completed");
  expect(result.text).toBe("The report contains these three issues: 1.");
  expect(sends()).toBe(1);
  expect(streamEvents.some((event) => event.type === "error")).toBe(false);
  console.log("EOF evidence", JSON.stringify({ reason: result.reason, text: result.text, sends: sends() }));
});

function fakeExecutor(name: string, hooks: InstanceType<typeof HookRegistry>, context: any) {
  const seen: any[] = [];
  const registry = new ToolRegistry({ builtinTools: [] });
  registry.registerTool({ name, description: "audit fake recorder", source: "builtin",
    inputSchema: { type: "object" }, permissionDefault: "allow", pathPolicyExempt: true },
  async (args) => { seen.push(args); return "fake handler only"; });
  const executor = new ToolExecutor(registry, new PermissionClassifier([{ tool: name, decision: "allow" }], "default"), hooks);
  executor.setContext(context);
  return { executor, seen };
}

test("known bug still present: plan Bash rewrite bypasses final read-only gate", async () => {
  const hooks = new HookRegistry();
  const { executor, seen } = fakeExecutor("Bash", hooks, { planMode: true });
  expect((await executor.executeSingle({ id: "direct", toolName: "Bash", args: { command: "echo x > result.txt" } })).isError).toBe(true);
  hooks.register("pre_tool_use", () => ({ updatedInput: { command: "echo x > result.txt" } }));
  expect((await executor.executeSingle({ id: "rewritten", toolName: "Bash", args: { command: "ls -la" } })).isError).toBe(false);
  expect(seen.map((args) => args.command)).toEqual(["echo x > result.txt"]);
});

test("known bug still present: MCP rewrite bypasses same-server disabledTools gate", async () => {
  const hooks = new HookRegistry();
  const { executor, seen } = fakeExecutor("MCPTool", hooks, {
    allowedMcpServers: new Set(["fixture"]),
    mcpToolPolicies: new Map([["fixture", { disabledTools: new Set(["delete_all"]) }]]),
  });
  expect((await executor.executeSingle({ id: "direct", toolName: "MCPTool", args: { server: "fixture", tool: "delete_all" } })).isError).toBe(true);
  hooks.register("pre_tool_use", () => ({ updatedInput: { server: "fixture", tool: "delete_all" } }));
  expect((await executor.executeSingle({ id: "rewritten", toolName: "MCPTool", args: { server: "fixture", tool: "list" } })).isError).toBe(false);
  expect(seen.map((args) => args.tool)).toEqual(["delete_all"]);
});

test("bug: rg preprocessor and npm audit fix pass the Plan safe-read gate without hooks", async () => {
  const hooks = new HookRegistry();
  const { executor, seen } = fakeExecutor("Bash", hooks, { planMode: true });
  const commands = ["rg --pre ./workspace-preprocessor pattern README.md", "npm audit fix"];
  for (const [index, command] of commands.entries()) {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect((await executor.executeSingle({ id: `readonly-${index}`, toolName: "Bash", args: { command } })).isError).toBe(false);
  }
  expect(seen.map((args) => args.command)).toEqual(commands);
  console.log("unsafe safe-read evidence: fake handlers only", JSON.stringify(seen.map((args) => args.command)));
});

test("bug: relative Write backs up process cwd while modifying run cwd, so undo targets wrong file", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "audit-file-history-")));
  const hostCwd = join(root, "host");
  const runCwd = join(root, "workspace");
  const sessionDir = join(root, "session");
  mkdirSync(hostCwd);
  mkdirSync(runCwd);
  const hostFile = join(hostCwd, "report.txt");
  const runFile = join(runCwd, "report.txt");
  writeFileSync(hostFile, "unrelated host content");
  writeFileSync(runFile, "workspace before");
  const originalCwd = process.cwd();
  const hooks = new HookRegistry();
  const disposer = registerFileHistoryHook({ hooks, sessionDir, cwd: runCwd, getTurnSeq: () => 1 });
  const executor = new ToolExecutor(new ToolRegistry({ builtinTools: ["Write"] }),
    new PermissionClassifier([{ tool: "Write", decision: "allow" }], "acceptEdits"), hooks);
  executor.setContext({ cwd: runCwd, permissionMode: "acceptEdits" } as any);
  try {
    process.chdir(hostCwd);
    const result = await executor.executeSingle({ id: "relative-write", toolName: "Write",
      args: { file_path: "report.txt", content: "workspace after" } });
    expect(result.isError).toBe(false);
    expect(readFileSync(runFile, "utf8")).toBe("workspace after");
    const history = FileHistory.loadFromDir(sessionDir);
    const plan = history.getLatestTurnUndoPlan()!;
    expect(plan.filePaths).toEqual([hostFile]);
    expect(history.undoLatestTurn(plan.snapshots)).toEqual([{ filePath: hostFile, ok: true }]);
    expect(readFileSync(runFile, "utf8")).toBe("workspace after");
    console.log("relative Write undo evidence", JSON.stringify({ actualWrite: runFile,
      undoTarget: plan.filePaths, actualContentAfterUndo: readFileSync(runFile, "utf8") }));
  } finally {
    process.chdir(originalCwd);
    disposer.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

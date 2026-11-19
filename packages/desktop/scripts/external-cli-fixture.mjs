/*
 * Scripted stand-ins for the `claude` and `codex` CLIs, for Electron acceptance
 * runs that must never start a real agent or reach a model.
 *
 * The fake `claude` speaks the `-p --output-format stream-json` contract. Each
 * invocation takes the next step from a queue file; a step may call Host tools
 * over the session's MCP bridge exactly like the real CLI would, then replies.
 * With an empty queue it answers in plain text and runs no tool.
 *
 * A step's `computer` calls go to the `codeshell_computer` stdio server from
 * the same config, the way the CLI treats a Host MCP tool it was not granted:
 * with a permission-prompt tool it asks first and obeys the answer, under
 * `bypassPermissions` it calls directly, otherwise it denies. `afterSignal`
 * calls are made when the host's SIGTERM arrives (a call already under way
 * when the user presses Stop); `holdMs` keeps the turn open meanwhile.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const claudeSource = ({ queueFile, logFile, computerLogFile }) => `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0 (Claude Code acceptance fixture)");
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  // Titles and summaries use a tool-less \`claude -p\`; they are not session turns.
  if (!option("--mcp-config")) {
    send({ type: "result", subtype: "success", is_error: false, result: "fixture summary" });
    return;
  }
  let queue = [];
  try {
    queue = JSON.parse(readFileSync(${JSON.stringify(queueFile)}, "utf8"));
  } catch {}
  const step = queue.shift() ?? {};
  writeFileSync(${JSON.stringify(queueFile)}, JSON.stringify(queue));
  const record = { pid: process.pid, cwd: process.cwd(), resumed: args.includes("--resume"), step, tools: [] };
  try {
    let instructions = "";
    try {
      instructions = readFileSync(option("--append-system-prompt-file"), "utf8");
    } catch {}
    const goal = /goalId: ([0-9a-f-]{36}); revision: (\\d+)/.exec(input + "\\n" + instructions);
    record.goal = goal ? { goalId: goal[1], revision: Number(goal[2]) } : null;
    record.prompt = input.slice(0, 400);
    const servers = JSON.parse(readFileSync(option("--mcp-config"), "utf8")).mcpServers;
    const bridge = servers.codeshell_tools;
    const computer = servers.codeshell_computer;
    record.mcpServers = Object.keys(servers);
    record.permissionMode = option("--permission-mode") ?? null;
    record.computerSession = computer?.env?.CODE_SHELL_CUA_SESSION_ID ?? null;
    let bridgeCalls = 0;
    const callBridge = async (name, args) => {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { ...bridge.headers, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++bridgeCalls, method: "tools/call", params: { name, arguments: args } }),
      });
      return { name, status: response.status, body: (await response.text()).slice(0, 4000) };
    };
    // The session's computer-use server, spoken to as the CLI's MCP client would.
    let computerServer;
    const connectComputer = async () => {
      const child = spawn(computer.command, computer.args, {
        env: { ...process.env, ...computer.env },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const pending = new Map();
      let nextId = 0;
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        } catch {}
      });
      const request = (method, params) =>
        new Promise((resolve) => {
          const id = ++nextId;
          pending.set(id, resolve);
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
        });
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "acceptance-fixture", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
      return { request, close: () => child.stdin.end() };
    };
    const promptTool = option("--permission-prompt-tool");
    const runComputer = async (call, phase) => {
      if (call.delayMs) await new Promise((done) => setTimeout(done, call.delayMs));
      const entry = { pid: process.pid, phase, name: call.name, asked: false, allowed: false, result: null };
      if (record.permissionMode === "bypassPermissions") entry.allowed = true;
      else if (promptTool) {
        entry.asked = true;
        const answer = await callBridge(promptTool.split("__").pop(), {
          tool_name: "mcp__codeshell_computer__" + call.name,
          input: call.arguments ?? {},
          tool_use_id: "acceptance-" + phase + "-" + call.name,
        });
        entry.answer = answer.body;
        try {
          entry.allowed = JSON.parse(JSON.parse(answer.body).result.content[0].text).behavior === "allow";
        } catch {}
      }
      if (entry.allowed)
        entry.result = (await computerServer.request("tools/call", { name: call.name, arguments: call.arguments ?? {} })).result ?? null;
      appendFileSync(${JSON.stringify(computerLogFile)}, JSON.stringify(entry) + "\\n");
      return entry;
    };
    send({ type: "system", subtype: "init", session_id: "acceptance-fixture-session", model: "fixture" });
    if (step.delayMs) await new Promise((done) => setTimeout(done, step.delayMs));
    for (const tool of step.tools ?? [])
      record.tools.push(
        await callBridge(tool.name, { ...tool.arguments, ...(tool.goal && record.goal ? record.goal : {}) }),
      );
    if (step.computer && computer) {
      computerServer = await connectComputer();
      const listed = (await computerServer.request("tools/list", {})).result.tools;
      record.computerTools = listed.map((tool) => tool.name);
      record.computerToolNotes = listed.filter((tool) => tool.description.includes("computer_input_refused")).length;
      if (step.afterSignal)
        process.on("SIGTERM", async () => {
          for (const call of step.afterSignal) await runComputer(call, "after-signal");
          record.signalled = true;
          appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(record) + "\\n");
          process.exit(0);
        });
      record.computer = [];
      for (const call of step.computer) record.computer.push(await runComputer(call, "turn"));
      if (step.holdMs) await new Promise((done) => setTimeout(done, step.holdMs));
      computerServer.close();
    }
    const text = step.text ?? "fixture reply";
    send({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } } });
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    send({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 1, output_tokens: 1 } });
  } catch (error) {
    record.error = String(error?.stack ?? error);
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: record.error });
  }
  appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(record) + "\\n");
});
`;

// A one-turn "codex app-server" (NDJSON, no jsonrpc field). Its turn asks the
// host to approve one command and stays open until that is answered or the
// worker is stopped. Everything else fails fast, so PATH lookups and model
// discovery never reach an installed Codex.
const codexSource = ({ logFile }) => `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.0.0 (acceptance fixture)");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(1);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (record) => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ pid: process.pid, ...record }) + "\\n");
const threadId = "acceptance-worker-thread";
const turn = { id: "acceptance-worker-turn" };
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture/0.162.0" } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === "turn/start") {
    log({ event: "turn", cwd: process.cwd() });
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId, turn } });
    return send({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: turn.id, startedAtMs: 1, itemId: "c1", command: "git commit -m acceptance", cwd: process.cwd(), reason: "writes .git" },
    });
  }
  if (message.method === "turn/interrupt") {
    log({ event: "interrupt" });
    send({ id: message.id, result: {} });
    return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "interrupted", error: null } } });
  }
  if (message.id === 900 && !message.method) {
    log({ event: "approval", answer: message.result ?? message.error });
    return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed", error: null } } });
  }
  if (message.id !== undefined && message.method)
    send({ id: message.id, error: { code: -32601, message: "unsupported by the acceptance fixture" } });
});
process.on("SIGTERM", () => {
  log({ event: "terminated" });
  process.exit(0);
});
`;

/** Install both stand-ins in `directory`; put it first on the app's PATH. */
export async function installExternalCliFixture(directory) {
  const bin = join(directory, "bin");
  const queueFile = join(directory, "claude-queue.json");
  const logFile = join(directory, "claude-invocations.jsonl");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(queueFile, "[]");
  const codexLogFile = join(directory, "codex-events.jsonl");
  const computerLogFile = join(directory, "claude-computer-calls.jsonl");
  const lines = async (file) =>
    (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  await writeFile(logFile, "");
  await writeFile(codexLogFile, "");
  await writeFile(computerLogFile, "");
  for (const [name, source] of [
    ["claude", claudeSource({ queueFile, logFile, computerLogFile })],
    ["codex", codexSource({ logFile: codexLogFile })],
  ]) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
  return {
    bin,
    /** Replace the pending steps; each later `claude` turn consumes one. */
    script: (steps) => writeFile(queueFile, JSON.stringify(steps)),
    invocations: () => lines(logFile),
    /** Each computer-use call the stand-in made, written as it finished. */
    computerCalls: () => lines(computerLogFile),
    /** What the Codex worker stand-in saw: turn, approval answer, interrupt, terminated. */
    codexEvents: () => lines(codexLogFile),
  };
}

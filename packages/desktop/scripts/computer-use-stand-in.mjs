/*
 * A stand-in for "CodeShell Computer Use.app" for Electron acceptance runs.
 *
 * It has the bundle's two executables and nothing else: the helper answers
 * `launch serve` by listening on the private socket, the driver answers
 * `mcp` as a line-delimited MCP server that records each tool call and returns
 * a canned result. Neither touches the desktop, links a macOS framework or can
 * ask for a privacy permission. Desktop's own proxy, input gate and approval
 * path run unchanged in front of it (CODESHELL_E2E_COMPUTER_USE_BUNDLE).
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const helperSource = ({ logFile }) => `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ helper: args.slice(0, 2).join(" "), pid: process.pid }) + "\\n");
if (args[0] !== "launch") process.exit(64);
if (args[1] === "serve" && args[2] === "--socket" && args[3]) {
  // The proxy's cursor reader connects here; a closed connection means "no cursor".
  const server = createServer((socket) => socket.destroy());
  server.listen(args[3]);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  // Permission reads and requests: granted, and nothing is ever asked of the OS.
  process.stdout.write(JSON.stringify({ version: 1, requested: args[1] !== "status", accessibility: true, screenRecording: true }));
}
`;

const tool = (name, description, properties = {}) => ({
  name,
  description,
  inputSchema: { type: "object", properties },
});

const TOOLS = [
  tool("list_apps", "List running apps."),
  tool("get_screen_size", "Screen size."),
  tool("get_window_state", "Read a window.", { pid: { type: "number" } }),
  tool("launch_app", "Launch an app.", { bundle_id: { type: "string" } }),
  tool("click", "Click an element.", { pid: { type: "number" } }),
  tool("set_value", "Set a field's value.", { pid: { type: "number" } }),
  tool("type_text", "Type text.", { pid: { type: "number" } }),
  // Withheld by the proxy: never listed to the model, never forwarded.
  tool("page", "Drive a browser page."),
  tool("browser_navigate", "Navigate the driver's browser."),
];

const driverSource = ({ logFile }) => `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] !== "mcp") process.exit(64);
const tools = ${JSON.stringify(TOOLS)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize")
    return reply({
      protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "cua-driver-stand-in", version: "0.0.0" },
    });
  if (message.method === "tools/list") return reply({ tools });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
      driver: name,
      arguments: message.params?.arguments ?? {},
      meta: Object.keys(message.params?._meta ?? {}),
      pid: process.pid,
    }) + "\\n");
    return reply({
      content: [{ type: "text", text: "stand-in driver ran " + name }],
      structuredContent: name === "list_apps" ? { apps: [] } : {},
    });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not in the stand-in" } });
});
`;

/** Install the stand-in bundle under `directory`; pass `bundle` to the app's env. */
export async function installComputerUseStandIn(directory) {
  const bundle = join(directory, "CodeShell Computer Use Stand-in.app");
  const logFile = join(directory, "computer-use-stand-in.jsonl");
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await mkdir(join(bundle, "Contents", "Resources"), { recursive: true, mode: 0o700 });
  await writeFile(logFile, "");
  const helperPath = join(bundle, "Contents", "MacOS", "codeshell-computer-use");
  const driverPath = join(bundle, "Contents", "Resources", "cua-driver");
  for (const [path, source] of [
    [helperPath, helperSource({ logFile })],
    [driverPath, driverSource({ logFile })],
  ]) {
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  const entries = async () =>
    (await readFile(logFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    bundle,
    helperPath,
    driverPath,
    /** Tool calls that reached the driver, in order. */
    driverCalls: async () => (await entries()).filter((entry) => entry.driver),
    /** Helper launches (`launch serve`, `launch status`, …). */
    helperLaunches: async () => (await entries()).filter((entry) => entry.helper),
  };
}

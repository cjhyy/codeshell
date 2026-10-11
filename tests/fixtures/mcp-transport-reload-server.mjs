import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
const deny = () => {
  throw new Error("stdio fixture denies HTTP");
};
globalThis.fetch = deny;
for (const t of [http, https]) {
  t.request = deny;
  t.get = deny;
}
syncBuiltinESMExports();
assert.throws(() => fetch("https://example.invalid"), /denies HTTP/);
assert.throws(() => http.get("http://127.0.0.1:9"), /denies HTTP/);
const [version, log] = process.argv.slice(2);
const record = (data) =>
  appendFileSync(log, JSON.stringify({ pid: process.pid, version, ...data }) + "\n");
record({ phase: "started", ppid: process.ppid, negativeProbes: 2, privateHome: process.env.HOME });
const lines = createInterface({ input: process.stdin });
let closed = false,
  sequence = 0;
const pending = new Map();
lines.on("close", () => {
  closed = true;
  for (const resolve of pending.values()) resolve([]);
});
const send = (message) => {
  if (!closed) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
};
async function gate(path) {
  if (!path) return;
  while (!closed && !existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 5));
}
async function details() {
  const roots = await new Promise((resolve) => {
    const id = "roots-" + ++sequence;
    pending.set(id, resolve);
    send({ id, method: "roots/list" });
  });
  return {
    version,
    pid: process.pid,
    cwd: process.cwd(),
    env: process.env.SYNTHETIC_VERSION,
    roots,
  };
}
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  if (!request.method) {
    pending.get(request.id)?.(request.result?.roots);
    pending.delete(request.id);
    return;
  }
  record({ phase: "request", method: request.method, tool: request.params?.name });
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    await gate(process.env.SYNTHETIC_INIT_GATE);
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "local-reload", version },
    };
  } else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: version,
          inputSchema: { type: "object", properties: { [version]: { type: "string" } } },
        },
        { name: "only_" + version, inputSchema: { type: "object", properties: {} } },
      ],
    };
  else if (request.method === "tools/call") {
    await gate(request.params.arguments?.gate);
    result = { content: [{ type: "text", text: JSON.stringify(await details()) }] };
  } else if (request.method === "resources/list")
    result = { resources: [{ uri: "fixture://note", name: version, description: version }] };
  else if (request.method === "resources/read")
    result = { contents: [{ uri: "fixture://note", text: JSON.stringify(await details()) }] };
  else result = {};
  send({ id: request.id, result });
});

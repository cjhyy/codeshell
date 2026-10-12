// Deliberately simulated calculator. This executable tests process attribution,
// MCP framing, images and cancellation without native UI or network access.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const [mode, embedded, socketOption, socketPath] = process.argv.slice(2);
assert.ok(mode === "serve" || mode === "mcp");
assert.equal(embedded, "--embedded");
assert.equal(socketOption, "--socket");
assert.equal(process.env.CUA_DRIVER_EMBEDDED, "1");
const directory = dirname(socketPath);
const control = JSON.parse(readFileSync(join(directory, "control.json"), "utf8"));
const record = (event) =>
  appendFileSync(
    join(directory, "events.jsonl"),
    JSON.stringify({
      mode,
      pid: process.pid,
      ppid: process.ppid,
      ...event,
    }) + "\n",
  );
const deny = () => {
  record({ phase: "network-denied" });
  throw new Error("Cua fixture denies network");
};
globalThis.fetch = deny;
for (const transport of [http, https]) {
  transport.request = deny;
  transport.get = deny;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const address = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof address === "string" ? address : address?.path) !== socketPath) return deny();
  return connect.apply(this, args);
};
syncBuiltinESMExports();
record({
  phase: "started",
  home: process.env.HOME,
  embedded: process.env.CUA_DRIVER_EMBEDDED,
  permissionMode: process.env.CUA_DRIVER_PERMISSION_MODE,
  hostBundleId: process.env.CUA_DRIVER_HOST_BUNDLE_ID,
  secretInherited: "CODESHELL_CUA_TEST_SECRET" in process.env,
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "mcp") {
  // A proxy must see an accepting daemon. Do not add retries that could hide
  // the Desktop startup ordering bug this integration fixture checks.
  const connectSocket = () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  const pending = new Set();
  const controlSocket = await connectSocket();
  let closing = false;
  const shutdown = (code) => {
    closing = true;
    for (const socket of pending) socket.destroy();
    controlSocket.destroy();
    process.exit(code);
  };
  // Match upstream run_proxy / supervise_control_connection: one acknowledged
  // control binding stays open for the proxy's lifetime; requests use separate
  // sockets. A daemon crash invalidates the identity and ends MCP stdio.
  controlSocket.on("close", () => {
    if (!closing) {
      record({ phase: "control-disconnected" });
      shutdown(1);
    }
  });
  controlSocket.on("error", () => shutdown(1));
  const controlLines = createInterface({ input: controlSocket });
  const acknowledged = new Promise((resolve) => controlLines.once("line", resolve));
  controlSocket.write(
    JSON.stringify({ jsonrpc: "2.0", id: "control", method: "session_begin" }) + "\n",
  );
  await acknowledged;
  record({ phase: "control-ready" });
  const stdin = createInterface({ input: process.stdin });
  stdin.on("line", async (line) => {
    const request = JSON.parse(line);
    try {
      const socket = await connectSocket();
      pending.add(socket);
      socket.on("close", () => pending.delete(socket));
      socket.on("error", () => shutdown(1));
      if (request.id === undefined) {
        socket.end(line + "\n");
        return;
      }
      const responses = createInterface({ input: socket });
      responses.once("line", (response) => {
        process.stdout.write(response + "\n");
        socket.destroy();
      });
      socket.write(line + "\n");
    } catch {
      shutdown(1);
    }
  });
  stdin.on("close", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
} else {
  const sockets = new Set();
  let display = "0";
  const pressed = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let isControl = false;
    socket.on("close", () => {
      sockets.delete(socket);
      if (isControl) record({ phase: "session-end" });
    });
    socket.on("error", () => {});
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      const send = (result) => {
        if (!socket.destroyed)
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      };
      record({ phase: "request", method: request.method, tool: request.params?.name });
      if (request.method === "session_begin") {
        isControl = true;
        record({ phase: "session-begin" });
        send({ registered: true });
        return;
      }
      if (request.method === "notifications/cancelled") {
        record({ phase: "cancelled", requestId: request.params.requestId });
        return;
      }
      if (request.id === undefined) return;
      if (request.method === "initialize") {
        send({
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "simulated-cua-driver", version: "1.0.0" },
        });
      } else if (request.method === "tools/list") {
        send({
          tools: [
            {
              name: "check_permissions",
              description: "Read simulated host permissions",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "observe",
              description: "Observe the simulated Calculator",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "click",
              description: "Click a simulated Calculator key",
              inputSchema: {
                type: "object",
                properties: { key: { type: "string", enum: ["7", "+", "8", "="] } },
                required: ["key"],
              },
            },
          ],
        });
      } else if (request.method === "tools/call") {
        const tool = request.params.name;
        record({ phase: "tool", tool, args: request.params.arguments });
        if (tool === "check_permissions") {
          send({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  accessibility: true,
                  screenRecording: true,
                  attribution: "host",
                  permissionMode: process.env.CUA_DRIVER_PERMISSION_MODE,
                  hostBundleId: process.env.CUA_DRIVER_HOST_BUNDLE_ID,
                }),
              },
            ],
          });
        } else if (tool === "observe") {
          if (control.holdObservation) {
            record({ phase: "observation-blocked" });
            return;
          }
          send({
            content: [
              { type: "text", text: JSON.stringify({ app: "Calculator", display, pressed }) },
              { type: "image", mimeType: "image/png", data: PNG },
            ],
          });
        } else if (tool === "click") {
          const key = request.params.arguments.key;
          assert.ok(["7", "+", "8", "="].includes(key));
          pressed.push(key);
          display = pressed.join("") === "7+8=" ? "15" : pressed.join("");
          record({ phase: "clicked", key, display });
          if (control.holdClick) {
            record({ phase: "action-blocked" });
            return;
          }
          send({ content: [{ type: "text", text: JSON.stringify({ clicked: key, display }) }] });
        } else {
          send({ isError: true, content: [{ type: "text", text: "Unknown simulated tool" }] });
        }
      } else send({});
    });
  });
  process.on("SIGTERM", () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  });
  if (control.readyDelayMs) await sleep(control.readyDelayMs);
  server.listen(socketPath, () => record({ phase: "listening" }));
}

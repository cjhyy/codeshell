import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuaNativeCursorBridge, readNativeCursorState } from "./cua-native-cursor.js";
import type { CuaActivityEvent } from "./cua-activity.js";
import { createCuaActivityServer } from "./cua-activity-server.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

function state(session: string, position: { x: number; y: number } | null = null) {
  return { session, position, enabled: true };
}

async function daemon(respond: (request: any, reply: (value: unknown) => void) => void) {
  const folder = mkdtempSync(join(tmpdir(), "cua-state-"));
  const path = join(folder, "d.sock");
  const requests: any[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      requests.push(request);
      respond(request, (value) => socket.write(JSON.stringify(value) + "\n"));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  });
  return { folder, path, requests, sockets };
}

function response(value: unknown) {
  return { ok: true, result: { structuredContent: value } };
}

function initialized(bridge: CuaNativeCursorBridge): void {
  bridge.observeRequest({ id: 1, method: "initialize" });
  bridge.consumeResponse({
    id: 1,
    result: { serverInfo: { name: "cua-driver", version: "0.34.1" } },
  });
}

const event: CuaActivityEvent = { id: "action:1", action: "click", phase: "start", capture: false };
const request = { method: "tools/call", params: { name: "click", arguments: {} } };

describe("native CUA cursor side channel", () => {
  test("validates session and logical coordinates and bounds stalled requests", async () => {
    let answer: unknown = state("mcp-42-123", { x: -2000, y: 80 });
    let stall = false;
    const server = await daemon((_request, reply) => {
      if (!stall) reply(response(answer));
    });
    const controller = new AbortController();
    const read = () =>
      readNativeCursorState(server.path, "mcp-42-123", undefined, controller.signal, 30);
    expect(await read()).toEqual({ session: "mcp-42-123", position: { x: -2000, y: 80 } });
    answer = state("another-owner", { x: 30, y: 40 });
    expect(await read()).toBeUndefined();
    answer = state("mcp-42-123", { x: 200_000, y: 40 });
    expect(await read()).toBeUndefined();
    stall = true;
    const at = Date.now();
    expect(await read()).toBeUndefined();
    expect(Date.now() - at).toBeLessThan(250);
    const pending = read();
    controller.abort();
    expect(await pending).toBeUndefined();
    await until(() => server.sockets.size === 0);
    expect(server.requests.every((item) => item.name === "get_agent_cursor_state")).toBe(true);
  });

  test("bootstraps its own proxy, samples during work, and withholds old and duplicate points", async () => {
    let position = { x: 10, y: 20 };
    const server = await daemon((input, reply) =>
      reply(response(state(input.args.session || input.session_id, position))),
    );
    const emitted: CuaActivityEvent[] = [];
    const injected: any[] = [];
    const bridge = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      intervalMs: 10,
      sendMcp: async (bytes) => {
        const input = JSON.parse(bytes.toString());
        injected.push(input);
        bridge.consumeResponse({
          id: input.id,
          result: { structuredContent: state("mcp-42-123", position) },
        });
      },
      emit: async (value) => {
        emitted.push(value);
      },
    });
    cleanups.push(() => bridge.close());
    initialized(bridge);
    await bridge.prepare(event, request);
    bridge.start(event.id);
    await until(() => server.requests.length >= 4);
    expect(emitted).toEqual([]);
    position = { x: -2200, y: 400 };
    await until(() => emitted.length === 1);
    expect(emitted[0]).toEqual({
      ...event,
      phase: "update",
      target: position,
      targetSource: "native-cursor",
    });
    await bridge.finish(event.id, false);
    expect(emitted).toHaveLength(1);
    expect(injected).toHaveLength(1);
    expect(injected[0].params).toEqual({ name: "get_agent_cursor_state", arguments: {} });
    expect(server.requests.every((item) => item.session_id === "mcp-42-123")).toBe(true);
    expect(server.requests.every((item) => item.method === "call")).toBe(true);
  });

  test("keeps the transport owner while selecting an explicit public session and reads a fast action's final position", async () => {
    let position: { x: number; y: number } | null = null;
    const server = await daemon((input, reply) =>
      reply(response(state(input.args.session || input.session_id, position))),
    );
    const emitted: CuaActivityEvent[] = [];
    const bridge = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      sendMcp: async (bytes) => {
        bridge.consumeResponse({
          id: JSON.parse(bytes.toString()).id,
          result: { structuredContent: state("mcp-42-123") },
        });
      },
      emit: async (value) => {
        emitted.push(value);
      },
    });
    cleanups.push(() => bridge.close());
    initialized(bridge);
    await bridge.prepare(event, {
      ...request,
      params: { name: "click", arguments: { session: "form", text: "private" } },
    });
    bridge.start(event.id);
    position = { x: 100, y: 200 };
    await bridge.finish(event.id, false);
    expect(emitted).toHaveLength(1);
    expect(server.requests.slice(1).every((input) => input.args.session === "form")).toBe(true);
    expect(server.requests.every((input) => input.session_id === "mcp-42-123")).toBe(true);
    expect(JSON.stringify(server.requests)).not.toContain("private");
  });

  test("a confirmed click anchor can emit a text transition at the same position", async () => {
    let position = { x: 10, y: 20 };
    let visualAction = "idle";
    const server = await daemon((input, reply) =>
      reply(
        response({
          ...state(input.args.session || input.session_id, position),
          visual_state: { requested_action: visualAction },
        }),
      ),
    );
    const emitted: CuaActivityEvent[] = [];
    const bridge = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      intervalMs: 5,
      sendMcp: async (bytes) => {
        bridge.consumeResponse({
          id: JSON.parse(bytes.toString()).id,
          result: { structuredContent: state("mcp-42-123", position) },
        });
      },
      emit: async (value) => {
        emitted.push(value);
      },
    });
    cleanups.push(() => bridge.close());
    initialized(bridge);
    await bridge.prepare(event, request);
    position = { x: -2000, y: 200 };
    visualAction = "click";
    await bridge.finish(event.id, false);
    const typing: CuaActivityEvent = { ...event, id: "action:2", action: "type" };
    await bridge.prepare(typing, {
      method: "tools/call",
      params: { name: "type_text", arguments: {} },
    });
    bridge.start(typing.id);
    visualAction = "text";
    await until(() => emitted.length === 2);
    await bridge.finish(typing.id, false);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({
      id: "action:2",
      action: "type",
      phase: "update",
      target: position,
    });
  });

  test("never uses another proxy's identity or treats desktop/capture actions as agent positions", async () => {
    const server = await daemon((input, reply) => reply(response(state(input.session_id))));
    let injections = 0;
    const bridge = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      sendMcp: async (bytes) => {
        injections += 1;
        bridge.consumeResponse({
          id: JSON.parse(bytes.toString()).id,
          result: { structuredContent: state("mcp-99-123") },
        });
      },
      emit: async () => {
        throw new Error("unexpected update");
      },
    });
    cleanups.push(() => bridge.close());
    initialized(bridge);
    await bridge.prepare({ ...event, capture: true }, request);
    await bridge.prepare(event, {
      ...request,
      params: { name: "click", arguments: { scope: "desktop" } },
    });
    expect(injections).toBe(0);
    await bridge.prepare(event, request);
    bridge.start(event.id);
    await bridge.finish(event.id, false);
    expect(server.requests).toEqual([]);
  });

  test("a timed-out bootstrap's late reply is consumed, and close aborts pending reads", async () => {
    let internalId: unknown;
    const server = await daemon(() => {});
    const bridge = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      timeoutMs: 25,
      sendMcp: async (bytes) => {
        internalId = JSON.parse(bytes.toString()).id;
      },
      emit: async () => {},
    });
    initialized(bridge);
    const at = Date.now();
    await bridge.prepare(event, request);
    expect(Date.now() - at).toBeLessThan(250);
    bridge.close();
    expect(
      bridge.consumeResponse({
        id: internalId,
        result: { structuredContent: state("mcp-42-123") },
      }),
    ).toBe(true);
    expect(bridge.consumeResponse({ id: "user-id", result: {} })).toBe(false);
    expect(server.requests).toEqual([]);
  });

  test("close settles a bootstrap and aborts a stalled poll without publishing after closure", async () => {
    const server = await daemon((input, reply) => {
      if (server.requests.length <= 2) reply(response(state(input.session_id)));
    });
    let injected: any;
    const emitted: CuaActivityEvent[] = [];
    const bridge = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      intervalMs: 5,
      sendMcp: async (bytes) => {
        injected = JSON.parse(bytes.toString());
      },
      emit: async (value) => {
        emitted.push(value);
      },
    });
    initialized(bridge);
    const preparing = bridge.prepare(event, request);
    await until(() => !!injected);
    bridge.consumeResponse({ id: injected.id, result: { structuredContent: state("mcp-42-123") } });
    await preparing;
    bridge.start(event.id);
    await until(() => server.requests.length === 3);
    const at = Date.now();
    bridge.close();
    await bridge.finish(event.id, false);
    await until(() => server.sockets.size === 0);
    expect(Date.now() - at).toBeLessThan(100);
    expect(emitted).toEqual([]);

    const pending = new CuaNativeCursorBridge({
      socketPath: server.path,
      childPid: 42,
      sendMcp: async () => {},
      emit: async () => {},
    });
    initialized(pending);
    const stopped = pending.prepare(event, request);
    pending.close();
    await stopped;
  });

  test("the stdio wrapper isolates queued actions, hides its query and preserves bytes through notifications and EOF", async () => {
    const positions = new Map<string, { x: number; y: number }>();
    let actionFinished = false;
    const native = await daemon((input, reply) => {
      const key = input.args.session || input.session_id;
      if (input.name === "type_text") {
        actionFinished = false;
        const position =
          input.args.text === "private text" ? { x: -1800, y: 300 } : { x: 2600, y: 600 };
        setTimeout(() => positions.set(key, position), 15);
        setTimeout(() => {
          actionFinished = true;
          reply({ ok: true, result: { content: [{ type: "text", text: "typed" }] } });
        }, 250);
      } else {
        reply(response(state(key, positions.get(key) ?? null)));
      }
    });
    const events: CuaActivityEvent[] = [];
    let updatedBeforeFinish = false;
    const activity = await createCuaActivityServer((value) => {
      events.push(value as CuaActivityEvent);
      if (value.phase === "update") updatedBeforeFinish = !actionFinished;
    });
    cleanups.push(() => activity.close());
    const driver = join(native.folder, "fake-driver");
    writeFileSync(
      driver,
      `#!/usr/bin/env node
const net = require('node:net');
const readline = require('node:readline');
const socketPath = process.argv[process.argv.indexOf('--socket') + 1];
const session = 'mcp-' + process.pid + '-123';
function native(name,args) { return new Promise(resolve => {
  const socket = net.createConnection(socketPath); let buffer='';
  socket.on('connect',()=>socket.write(JSON.stringify({method:'call',name,args,session_id:session})+'\\n'));
  socket.on('data',chunk=>{ buffer+=chunk; if(buffer.includes('\\n')) { socket.destroy(); resolve(JSON.parse(buffer).result); } });
}); }
let queue=Promise.resolve();
readline.createInterface({input:process.stdin}).on('line',line=>{ queue=queue.then(async()=>{
 const input=JSON.parse(line);
 if(input.id===undefined)return;
 const result=input.method==='initialize' ? {serverInfo:{name:'cua-driver',version:'0.34.1'}} : await native(input.params.name,input.params.arguments);
 process.stdout.write(' { "jsonrpc" : "2.0", "id" : '+JSON.stringify(input.id)+', "result" : '+JSON.stringify(result)+' } \\r\\n');
}); });
`,
    );
    chmodSync(driver, 0o755);
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "cua-activity-proxy.ts"), "--driver", driver, "--socket", native.path],
      {
        env: {
          ...process.env,
          CODE_SHELL_CUA_ACTIVITY_SOCKET: activity.socketPath,
          CODE_SHELL_CUA_ACTIVITY_TOKEN: activity.token,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    cleanups.push(() => {
      child.kill();
    });
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise((resolve) => child.once("close", resolve));
    // EOF is already pending while the observer bootstraps. Notifications keep
    // their position in the stream and must not be mistaken for response turns.
    child.stdin.end(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' +
        ' {"jsonrpc":"2.0", "id":2, "method":"tools/call", "params":{"name":"type_text", "arguments":{"text":"private text", "session":"form"}}} \r\n' +
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' +
        ' {"jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{"name":"type_text", "arguments":{"text":"private second", "session":"form"}}} \r\n',
    );
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    expect(output).toBe(
      ' { "jsonrpc" : "2.0", "id" : 1, "result" : {"serverInfo":{"name":"cua-driver","version":"0.34.1"}} } \r\n' +
        ' { "jsonrpc" : "2.0", "id" : 2, "result" : {"content":[{"type":"text","text":"typed"}]} } \r\n' +
        ' { "jsonrpc" : "2.0", "id" : 3, "result" : {"content":[{"type":"text","text":"typed"}]} } \r\n',
    );
    expect(native.requests.filter((item) => item.name === "type_text")).toHaveLength(2);
    expect(events.map((value) => value.phase)).toEqual([
      "start",
      "update",
      "end",
      "start",
      "update",
      "end",
    ]);
    expect(updatedBeforeFinish).toBe(true);
    expect(events[1]?.target).toEqual({ x: -1800, y: 300 });
    expect(events[4]?.target).toEqual({ x: 2600, y: 600 });
    expect(JSON.stringify(events)).not.toContain("private text");
  }, 10_000);
});

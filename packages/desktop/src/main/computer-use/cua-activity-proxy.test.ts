import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  annotateToolList,
  CuaActivityChannel,
  cuaWireParts,
  parseCuaActivityProxyArgs,
  toolCall,
} from "./cua-activity-proxy.js";
import type { InputGateState } from "./input-gate-policy.js";

const OPEN: InputGateState = { version: 1, userActive: false, cancelledSessions: [] };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function activityServer(ack = true, gate: InputGateState | null = OPEN) {
  const folder = mkdtempSync(join(tmpdir(), "cua-act-"));
  const path = join(folder, "a.sock");
  const events: any[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event.type === "hello") {
          if (gate) socket.write(`${JSON.stringify({ type: "gate", gate })}\n`);
          continue;
        }
        events.push(event);
        if (ack)
          socket.write(`${JSON.stringify({ id: event.id, phase: event.phase, ok: true })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { folder, path, events, sockets, connections: () => connections };
}

const ECHO_DRIVER = `#!/usr/bin/env node\nconst readline=require('node:readline');\nif(process.env.CODE_SHELL_CUA_ACTIVITY_TOKEN)process.exit(9);\nreadline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify({args:process.argv.slice(2),request:r})}]}})+'\\n')});\n`;

describe("CUA activity proxy", () => {
  test("uses one authenticated connection and correlates start/end acknowledgements", async () => {
    const server = await activityServer();
    const channel = new CuaActivityChannel(server.path, "test-token");
    cleanups.push(() => channel.close());
    expect(
      await channel.send({ id: "unique:1", action: "observe", phase: "start", capture: true }),
    ).toBe(true);
    expect(
      await channel.send({ id: "unique:1", action: "observe", phase: "end", capture: true }),
    ).toBe(true);
    expect(server.connections()).toBe(1);
    expect(server.events.map((event) => event.token)).toEqual(["test-token", "test-token"]);
  });

  test("a missing ACK is bounded and keeps the connection that carries the input gate", async () => {
    const server = await activityServer(false);
    const channel = new CuaActivityChannel(server.path, "test-token", 30);
    cleanups.push(() => channel.close());
    const start = Date.now();
    expect(
      await channel.send({ id: "unique:1", action: "observe", phase: "start", capture: true }),
    ).toBe(false);
    expect(Date.now() - start).toBeLessThan(250);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.sockets.size).toBe(1);
    expect(channel.gate()).toEqual(OPEN);
  });

  test("gate state follows host pushes and is lost with the connection", async () => {
    const server = await activityServer();
    const channel = new CuaActivityChannel(server.path, "test-token");
    cleanups.push(() => channel.close());
    expect(await channel.waitForGate(500)).toEqual(OPEN);
    const held = { ...OPEN, version: 2, holdAll: "user-stop" as const };
    for (const socket of server.sockets)
      socket.write(`${JSON.stringify({ type: "gate", gate: held })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.gate()).toEqual(held);
    // An older push never overrides a newer state on the same connection.
    for (const socket of server.sockets)
      socket.write(`${JSON.stringify({ type: "gate", gate: OPEN })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.gate()).toEqual(held);
    for (const socket of server.sockets) socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.gate()).toBeUndefined();
  });

  test("unavailable and unconfigured activity channels fail open", async () => {
    const server = await activityServer();
    const channel = new CuaActivityChannel(join(server.folder, "missing.sock"), "token");
    cleanups.push(() => channel.close());
    expect(await channel.send({ id: "a", action: "click", phase: "start", capture: false })).toBe(
      false,
    );
    expect(
      await new CuaActivityChannel(undefined, undefined).send({
        id: "b",
        action: "click",
        phase: "start",
        capture: false,
      }),
    ).toBe(false);
  });

  test("wire framing preserves split UTF-8 and oversized payload bytes with bounded inspection", async () => {
    const source = new PassThrough();
    const payload = Buffer.from('{"label":"宠物"}\r\n' + "x".repeat(100) + "\n{}\n");
    const collected = (async () => {
      const parts = [];
      for await (const part of cuaWireParts(source, 30)) parts.push(part);
      return parts;
    })();
    for (let i = 0; i < payload.length; i += 2) {
      source.write(payload.subarray(i, i + 2));
      await Promise.resolve();
    }
    source.end();
    const parts = await collected;
    expect(Buffer.concat(parts.map((part) => part.bytes))).toEqual(payload);
    expect(parts.some((part) => part.overflow)).toBe(true);
    expect(parts.at(-1)?.inspect).toBe(true);
  });

  test("peels the Session lineage off a tool call without touching other metadata", () => {
    const call = toolCall({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "click",
        arguments: { x: 1 },
        _meta: { progressToken: "p", "codeshell/sessionIds": ["child", "root", "bad id!"] },
      },
    });
    expect(call?.sessionIds).toEqual(["child", "root"]);
    expect(call?.stripped).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "click", arguments: { x: 1 }, _meta: { progressToken: "p" } },
    });
    expect(
      toolCall({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "click", _meta: { "codeshell/sessionIds": ["a"] } },
      })?.stripped,
    ).toEqual({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "click" } });
    expect(
      toolCall({ jsonrpc: "2.0", method: "tools/call", params: { name: "x" } }),
    ).toBeUndefined();
  });

  test("tool descriptions carry the input strategy exactly once", () => {
    const listed = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "type_text", description: "Type text." },
          { name: "list_apps", description: "List apps." },
        ],
      },
    };
    const annotated = annotateToolList(listed) as any;
    expect(annotated.result.tools[0].description).toContain("never loop over characters");
    expect(annotated.result.tools[1].description).toContain("computer_input_refused");
    expect(annotateToolList(annotated)).toBeUndefined();
  });

  test("the driver's browser route never reaches the model's tool list", () => {
    const listed = {
      jsonrpc: "2.0",
      id: 3,
      result: {
        tools: [
          { name: "browser_navigate", description: "Navigate." },
          { name: "click", description: "Click." },
          { name: "page", description: "Legacy browser." },
          { name: "get_browser_state", description: "Browser state." },
        ],
      },
    };
    const annotated = annotateToolList(listed) as any;
    expect(annotated.result.tools.map((tool: any) => tool.name)).toEqual(["click"]);
    expect(annotateToolList(annotated)).toBeUndefined();
  });

  test("rejects extra invocation arguments", () => {
    expect(parseCuaActivityProxyArgs(["--driver", "/driver", "--socket", "/private.sock"])).toEqual(
      { driver: "/driver", socket: "/private.sock" },
    );
    expect(() =>
      parseCuaActivityProxyArgs(["--driver", "/driver", "--socket", "/private.sock", "--direct"]),
    ).toThrow();
  });

  test("forwards each real request once, preserves responses and never gives the driver activity credentials", async () => {
    const server = await activityServer();
    const driver = join(server.folder, "fake-driver");
    writeFileSync(
      driver,
      `#!/usr/bin/env node\nconst readline=require('node:readline');\nif(process.env.CODE_SHELL_CUA_ACTIVITY_TOKEN)process.exit(9);\nreadline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify({args:process.argv.slice(2),request:r})}]}})+'\\n')});\n`,
    );
    chmodSync(driver, 0o755);
    const entry = join(import.meta.dir, "cua-activity-proxy.ts");
    const child = spawn(
      process.execPath,
      [entry, "--driver", driver, "--socket", "/fake-driver.sock"],
      {
        env: {
          ...process.env,
          CODE_SHELL_CUA_ACTIVITY_SOCKET: server.path,
          CODE_SHELL_CUA_ACTIVITY_TOKEN: "test-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    cleanups.push(() => child.kill());
    const outputs: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => outputs.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const exited = new Promise((resolve) => child.once("close", resolve));
    const input = {
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "type_text", arguments: { text: "private user text" } },
    };
    child.stdin.end(`${JSON.stringify(input)}\n`);
    expect(await exited).toBe(0);
    expect(Buffer.concat(errors).toString()).toBe("");
    const lines = Buffer.concat(outputs).toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    const returned = JSON.parse(JSON.parse(lines[0]!).result.content[0].text);
    expect(returned.request).toEqual(input);
    expect(returned.args).toEqual(["mcp", "--embedded", "--socket", "/fake-driver.sock"]);
    expect(server.events.map((event) => event.phase)).toEqual(["start", "end"]);
    expect(JSON.stringify(server.events)).not.toContain("private user text");
  }, 10_000);

  async function runProxy(
    server: Awaited<ReturnType<typeof activityServer>> | { path: string; folder: string },
    lines: unknown[],
    driverScript = ECHO_DRIVER,
    extraEnv: Record<string, string> = {},
  ) {
    const driver = join(server.folder, `fake-driver-${Math.random().toString(16).slice(2)}`);
    writeFileSync(driver, driverScript);
    chmodSync(driver, 0o755);
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "cua-activity-proxy.ts"), "--driver", driver, "--socket", "/x.sock"],
      {
        env: {
          ...process.env,
          CODE_SHELL_CUA_ACTIVITY_SOCKET: server.path,
          CODE_SHELL_CUA_ACTIVITY_TOKEN: "test-token",
          ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    cleanups.push(() => child.kill());
    const outputs: Buffer[] = [];
    child.stdout.on("data", (chunk) => outputs.push(chunk));
    const exited = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end(lines.map((value) => `${JSON.stringify(value)}\n`).join(""));
    expect(await exited).toBe(0);
    return Buffer.concat(outputs)
      .toString()
      .trim()
      .split("\n")
      .map((value) => JSON.parse(value));
  }

  const call = (id: number, name: string, args: Record<string, unknown> = {}, meta?: unknown) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });
  const echoed = (response: any) => JSON.parse(response.result.content[0].text).request;

  test("app notes reach the model once per Session root and app; actions name the app", async () => {
    const server = await activityServer(true, OPEN);
    const appDriver = `#!/usr/bin/env node\nconst readline=require('node:readline');\nif(process.env.CODE_SHELL_CUA_APP_PROFILES)process.exit(9);\nreadline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const state=r.params&&r.params.name==='get_window_state';process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'tree'}],structuredContent:state?{pid:77,window_id:5,app_name:'Slack',window_bounds:{x:0,y:400,width:900,height:600},elements:[]}:{}}})+'\\n')});\n`;
    const root = (id: string) => ({ "codeshell/sessionIds": ["leaf", id] });
    const responses = await runProxy(
      server,
      [
        call(
          1,
          "get_window_state",
          { pid: 77, window_id: 5, include_screenshot: false },
          root("r1"),
        ),
        call(
          2,
          "get_window_state",
          { pid: 77, window_id: 5, include_screenshot: false },
          root("r1"),
        ),
        call(
          3,
          "get_window_state",
          { pid: 77, window_id: 5, include_screenshot: false },
          root("r2"),
        ),
        call(4, "click", { pid: 77, window_id: 5, x: 10, y: 10 }, root("r1")),
      ],
      appDriver,
      {
        CODE_SHELL_CUA_APP_PROFILES: join(import.meta.dir, "../../../resources/computer-use/apps"),
      },
    );
    const notes = (index: number) =>
      responses[index].result.content.filter((part: any) =>
        /CodeShell app notes for Slack/.test(part.text),
      ).length;
    expect([notes(0), notes(1), notes(2)]).toEqual([1, 0, 1]);
    expect(responses[0].result.content[0]).toEqual({ type: "text", text: "tree" });
    const click = server.events.find(
      (event) => event.action === "click" && event.phase === "start",
    );
    expect(click).toMatchObject({ pid: 77, appId: "slack" });
  }, 10_000);

  // First window-state read: an empty web area; every later one: a full page.
  // Each answer also reports the arguments and id the driver received.
  const SPARSE_THEN_FULL = (failSecond = false) =>
    `#!/usr/bin/env node\nconst readline=require('node:readline');let reads=0;\nreadline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const name=r.params&&r.params.name;if(name!=='get_window_state'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[]}})+'\\n');return;}reads++;if(reads===2&&${failSecond}){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{isError:true,content:[{type:'text',text:'boom'}]}})+'\\n');return;}const kids=reads===1?0:5;const elements=[{element_index:0,role:'AXWindow'},{element_index:1,parent_index:0,role:'AXWebArea'}].concat(Array.from({length:kids},(_,i)=>({element_index:2+i,parent_index:1,role:'AXButton'})));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify({id:r.id,args:r.params.arguments,read:reads})}],structuredContent:{elements}}})+'\\n')});\n`;
  const seen = (response: any) => JSON.parse(response.result.content[0].text);

  test("an empty web area is read once more and the full page answers the caller", async () => {
    const server = await activityServer(true, OPEN);
    const responses = await runProxy(
      server,
      [
        call(1, "get_window_state", { pid: 1, window_id: 2, include_screenshot: false }),
        call(2, "get_window_state", { pid: 1, window_id: 2, timeout_ms: 800 }),
      ],
      SPARSE_THEN_FULL(),
    );
    expect(responses).toHaveLength(2);
    expect(responses[0].id).toBe(1);
    expect(responses[0].result.structuredContent.elements).toHaveLength(7);
    // The caller sees the private re-read's answer, which got the default budget.
    expect(seen(responses[0])).toMatchObject({ read: 2, args: { timeout_ms: 3000 } });
    expect(seen(responses[0]).id).toMatch(/^codeshell-reread-/);
    // An explicit budget is the caller's; the page is no longer sparse.
    expect(seen(responses[1])).toMatchObject({ id: 2, read: 3, args: { timeout_ms: 800 } });
  }, 10_000);

  test("a failed re-read leaves the first answer in place", async () => {
    const server = await activityServer(true, OPEN);
    const responses = await runProxy(
      server,
      [call(1, "get_window_state", { pid: 1, window_id: 2, include_screenshot: false })],
      SPARSE_THEN_FULL(true),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(1);
    expect(responses[0].result.isError).toBeUndefined();
    expect(seen(responses[0])).toMatchObject({ id: 1, read: 1 });
  }, 10_000);

  test("a held gate refuses input locally while observation still reaches the driver", async () => {
    const server = await activityServer(true, { ...OPEN, holdAll: "user-stop" });
    const responses = await runProxy(server, [
      call(1, "type_text", { text: "secret" }),
      call(2, "get_window_state", { pid: 1, window_id: 2 }),
    ]);
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { isError: true, structuredContent: { reason: "user-stop", lane: "background" } },
    });
    expect(echoed(responses[1]).params.name).toBe("get_window_state");
    expect(JSON.stringify(responses)).not.toContain("secret");
    // The refused input never reached the observer; only the read did.
    expect(server.events.every((event) => event.action === "observe")).toBe(true);
  }, 10_000);

  test("foreground input is refused while the user is active; background input proceeds", async () => {
    const server = await activityServer(true, { ...OPEN, userActive: true });
    const responses = await runProxy(server, [
      call(1, "click", { delivery_mode: "foreground" }),
      call(2, "launch_app", { bundle_id: "com.apple.TextEdit" }),
      call(3, "set_value", { value: "整段 文本\n  缩进" }),
    ]);
    expect(responses[0].result.structuredContent.reason).toBe("user-active");
    expect(responses[1].result.structuredContent).toMatchObject({
      reason: "user-active",
      lane: "foreground",
    });
    expect(echoed(responses[2]).params.arguments.value).toBe("整段 文本\n  缩进");
  }, 10_000);

  test("a cancelled Session is refused anywhere in its lineage, and the lineage never reaches the driver", async () => {
    const server = await activityServer(true, { ...OPEN, cancelledSessions: ["root"] });
    const responses = await runProxy(server, [
      call(1, "click", {}, { "codeshell/sessionIds": ["child", "root"] }),
      call(2, "click", {}, { "codeshell/sessionIds": ["other"], progressToken: 7 }),
    ]);
    expect(responses[0].result.structuredContent.reason).toBe("session-cancelled");
    const forwarded = echoed(responses[1]);
    expect(forwarded.params._meta).toEqual({ progressToken: 7 });
    expect(server.events.find((event) => event.phase === "start")?.sessionId).toBe("other");
  }, 10_000);

  test("without a reachable host, input fails closed and reads still work", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cua-none-"));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const at = Date.now();
    const responses = await runProxy({ folder, path: join(folder, "missing.sock") }, [
      call(1, "type_text", { text: "x" }),
      call(2, "list_apps"),
    ]);
    expect(responses[0].result.structuredContent.reason).toBe("host-unavailable");
    expect(echoed(responses[1]).params.name).toBe("list_apps");
    expect(Date.now() - at).toBeLessThan(5_000);
  }, 10_000);

  test("input is forwarded without waiting for presentation acknowledgements", async () => {
    // A host that never acknowledges anything must not slow non-capture input.
    const server = await activityServer(false);
    const driver = join(server.folder, "timed-driver");
    writeFileSync(
      driver,
      `#!/usr/bin/env node\nconst readline=require('node:readline');\nreadline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:String(Date.now())}]}})+'\\n')});\n`,
    );
    chmodSync(driver, 0o755);
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "cua-activity-proxy.ts"), "--driver", driver, "--socket", "/x.sock"],
      {
        env: {
          ...process.env,
          CODE_SHELL_CUA_ACTIVITY_SOCKET: server.path,
          CODE_SHELL_CUA_ACTIVITY_TOKEN: "test-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    cleanups.push(() => child.kill());
    let buffer = "";
    const received: Array<{ id: number; sent: number; at: number }> = [];
    const sent = new Map<number, number>();
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const value = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        received.push({ id: value.id, sent: sent.get(value.id)!, at: Date.now() });
      }
    });
    // Warm up: the first input waits once for the host's gate push.
    sent.set(0, Date.now());
    child.stdin.write(`${JSON.stringify(call(0, "click"))}\n`);
    while (received.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    for (let id = 1; id <= 20; id++) {
      sent.set(id, Date.now());
      child.stdin.write(
        `${JSON.stringify(call(id, id % 2 ? "click" : "type_text", { text: "x" }))}\n`,
      );
      while (received.length < id + 1) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    child.stdin.end();
    const latencies = received
      .slice(1)
      .map((item) => item.at - item.sent)
      .sort((a, b) => a - b);
    // Includes two process hops and the 1ms polling of this test. Without the
    // change each action waited for the 180ms ACK deadline.
    expect(latencies[Math.floor(latencies.length * 0.95)]!).toBeLessThan(60);
  }, 20_000);
});

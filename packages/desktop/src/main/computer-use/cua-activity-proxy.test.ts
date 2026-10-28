import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  CuaActivityChannel,
  cuaWireParts,
  parseCuaActivityProxyArgs,
} from "./cua-activity-proxy.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function activityServer(ack = true) {
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

  test("a missing ACK is bounded and closes the connection so the host can clear capture state", async () => {
    const server = await activityServer(false);
    const channel = new CuaActivityChannel(server.path, "test-token", 30);
    cleanups.push(() => channel.close());
    const start = Date.now();
    expect(
      await channel.send({ id: "unique:1", action: "observe", phase: "start", capture: true }),
    ).toBe(false);
    expect(Date.now() - start).toBeLessThan(250);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.sockets.size).toBe(0);
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
});

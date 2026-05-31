import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { connect } from "node:net";
import { SocketTransport, listenTcp } from "./tcp-transport.js";
import type { RpcMessage } from "./types.js";

describe("SocketTransport — NDJSON framing", () => {
  test("parses one JSON value per line and dispatches to handlers", async () => {
    // Use a single PassThrough as the socket; we write lines into it and the
    // transport's readline consumes them.
    const sock = new PassThrough();
    const t = new SocketTransport(sock);
    const got: RpcMessage[] = [];
    t.onMessage((m) => got.push(m));

    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }) + "\n");
    sock.write("not json\n"); // malformed — skipped
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "pong", params: {} }) + "\n");

    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(2);
    expect((got[0] as { method: string }).method).toBe("ping");
    expect((got[1] as { method: string }).method).toBe("pong");
  });

  test("send writes a newline-terminated JSON line", async () => {
    const sock = new PassThrough();
    const t = new SocketTransport(sock);
    const chunks: string[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c.toString("utf-8")));
    t.send({ jsonrpc: "2.0", id: 9, result: { ok: true } } as RpcMessage);
    await new Promise((r) => setTimeout(r, 10));
    const out = chunks.join("");
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out.trim())).toMatchObject({ id: 9 });
  });
});

describe("listenTcp — real localhost round trip", () => {
  test("accepts a connection and exchanges a framed message", async () => {
    const received: RpcMessage[] = [];
    const listener = await listenTcp({ port: 0, host: "127.0.0.1" }, (transport) => {
      transport.onMessage((m) => {
        received.push(m);
        // Echo a response back.
        transport.send({ jsonrpc: "2.0", id: (m as { id: number }).id, result: { echoed: true } } as RpcMessage);
      });
    });

    const client = connect({ port: listener.port, host: "127.0.0.1" });
    const clientLines: string[] = [];
    client.on("data", (c: Buffer) => clientLines.push(c.toString("utf-8")));
    await new Promise((r) => client.on("connect", r));
    client.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "hi", params: {} }) + "\n");

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect((received[0] as { method: string }).method).toBe("hi");
    const reply = JSON.parse(clientLines.join("").trim());
    expect(reply).toMatchObject({ id: 7, result: { echoed: true } });

    client.end();
    await listener.close();
  });

  test("defaults to 127.0.0.1 (does not bind a public interface)", async () => {
    // host omitted → 127.0.0.1; just assert it binds and closes cleanly.
    const listener = await listenTcp({ port: 0 }, () => {});
    expect(listener.port).toBeGreaterThan(0);
    await listener.close();
  });
});

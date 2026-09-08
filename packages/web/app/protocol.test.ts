import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProtocolClient, ProtocolRequestError } from "./protocol.js";

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
  sent: Array<Record<string, any>> = [];
  failSend = false;
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(raw: string) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(JSON.parse(raw));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const NativeSocket = globalThis.WebSocket;
let client: ProtocolClient;
let socket: FakeSocket;
beforeEach(() => {
  FakeSocket.sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  client = new ProtocolClient("ws://localhost/ws");
  client.connect();
  socket = FakeSocket.sockets[0];
  socket.open();
});
afterEach(() => {
  client.close();
  globalThis.WebSocket = NativeSocket;
});

describe("Hub browser protocol", () => {
  test("run surfaces an immediate server error instead of leaving the UI running", async () => {
    const run = client.run({ sessionId: "s1", task: "hello", uploadIds: ["upload-1"] });
    const frame = socket.sent[0];
    expect(frame.params.uploadIds).toEqual(["upload-1"]);
    socket.receive({ id: frame.id, error: { code: -32602, message: "Upload expired" } });
    await expect(run).rejects.toThrow("Upload expired");
  });

  test("approval keeps routing fields and awaits its matching acknowledgement", async () => {
    const pending = client.approve(
      {
        requestId: "a1",
        sessionId: "s1",
        connectionId: "worker1",
        generation: 4,
        request: { toolName: "Bash", args: {} },
      },
      true,
    );
    const frame = socket.sent[0];
    expect(frame.params).toMatchObject({
      sessionId: "s1",
      connectionId: "worker1",
      generation: 4,
      requestId: "a1",
      decision: { approved: true },
    });
    socket.receive({ id: "unrelated", result: { ok: true } });
    socket.receive({ id: frame.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  test("close rejects both ordinary requests and long running turns", async () => {
    const query = client.listSessions();
    const run = client.run({ sessionId: "s1", task: "hello" });
    client.close();
    await expect(query).rejects.toThrow("connection closed");
    await expect(run).rejects.toThrow("connection closed");
    await expect(client.cancel("s1")).rejects.toThrow("not connected");
  });

  test("unmount cancels a scheduled reconnect", async () => {
    socket.close();
    client.close();
    await Bun.sleep(850);
    expect(FakeSocket.sockets).toHaveLength(1);
  });

  test("revoked sessions emit auth loss and stop automatic reconnect", async () => {
    let lost = 0;
    client.onAuthLost(() => lost++);
    socket.close(4401);
    expect(lost).toBe(1);
    await Bun.sleep(850);
    expect(FakeSocket.sockets).toHaveLength(1);
  });

  test("send exceptions reject without retaining request timers", async () => {
    socket.failSend = true;
    await expect(client.listSessions()).rejects.toThrow("send failed");
    client.close();
  });

  test("request timeouts reject and ignore a late reply", async () => {
    const pending = client.request("agent/query", {}, 5);
    await expect(pending).rejects.toThrow("request timed out: agent/query");
    socket.receive({ id: socket.sent[0].id, result: { ok: true } });
  });

  test("malformed frames do not interrupt later notifications", () => {
    const received: string[] = [];
    client.onNotification((method) => received.push(method));
    socket.receive(null);
    socket.receive([]);
    socket.onmessage?.({ data: "not JSON" });
    socket.receive({ method: "serve/approvalSnapshot", params: { approvals: [] } });
    expect(received).toEqual(["serve/approvalSnapshot"]);
  });
});

describe("run delivery receipts", () => {
  test("server rejection carries a definite response kind and code", async () => {
    const pending = client
      .run({ sessionId: "s1", task: "hello", clientMessageId: "client-1", displayText: "hello" })
      .catch((error) => error);
    const frame = socket.sent[0];
    expect(frame.params.clientMessageId).toBe("client-1");
    expect(frame.params.displayText).toBe("hello");
    socket.receive({ id: frame.id, error: { code: -32009, message: "configuration changing" } });
    const error = await pending;
    expect(error).toBeInstanceOf(ProtocolRequestError);
    expect(error.kind).toBe("response");
    expect(error.code).toBe(-32009);
  });

  test("lost acknowledgements and known unsent requests remain distinguishable", async () => {
    const pending = client.run({ sessionId: "s1", task: "hello" }).catch((error) => error);
    socket.close();
    expect((await pending).kind).toBe("transport");
    const unsent = await client.run({ sessionId: "s1", task: "hello" }).catch((error) => error);
    expect(unsent.kind).toBe("not-sent");
  });
});

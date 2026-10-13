import { describe, expect, test } from "bun:test";
import type { RpcMessage } from "../protocol/types.js";
import { createInProcessTransport } from "../protocol/transport.js";
import {
  createDesktopOperationBatchAuthorityClient,
  DESKTOP_OPERATION_BATCH_METHOD,
  isOperationBatchAuthorityFrame,
  OPERATION_BATCH_AUTHORITY_ID_PREFIX,
  type DesktopOperationBatchAuthorityInput,
} from "./desktop-batch-authority-client.js";

const input = (): DesktopOperationBatchAuthorityInput => ({
  sessionId: "session-1",
  runId: "run-1",
  originIntent: "intent-1",
  connectionId: "connection-1",
  parameters: { owner: "owner", repo: "repo", title: "Title", body: "Body" },
  phase: "resolve",
  token: "301ad4bf-2948-4507-a3ba-ff5580857438",
});

function harness(options: { timeoutMs?: number; maxPending?: number } = {}) {
  let receive: ((message: RpcMessage) => void) | undefined;
  const sent: RpcMessage[] = [];
  let failSend = false;
  const client = createDesktopOperationBatchAuthorityClient(
    {
      send(message) {
        if (failSend) throw new Error("transport failure with private details");
        sent.push(message);
      },
      onMessage(handler) {
        receive = handler;
      },
    },
    options,
  );
  const reply = (index: number, result: unknown, extra: Record<string, unknown> = {}) => {
    const request = sent[index]!;
    receive?.({ jsonrpc: "2.0", id: "id" in request ? request.id : "", result, ...extra });
  };
  return {
    client,
    sent,
    reply,
    receive: (message: RpcMessage) => receive?.(message),
    setFailSend: (value: boolean) => {
      failSend = value;
    },
  };
}

describe("Desktop operation batch authority channel", () => {
  test("fences its method and every prefixed response id, including unrecognized suffixes", () => {
    const id = `${OPERATION_BATCH_AUTHORITY_ID_PREFIX}untrusted-suffix`;
    for (const frame of [
      { method: DESKTOP_OPERATION_BATCH_METHOD },
      { method: "other", id },
      { id, result: { kind: "single" } },
      { id, error: { code: -1, message: "denied" } },
      { id: OPERATION_BATCH_AUTHORITY_ID_PREFIX },
    ])
      expect(isOperationBatchAuthorityFrame(JSON.stringify(frame))).toBe(true);
    for (const frame of [
      { method: "agent/run", id: "ordinary" },
      { id: `other-${id}`, result: {} },
      { id: 1 },
      [],
      null,
      "not a frame",
    ])
      expect(isOperationBatchAuthorityFrame(JSON.stringify(frame))).toBe(false);
    expect(isOperationBatchAuthorityFrame("{invalid")).toBe(false);
  });

  test("crosses the transport with a detached fixed request and a strictly validated Main result", async () => {
    const [worker, main] = createInProcessTransport();
    const client = createDesktopOperationBatchAuthorityClient(worker);
    const requests: RpcMessage[] = [];
    main.onMessage((message) => requests.push(message));
    try {
      const parameters = input();
      const pending = client.request(parameters);
      parameters.parameters.title = "Changed after submission";
      expect(requests[0]).toMatchObject({
        jsonrpc: "2.0",
        method: DESKTOP_OPERATION_BATCH_METHOD,
        params: { ...input(), parameters: { ...input().parameters, title: "Title" } },
      });
      const id = "id" in requests[0]! ? requests[0]!.id : "";
      expect(String(id).startsWith(OPERATION_BATCH_AUTHORITY_ID_PREFIX)).toBe(true);
      main.send({
        jsonrpc: "2.0",
        id,
        result: { kind: "batch", batchId: "batch-1", index: 0, count: 2 },
      });
      await expect(pending).resolves.toEqual({
        kind: "batch",
        batchId: "batch-1",
        index: 0,
        count: 2,
      });
      const finishing = client.request({
        ...input(),
        phase: "finish",
        batchId: "batch-1",
        index: 1,
      });
      const finishId = "id" in requests[1]! ? requests[1]!.id : "";
      main.send({
        jsonrpc: "2.0",
        id: finishId,
        result: {
          kind: "batch",
          batchId: "batch-1",
          index: 1,
          count: 2,
          allVerified: true,
          previousVerifiedId: "a".repeat(64),
        },
      });
      await expect(finishing).resolves.toMatchObject({
        allVerified: true,
        previousVerifiedId: "a".repeat(64),
      });
    } finally {
      client.dispose();
      worker.close();
      main.close();
    }
  });

  test("ignores unrelated responses and permits only a closed single result", async () => {
    const h = harness();
    try {
      const pending = h.client.request(input());
      h.receive({ jsonrpc: "2.0", id: "unrelated", result: { kind: "batch", index: 100 } });
      h.reply(0, { kind: "single" });
      await expect(pending).resolves.toEqual({ kind: "single" });
    } finally {
      h.client.dispose();
    }
  });

  test("refuses invalid request envelopes and non-JSON data before sending", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "title", {
      enumerable: true,
      get() {
        getterCalls++;
        return "hidden";
      },
    });
    const symbolKey = { [Symbol("authority")]: "secret" };
    const sparse = new Array(1);
    const malformed = [
      { ...input(), unexpected: true },
      { ...input(), phase: "grant" },
      { ...input(), sessionId: "" },
      { ...input(), batchId: "" },
      { ...input(), token: "not-a-run-token" },
      { ...input(), index: 0 },
      { ...input(), batchId: "batch-1", index: 8 },
      { ...input(), parameters: [] },
      { ...input(), parameters: { nested: new Date() } },
      { ...input(), parameters: { nested: Infinity } },
      { ...input(), parameters: { nested: undefined } },
      { ...input(), parameters: { nested: cyclic } },
      { ...input(), parameters: accessor },
      { ...input(), parameters: symbolKey },
      { ...input(), parameters: { nested: sparse } },
      { ...input(), parameters: { body: "\u0000".repeat(50_000) } },
      { ...input(), parameters: Object.create({ inherited: "data" }) },
    ];
    const h = harness();
    try {
      for (const bad of malformed)
        await expect(
          h.client.request(bad as DesktopOperationBatchAuthorityInput),
        ).rejects.toThrow();
      expect(getterCalls).toBe(0);
      expect(h.sent).toHaveLength(0);
    } finally {
      h.client.dispose();
    }
  });

  test("refuses malformed or denied responses without exposing private error text", async () => {
    const h = harness();
    const malformed = [
      { kind: "single", batchId: "injected" },
      { kind: "batch", batchId: "b", index: 0, count: 9 },
      { kind: "batch", batchId: "b", index: 2, count: 2 },
      { kind: "batch", batchId: "b", index: 0, count: 1, allVerified: "true" },
      { kind: "batch", batchId: "b", index: 0, count: 1, authority: "injected" },
      { kind: "batch", batchId: "b", index: 0, count: 1, previousVerifiedId: "not-a-receipt" },
      { kind: "denied" },
      null,
    ];
    try {
      for (const result of malformed) {
        const pending = h.client.request(input());
        h.reply(h.sent.length - 1, result);
        await expect(pending).rejects.toThrow("denied or returned an invalid response");
      }
      const pending = h.client.request(input());
      h.reply(
        h.sent.length - 1,
        { kind: "single" },
        { error: { code: -1, message: "private request body" } },
      );
      await expect(pending).rejects.toThrow("denied or returned an invalid response");
    } finally {
      h.client.dispose();
    }
  });

  test("bounds simultaneous calls and releases capacity after a response", async () => {
    const h = harness({ maxPending: 1 });
    try {
      const first = h.client.request(input());
      await expect(h.client.request(input())).rejects.toThrow("pending limit");
      expect(h.sent).toHaveLength(1);
      h.reply(0, { kind: "single" });
      await first;
      const next = h.client.request(input());
      h.reply(1, { kind: "single" });
      await expect(next).resolves.toEqual({ kind: "single" });
    } finally {
      h.client.dispose();
    }
  });

  test("pre-aborted and pending cancellations send no extra request and cannot consume a late reply", async () => {
    const h = harness({ maxPending: 1 });
    try {
      const before = new AbortController();
      before.abort();
      await expect(h.client.request(input(), { signal: before.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(h.sent).toHaveLength(0);
      const controller = new AbortController();
      const cancelled = h.client.request(input(), { signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      const next = h.client.request(input());
      h.reply(0, { kind: "batch", batchId: "late", index: 0, count: 1 });
      h.reply(1, { kind: "single" });
      await expect(next).resolves.toEqual({ kind: "single" });
    } finally {
      h.client.dispose();
    }
  });

  test("timeout frees capacity and a late response cannot settle a later call", async () => {
    const h = harness({ timeoutMs: 5, maxPending: 1 });
    try {
      await expect(h.client.request(input())).rejects.toThrow("timed out");
      const next = h.client.request(input());
      h.reply(0, { kind: "batch", batchId: "late", index: 0, count: 1 });
      h.reply(1, { kind: "single" });
      await expect(next).resolves.toEqual({ kind: "single" });
    } finally {
      h.client.dispose();
    }
  });

  test("send failure clears its pending entry and synchronous replies are supported", async () => {
    const h = harness({ maxPending: 1 });
    try {
      h.setFailSend(true);
      await expect(h.client.request(input())).rejects.toThrow("unavailable");
      h.setFailSend(false);
      const next = h.client.request(input());
      h.reply(0, { kind: "single" });
      await next;
    } finally {
      h.client.dispose();
    }
    const [worker, main] = createInProcessTransport();
    const client = createDesktopOperationBatchAuthorityClient(worker);
    main.onMessage((message) => {
      if ("id" in message)
        main.send({ jsonrpc: "2.0", id: message.id, result: { kind: "single" } });
    });
    try {
      await expect(client.request(input())).resolves.toEqual({ kind: "single" });
    } finally {
      client.dispose();
      worker.close();
      main.close();
    }
  });

  test("dispose rejects pending and future calls without closing the shared transport", async () => {
    const [worker, main] = createInProcessTransport();
    const client = createDesktopOperationBatchAuthorityClient(worker);
    const first = client.request(input());
    const second = client.request(input());
    const closed = Promise.all([first.catch((error) => error), second.catch((error) => error)]);
    client.dispose();
    client.dispose();
    for (const error of await closed) expect(error.message).toContain("closed");
    await expect(client.request(input())).rejects.toThrow("closed");
    let received = false;
    main.onMessage(() => {
      received = true;
    });
    worker.send({ jsonrpc: "2.0", method: "shared/transport/still-open" });
    expect(received).toBe(true);
    worker.close();
    main.close();
  });

  test("factory bounds cannot disable time or pending limits", () => {
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 30_001 },
      { maxPending: 0 },
      { maxPending: 65 },
    ])
      expect(() =>
        createDesktopOperationBatchAuthorityClient({ send() {}, onMessage() {} }, options),
      ).toThrow("bounds");
  });
});

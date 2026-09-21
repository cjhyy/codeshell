import { describe, expect, test } from "bun:test";
import { GatewayChatRequests } from "./im-gateway-chat-requests.js";
import type { PetChatControlRequest } from "./im-gateway-control-server.js";

const request: PetChatControlRequest = {
  message: "我发了截图你帮我看看最新结论",
  origin: {
    channel: "wechat",
    target: "owner",
    senderId: "owner",
    messageId: "screenshot-1",
    capabilities: {
      inbound: { text: true, attachments: ["image"] },
      outbound: { text: true, attachments: [] },
    },
  },
};
const result = { text: "最新结论", petSessionId: "mimi" };

describe("gateway chat request ownership", () => {
  test("a disconnected poll and retry retain one pending run and its terminal result", async () => {
    let finish!: (value: typeof result) => void;
    let runs = 0;
    const cache = new GatewayChatRequests(() => {
      runs++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const ticket = cache.start(request);
    const controller = new AbortController();
    const poll = cache.poll(ticket.requestId, 25_000, controller.signal);
    controller.abort();
    expect(await poll).toEqual(ticket);
    expect(cache.start(request)).toEqual(ticket);
    const terminal = cache.poll(ticket.requestId, 1_000);
    finish(result);
    expect(await terminal).toEqual(result);
    expect(await cache.poll(cache.start(request).requestId, 0)).toEqual(result);
    expect(runs).toBe(1);
  });

  test("rejects changed content for one identity but isolates different senders", () => {
    const cache = new GatewayChatRequests(() => new Promise(() => {}));
    const original = cache.start(request);
    expect(() => cache.start({ ...request, message: "different" })).toThrow("内容发生变化");
    expect(
      cache.start({ ...request, origin: { ...request.origin!, senderId: "someone-else" } })
        .requestId,
    ).not.toBe(original.requestId);
  });

  test("capacity and TTL never evict pending work, but completed work expires", async () => {
    let now = 0;
    let finish!: (value: typeof result) => void;
    const cache = new GatewayChatRequests(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      { capacity: 1, retentionMs: 100 },
      () => now,
    );
    const ticket = cache.start(request);
    await Promise.resolve();
    now = 200;
    expect(() => cache.start({ message: "next" })).toThrow("正在处理");
    expect(cache.start(request)).toEqual(ticket);
    const terminal = cache.poll(ticket.requestId, 1_000);
    finish(result);
    await terminal;
    now = 301;
    await expect(cache.poll(ticket.requestId, 0)).rejects.toThrow("已过期");
    expect(cache.start(request).requestId).not.toBe(ticket.requestId);
  });

  test("a worker failure is preserved and a cleared host asks the inbox to recover", async () => {
    const cache = new GatewayChatRequests(async () => {
      throw new Error("worker exited");
    });
    const ticket = cache.start(request);
    await expect(cache.poll(ticket.requestId, 1_000)).rejects.toThrow("worker exited");
    cache.clear();
    await expect(cache.poll(ticket.requestId, 0)).rejects.toMatchObject({ status: 503 });
  });
});

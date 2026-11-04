import { expect, test } from "bun:test";
import { ChatGateway, createOrderedChatRouting } from "./chat-gateway.js";
import { createBoundSessionChat } from "./bound-session-chat.js";
import { createCodeShellRemoteCommands } from "./gateway.js";
import type { ChannelAdapter } from "./channel.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const adapter: ChannelAdapter = { channel: "fixture", run: async () => {}, send: async () => {} };
const message = (text: string) => ({
  channel: "fixture",
  target: "room",
  senderId: "user",
  text,
  isDirectMessage: true,
});

test("bound messages and leave decisions retain arrival order", async () => {
  const gate = deferred();
  const entered = deferred();
  const order: string[] = [];
  const gateway = new ChatGateway({ adapters: [adapter] });
  gateway.use(
    createOrderedChatRouting(
      createBoundSessionChat({
        desktop: {
          async routeBoundSessionMessage(input) {
            order.push(`start:${input.text}`);
            if (input.text === "A") {
              entered.resolve();
              await gate.promise;
            }
            order.push(`end:${input.text}`);
            return { kind: "accepted" };
          },
        },
      }),
    ),
  );
  const first = gateway.dispatch(adapter, message("A"));
  await entered.promise;
  const second = gateway.dispatch(adapter, message("/mimi"));
  await Promise.resolve();
  expect(order).toEqual(["start:A"]);
  gate.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["start:A", "end:A", "start:/mimi", "end:/mimi"]);
});

test("remote close cannot overtake open, while unbound Mimi turns remain concurrent", async () => {
  const gate = deferred();
  const entered = deferred();
  const order: string[] = [];
  const gateway = new ChatGateway({ adapters: [adapter] });
  gateway.use(
    createOrderedChatRouting(
      createCodeShellRemoteCommands({
        desktop: {
          async open() {
            order.push("open");
            entered.resolve();
            await gate.promise;
            return { url: "https://fixture.invalid", pairingUrl: "https://fixture.invalid/pair" };
          },
          async close() {
            order.push("close");
          },
          async status() {
            return {} as never;
          },
        },
      }),
      createBoundSessionChat({
        desktop: {
          async routeBoundSessionMessage() {
            return { kind: "not-bound" };
          },
        },
      }),
    ),
  );
  const first = gateway.dispatch(adapter, message("/open"));
  await entered.promise;
  const second = gateway.dispatch(adapter, message("/close"));
  await Promise.resolve();
  expect(order).toEqual(["open"]);
  gate.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["open", "close"]);
  const mimiGate = deferred();
  const both = deferred();
  let active = 0;
  gateway.use(async () => {
    active++;
    if (active === 2) both.resolve();
    await mimiGate.promise;
  });
  const mimi = [
    gateway.dispatch(adapter, message("one")),
    gateway.dispatch(adapter, message("two")),
  ];
  await both.promise;
  expect(active).toBe(2);
  mimiGate.resolve();
  await Promise.all(mimi);
});

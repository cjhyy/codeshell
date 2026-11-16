import { describe, expect, it } from "bun:test";

import type { Message } from "../types.js";
import { resolveStablePrefixMessageCount } from "./stable-prefix.js";
import { moveVolatileContextToTail } from "./volatile-context-tail.js";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

describe("volatile context at the request tail", () => {
  it("moves the volatile message behind the newest message, in place", () => {
    const world = user("world");
    const messages = [user("task"), world, assistant("step"), user("tool result")];
    const before = messages.filter((message) => message !== world);
    moveVolatileContextToTail(messages, new Set([world]));
    expect(messages).toEqual([...before, world]);
    expect(messages.at(-1)).toBe(world);
  });

  it("leaves a list alone when the volatile message is already last or absent", () => {
    const world = user("world");
    const tail = [user("task"), assistant("step"), world];
    const copy = [...tail];
    moveVolatileContextToTail(tail, new Set([world]));
    expect(tail).toEqual(copy);
    const none = [user("task")];
    moveVolatileContextToTail(none, new Set([world]));
    expect(none).toHaveLength(1);
    moveVolatileContextToTail(none, new Set());
    expect(none).toHaveLength(1);
  });

  it("keeps an earlier pending rewrite outside the stable prefix when volatile context moves", () => {
    const world = user("world");
    const runStart = user("task");
    const rewrite = user("old");
    const messages = [rewrite, assistant("old answer"), runStart, assistant("step"), world];
    const input = {
      messages,
      isVolatile: (message: Message) => message === world,
      pendingRewriteMessage: rewrite,
      runStartMessage: runStart,
    };
    // In place: the settled line (here the pending rewrite) wins.
    expect(resolveStablePrefixMessageCount(input)).toBe(0);
    // Moving volatile context cannot settle an earlier pending rewrite.
    expect(resolveStablePrefixMessageCount({ ...input, volatileAtTail: true })).toBe(0);
    // No volatile message this run: the flag changes nothing.
    expect(
      resolveStablePrefixMessageCount({ ...input, isVolatile: () => false, volatileAtTail: true }),
    ).toBe(0);
  });

  it("ends the stable prefix before tail-placed volatile context when no rewrite is pending", () => {
    const world = user("world");
    const runStart = user("task");
    const messages = [user("old"), assistant("old answer"), runStart, assistant("step"), world];
    expect(
      resolveStablePrefixMessageCount({
        messages,
        isVolatile: (message) => message === world,
        runStartMessage: runStart,
        volatileAtTail: true,
      }),
    ).toBe(4);
  });
});

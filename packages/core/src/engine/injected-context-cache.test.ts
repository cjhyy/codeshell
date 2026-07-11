import { describe, expect, it } from "bun:test";
import type { Message } from "../types.js";
import { stripInjectedContextMessages } from "./injected-context-cache.js";

describe("stripInjectedContextMessages", () => {
  it("removes the exact user head and dynamic tail identities without matching equal content", () => {
    const userContext: Message = { role: "user", content: "same" };
    const equalButDurable: Message = { role: "user", content: "same" };
    const dynamicContext: Message = { role: "user", content: "dynamic" };
    const messages = [userContext, equalButDurable, { role: "assistant", content: "answer" } as Message, dynamicContext];

    expect(stripInjectedContextMessages(messages, userContext, dynamicContext)).toEqual([
      equalButDurable,
      { role: "assistant", content: "answer" },
    ]);
    expect(messages).toHaveLength(4);
  });

  it("keeps a user-context object that is no longer the first message", () => {
    const userContext: Message = { role: "user", content: "context" };
    const first: Message = { role: "user", content: "real" };
    expect(stripInjectedContextMessages([first, userContext], userContext, null)).toEqual([
      first,
      userContext,
    ]);
  });
});

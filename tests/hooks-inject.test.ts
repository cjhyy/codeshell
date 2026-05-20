import { describe, it, expect } from "bun:test";
import { HookRegistry } from "../src/hooks/registry.js";
import { wrapHookMessages } from "../src/hooks/inject.js";

describe("wrapHookMessages", () => {
  it("returns null for empty / undefined / whitespace-only inputs", () => {
    expect(wrapHookMessages(undefined)).toBeNull();
    expect(wrapHookMessages([])).toBeNull();
    expect(wrapHookMessages(["", "   ", "\n"])).toBeNull();
  });

  it("wraps a single message into a user-role <system-reminder>", () => {
    const msg = wrapHookMessages(["Hello"]);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("user");
    expect(msg!.content).toBe("<system-reminder>\nHello\n</system-reminder>");
  });

  it("joins multiple messages with a blank line inside a single reminder", () => {
    const msg = wrapHookMessages(["one", "two", "three"]);
    expect(msg!.content).toBe(
      "<system-reminder>\none\n\ntwo\n\nthree\n</system-reminder>",
    );
  });

  it("trims each message and drops empties before joining", () => {
    const msg = wrapHookMessages(["  alpha  ", "", "beta\n", "   "]);
    expect(msg!.content).toBe(
      "<system-reminder>\nalpha\n\nbeta\n</system-reminder>",
    );
  });
});

describe("HookRegistry + wrapHookMessages integration", () => {
  it("aggregates messages from multiple handlers in priority order", async () => {
    const r = new HookRegistry();
    r.register(
      "on_session_start",
      () => ({ messages: ["low-priority"] }),
      1,
      "low",
    );
    r.register(
      "on_session_start",
      () => ({ messages: ["high-priority"] }),
      10,
      "high",
    );

    const result = await r.emit("on_session_start", { sessionId: "test" });
    expect(result.messages).toEqual(["high-priority", "low-priority"]);

    const wrapped = wrapHookMessages(result.messages);
    expect(wrapped!.content).toBe(
      "<system-reminder>\nhigh-priority\n\nlow-priority\n</system-reminder>",
    );
  });

  it("handler receives data merged via emit (smoke test for ctx envelope)", async () => {
    const r = new HookRegistry();
    let seen: Record<string, unknown> | undefined;
    r.register("user_prompt_submit", (ctx) => {
      seen = ctx.data;
      return {};
    });

    await r.emit("user_prompt_submit", {
      sessionId: "abc",
      isSubAgent: true,
      prompt: "hi",
    });

    expect(seen).toEqual({ sessionId: "abc", isSubAgent: true, prompt: "hi" });
  });

  it("handler can skip via isSubAgent and return no messages", async () => {
    const r = new HookRegistry();
    r.register("on_session_start", (ctx) => {
      if (ctx.data.isSubAgent === true) return {};
      return { messages: ["only for parent agents"] };
    });

    const child = await r.emit("on_session_start", { isSubAgent: true });
    expect(child.messages).toBeUndefined();

    const parent = await r.emit("on_session_start", { isSubAgent: false });
    expect(parent.messages).toEqual(["only for parent agents"]);
  });

  it("returning {stop: true} short-circuits the chain but keeps prior messages", async () => {
    const r = new HookRegistry();
    let third = false;
    r.register("on_session_start", () => ({ messages: ["first"] }), 30);
    r.register(
      "on_session_start",
      () => ({ messages: ["second"], stop: true }),
      20,
    );
    r.register(
      "on_session_start",
      () => {
        third = true;
        return { messages: ["third"] };
      },
      10,
    );

    const result = await r.emit("on_session_start", {});
    expect(third).toBe(false);
    expect(result.messages).toEqual(["first", "second"]);
    expect(result.stop).toBe(true);
  });
});

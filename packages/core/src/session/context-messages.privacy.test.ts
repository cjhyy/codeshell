import { describe, expect, test } from "bun:test";
import {
  isContextEvent,
  withoutContextEvents,
  withoutLocalContextState,
} from "./context-messages.js";

const message = (data: Record<string, unknown>) => ({ id: "e", type: "message", data });

describe("engine context privacy helpers", () => {
  test("ledger, reminder and prompt-rewrite events are context; ordinary messages are not", () => {
    expect(isContextEvent(message({ role: "user", contextLedger: { kind: "snapshot" } }))).toBe(
      true,
    );
    expect(isContextEvent(message({ role: "user", hookReminder: {} }))).toBe(true);
    expect(isContextEvent({ type: "prompt_rewrite", data: { messageEventId: "m" } })).toBe(true);
    expect(isContextEvent({ type: "context_checkpoint", data: { messages: [] } })).toBe(true);
    // Other injected messages (steers, goal control) are conversation.
    expect(isContextEvent(message({ role: "user", injected: true, content: "steer" }))).toBe(false);
    expect(isContextEvent(message({ role: "assistant", content: "answer" }))).toBe(false);
    expect(isContextEvent({ type: "tool_result", data: { hookReminder: {} } })).toBe(false);
    for (const odd of [null, undefined, "message", [], { type: "message" }]) {
      expect(isContextEvent(odd)).toBe(false);
    }
  });

  test("withoutContextEvents keeps order and everything else", () => {
    const events = [
      message({ role: "user", content: "q" }),
      message({ role: "user", contextLedger: {} }),
      { type: "prompt_rewrite", data: {} },
      { type: "context_checkpoint", data: { messages: [{ role: "user", content: "private" }] } },
      message({ role: "assistant", content: "a" }),
    ];
    expect(withoutContextEvents(events)).toEqual([events[0], events[4]]);
  });

  test("withoutLocalContextState drops only the hook messages", () => {
    const state = { sessionId: "s", cwd: "/w", promptSubmitHookMessages: ["rules"] };
    expect(withoutLocalContextState(state)).toEqual({ sessionId: "s", cwd: "/w" });
    expect(state.promptSubmitHookMessages).toEqual(["rules"]);
    const plain = { sessionId: "s" };
    expect(withoutLocalContextState(plain)).toBe(plain);
    expect(withoutLocalContextState(null)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  isContextEvent,
  redactContextEvents,
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
      message({ role: "assistant", content: "a" }),
    ];
    expect(withoutContextEvents(events)).toEqual([events[0], events[3]]);
  });

  test("redactContextEvents keeps each event's place but none of the context text", () => {
    const events = [
      { id: "q", type: "message", timestamp: 1, turnNumber: 1, data: { role: "user" } },
      {
        id: "l",
        type: "message",
        timestamp: 2,
        turnNumber: 1,
        data: { role: "user", content: "LEDGER", contextLedger: {} },
      },
      {
        id: "r",
        type: "prompt_rewrite",
        timestamp: 3,
        turnNumber: 1,
        data: { messageEventId: "q", content: "REWRITE" },
      },
    ];
    const redacted = redactContextEvents(events);
    expect(redacted[0]).toBe(events[0]);
    expect(redacted.slice(1)).toEqual([
      { id: "l", type: "message", timestamp: 2, turnNumber: 1, data: { redactedContext: true } },
      {
        id: "r",
        type: "prompt_rewrite",
        timestamp: 3,
        turnNumber: 1,
        data: { redactedContext: true },
      },
    ]);
    // A stub is still context: an export of a remote detail drops it.
    expect(redacted.slice(1).every(isContextEvent)).toBe(true);
    expect(withoutContextEvents(redacted)).toEqual([events[0]]);
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

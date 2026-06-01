import { describe, it, expect } from "bun:test";
import { mergeTranscripts } from "./mergeTranscripts";
import type { Message, MessagesReducerState } from "../types";
import { INITIAL_STATE } from "../types";

/** Build a MessagesReducerState from a bare list of messages. */
function stateOf(messages: Message[], extra?: Partial<MessagesReducerState>): MessagesReducerState {
  return { ...INITIAL_STATE, messages, ...extra };
}

const user = (id: string, text: string): Message => ({ kind: "user", id, text });
const assistant = (id: string, text: string): Message => ({ kind: "assistant", id, text, done: true });
const system = (id: string, text: string): Message => ({ kind: "system", id, text });
const tool = (id: string, toolName: string, args: string): Message => ({
  kind: "tool",
  id,
  toolName,
  args,
  status: "ok",
  startedAt: 0,
});

describe("mergeTranscripts", () => {
  it("keeps disk as the canonical base and appends live-only tail", () => {
    // disk: headless briefing turn (different ids than the live re-render would use)
    const disk = stateOf([
      user("d-u1", "汇总新闻"),
      assistant("d-a1", "今日简报：……"),
    ]);
    // live (localStorage): only the manual follow-up turn was streamed in
    const live = stateOf([
      user("l-u1", "为什么没输出"),
      assistant("l-a1", "我刚才误解成……"),
    ]);

    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.map((m) => [m.kind, (m as { text: string }).text])).toEqual([
      ["user", "汇总新闻"],
      ["assistant", "今日简报：……"],
      ["user", "为什么没输出"],
      ["assistant", "我刚才误解成……"],
    ]);
  });

  it("does not duplicate turns present in both disk and live (different ids)", () => {
    // Live re-rendered the SAME briefing turn the disk has, but with fresh ids.
    const disk = stateOf([user("d-u1", "汇总新闻"), assistant("d-a1", "今日简报：……")]);
    const live = stateOf([
      user("l-u1", "汇总新闻"), // same text, different id
      assistant("l-a1", "今日简报：……"),
      user("l-u2", "再补充一句"), // genuinely new live-only turn
    ]);

    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.map((m) => (m as { text: string }).text)).toEqual([
      "汇总新闻",
      "今日简报：……",
      "再补充一句",
    ]);
  });

  it("dedupes tool messages by name + args, not id", () => {
    const disk = stateOf([tool("d-t1", "WebFetch", '{"url":"a"}')]);
    const live = stateOf([
      tool("l-t1", "WebFetch", '{"url":"a"}'), // dup of disk
      tool("l-t2", "Bash", '{"command":"ls"}'), // new
    ]);
    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.map((m) => (m as { toolName: string }).toolName)).toEqual([
      "WebFetch",
      "Bash",
    ]);
  });

  it("falls back to live when disk is empty", () => {
    const live = stateOf([user("l-u1", "hi"), assistant("l-a1", "hello")]);
    const merged = mergeTranscripts(INITIAL_STATE, live);
    expect(merged.messages).toEqual(live.messages);
  });

  it("uses disk alone when live is empty", () => {
    const disk = stateOf([user("d-u1", "hi"), assistant("d-a1", "hello")], { sessionId: "s1" });
    const merged = mergeTranscripts(disk, INITIAL_STATE);
    expect(merged.messages).toEqual(disk.messages);
    expect(merged.sessionId).toBe("s1");
  });

  it("does not double when disk and live fully overlap", () => {
    const disk = stateOf([user("d-u1", "hi"), assistant("d-a1", "hello")]);
    const live = stateOf([user("l-u1", "hi"), assistant("l-a1", "hello")]);
    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.map((m) => (m as { text: string }).text)).toEqual(["hi", "hello"]);
  });

  it("preserves session metadata from disk, falling back to live", () => {
    const disk = stateOf([assistant("d-a1", "x")], { sessionId: null, promptTokens: 0 });
    const live = stateOf([user("l-u1", "y")], { sessionId: "live-sess", promptTokens: 42 });
    const merged = mergeTranscripts(disk, live);
    expect(merged.sessionId).toBe("live-sess");
    expect(merged.promptTokens).toBe(42);
  });
});

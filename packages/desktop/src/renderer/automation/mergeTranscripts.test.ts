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
const filesChanged = (id: string, path: string, added: number, removed: number): Message => ({
  kind: "files_changed",
  id,
  files: [{ path, added, removed, count: 1 }],
  totalAdded: added,
  totalRemoved: removed,
});
const contextBoundary = (id: string, before: number, after: number): Message => ({
  kind: "context_boundary",
  id,
  strategy: "summary",
  before,
  after,
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

  // Regression: files_changed / context_boundary cards ARE produced by the
  // disk fold (turn_complete -> files_changed, context_compact ->
  // context_boundary), each with a fresh random id. The merged result is
  // persisted back to localStorage, so on the NEXT open `live` carries the
  // previously-folded card (old id) while the fresh fold produces the same
  // card with a new id. Keying these on id let the old copy survive in the
  // tail, so the card accumulated one duplicate per re-open.
  it("dedupes files_changed cards by content, not id (no accumulation on re-open)", () => {
    // Fresh disk fold of a headless run that edited a.ts.
    const disk = stateOf([
      user("d-u1", "改一下 a.ts"),
      assistant("d-a1", "done"),
      filesChanged("files-changed-2-1", "a.ts", 3, 1),
    ]);
    // localStorage from a PRIOR open: same turn, but the card was folded with a
    // different fresh id last time and persisted back.
    const live = stateOf([
      user("l-u1", "改一下 a.ts"),
      assistant("l-a1", "done"),
      filesChanged("files-changed-1-9", "a.ts", 3, 1), // same content, stale id
    ]);
    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.filter((m) => m.kind === "files_changed")).toHaveLength(1);
  });

  it("dedupes context_boundary cards by content, not id", () => {
    const disk = stateOf([
      assistant("d-a1", "x"),
      contextBoundary("ctx-2-1", 1000, 200),
    ]);
    const live = stateOf([
      assistant("l-a1", "x"),
      contextBoundary("ctx-1-9", 1000, 200), // same content, stale id
    ]);
    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.filter((m) => m.kind === "context_boundary")).toHaveLength(1);
  });

  it("keeps a genuinely different files_changed card (different files)", () => {
    const disk = stateOf([filesChanged("fc-1", "a.ts", 3, 1)]);
    const live = stateOf([filesChanged("fc-2", "b.ts", 5, 0)]); // different file = real new card
    const merged = mergeTranscripts(disk, live);
    expect(merged.messages.filter((m) => m.kind === "files_changed")).toHaveLength(2);
  });

  // Regression (orphan "已处理 N 条命令" group at the bottom): now that
  // automation runs ALSO stream live into the renderer (ingestExternalEvent),
  // localStorage carries the SAME turn the disk fold produces — PLUS live-only
  // kinds the disk fold never emits (task_list / agent / ask_user, keyed by
  // kind|id). The old dedup kept those live-only messages and appended them as
  // a tail, even though they belong to a turn disk already fully covers. With
  // no user message among them, buildStreamItems folded the leaked tools into a
  // single orphan TurnProcessGroup pinned to the very bottom. Fix: a live
  // message only survives as tail when it comes AFTER the last live message
  // that disk also has (a genuine continuation) — live-only messages inside an
  // already-covered span are dropped.
  it("drops live-only messages that fall inside a disk-covered turn (no orphan tail)", () => {
    const taskList = (id: string): Message => ({ kind: "task_list", id, tasks: [] });
    const agent = (id: string): Message => ({
      kind: "agent",
      id,
      description: "sub",
      done: true,
      startedAt: 0,
      toolCalls: [],
      textBuffer: "",
      toolCount: 0,
    });
    // disk = the complete automation turn (authoritative).
    const disk = stateOf([
      user("d-u1", "汇总新闻"),
      tool("d-t1", "WebSearch", '{"q":"a"}'),
      tool("d-t2", "WebFetch", '{"url":"b"}'),
      assistant("d-a1", "今日简报：……"),
    ]);
    // live = the SAME turn streamed in (tools dedupe by name+args), but with
    // interleaved live-only task_list/agent the disk fold never produced.
    const live = stateOf([
      user("l-u1", "汇总新闻"),
      taskList("l-tl1"),
      tool("l-t1", "WebSearch", '{"q":"a"}'),
      agent("l-ag1"),
      tool("l-t2", "WebFetch", '{"url":"b"}'),
      assistant("l-a1", "今日简报：……"),
    ]);
    const merged = mergeTranscripts(disk, live);
    // No leaked tail: everything in live is covered by disk's turn.
    expect(merged.messages).toEqual(disk.messages);
  });

  it("still appends a genuine live continuation after a disk-covered turn", () => {
    const disk = stateOf([
      user("d-u1", "汇总新闻"),
      tool("d-t1", "WebSearch", '{"q":"a"}'),
      assistant("d-a1", "今日简报：……"),
    ]);
    const live = stateOf([
      user("l-u1", "汇总新闻"),
      tool("l-t1", "WebSearch", '{"q":"a"}'),
      assistant("l-a1", "今日简报：……"),
      user("l-u2", "帮我改成早上9点"), // genuine continuation AFTER the covered turn
      assistant("l-a2", "已改好"),
    ]);
    const merged = mergeTranscripts(disk, live);
    expect(
      merged.messages
        .filter((m) => m.kind === "user" || m.kind === "assistant")
        .map((m) => (m as { text: string }).text),
    ).toEqual([
      "汇总新闻",
      "今日简报：……",
      "帮我改成早上9点",
      "已改好",
    ]);
    // The continuation's tools/turns are present; no orphan duplication.
    expect(merged.messages.filter((m) => m.kind === "tool")).toHaveLength(1);
  });

  it("preserves session metadata from disk, falling back to live", () => {
    const disk = stateOf([assistant("d-a1", "x")], { sessionId: null, promptTokens: 0 });
    const live = stateOf([user("l-u1", "y")], { sessionId: "live-sess", promptTokens: 42 });
    const merged = mergeTranscripts(disk, live);
    expect(merged.sessionId).toBe("live-sess");
    expect(merged.promptTokens).toBe(42);
  });
});

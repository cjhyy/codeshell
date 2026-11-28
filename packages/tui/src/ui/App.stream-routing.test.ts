import { describe, expect, test } from "bun:test";
import type { AsyncAgentEntry } from "@cjhyy/code-shell-core/internal";
import { shouldAppendThinkingDeltaToMainFeed } from "./App.js";
import { applyPendingToolArgs } from "./app-helpers.js";
import type { ChatEntry } from "./store.js";
import {
  agentRowSignature,
  subscribeAgentRegistryGated,
  type AgentRegistrySource,
} from "./hooks/useAgentRegistrySnapshot.js";

describe("stream event routing", () => {
  test("routes only main-agent thinking deltas into the main feed", () => {
    expect(shouldAppendThinkingDeltaToMainFeed(undefined)).toBe(true);
    expect(shouldAppendThinkingDeltaToMainFeed("agent-1")).toBe(false);
  });
});

describe("buffered tool_use_args_delta", () => {
  const row = (id: string, toolCallId: string, args: Record<string, unknown> = {}): ChatEntry =>
    ({ id, type: "tool_start", toolName: "Write", toolCallId, args }) as ChatEntry;

  test("applies the latest args per call and keeps untouched rows by identity", () => {
    const entries = [row("1", "call-a"), row("2", "call-b"), row("3", "call-c")];
    const next = applyPendingToolArgs(
      entries,
      new Map([
        ["call-b", { content: "x".repeat(4) }],
        ["call-c", { content: "y" }],
      ]),
    );
    expect(next).not.toBe(entries);
    expect(next[0]).toBe(entries[0]);
    expect((next[1] as { args: unknown }).args).toEqual({ content: "xxxx" });
    expect((next[2] as { args: unknown }).args).toEqual({ content: "y" });
    expect((entries[1] as { args: unknown }).args).toEqual({});
  });

  test("returns the same array when no tool_start row matches", () => {
    const entries = [row("1", "call-a")];
    expect(applyPendingToolArgs(entries, new Map([["missing", { a: 1 }]]))).toBe(entries);
  });

  test("targets the most recent row when a toolCallId repeats", () => {
    const entries = [row("1", "dup"), row("2", "dup")];
    const next = applyPendingToolArgs(entries, new Map([["dup", { a: 1 }]]));
    expect(next[0]).toBe(entries[0]);
    expect((next[1] as { args: unknown }).args).toEqual({ a: 1 });
  });
});

/** Mirrors AsyncAgentRegistry: entries mutate in place, notify() copies. */
function fakeRegistry() {
  const listeners = new Set<() => void>();
  const agent: AsyncAgentEntry = {
    agentId: "a1",
    description: "explore",
    status: "running",
    startedAt: 1,
    abort: () => {},
    transcript: [],
  };
  let snapshot: AsyncAgentEntry[] = [agent];
  const notify = () => {
    snapshot = [agent];
    for (const cb of listeners) cb();
  };
  const source: AgentRegistrySource = {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => snapshot,
  };
  return {
    source,
    token: () => {
      agent.transcript!.push({ id: String(agent.transcript!.length), type: "assistant_text" });
      notify();
    },
    finish: () => {
      agent.status = "completed";
      agent.finishedAt = 2;
      notify();
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("gated agent registry subscription", () => {
  test("ignores per-token transcript touches when no transcript is on screen", async () => {
    const reg = fakeRegistry();
    let calls = 0;
    const off = subscribeAgentRegistryGated(reg.source, { watchTranscripts: false }, () => calls++);
    for (let i = 0; i < 100; i++) reg.token();
    await wait(30);
    expect(calls).toBe(0);
    reg.finish();
    expect(calls).toBe(1);
    off();
  });

  test("coalesces transcript touches into one throttled update when watched", async () => {
    const reg = fakeRegistry();
    const seen: AsyncAgentEntry[][] = [];
    const off = subscribeAgentRegistryGated(
      reg.source,
      { watchTranscripts: true, throttleMs: 10 },
      (s) => seen.push(s),
    );
    for (let i = 0; i < 100; i++) reg.token();
    expect(seen).toHaveLength(0);
    await wait(60);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]!.transcript).toHaveLength(100);
    off();
  });

  test("row changes flush immediately and cancel a pending throttle", async () => {
    const reg = fakeRegistry();
    let calls = 0;
    const off = subscribeAgentRegistryGated(
      reg.source,
      { watchTranscripts: true, throttleMs: 10 },
      () => calls++,
    );
    reg.token();
    reg.finish();
    expect(calls).toBe(1);
    await wait(60);
    expect(calls).toBe(1);
    off();
  });

  test("emits a change that landed before subscribing", () => {
    const reg = fakeRegistry();
    const stale = agentRowSignature(reg.source.getSnapshot());
    reg.finish();
    let calls = 0;
    const off = subscribeAgentRegistryGated(
      reg.source,
      { watchTranscripts: false },
      () => calls++,
      stale,
    );
    expect(calls).toBe(1);
    off();
  });
});

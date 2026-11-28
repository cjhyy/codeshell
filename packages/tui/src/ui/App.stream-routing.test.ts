import { describe, expect, test } from "bun:test";
import type { AsyncAgentEntry } from "@cjhyy/code-shell-core/internal";
import { shouldAppendThinkingDeltaToMainFeed } from "./App.js";
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

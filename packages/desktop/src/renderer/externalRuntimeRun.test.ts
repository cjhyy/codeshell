/**
 * The behaviour that matters here is the session cache: restarting a runtime
 * mid-conversation silently drops its context, and NOT restarting after a
 * model switch silently sends to the wrong backend. Both are quiet failures,
 * so both get pinned.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  forgetExternalRuntimeSession,
  resolveRunSessionId,
  resetExternalRuntimeSessions,
  runExternalRuntimeTurn,
  type ExternalRuntimeBridge,
} from "./externalRuntimeRun.js";

function bridge(overrides: Partial<ExternalRuntimeBridge> = {}) {
  const starts: Array<{ sessionId: string; modelKey: string }> = [];
  const sends: Array<{ sessionId: string; text: string }> = [];
  const impl: ExternalRuntimeBridge = {
    start: async ({ sessionId, modelKey }) => {
      starts.push({ sessionId, modelKey });
      return { kind: "codex", runtimeSessionId: "t-1", tools: [] };
    },
    send: async ({ sessionId, text }) => {
      sends.push({ sessionId, text });
    },
    ...overrides,
  };
  return { impl, starts, sends };
}

const base = { sessionId: "sess-1", cwd: "/tmp/project", modelKey: "codex/gpt-5.6-sol" };

beforeEach(() => resetExternalRuntimeSessions());

describe("runExternalRuntimeTurn", () => {
  test("keeps external business identity on the UI session id", () => {
    expect(resolveRunSessionId("ui-session", "leaked-provider-id", true)).toBe("ui-session");
    expect(resolveRunSessionId("ui-session", "legacy-engine-id", false)).toBe("legacy-engine-id");
    expect(resolveRunSessionId("ui-session", undefined, false)).toBe("ui-session");
  });

  test("starts once, then reuses the session for later turns", async () => {
    // Restarting per turn would hand the model an empty context each time —
    // the conversation would appear to forget everything after each reply.
    const { impl, starts, sends } = bridge();
    await runExternalRuntimeTurn({ ...base, text: "one", runtime: impl });
    await runExternalRuntimeTurn({ ...base, text: "two", runtime: impl });
    expect(starts).toHaveLength(1);
    expect(sends.map((s) => s.text)).toEqual(["one", "two"]);
  });

  test("serializes concurrent first turns so they start the runtime only once", async () => {
    let releaseStart!: () => void;
    const startReady = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { impl, starts, sends } = bridge({
      start: async ({ sessionId, modelKey }) => {
        starts.push({ sessionId, modelKey });
        await startReady;
        return { kind: "codex", runtimeSessionId: "t-1", tools: [] };
      },
    });

    const first = runExternalRuntimeTurn({ ...base, text: "one", runtime: impl });
    await Promise.resolve();
    const second = runExternalRuntimeTurn({ ...base, text: "two", runtime: impl });
    await Promise.resolve();
    expect(starts).toHaveLength(1);

    releaseStart();
    await Promise.all([first, second]);
    expect(starts).toHaveLength(1);
    expect(sends.map((send) => send.text)).toEqual(["one", "two"]);
  });

  test("restarts when the model key changes", async () => {
    // Codex → Claude has to rebuild the backend; reusing would send to the
    // runtime the user just switched away from.
    const { impl, starts } = bridge();
    await runExternalRuntimeTurn({ ...base, text: "one", runtime: impl });
    await runExternalRuntimeTurn({
      ...base,
      modelKey: "claude-code/sonnet",
      text: "two",
      runtime: impl,
    });
    expect(starts.map((s) => s.modelKey)).toEqual(["codex/gpt-5.6-sol", "claude-code/sonnet"]);
  });

  test("tracks sessions independently", async () => {
    const { impl, starts } = bridge();
    await runExternalRuntimeTurn({ ...base, text: "a", runtime: impl });
    await runExternalRuntimeTurn({ ...base, sessionId: "sess-2", text: "b", runtime: impl });
    expect(starts.map((s) => s.sessionId)).toEqual(["sess-1", "sess-2"]);
  });

  test("a failed start is not cached, so the next turn retries it", async () => {
    // Caching a failed start would leave the session permanently sending into
    // a runtime that was never created.
    let attempt = 0;
    const { impl, sends } = bridge({
      start: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("codex not found");
        return { kind: "codex", runtimeSessionId: "t-1", tools: [] };
      },
    });

    const failed = await runExternalRuntimeTurn({ ...base, text: "one", runtime: impl });
    expect(failed.ok).toBe(false);
    expect(failed.text).toMatch(/codex not found/);
    expect(sends).toHaveLength(0);

    const second = await runExternalRuntimeTurn({ ...base, text: "two", runtime: impl });
    expect(second.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  test("a send failure is reported rather than thrown", async () => {
    // The caller's .then chain clears busy; a throw would skip it and leave the
    // composer stuck.
    const { impl } = bridge({
      send: async () => {
        throw new Error("turn exploded");
      },
    });
    const result = await runExternalRuntimeTurn({ ...base, text: "one", runtime: impl });
    expect(result).toEqual({
      ok: false,
      reason: "external_runtime_error",
      text: "turn exploded",
    });
  });

  test("forgetting a session forces a fresh start", async () => {
    const { impl, starts } = bridge();
    await runExternalRuntimeTurn({ ...base, text: "one", runtime: impl });
    forgetExternalRuntimeSession("sess-1");
    await runExternalRuntimeTurn({ ...base, text: "two", runtime: impl });
    expect(starts).toHaveLength(2);
  });

  test("forgetting during start prevents the stale request from restoring the cache", async () => {
    let releaseStart!: () => void;
    const startReady = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { impl, starts, sends } = bridge({
      start: async ({ sessionId, modelKey }) => {
        starts.push({ sessionId, modelKey });
        await startReady;
        return { kind: "codex", runtimeSessionId: "t-1", tools: [] };
      },
    });

    const stale = runExternalRuntimeTurn({ ...base, text: "stale", runtime: impl });
    await Promise.resolve();
    forgetExternalRuntimeSession("sess-1");
    releaseStart();
    expect((await stale).ok).toBe(false);
    expect(sends).toHaveLength(0);

    await runExternalRuntimeTurn({ ...base, text: "fresh", runtime: impl });
    expect(starts).toHaveLength(2);
    expect(sends.map((send) => send.text)).toEqual(["fresh"]);
  });
});

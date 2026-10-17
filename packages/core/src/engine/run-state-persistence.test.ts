import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/session-manager.js";
import type { TokenUsage } from "../types.js";
import { persistRunState, type RunningSessionState } from "./run-state-persistence.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const usage = (promptTokens: number, cacheReadTokens = 0): TokenUsage => ({
  promptTokens,
  completionTokens: 0,
  totalTokens: promptTokens,
  cacheReadTokens,
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "foreground-cache-persist-"));
  dirs.push(dir);
  const manager = new SessionManager(dir);
  const { state } = manager.create("/tmp/project", "model", "provider", "cache-session");
  manager.registerSessionGeneration(state.sessionId);
  manager.startSessionRun(state, "cache-run");
  let billed = usage(1500, 800);
  let foreground = usage(1000, 800);
  const running: RunningSessionState = {
    sessionId: state.sessionId,
    runId: "cache-run",
    state,
    committedUsage: usage(0),
    committedCacheUsage: usage(0),
    committedAnchor: undefined,
    finalized: false,
    ownUsage: () => billed,
    ownCacheUsage: () => foreground,
  };
  const persist = () =>
    persistRunState({
      manager,
      state,
      runId: "cache-run",
      running,
      fields: { status: "active" },
      costState: () => ({}),
    });
  return {
    manager,
    state,
    running,
    persist,
    advance() {
      billed = usage(2000, 1200);
      foreground = usage(1500, 1200);
    },
  };
}

test("heartbeats and final state merge foreground cache independently of all billed input", () => {
  const f = fixture();
  expect(f.persist()).toBe(true);
  expect(f.persist()).toBe(true);
  expect(f.manager.resume(f.state.sessionId).state).toMatchObject({
    cacheUsageVersion: 1,
    tokenUsage: { promptTokens: 1500, cacheReadTokens: 800 },
    cumulativePromptTokens: 1000,
    cumulativeCacheReadTokens: 800,
  });
  // A detached owner settles auxiliary usage between this run's checkpoints.
  f.manager.recordAuxiliaryUsage(f.state.sessionId, usage(250));
  f.advance();
  expect(f.persist()).toBe(true);
  expect(f.manager.resume(f.state.sessionId).state).toMatchObject({
    tokenUsage: { promptTokens: 2250, cacheReadTokens: 1200 },
    cumulativePromptTokens: 1500,
    cumulativeCacheReadTokens: 1200,
  });
});

test("a failed state write advances neither billing nor foreground checkpoints", () => {
  const f = fixture();
  const write = spyOn(f.manager, "updateSessionRunState").mockImplementationOnce(() => {
    throw new Error("CAS writer won");
  });
  expect(f.persist()).toBe(false);
  expect(f.running.committedUsage.promptTokens).toBe(0);
  expect(f.running.committedCacheUsage.promptTokens).toBe(0);
  write.mockRestore();
  f.manager.recordAuxiliaryUsage(f.state.sessionId, usage(250));
  expect(f.persist()).toBe(true);
  expect(f.persist()).toBe(true);
  expect(f.manager.resume(f.state.sessionId).state).toMatchObject({
    tokenUsage: { promptTokens: 1750 },
    cumulativePromptTokens: 1000,
    cumulativeCacheReadTokens: 800,
  });
});

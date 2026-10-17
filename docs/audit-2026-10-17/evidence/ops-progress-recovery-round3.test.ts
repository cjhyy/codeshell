import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialAgentProgress, reduceAgentProgress } from "../../../packages/core/src/tool-system/builtin/agent-progress.ts";
import { FileRunStore } from "../../../packages/core/src/run/FileRunStore.ts";
import { RunManager } from "../../../packages/core/src/run/RunManager.ts";
import type { RunSnapshot } from "../../../packages/core/src/run/types.ts";

const roots: string[] = [];
const managers: RunManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("observation: parallel tool A completion inherits tool B start timestamp", () => {
  let progress = initialAgentProgress(1);
  progress = reduceAgentProgress(progress, { type: "tool_use_start", toolCall: { id: "a", toolName: "Read", args: {} } }, 10);
  progress = reduceAgentProgress(progress, { type: "tool_use_start", toolCall: { id: "b", toolName: "Search", args: {} } }, 20);
  progress = reduceAgentProgress(progress, { type: "tool_result", result: { id: "a", toolName: "Read", result: "done" } }, 30);
  console.log(JSON.stringify({ observation: "parallel-tool-start-attribution", expectedReadStartedAt: 10, actual: progress.lastTool }));
  expect(progress.lastTool).toEqual({ name: "Read", state: "completed", startedAt: 20, finishedAt: 30 });
});

test("boundary observation: cold queued snapshot is ignored by recover and resume, SDK start executes it", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "codeshell-audit-ops-recovery-"));
  roots.push(runsDir);
  const store = new FileRunStore(runsDir);
  const now = Date.now();
  const snapshot: RunSnapshot = {
    runId: "queued-before-restart", objective: "Create report", preset: "general", cwd: runsDir,
    status: "queued", createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    parentRunId: null, sessionId: null, childSessionIds: [], attemptCount: 0,
    latestCheckpointId: null, latestApprovalId: null, summary: null, error: null, tags: [], metadata: {},
  };
  await store.create(snapshot);
  let calls = 0;
  const manager = new RunManager({ store, runsDir, executor: { async execute() {
    calls++;
    return { result: { text: "done", reason: "completed", turnCount: 1, sessionId: "local-session" } } as any;
  } } });
  managers.push(manager);
  const recovered = await manager.recover();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const afterRecover = await store.get(snapshot.runId);
  expect(recovered).toEqual([]);
  expect(calls).toBe(0);
  expect(afterRecover?.status).toBe("queued");
  await expect(manager.resume(snapshot.runId)).rejects.toThrow("current status is queued");
  await manager.start(snapshot.runId);
  for (let index = 0; index < 100; index++) {
    if ((await store.get(snapshot.runId))?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const afterStart = await store.get(snapshot.runId);
  console.log(JSON.stringify({ observation: "queued-cold-boundary", recovered, afterRecover: afterRecover?.status, callsAfterSdkStart: calls, afterStart: afterStart?.status }));
  expect(calls).toBe(1);
  expect(afterStart?.status).toBe("completed");
});

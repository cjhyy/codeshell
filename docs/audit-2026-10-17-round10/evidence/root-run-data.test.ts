import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointWriter } from "../../../packages/core/src/run/CheckpointWriter.js";
import { FileRunStore } from "../../../packages/core/src/run/FileRunStore.js";
import type { RunStore } from "../../../packages/core/src/run/RunStore.js";
import type { RunCheckpoint, RunSnapshot } from "../../../packages/core/src/run/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writer(turnInterval = 0) {
  const checkpoints: RunCheckpoint[] = [];
  const store = { async saveCheckpoint(cp: RunCheckpoint) { checkpoints.push(structuredClone(cp)); } } as RunStore;
  return { checkpoints, writer: new CheckpointWriter({ runId: "owned-run", objective: "Owned offline objective", store, turnInterval }) };
}

describe("round10 checkpoint heuristic and ordinary data controls", () => {
  test("a negative test-status sentence still matches the documented keyword heuristic", async () => {
    const negative = writer();
    await negative.writer.onStreamEvent({ type: "assistant_message", message: { role: "assistant", content: "The tests did not pass. More work is required." } });
    expect(negative.checkpoints).toHaveLength(1);
    expect(negative.checkpoints[0].phase).toBe("tests_passing");
    expect(negative.checkpoints[0].summary).toBe("The tests did not pass. More work is required.");
    const positive = writer();
    await positive.writer.onStreamEvent({ type: "assistant_message", message: { role: "assistant", content: "The tests pass." } });
    expect(positive.checkpoints).toHaveLength(1);
    expect(positive.checkpoints[0].phase).toBe("tests_passing");
  });

  test("positive phase detection deduplicates one phase and keeps structured text", async () => {
    const h = writer();
    await h.writer.onStreamEvent({ type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "Research " }, { type: "text", text: "complete." }] } });
    await h.writer.onStreamEvent({ type: "assistant_message", message: { role: "assistant", content: "Research complete." } });
    expect(h.checkpoints).toHaveLength(1);
    expect(h.checkpoints[0].phase).toBe("research_complete");
    expect(h.checkpoints[0].summary).toBe("Research complete.");
  });

  test("final turn boundary preserves session pointer, tool names and periodic summary", async () => {
    const h = writer(2);
    h.writer.setSessionId("owned-session");
    await h.writer.onStreamEvent({ type: "stream_request_start", turnNumber: 2 });
    await h.writer.onStreamEvent({ type: "tool_use_start", toolCall: { id: "owned-call", toolName: "OwnedTool", args: {} } });
    await h.writer.onStreamEvent({ type: "assistant_message", message: { role: "assistant", content: "Ordinary response with no phase keywords." } });
    await h.writer.onStreamEvent({ type: "turn_complete", reason: "completed" });
    expect(h.checkpoints).toHaveLength(1);
    expect(h.checkpoints[0]).toMatchObject({ phase: "turn_2", linkedSessionId: "owned-session", touchedTools: ["OwnedTool"], metadata: { turn: 2 } });
    expect(h.writer.getTouchedTools()).toEqual(["OwnedTool"]);
  });
});

test("round10 ordinary store filters before paging and preserves independent disk values", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-run-data-r10-")); roots.push(root);
  const store = new FileRunStore(root);
  const base: RunSnapshot = { runId: "owned-a", objective: "Owned data", preset: "terminal-coding", cwd: root, status: "completed", createdAt: 1, updatedAt: 1, startedAt: null, finishedAt: null, parentRunId: null, sessionId: null, childSessionIds: [], attemptCount: 0, latestCheckpointId: null, latestApprovalId: null, summary: null, error: null, tags: ["kept"], metadata: {} };
  await store.create(base);
  await store.create({ ...base, runId: "owned-b", status: "failed", createdAt: 2 });
  await store.create({ ...base, runId: "owned-c", createdAt: 3, tags: ["other"] });
  expect((await store.list({ status: ["completed", "failed"], tag: "kept", offset: 1, limit: 1 })).map(s => s.runId)).toEqual(["owned-a"]);
  expect((await store.list({ status: "completed", tag: "kept" })).map(s => s.runId)).toEqual(["owned-a"]);
  const read = await store.get("owned-a");
  read!.tags.push("local-edit");
  expect((await store.get("owned-a"))!.tags).toEqual(["kept"]);
  for (const [index, eventId] of ["event-a", "event-b"].entries()) await store.appendEvent({ eventId, runId: "owned-a", type: "run_created", timestamp: index + 1, data: {} });
  expect((await store.listEvents("owned-a")).map(e => e.eventId)).toEqual(["event-a", "event-b"]);
});

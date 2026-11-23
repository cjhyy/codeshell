import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { HostOutput } from "./host-output.js";
import {
  StoredDesktopOutput,
  type OutputMutation,
  type OutputPublication,
} from "./stored-output.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-host-output-"));
  roots.push(root);
  const manager = new SessionManager(root);
  manager.create(root, "test", "test", "work");
  return new StoredDesktopOutput(root);
}

const line = (type: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/streamEvent",
    params: { sessionId: "work", event: { type } },
  });

test("Host commits worker and external publications in one sequence before subsequent reads", async () => {
  const stored = store();
  const delivered: OutputPublication[] = [];
  const storage = {
    request: async (
      command: string,
      arg: OutputMutation | { sessionId: string; sinceSeq?: number },
    ) =>
      command === "output/mutate"
        ? stored.mutate(arg as OutputMutation)
        : stored.snapshots.get(
            (arg as { sessionId: string }).sessionId,
            (arg as { sinceSeq?: number }).sinceSeq,
          ),
  };
  const output = new HostOutput(
    Promise.resolve(storage as StateStorage),
    (batch) => delivered.push(...batch),
    () => {},
    () => {},
    (e) => {
      throw e;
    },
  );
  output.push(line("session_started"));
  const pending = output.mutate({
    type: "publish",
    sessionId: "work",
    event: { type: "session_started" },
    owned: true,
  });
  output.push(line("stream_request_start"));
  const snapshot = await output.snapshot("work", 1);
  await pending;
  expect(delivered.map((item) => [item.origin, item.envelope.seq])).toEqual([
    ["worker", 1],
    ["owned", 2],
    ["worker", 3],
  ]);
  expect(snapshot.events.map((entry) => entry.seq)).toEqual([2, 3]);
  expect(delivered.every((item) => item.envelope.epoch === snapshot.epoch)).toBe(true);
  expect(snapshot.topLevelRunning).toBe(true);
  await output.mutate({ type: "worker-exit" });
  expect((await output.snapshot("work")).topLevelRunning).toBe(true);
});

test("a forgotten source cannot publish to a subsequent session lifetime", () => {
  const stored = store();
  stored.mutate({ type: "capture", sessionId: "work", sourceId: "old", workerRunning: false });
  stored.mutate({ type: "forget", sessionId: "work" });
  expect(() =>
    stored.mutate({
      type: "captured",
      sessionId: "work",
      sourceId: "old",
      event: { type: "error", error: "late" },
    }),
  ).toThrow("revoked");
  expect(stored.snapshots.get("work").events).toEqual([]);
});

test("Host pauses worker on bounded bytes, flushes in order, and surfaces loss", async () => {
  const pressure: boolean[] = [];
  const batchSizes: number[] = [];
  const errors: unknown[] = [];
  let failure = false;
  const storage = {
    request: async (_command: string, payload: OutputMutation) => {
      if (failure) throw new Error("storage offline");
      if (payload.type === "worker") batchSizes.push(payload.lines.length);
      return { frames: [], diagnostics: [] };
    },
  };
  const output = new HostOutput(
    Promise.resolve(storage as StateStorage),
    () => {},
    () => {},
    (state) => pressure.push(state),
    (e) => errors.push(e),
  );
  const chunk = "a".repeat(1024 * 1024);
  for (let i = 0; i < 4; i++) output.push(chunk);
  expect(pressure).toEqual([true]);
  await output.drain();
  expect(pressure).toEqual([true, false]);
  expect(batchSizes).toEqual([1, 1, 1, 1]);
  failure = true;
  output.push("lost");
  await output.drain();
  expect(String(errors[0])).toContain("storage offline");
});

import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptSubscriptionManager } from "./transcript-subscriptions.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const line = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
function fixture(padding = 0) {
  const root = mkdtempSync(join(tmpdir(), "transcript-poll-"));
  const file = join(root, "transcript.jsonl");
  const original =
    line("baseline") +
    (JSON.stringify({ type: "metadata", padding: "x".repeat(128 * 1024) }) + "\n").repeat(padding);
  writeFileSync(file, original);
  const messages: unknown[] = [];
  const failures: string[] = [];
  const manager = new TranscriptSubscriptionManager({
    resolveFile: () => file,
    onStart() {},
    onStop() {},
    roomCursor: () => messages.length,
    onMessages(_room, batch) {
      messages.push(...batch);
    },
    onFailure(_room, message) {
      failures.push(message);
    },
    pollIntervalMs: 60_000,
  });
  const target = {
    roomId: "room",
    cwd: "/fixture",
    sessionId: "session",
    kind: "claude-code" as const,
    subscriberId: "first",
    limit: 50,
  };
  manager.subscribe(target);
  const record = (
    manager as unknown as {
      follows: Map<
        string,
        {
          listener(): void;
          polling?: Promise<void>;
        }
      >;
    }
  ).follows.get(target.roomId)!;
  const poll = () => {
    record.listener();
    return record.polling!;
  };
  cleanups.push(() => {
    manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { file, original, manager, target, messages, failures, poll };
}

test("growing 16 MiB transcripts yield to Main callbacks and concurrent polls share one read", async () => {
  const f = fixture(128);
  appendFileSync(f.file, line("new output"));
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const first = f.poll();
  expect(f.poll()).toBe(first);
  expect(f.messages).toHaveLength(0);
  await first;
  expect(yielded).toBe(true);
  expect(f.messages).toMatchObject([{ type: "text", text: "new output" }]);
  expect(f.failures).toEqual([]);
});

test("async polling still rejects a rewrite anywhere in the committed prefix", async () => {
  const f = fixture(8);
  writeFileSync(f.file, f.original.replace("baseline", "tampered") + line("new output"));
  await f.poll();
  expect(f.messages).toHaveLength(0);
  expect(f.failures).toHaveLength(1);
  expect(f.failures[0]).toContain("prefix was rewritten");
});

for (const action of ["subscribe", "close"] as const)
  test(`a synchronous ${action} racing a poll drains once and invalidates the old capture`, async () => {
    const f = fixture(8);
    appendFileSync(f.file, line("last output"));
    const pending = f.poll();
    if (action === "subscribe") f.manager.subscribe({ ...f.target, subscriberId: "second" });
    else f.manager.closeAll();
    await pending;
    expect(f.messages).toMatchObject([{ type: "text", text: "last output" }]);
    expect(f.failures).toEqual([]);
  });

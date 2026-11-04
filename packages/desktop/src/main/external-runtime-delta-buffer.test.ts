import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsRoot, type StreamEvent } from "@cjhyy/code-shell-core";
import { readOutputJournal, SessionOutputJournal } from "@cjhyy/code-shell-core/internal";
import { ExternalRuntimeDeltaBuffer } from "./external-runtime-delta-buffer.js";
import { ExternalRuntimeSessionRecorder } from "./external-runtime-state.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const previous = process.env.CODE_SHELL_HOME;
  const home = mkdtempSync(join(tmpdir(), "external-delta-buffer-"));
  process.env.CODE_SHELL_HOME = home;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const recorder = new ExternalRuntimeSessionRecorder("burst", home, "test", "claude-code");
  recorder.beginTurn({ text: "synthetic input" });
  const published: StreamEvent[] = [];
  const batches: number[] = [];
  const failures: unknown[] = [];
  const buffer = new ExternalRuntimeDeltaBuffer({
    batch(events) {
      const committed = recorder.onDeltaBatch(events);
      // Publication must never get ahead of the physical journal, including
      // the last event of a batch rather than only its first durable prefix.
      const page = readOutputJournal(sessionsRoot(), "burst", {
        after: committed.at(-1)!.outputCursor,
        through: committed.at(-1)!.outputCursor,
      });
      expect(page.status).toBe("ok");
      expect(page.complete).toBe(true);
      batches.push(events.length);
      published.push(...committed);
    },
    single(event) {
      const committed = recorder.onEvent(event);
      if (committed) published.push(committed);
    },
    failed(error) {
      failures.push(error);
    },
  });
  cleanups.push(() => buffer.flush());
  return { recorder, buffer, published, batches, failures };
}

test("one stdout burst commits bounded batches before publishing original ordered cursors", () => {
  const f = fixture();
  const append = spyOn(SessionOutputJournal.prototype, "appendBatch");
  cleanups.push(() => append.mockRestore());
  for (let i = 0; i < 130; i++) f.buffer.push({ type: "text_delta", text: `${i},` });
  expect(f.batches).toEqual([64, 64]);
  f.buffer.push({ type: "turn_complete", reason: "completed" });
  expect(f.batches).toEqual([64, 64, 2]);
  expect(append.mock.calls.map(([events]) => events.length)).toEqual([64, 64, 2, 1]);
  expect(f.published.map((event) => event.type)).toEqual([
    ...Array(130).fill("text_delta"),
    "turn_complete",
  ]);
  expect(new Set(f.published.map((event) => event.outputCursor)).size).toBe(131);
  expect(f.recorder.finishIfMissing().text).toBe(
    Array.from({ length: 130 }, (_, i) => `${i},`).join(""),
  );
});

test("idle timer and explicit close fence flush pending text without a following provider event", async () => {
  const f = fixture();
  f.buffer.push({ type: "thinking_delta", text: "reason" });
  expect(f.published).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.published).toHaveLength(1);
  f.buffer.push({ type: "text_delta", text: "accepted before stop" });
  f.buffer.flush();
  f.buffer.push({ type: "turn_complete", reason: "aborted_streaming" });
  expect(f.published.map((event) => event.type)).toEqual([
    "thinking_delta",
    "text_delta",
    "turn_complete",
  ]);
  expect(f.failures).toEqual([]);
});

test("a rejected batch publishes none of its uncommitted events", async () => {
  const f = fixture();
  const append = spyOn(SessionOutputJournal.prototype, "appendBatch").mockImplementation(() => {
    throw new Error("synthetic journal failure");
  });
  cleanups.push(() => append.mockRestore());
  f.buffer.push({ type: "text_delta", text: "uncommitted" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.published).toEqual([]);
  expect(f.failures).toHaveLength(1);
});

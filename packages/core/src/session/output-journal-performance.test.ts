import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "./session-manager.js";
import { readOutputJournal, SessionOutputJournal } from "./output-journal.js";
import type { StreamEvent } from "../types.js";

test("token-heavy history keeps bounded page reads and preserves every frame", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "journal-page-performance-"));
  try {
    const manager = new SessionManager(root);
    const session = manager.create(root, "fixture", "fixture", "history");
    manager.startSessionRun(session.state, "run");
    const writer = new SessionOutputJournal(root, "history", "run");
    let batch: StreamEvent[] = [];
    let emitted = 0;
    const append = (event: StreamEvent) => {
      batch.push(event);
      emitted++;
      if (batch.length === 64) {
        writer.appendBatch(batch);
        batch = [];
      }
    };
    let tool = 0;
    for (let turn = 0; turn < 64; turn++) {
      append({ type: "stream_request_start", turnNumber: turn + 1 });
      for (let delta = 0; delta < 192; delta++)
        append({ type: "text_delta", text: "synthetic token " });
      for (let count = 0; count < (turn < 47 ? 9 : 8); count++) {
        const id = `tool-${++tool}`;
        append({ type: "tool_use_start", toolCall: { id, toolName: "Read", args: {} } });
        append({ type: "tool_result", result: { id, result: "x".repeat(8 * 1024) } });
      }
      append({ type: "turn_complete", reason: "completed" });
    }
    if (batch.length) writer.appendBatch(batch);
    const file = join(root, "history", "output-journal.jsonl");
    const metadata = fs.statSync(file);
    expect(tool).toBe(559);
    const read = fs.readSync;
    let readBytes = 0;
    const spy = spyOn(fs, "readSync").mockImplementation((...args: any[]) => {
      const size = (read as any)(...args);
      if (fs.fstatSync(args[0]).ino === metadata.ino) readBytes += size;
      return size;
    });
    const measure = (maxFrames?: number) => {
      // Change only metadata to force the existing file proof cache to rebuild,
      // so both measurements include the complete cold hash-chain validation.
      const stamp = new Date(fs.statSync(file).mtimeMs + 1000);
      fs.utimesSync(file, stamp, stamp);
      readBytes = 0;
      const started = performance.now();
      const digest = createHash("sha256");
      let pages = 0,
        frames = 0;
      let after: string | undefined, through: string | undefined;
      for (;;) {
        const page = readOutputJournal(root, "history", { after, through, maxFrames });
        expect(page.status).toBe("ok");
        expect(page.frames.length).toBeLessThanOrEqual(maxFrames ?? 512);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
          1024 * 1024 + 16 * 1024,
        );
        pages++;
        frames += page.frames.length;
        for (const frame of page.frames) digest.update(JSON.stringify(frame));
        after = page.next;
        through ??= page.through;
        if (page.complete) break;
        if (pages > 200) throw new Error("history did not converge");
      }
      expect(frames).toBe(emitted);
      return {
        pages,
        frames,
        readBytes,
        ms: performance.now() - started,
        digest: digest.digest("hex"),
      };
    };
    try {
      const standard = measure();
      const dense = measure(2048);
      expect(dense.digest).toBe(standard.digest);
      expect(dense.pages).toBeLessThan(standard.pages * 0.6);
      // Includes full cold validation plus bounded cursor/page reads, not an
      // unchecked shortcut or a growing prefix rescan for every page.
      expect(dense.readBytes).toBeLessThan(metadata.size * 3.5);
      console.log(JSON.stringify({ journalBytes: metadata.size, standard, dense }));
    } finally {
      spy.mockRestore();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

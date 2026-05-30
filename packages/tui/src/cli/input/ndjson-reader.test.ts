import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { NdjsonReader } from "./ndjson-reader.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

// Regression: start() created a readline interface but never stored it, so
// there was no way to close it — the interface and its stdin listener leaked
// (review-2026-05-30). start() now returns/owns a closable handle via stop().

describe("NdjsonReader.start lifecycle", () => {
  test("stop() closes the interface; no lines processed afterward", async () => {
    const input = new PassThrough();
    const reader = new NdjsonReader(input);
    const got: string[] = [];
    reader.on("message", (m) => {
      if (m.type === "message") got.push(m.content);
    });

    reader.start();
    input.write('{"type":"message","content":"a"}\n');
    await tick();
    expect(got).toEqual(["a"]);

    reader.stop();
    input.write('{"type":"message","content":"b"}\n');
    await tick();
    // After stop() the line must not be processed.
    expect(got).toEqual(["a"]);
  });

  test("stop() before start() is a no-op (does not throw)", () => {
    const reader = new NdjsonReader(new PassThrough());
    expect(() => reader.stop()).not.toThrow();
  });
});

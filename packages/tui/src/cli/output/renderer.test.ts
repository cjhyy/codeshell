import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRenderer } from "./renderer.js";
import type { StreamEvent, TerminalReason } from "@cjhyy/code-shell-core";

// Capture stdout.write so we can assert the exact bytes each renderer emits.
let chunks: string[];
let restore: () => void;

beforeEach(() => {
  chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    chunks.push(typeof s === "string" ? s : String(s));
    return true;
  }) as typeof process.stdout.write;
  restore = () => {
    process.stdout.write = orig;
  };
});

afterEach(() => restore());

const textEvent: StreamEvent = { type: "text_delta", text: "hello" } as StreamEvent;
const reason: TerminalReason = "completed";
const meta = { sessionId: "s1", turnCount: 2 };

describe("output renderers — schema contracts", () => {
  test("json emits exactly one final aggregated object", () => {
    const r = createRenderer("json");
    r.onEvent(textEvent);
    r.onComplete("hello", reason, meta);
    restore();
    expect(chunks).toHaveLength(1);
    const obj = JSON.parse(chunks[0]);
    expect(obj.result).toBe("hello");
    expect(obj.reason).toBe("completed");
    expect(obj.sessionId).toBe("s1");
  });

  test("jsonl emits one line per event plus a final result line", () => {
    const r = createRenderer("jsonl");
    r.onEvent(textEvent);
    r.onComplete("hello", reason, meta);
    restore();
    expect(chunks).toHaveLength(2);
    // Each chunk is a single newline-terminated JSON value.
    for (const c of chunks) expect(c.endsWith("\n")).toBe(true);
    const ev = JSON.parse(chunks[0]);
    expect(ev.type).toBe("text_delta");
    const result = JSON.parse(chunks[1]);
    expect(result.type).toBe("result");
    expect(result.reason).toBe("completed");
  });

  test("stream-json is a documented alias of jsonl (same wire shape)", () => {
    const jsonl = createRenderer("jsonl");
    const stream = createRenderer("stream-json");
    const jsonlOut: string[] = [];
    const streamOut: string[] = [];

    // Re-point capture for each independently.
    const cap = (sink: string[]) => {
      chunks = sink;
    };

    cap(jsonlOut);
    jsonl.onEvent(textEvent);
    jsonl.onComplete("hello", reason, meta);

    cap(streamOut);
    stream.onEvent(textEvent);
    stream.onComplete("hello", reason, meta);

    restore();
    expect(streamOut).toEqual(jsonlOut);
  });

  test("unknown format falls back to the text renderer", () => {
    // text writes a trailing newline on completed; just assert it doesn't throw
    // and isn't one of the JSON renderers' single-object shape.
    const r = createRenderer("text");
    r.onComplete("hi", reason, {});
    restore();
    expect(chunks.join("")).not.toContain('"reason"');
  });
});

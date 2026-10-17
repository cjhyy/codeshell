import { describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import {
  NdjsonReader,
  type NdjsonMessage,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/cli/input/ndjson-reader.ts";

// Every reader receives an owned memory stream. No process.stdin, CLI,
// native input, timers, approval messages, or actual abort command is used.
async function collectStarted(chunks: (string | Buffer)[]) {
  const input = new PassThrough();
  const reader = new NdjsonReader(input);
  const got: NdjsonMessage[] = [];
  reader.on("message", (message) => got.push(message));
  reader.on("ping", (message) => got.push(message));
  const closed = new Promise<void>((resolve) => reader.on("abort", () => resolve()));
  reader.start();
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await closed;
  return got;
}

async function collectIterated(chunks: (string | Buffer)[]) {
  const input = Readable.from(chunks);
  const reader = new NdjsonReader(input);
  const got: NdjsonMessage[] = [];
  for await (const message of reader.messages()) got.push(message);
  return got;
}

describe("NdjsonReader owned ordinary input", () => {
  test("start dispatches message and ping in line order", async () => {
    const got = await collectStarted([
      '{"type":"message","content":"first"}\n{"type":"ping"}\n',
      '{"type":"message","content":"last"}\n',
    ]);
    expect(got).toEqual([
      { type: "message", content: "first" },
      { type: "ping" },
      { type: "message", content: "last" },
    ]);
    expect(got).toHaveLength(3);
  });

  test("start skips whitespace and malformed JSON then processes the next ordinary line", async () => {
    const got = await collectStarted([
      '\n \t\r\n{bad json}\n{"type":"message","content":"ok"}\n',
    ]);
    expect(got).toEqual([{ type: "message", content: "ok" }]);
    expect(got).toHaveLength(1);
  });

  test("start keeps content whitespace and escaped newline inside the single message", async () => {
    const content = "  first\nsecond\t  ";
    const got = await collectStarted(["  " + JSON.stringify({ type: "message", content }) + " \n"]);
    expect(got).toEqual([{ type: "message", content }]);
    expect(got).toHaveLength(1);
  });

  test("start combines JSON syntax chunks and CRLF split across writes", async () => {
    const got = await collectStarted([
      '{"type":"mess',
      'age","content":"one"}\r',
      '\n{"type":"ping"}\r',
      "\n",
    ]);
    expect(got).toEqual([{ type: "message", content: "one" }, { type: "ping" }]);
    expect(got).toHaveLength(2);
  });

  test("start decodes UTF-8 split at every byte without replacing ordinary Unicode", async () => {
    const content = "a中😀e\u0301";
    const wire = Buffer.from(JSON.stringify({ type: "message", content }) + "\n");
    const got = await collectStarted(Array.from(wire, (byte) => Buffer.from([byte])));
    expect(got).toEqual([{ type: "message", content }]);
    expect(JSON.stringify(got)).not.toContain("\uFFFD");
  });

  test("start emits a final ordinary message without a trailing line terminator at EOF", async () => {
    const got = await collectStarted(['{"type":"message","content":"tail"}']);
    expect(got).toEqual([{ type: "message", content: "tail" }]);
    expect(got).toHaveLength(1);
  });

  test("start accepts an empty content string without confusing it with an empty line", async () => {
    const got = await collectStarted(['{"type":"message","content":""}\n']);
    expect(got).toEqual([{ type: "message", content: "" }]);
    expect(got).toHaveLength(1);
  });

  test("messages iterator retains ordinary message and ping order", async () => {
    const got = await collectIterated([
      '{"type":"ping"}\n{"type":"message","content":"body"}\n',
      '{"type":"ping"}\n',
    ]);
    expect(got).toEqual([
      { type: "ping" },
      { type: "message", content: "body" },
      { type: "ping" },
    ]);
    expect(got).toHaveLength(3);
  });

  test("messages iterator skips malformed and whitespace lines", async () => {
    const got = await collectIterated([
      '\n \t\r\n{bad json}\n{"type":"message","content":"ok"}\n',
    ]);
    expect(got).toEqual([{ type: "message", content: "ok" }]);
    expect(got).toHaveLength(1);
  });

  test("messages iterator preserves escaped content newline and surrounding whitespace", async () => {
    const content = " \n中😀 \t";
    const got = await collectIterated([" " + JSON.stringify({ type: "message", content }) + "\r\n"]);
    expect(got).toEqual([{ type: "message", content }]);
    expect(got).toHaveLength(1);
  });

  test("messages iterator reads final message at EOF without a trailing newline", async () => {
    const got = await collectIterated(['{"type":"message","content":"tail"}']);
    expect(got).toEqual([{ type: "message", content: "tail" }]);
    expect(got).toHaveLength(1);
  });

  test("messages iterator decodes every-byte UTF-8 chunks and split CRLF", async () => {
    const content = "中😀e\u0301";
    const wire = Buffer.from(JSON.stringify({ type: "message", content }) + "\r\n");
    const got = await collectIterated(Array.from(wire, (byte) => Buffer.from([byte])));
    expect(got).toEqual([{ type: "message", content }]);
    expect(JSON.stringify(got)).not.toContain("\uFFFD");
  });

  test("stop before start is a no-op on an explicitly owned stream", () => {
    const input = new PassThrough();
    const reader = new NdjsonReader(input);
    expect(() => reader.stop()).not.toThrow();
    expect(input.destroyed).toBe(false);
    input.destroy();
  });

  test("duplicate start remains idempotent and EOF closes its owned interface once", async () => {
    const input = new PassThrough();
    const reader = new NdjsonReader(input);
    const got: string[] = [];
    let closes = 0;
    reader.on("message", (message) => {
      if (message.type === "message") got.push(message.content);
    });
    const closed = new Promise<void>((resolve) => reader.on("abort", () => {
      closes++;
      resolve();
    }));
    reader.start();
    reader.start();
    input.end('{"type":"message","content":"once"}\n');
    await closed;
    reader.stop();
    expect(got).toEqual(["once"]);
    expect(closes).toBe(1);
  });

  test("stop prevents later lines and repeated stop does not repeat closure", async () => {
    const input = new PassThrough();
    const reader = new NdjsonReader(input);
    const got: string[] = [];
    let closes = 0;
    reader.on("message", (message) => {
      if (message.type === "message") got.push(message.content);
    });
    const closed = new Promise<void>((resolve) => reader.on("abort", () => {
      closes++;
      resolve();
    }));
    reader.start();
    input.write('{"type":"message","content":"before"}\n');
    reader.stop();
    reader.stop();
    input.end('{"type":"message","content":"after"}\n');
    await closed;
    expect(got).toEqual(["before"]);
    expect(closes).toBe(1);
  });
});

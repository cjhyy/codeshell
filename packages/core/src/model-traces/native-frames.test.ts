import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createNativeModelTraceFrameDecoder } from "./native-frames.js";

function fragments(message: unknown, messageId = randomUUID()) {
  const bytes = Buffer.from(JSON.stringify(message));
  const lines: string[] = [];
  for (let offset = 0, part = 0; offset < bytes.length; offset += 192, part++)
    lines.push(
      JSON.stringify({
        version: 1,
        type: "model_trace_chunk",
        messageId,
        part,
        data: bytes.subarray(offset, offset + 192).toString("base64"),
        final: offset + 192 >= bytes.length,
      }),
    );
  return lines;
}
const message = (index: number) => ({
  version: 1,
  type: "model_trace",
  phase: "start",
  callId: `call-${index}`,
  provider: "fixture",
  model: "fixture",
  input: { messages: [{ role: "user", content: `${index}实际输入` + "长".repeat(30_000) }] },
});

test("legacy frames pass unchanged and concurrent UTF8 fragments preserve every message identity", () => {
  const decoder = createNativeModelTraceFrameDecoder();
  const direct = JSON.stringify({ version: 1, type: "model_trace", phase: "finish" });
  expect(decoder.read(direct)).toBe(direct);
  const original = Array.from({ length: 16 }, (_, index) => message(index));
  const all = original.map((value) => fragments(value));
  const result: unknown[] = [];
  for (let part = 0; part < Math.max(...all.map((lines) => lines.length)); part++)
    for (const lines of all) {
      if (!lines[part]) continue;
      expect(Buffer.byteLength(lines[part]!) + 1).toBeLessThanOrEqual(512);
      const decoded = decoder.read(lines[part]!);
      if (decoded !== undefined) result.push(JSON.parse(decoded));
    }
  expect(result).toEqual(original);
});

test("malformed, reordered, repeated, noncanonical and oversized physical chunks are rejected", () => {
  const first = JSON.parse(fragments(message(1))[0]!);
  for (const update of [
    { version: 2 },
    { messageId: "untrusted" },
    { part: -1 },
    { part: 0.5 },
    { part: 1 },
    { data: "YQ" },
    { data: "YR==" },
    { data: "YQ==$" },
    { data: "" },
    { data: Buffer.alloc(193).toString("base64") },
    { final: "true" },
    { workspacePath: "/forged" },
  ]) {
    const decoder = createNativeModelTraceFrameDecoder();
    expect(() => decoder.read(JSON.stringify({ ...first, ...update }))).toThrow();
  }
  const duplicate = createNativeModelTraceFrameDecoder();
  duplicate.read(JSON.stringify(first));
  expect(() => duplicate.read(JSON.stringify(first))).toThrow();
  const huge = createNativeModelTraceFrameDecoder();
  expect(() => huge.read(JSON.stringify({ ...first, data: "A".repeat(400) }))).toThrow();
});

test("inflight count, frame size, total partial bytes, lifetime and cleanup are bounded", () => {
  const decoder = createNativeModelTraceFrameDecoder();
  const initial = Array.from({ length: 65 }, () => fragments(message(1))[0]!);
  for (const line of initial.slice(0, 64)) decoder.read(line);
  expect(() => decoder.read(initial[64]!)).toThrow();
  decoder.clear();
  expect(decoder.read(initial[64]!)).toBeUndefined();

  const tooLarge = createNativeModelTraceFrameDecoder();
  const over = fragments({ type: "model_trace", data: "x".repeat(256 * 1024) });
  expect(() => {
    for (const line of over) tooLarge.read(line);
  }).toThrow();

  const total = createNativeModelTraceFrameDecoder();
  const many = Array.from({ length: 64 }, () =>
    fragments({ type: "model_trace", data: "x".repeat(150_000) }),
  );
  expect(() => {
    // Keep every large message unfinished; crossing the shared byte cap fails.
    for (let part = 0; part < 700; part++) for (const lines of many) total.read(lines[part]!);
  }).toThrow();
  total.clear();
  expect(total.read(initial[0]!)).toBeUndefined();

  let now = 10;
  const age = createNativeModelTraceFrameDecoder({ now: () => now });
  const old = fragments(message(2));
  age.read(old[0]!);
  now += 30_001;
  expect(() => age.read(old[1]!)).toThrow();
  age.clear();
});

test("invalid UTF8, nested fragments and newline injection cannot become logical messages", () => {
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from('{"type":"model_trace_chunk"}'),
    Buffer.from('{"type":"model_trace"}\n{}'),
  ]) {
    const decoder = createNativeModelTraceFrameDecoder();
    expect(() =>
      decoder.read(
        JSON.stringify({
          version: 1,
          type: "model_trace_chunk",
          messageId: randomUUID(),
          part: 0,
          data: bytes.toString("base64"),
          final: true,
        }),
      ),
    ).toThrow();
  }
});

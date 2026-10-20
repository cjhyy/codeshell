import { expect, test } from "bun:test";
import {
  eventIndent, eventRequestId, groupModelTraces, mergeTraceCalls,
  traceCoverageLabel, traceDuration, traceStatusLabel, traceTime,
} from "../../../packages/desktop/src/renderer/activity/modelTracePresentation.ts";

// Ordinary in-memory projection controls only. No provider, IPC, React, trace
// storage, localization runtime, or Core barrel is imported/executed.
const translateKey = ((key: string) => key) as never;
const call = (id: string, traceId: string, startedAt: number) => ({ id, traceId, startedAt }) as never;
const event = (id: string, parentId?: string) => ({ id, parentId }) as never;

test("status and coverage labels retain ordinary discriminants", () => {
  for (const status of ["running", "completed", "failed", "cancelled"]) {
    expect(traceStatusLabel(status, translateKey)).toBe(`observability.${status}`);
  }
  expect(traceStatusLabel("future-status", translateKey)).toBe("future-status");
  expect(traceCoverageLabel("provider-wire", translateKey)).toBe("observability.wire");
  expect(traceCoverageLabel("external-cli-input", translateKey)).toBe("observability.externalInput");
  expect(traceCoverageLabel("logical", translateKey)).toBe("observability.logical");
});

test("duration and optional time formatting follow their finite bounds", () => {
  expect(traceDuration()).toBe("—");
  expect(traceDuration(1, Number.NaN)).toBe("—");
  expect(traceDuration(1000, 1999)).toBe("999 ms");
  expect(traceDuration(1000, 2250)).toBe("1.25 s");
  expect(traceDuration(2000, 1000)).toBe("0 ms");
  expect(traceTime(undefined, "en")).toBe("—");
  expect(traceTime(Number.NaN, "zh")).toBe("—");
  expect(traceTime(1000, "en").length).toBeGreaterThan(0);
});

test("trace grouping uses exact identity and earliest start without input mutation", () => {
  const one = Object.freeze(call("one", "trace-a", 30));
  const two = Object.freeze(call("two", "trace-b", 20));
  const three = Object.freeze(call("three", "trace-a", 10));
  const input = Object.freeze([one, two, three]);
  const groups = groupModelTraces(input);
  expect(groups.map(g => [g.traceId, g.startedAt, g.requests.map(r => r.id)])).toEqual([
    ["trace-a", 10, ["one", "three"]], ["trace-b", 20, ["two"]],
  ]);
  expect(input.map(r => r.id)).toEqual(["one", "two", "three"]);
  expect(groupModelTraces([])).toEqual([]);
});

test("incremental calls replace matching ids and sort a copied result", () => {
  const previous = [call("b", "t", 20), call("a", "t", 20)];
  const incoming = [call("b", "t", 5), call("c", "t", 30)];
  const result = mergeTraceCalls(previous, incoming);
  expect(result.map(r => [r.id, r.startedAt])).toEqual([["b", 5], ["a", 20], ["c", 30]]);
  expect(previous.map(r => r.id)).toEqual(["b", "a"]);
  expect(incoming.map(r => r.id)).toEqual(["b", "c"]);
  expect(mergeTraceCalls([], [])).toEqual([]);
});

test("indent requires known parents, stays bounded and terminates on cycles", () => {
  const root = event("root");
  const child = event("child", "root");
  expect(eventIndent(root, [root, child])).toBe(0);
  expect(eventIndent(child, [root, child])).toBe(1);
  expect(eventIndent(event("missing", "absent"), [root])).toBe(0);
  const a = event("a", "b"), b = event("b", "a");
  expect(eventIndent(a, [a, b])).toBe(1);
  const chain = [event("0"), ...Array.from({ length: 6 }, (_, i) => event(String(i + 1), String(i)))];
  expect(eventIndent(chain[6], chain)).toBe(4);
});

test("request association uses explicit ancestry and terminates on broken or cyclic links", () => {
  const tool = event("tool", "attempt");
  const attempt = event("attempt", "request");
  expect(eventRequestId(tool, [tool, attempt], new Set(["request"]))).toBe("request");
  expect(eventRequestId(event("unlinked"), [tool, attempt], new Set(["request"]))).toBeUndefined();
  expect(eventRequestId(event("broken", "absent"), [], new Set(["request"]))).toBeUndefined();
  const a = event("a", "b"), b = event("b", "a");
  expect(eventRequestId(a, [a, b], new Set(["request"]))).toBeUndefined();
});

import { expect, test, describe } from "bun:test";
import { bucket, buildScrollTrigger } from "./scrollTrigger";
import type { Message } from "../types";

describe("bucket", () => {
  test("0..39 → 0, 40..79 → 1", () => {
    expect(bucket(0)).toBe(0);
    expect(bucket(39)).toBe(0);
    expect(bucket(40)).toBe(1);
    expect(bucket(79)).toBe(1);
    expect(bucket(80)).toBe(2);
  });
});

const asst = (text: string, done: boolean): Message =>
  ({ kind: "assistant", id: "a1", text, done, createdAt: 0 }) as Message;

const agent = (text: string, textBuffer: string): Message =>
  ({ kind: "agent", id: "g1", text, textBuffer }) as Message;

describe("buildScrollTrigger", () => {
  test("no live turn → tail bucket is 0", () => {
    const msgs = [asst("hello world this is a long streamed answer", false)];
    expect(buildScrollTrigger(msgs, false, null)).toBe("1::0");
  });

  test("live streaming assistant → tail length bucketed", () => {
    const msgs = [asst("x".repeat(85), false)];
    expect(buildScrollTrigger(msgs, true, null)).toBe("1::2");
  });

  test("done assistant is not counted as live tail", () => {
    const msgs = [asst("x".repeat(85), true)];
    expect(buildScrollTrigger(msgs, true, null)).toBe("1::0");
  });

  test("live agent counts text + textBuffer", () => {
    const msgs = [agent("x".repeat(40), "y".repeat(40))]; // 80 → bucket 2
    expect(buildScrollTrigger(msgs, true, null)).toBe("1::2");
  });

  test("trailing key is encoded", () => {
    const msgs = [asst("hi", false)];
    expect(buildScrollTrigger(msgs, false, "approval-42")).toBe("1:approval-42:0");
  });

  test("bucket ticks every 40 chars → same bucket = same trigger", () => {
    const a = buildScrollTrigger([asst("x".repeat(10), false)], true, null);
    const b = buildScrollTrigger([asst("x".repeat(39), false)], true, null);
    const c = buildScrollTrigger([asst("x".repeat(40), false)], true, null);
    expect(a).toBe(b); // same bucket, no re-scroll churn
    expect(a).not.toBe(c); // crossed a bucket boundary → new trigger
  });

  test("empty message list", () => {
    expect(buildScrollTrigger([], true, null)).toBe("0::0");
  });
});

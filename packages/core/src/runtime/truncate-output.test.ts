import { describe, it, expect } from "bun:test";
import { truncateHeadTail } from "./truncate-output.js";

describe("truncateHeadTail", () => {
  it("returns input unchanged when within cap", () => {
    expect(truncateHeadTail("short", { cap: 100 })).toBe("short");
  });

  it("keeps both head and tail with an omission marker", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = truncateHeadTail(lines, { cap: 200 });
    expect(out).toContain("line 0"); // head preserved
    expect(out).toContain("line 199"); // tail preserved (the important end!)
    expect(out).toContain("chars omitted");
    expect(out.length).toBeLessThan(lines.length);
  });

  it("omitted count + kept lengths are consistent", () => {
    const text = "x".repeat(1000) + "\n" + "y".repeat(1000);
    const out = truncateHeadTail(text, { cap: 400 });
    const m = /\[(\d+) chars omitted — showing first (\d+) \+ last (\d+)\]/.exec(out);
    expect(m).not.toBeNull();
    const [, omitted, head, tail] = m!.map(Number);
    expect(omitted + head + tail).toBe(text.length);
  });

  it("honors headRatio (more head than tail)", () => {
    const text = "a".repeat(5000);
    const out = truncateHeadTail(text, { cap: 1000, headRatio: 0.8 });
    const m = /showing first (\d+) \+ last (\d+)/.exec(out)!;
    const head = Number(m[1]);
    const tail = Number(m[2]);
    expect(head).toBeGreaterThan(tail);
  });

  it("hard-cuts a single giant line (no newline to snap to)", () => {
    const text = "z".repeat(10_000); // one line, no \n
    const out = truncateHeadTail(text, { cap: 1000 });
    expect(out).toContain("chars omitted");
    expect(out.length).toBeLessThan(2000);
  });

  it("cap<=0 is a no-op", () => {
    expect(truncateHeadTail("anything", { cap: 0 })).toBe("anything");
  });
});

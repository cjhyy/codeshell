import { describe, test, expect } from "bun:test";
import { memoize } from "../../../../packages/core/src/utils/memoize.ts";
import { gte, gt, lt } from "../../../../packages/core/src/utils/semver.ts";
import { formatToolArgs, compactOutput, singleLine, formatBytes, truncate } from "../../../../packages/core/src/utils/toolDisplay.ts";

describe("ordinary utility data controls", () => {
  test("memoize caches undefined using presence and exposes clear", () => {
    let calls = 0;
    const f = memoize((_: string) => { calls++; return undefined; }, (x: string) => x);
    expect(f("a")).toBeUndefined(); expect(f("a")).toBeUndefined(); expect(calls).toBe(1);
    f.cache.clear(); expect(f("a")).toBeUndefined(); expect(calls).toBe(2);
  });
  test("memoize partitions external resolver state without losing arguments", () => {
    let state = 1, calls = 0;
    const f = memoize((x: number) => { calls++; return x * state; }, (x: number) => `${state}:${x}`);
    expect(f(2)).toBe(2); expect(f(2)).toBe(2); state = 3;
    expect(f(2)).toBe(6); expect(f(4)).toBe(12); expect(calls).toBe(3);
  });
  test("synchronous throws are not installed as cache entries", () => {
    const failure = new Error("owned callback failure"); let calls = 0;
    const f = memoize(() => { calls++; if (calls === 1) throw failure; return "ok"; }, () => "key");
    expect(() => f()).toThrow(failure); expect(f()).toBe("ok"); expect(f()).toBe("ok"); expect(calls).toBe(2);
  });
  test("semver release, prerelease, and build metadata comparison", () => {
    expect(gt("2.0.0", "1.99.99")).toBe(true); expect(lt("2.0.0-rc.1", "2.0.0")).toBe(true);
    expect(gte("2.0.0+build.2", "2.0.0+build.1")).toBe(true); expect(gt("2.0.0", "2.0.0")).toBe(false);
  });
  test("tool arguments maintain paging and quoted cd-prefix controls", () => {
    expect(formatToolArgs("Read", {file_path: "file.txt", offset: 10, limit: 3})).toBe("file.txt :10-12");
    expect(formatToolArgs("Bash", {command: "cd '/owned path' && echo hello"})).toBe("echo hello");
    expect(formatToolArgs("Bash", {command: "echo cd path"})).toBe("echo cd path");
    expect(formatToolArgs("Sleep", {seconds: 0})).toBe("0");
  });
  test("compact output line previews and byte formatter controls", () => {
    expect(compactOutput("Bash", "a\nb\nc\nd\ne")).toEqual({summary: "5 lines output", preview: ["a", "b", "c", "d"], moreLines: 1});
    expect(compactOutput("Glob", "a\nb")).toEqual({summary: "2 files found", preview: ["a", "b"], moreLines: 0});
    expect(singleLine(" a\n b\t c ")).toBe("a b c"); expect(formatBytes(1024)).toBe("1.0KB");
  });
  test("related Unicode summary cutting has the previously recorded UTF-16 mechanism", () => {
    const actual = formatToolArgs("Agent", {description: "x".repeat(58) + "😀tail"});
    expect(actual.length).toBe(60); expect(actual.charCodeAt(58)).toBe(0xd83d);
    expect(actual.isWellFormed()).toBe(false); expect(truncate("short", 60)).toBe("short");
  });
});

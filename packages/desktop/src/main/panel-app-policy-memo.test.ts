import { expect, test } from "bun:test";
import { createPanelAppPolicyMemo } from "./panel-app-policy-memo.js";

function fixture(ttlMs = 500, maxEntries = 4) {
  let now = 0;
  const reads: string[] = [];
  const memo = createPanelAppPolicyMemo(
    (cwd: string) => {
      reads.push(cwd);
      return { cwd, read: reads.length };
    },
    { ttlMs, maxEntries, now: () => now },
  );
  return {
    memo,
    reads,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("repeated guards inside the window reuse one settings read", () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.memo.get("/project");
  expect(f.reads).toEqual(["/project"]);
});

test("a stale entry is re-read once the window has passed", () => {
  const f = fixture();
  expect(f.memo.get("/project").read).toBe(1);
  f.advance(499);
  expect(f.memo.get("/project").read).toBe(1);
  f.advance(1);
  expect(f.memo.get("/project").read).toBe(2);
});

test("invalidation makes the next guard observe a binding change immediately", () => {
  const f = fixture();
  f.memo.get("/project");
  f.memo.invalidate();
  expect(f.memo.get("/project").read).toBe(2);
});

test("projects are cached independently and the cache stays bounded", () => {
  const f = fixture(500, 2);
  f.memo.get("/a");
  f.memo.get("/b");
  f.memo.get("/c");
  expect(f.reads).toEqual(["/a", "/b", "/c"]);
  f.memo.get("/b");
  f.memo.get("/c");
  expect(f.reads).toHaveLength(3);
  f.memo.get("/a");
  expect(f.reads).toEqual(["/a", "/b", "/c", "/a"]);
});

test("a failed read is not cached", () => {
  let fail = true;
  let reads = 0;
  const memo = createPanelAppPolicyMemo(
    () => {
      reads++;
      if (fail) throw new Error("settings unreadable");
      return reads;
    },
    { ttlMs: 500, maxEntries: 4, now: () => 0 },
  );
  expect(() => memo.get("/project")).toThrow("settings unreadable");
  fail = false;
  expect(memo.get("/project")).toBe(2);
});

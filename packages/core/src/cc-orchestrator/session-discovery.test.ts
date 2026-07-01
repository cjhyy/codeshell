import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd, discoverSessions, countSessions, selectRecentStats } from "./session-discovery.js";

describe("encodeCwd", () => {
  it("replaces each non-alphanumeric char with a dash (incl. leading slash)", () => {
    expect(encodeCwd("/Users/admin/proj")).toBe("-Users-admin-proj");
  });
  it("turns CJK chars into one dash each", () => {
    expect(encodeCwd("/Users/admin/Documents/个人学习/代码学习/codeshell")).toBe(
      "-Users-admin-Documents-----------codeshell",
    );
  });
});

describe("discoverSessions", () => {
  it("lists sessions for a cwd from <claudeHome>/projects/<encoded>/*.jsonl", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
    const cwd = "/tmp/myproj";
    const dir = join(claudeHome, "projects", encodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    const sid = "aaaa1111-2222-3333-4444-555566667777";
    const lines = [
      JSON.stringify({ type: "mode", sessionId: sid }),
      JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "<local-command-caveat>noise" } }),
      JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "Fix the login bug" } }),
      JSON.stringify({ type: "assistant", sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    ];
    writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
    const got = discoverSessions(cwd, claudeHome);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe(sid);
    expect(got[0].firstMessage).toBe("Fix the login bug");
    expect(got[0].messageCount).toBe(2);
  });

  it("returns [] when the project dir is absent", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
    expect(discoverSessions("/tmp/nope", claudeHome)).toEqual([]);
  });
});

describe("selectRecentStats (shared window+limit)", () => {
  const stats = [
    { mtimeMs: 100 },
    { mtimeMs: 500 },
    { mtimeMs: 300 },
    { mtimeMs: 50 },
  ];
  it("sorts newest first", () => {
    expect(selectRecentStats(stats).map((s) => s.mtimeMs)).toEqual([500, 300, 100, 50]);
  });
  it("caps to limit after sorting", () => {
    expect(selectRecentStats(stats, { limit: 2 }).map((s) => s.mtimeMs)).toEqual([500, 300]);
  });
  it("filters by recency window relative to now", () => {
    // now=600, window=400 → cutoff 200 → keep 500,300 (not 100,50)
    expect(selectRecentStats(stats, { sinceMs: 400, now: 600 }).map((s) => s.mtimeMs)).toEqual([500, 300]);
  });
  it("applies window AND limit (the default intersection)", () => {
    expect(
      selectRecentStats(stats, { sinceMs: 600, now: 600, limit: 1 }).map((s) => s.mtimeMs),
    ).toEqual([500]);
  });
});

describe("discoverSessions bounding", () => {
  function seed(n: number): { cwd: string; home: string } {
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    const cwd = "/tmp/bounded";
    const dir = join(home, "projects", encodeCwd(cwd));
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      const sid = `s${String(i).padStart(4, "0")}-0000-0000-0000-000000000000`;
      const f = join(dir, `${sid}.jsonl`);
      writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: `msg ${i}` } }) + "\n");
      // mtime spread: older index = older time.
      const t = new Date((i + 1) * 1000);
      utimesSync(f, t, t);
    }
    return { cwd, home };
  }

  it("caps the returned list to `limit`, newest first", () => {
    const { cwd, home } = seed(30);
    const got = discoverSessions(cwd, home, { limit: 20 });
    expect(got).toHaveLength(20);
    // newest (highest index) first
    expect(got[0].sessionId.startsWith("s0029")).toBe(true);
  });

  it("countSessions reports the full total regardless of limit", () => {
    const { cwd, home } = seed(30);
    expect(countSessions(cwd, home)).toBe(30);
    expect(discoverSessions(cwd, home, { limit: 5 })).toHaveLength(5);
  });

  it("no opts = unbounded (back-compat)", () => {
    const { cwd, home } = seed(25);
    expect(discoverSessions(cwd, home)).toHaveLength(25);
  });
});

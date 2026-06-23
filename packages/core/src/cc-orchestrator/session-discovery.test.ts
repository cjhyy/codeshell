import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd, discoverSessions } from "./session-discovery.js";

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

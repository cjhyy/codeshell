import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecentHistory } from "./session-history.js";
import { encodeCwd } from "./session-discovery.js";

function setup(lines: object[]): { cwd: string; home: string; sid: string } {
  const home = mkdtempSync(join(tmpdir(), "claude-home-"));
  const cwd = "/tmp/proj";
  const sid = "sess-1111";
  const dir = join(home, "projects", encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { cwd, home, sid };
}

describe("readRecentHistory", () => {
  it("returns last N user/assistant messages with hasMore", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "first" } },
      { type: "assistant", message: { content: [{ type: "text", text: "reply1" }] } },
      { type: "user", message: { role: "user", content: "second" } },
      { type: "assistant", message: { content: [{ type: "text", text: "reply2" }] } },
    ];
    const { cwd, home, sid } = setup(lines);
    const r = readRecentHistory(cwd, sid, 2, home);
    expect(r.messages.length).toBe(2);
    expect(r.messages[r.messages.length - 1].text).toBe("reply2");
    expect(r.hasMore).toBe(true);
    expect(r.totalCount).toBe(4);
  });
  it("captures assistant tool_use as a tool summary", () => {
    const lines = [
      { type: "user", message: { role: "user", content: "do" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/a.txt" } }] } },
    ];
    const { cwd, home, sid } = setup(lines);
    const r = readRecentHistory(cwd, sid, 10, home);
    const a = r.messages.find((m) => m.role === "assistant");
    expect(a?.tools?.[0].name).toBe("Write");
  });
  it("skips caveat noise; returns empty when session absent", () => {
    expect(readRecentHistory("/tmp/none", "nope", 10, mkdtempSync(join(tmpdir(), "h-"))).messages).toEqual([]);
  });
});

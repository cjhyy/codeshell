import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countSessions, discoverSessions, encodeCwd } from "../../../packages/coding/src/cc-orchestrator/session-discovery.ts";
import { readRecentHistory } from "../../../packages/coding/src/cc-orchestrator/session-history.ts";

function transcript(home: string, cwd: string, sessionId: string, text: string) {
  const directory = join(home, "projects", encodeCwd(cwd));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${sessionId}.jsonl`), JSON.stringify({ type: "user", cwd, sessionId, message: { role: "user", content: text } }) + "\n");
}

test("R2-01 colliding project directory encodings label another project's session as the selected cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "cs-audit-claude-discovery-"));
  try {
    const a = "/workspace/foo-bar";
    const b = "/workspace/foo/bar";
    expect(encodeCwd(a)).toBe(encodeCwd(b));
    transcript(home, a, "session-a", "project A question");
    transcript(home, b, "session-b", "project B question");
    const result = discoverSessions(a, home);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.sessionId === "session-b")).toMatchObject({ cwd: a, firstMessage: "project B question" });
    expect(countSessions(a, home)).toBe(2);
    expect(readRecentHistory(a, "session-b", 10, home).messages).toEqual([{ role: "user", text: "project B question" }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("R2-01 distinct encoded buckets retain normal project-specific discovery", () => {
  const home = mkdtempSync(join(tmpdir(), "cs-audit-claude-discovery-control-"));
  try {
    transcript(home, "/workspace/alpha", "session-a", "project A question");
    transcript(home, "/workspace/beta", "session-b", "project B question");
    expect(discoverSessions("/workspace/alpha", home).map((s) => s.sessionId)).toEqual(["session-a"]);
    expect(countSessions("/workspace/alpha", home)).toBe(1);
    expect(readRecentHistory("/workspace/alpha", "session-b", 10, home).messages).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

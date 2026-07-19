import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexSessions } from "./codex-session-discovery.js";

/** Build one codex rollout JSONL file under <home>/sessions/YYYY/MM/DD/. */
function writeRollout(
  codexHome: string,
  datePath: string,
  fileName: string,
  lines: unknown[],
): void {
  const dir = join(codexHome, "sessions", datePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function metaLine(id: string, cwd: string, timestamp: string) {
  return { timestamp, type: "session_meta", payload: { id, cwd, timestamp } };
}
function userItem(text: string) {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
function assistantItem(text: string) {
  return {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

describe("discoverCodexSessions", () => {
  it("lists codex sessions for a cwd, reading id/firstMessage from rollout files", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/myproj";
    const id = "019e8971-b4ce-7582-9d44-bb3a9253c331";
    writeRollout(home, "2026/06/24", `rollout-2026-06-24T11-31-03-${id}.jsonl`, [
      metaLine(id, cwd, "2026-06-24T03:31:03.000Z"),
      // First user message is environment_context noise — must be skipped.
      userItem("<environment_context>\n  <cwd>/tmp/myproj</cwd>\n</environment_context>"),
      userItem("看看样式 还有没有遗漏的地方"),
      assistantItem("ok"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe(id);
    expect(got[0].firstMessage).toBe("看看样式 还有没有遗漏的地方");
  });

  it("uses the real input part as the title instead of injected host context", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/myproj";
    writeRollout(home, "2026/06/24", "rollout-context-title.jsonl", [
      metaLine("id-context-title", cwd, "2026-06-24T03:31:03.000Z"),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>hidden</environment_context>" },
            { type: "input_text", text: "修复房间输入显示" },
          ],
        },
      },
    ]);

    expect(discoverCodexSessions(cwd, home)[0]?.firstMessage).toBe("修复房间输入显示");
  });

  it("filters out sessions whose session_meta.cwd differs", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeRollout(home, "2026/06/24", "rollout-a.jsonl", [
      metaLine("id-a", "/tmp/wanted", "2026-06-24T01:00:00.000Z"),
      userItem("real a"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-b.jsonl", [
      metaLine("id-b", "/tmp/other", "2026-06-24T02:00:00.000Z"),
      userItem("real b"),
    ]);
    const got = discoverCodexSessions("/tmp/wanted", home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe("id-a");
  });

  it("sorts by lastModified descending (newest first)", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/p";
    // Two files in different date dirs; mtime ordering is what matters.
    writeRollout(home, "2026/06/20", "rollout-old.jsonl", [
      metaLine("id-old", cwd, "2026-06-20T00:00:00.000Z"),
      userItem("old"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-new.jsonl", [
      metaLine("id-new", cwd, "2026-06-24T00:00:00.000Z"),
      userItem("new"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got.map((s) => s.sessionId)).toEqual(["id-new", "id-old"]);
  });

  it("skips files with a broken/absent session_meta first line", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/p";
    writeRollout(home, "2026/06/24", "rollout-bad.jsonl", [
      { type: "event_msg", payload: { type: "task_started" } }, // no session_meta first
      userItem("orphan"),
    ]);
    writeRollout(home, "2026/06/24", "rollout-good.jsonl", [
      metaLine("id-good", cwd, "2026-06-24T00:00:00.000Z"),
      userItem("good"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe("id-good");
  });

  it("returns [] when the sessions dir is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    expect(discoverCodexSessions("/tmp/nope", home)).toEqual([]);
  });

  it("tolerates a session with no real user message (firstMessage empty)", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/p";
    writeRollout(home, "2026/06/24", "rollout-meta-only.jsonl", [
      metaLine("id-only", cwd, "2026-06-24T00:00:00.000Z"),
      userItem("<environment_context>only noise</environment_context>"),
    ]);
    const got = discoverCodexSessions(cwd, home);
    expect(got).toHaveLength(1);
    expect(got[0].sessionId).toBe("id-only");
    expect(got[0].firstMessage).toBe("");
  });
});

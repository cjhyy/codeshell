import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeTranscriptLine, readRecentHistory } from "./session-history.js";
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
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/a.txt" } }] },
      },
    ];
    const { cwd, home, sid } = setup(lines);
    const r = readRecentHistory(cwd, sid, 10, home);
    const a = r.messages.find((m) => m.role === "assistant");
    expect(a?.tools?.[0].name).toBe("Write");
  });
  it("returns full long assistant text without the old 4000-character truncation", () => {
    const longReply = "长回复".repeat(1600);
    const lines = [
      { type: "user", message: { role: "user", content: "tell me everything" } },
      { type: "assistant", message: { content: [{ type: "text", text: longReply }] } },
    ];
    const { cwd, home, sid } = setup(lines);
    const a = readRecentHistory(cwd, sid, 10, home).messages.find((m) => m.role === "assistant");
    expect(a?.text).toBe(longReply);
    expect(a?.text.length).toBeGreaterThan(4000);
  });
  it("captures the FULL tool input as args (e.g. a sub-agent prompt not in the summary whitelist)", () => {
    const input = {
      description: "build X",
      prompt: "一大段子任务 prompt……",
      subagent_type: "general-purpose",
    };
    const lines = [
      { type: "user", message: { role: "user", content: "go" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input }] } },
    ];
    const { cwd, home, sid } = setup(lines);
    const a = readRecentHistory(cwd, sid, 10, home).messages.find((m) => m.role === "assistant");
    expect(a?.tools?.[0].name).toBe("Agent");
    // summary is empty (prompt isn't a whitelist key) but the full args survive.
    expect(a?.tools?.[0].summary).toBe("");
    expect(a?.tools?.[0].args).toEqual(input);
  });
  it("skips caveat noise; returns empty when session absent", () => {
    expect(
      readRecentHistory("/tmp/none", "nope", 10, mkdtempSync(join(tmpdir(), "h-"))).messages,
    ).toEqual([]);
  });
});

describe("parseClaudeTranscriptLine", () => {
  it("maps appended user, assistant, tool and result lines", () => {
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({ type: "user", message: { content: "keep going" } }),
      ),
    ).toEqual([{ type: "user", text: "keep going" }]);
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "working" },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/a" } },
            ],
            stop_reason: "tool_use",
          },
        }),
      ),
    ).toEqual([
      { type: "assistant", text: "working" },
      {
        type: "tool",
        id: "tool-1",
        name: "Read",
        summary: "/a",
        args: { file_path: "/a" },
      },
    ]);
    expect(
      parseClaudeTranscriptLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "done",
                is_error: false,
              },
            ],
          },
        }),
      ),
    ).toEqual([{ type: "tool_result", id: "tool-1", result: "done", isError: false }]);
  });
});

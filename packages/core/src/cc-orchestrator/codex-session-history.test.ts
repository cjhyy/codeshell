import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexRecentHistory } from "./codex-session-history.js";

/** Build one codex rollout JSONL file under <home>/sessions/YYYY/MM/DD/. */
function writeRollout(codexHome: string, datePath: string, fileName: string, lines: unknown[]): void {
  const dir = join(codexHome, "sessions", datePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const metaLine = (id: string, cwd: string, timestamp = "2026-06-24T03:31:03.000Z") => ({
  timestamp,
  type: "session_meta",
  payload: { id, cwd, timestamp },
});
const userItem = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const assistantItem = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
});
const functionCall = (name: string, args: object) => ({
  type: "response_item",
  payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c1" },
});
const customToolCall = (name: string, input: string) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name, input, call_id: "c2" },
});

describe("readCodexRecentHistory", () => {
  it("returns last N user/assistant messages with hasMore", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/proj";
    const id = "019e8971-b4ce-7582-9d44-bb3a9253c331";
    writeRollout(home, "2026/06/24", `rollout-x-${id}.jsonl`, [
      metaLine(id, cwd),
      userItem("<environment_context>noise</environment_context>"),
      userItem("first"),
      assistantItem("reply1"),
      userItem("second"),
      assistantItem("reply2"),
    ]);
    const r = readCodexRecentHistory(cwd, id, 2, home);
    expect(r.messages.length).toBe(2);
    expect(r.messages[r.messages.length - 1].text).toBe("reply2");
    expect(r.hasMore).toBe(true);
    // 2 user (env_context skipped) + 2 assistant = 4 real messages
    expect(r.totalCount).toBe(4);
  });

  it("captures function_call and custom_tool_call as tool summaries", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/proj";
    const id = "id-tools";
    writeRollout(home, "2026/06/24", `rollout-${id}.jsonl`, [
      metaLine(id, cwd),
      userItem("do"),
      functionCall("exec_command", { cmd: "ls -la", workdir: "/tmp/proj" }),
      customToolCall("apply_patch", "*** Begin Patch\n*** Update File: /tmp/proj/a.txt"),
      assistantItem("done"),
    ]);
    const r = readCodexRecentHistory(cwd, id, 10, home);
    const tools = r.messages.flatMap((m) => m.tools ?? []);
    const names = tools.map((t) => t.name);
    expect(names).toContain("exec_command");
    expect(names).toContain("apply_patch");
    // function_call `arguments` (JSON string) is parsed into structured args;
    // custom_tool_call `input` (raw string) is preserved under {input}.
    expect(tools.find((t) => t.name === "exec_command")?.args).toEqual({ cmd: "ls -la", workdir: "/tmp/proj" });
    expect(tools.find((t) => t.name === "apply_patch")?.args).toEqual({
      input: "*** Begin Patch\n*** Update File: /tmp/proj/a.txt",
    });
  });

  it("returns full long assistant text without the old 4000-character truncation", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/proj";
    const id = "id-long-assistant";
    const longReply = "codex长回复".repeat(700);
    writeRollout(home, "2026/06/24", `rollout-${id}.jsonl`, [
      metaLine(id, cwd),
      userItem("tell me everything"),
      assistantItem(longReply),
    ]);
    const a = readCodexRecentHistory(cwd, id, 10, home).messages.find((m) => m.role === "assistant");
    expect(a?.text).toBe(longReply);
    expect(a?.text.length).toBeGreaterThan(4000);
  });

  it("matches the rollout by threadId even across date dirs; ignores other cwds", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const cwd = "/tmp/wanted";
    const id = "id-wanted";
    writeRollout(home, "2026/06/20", "rollout-other.jsonl", [
      metaLine("id-other", "/tmp/other"),
      userItem("nope"),
    ]);
    writeRollout(home, "2026/06/24", `rollout-${id}.jsonl`, [
      metaLine(id, cwd),
      userItem("yes"),
    ]);
    const r = readCodexRecentHistory(cwd, id, 10, home);
    expect(r.messages.map((m) => m.text)).toEqual(["yes"]);
  });

  it("returns empty when the thread is not found", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    expect(readCodexRecentHistory("/tmp/nope", "missing", 10, home).messages).toEqual([]);
  });

  it("returns empty when the sessions dir is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    expect(readCodexRecentHistory("/tmp/p", "id", 10, home)).toEqual({
      messages: [],
      hasMore: false,
      totalCount: 0,
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { transcriptToFoldItems, getSessionTranscript } from "./transcript-reader";

function line(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ id: "x", type, timestamp: 1, turnNumber: 0, data });
}

describe("transcriptToFoldItems", () => {
  it("maps a simple user→assistant turn", () => {
    const jsonl = [
      line("session_meta", { sessionId: "sess-1", cwd: "/repo" }),
      line("message", { role: "user", content: "hello" }),
      line("message", { role: "assistant", content: "hi there" }),
      line("turn_boundary", { turnNumber: 1 }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    // Each FoldItem carries the event's original persisted timestamp (the
    // fixture stamps every line with timestamp:1) so replay can recover the
    // real asked-at / answered-at and elapsed instead of showing 0s.
    expect(items[0]).toEqual({ kind: "stream", event: { type: "session_started", sessionId: "sess-1", promptTokens: 0 }, timestamp: 1 });
    expect(items[1]).toEqual({ kind: "user", text: "hello", timestamp: 1 });
    expect(items[2]).toEqual({ kind: "stream", event: { type: "stream_request_start", turnNumber: 0 }, timestamp: 1 });
    expect(items[3]).toEqual({ kind: "stream", event: { type: "text_delta", text: "hi there" }, timestamp: 1 });
    expect(items[4]).toEqual({ kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi there" } }, timestamp: 1 });
    expect(items[5]).toEqual({ kind: "stream", event: { type: "turn_complete", reason: "completed" }, timestamp: 1 });
  });

  it("maps tool_use + tool_result", () => {
    const jsonl = [
      line("tool_use", { toolName: "Bash", toolCallId: "tc1", args: { command: "ls" } }),
      line("tool_result", { toolCallId: "tc1", toolName: "Bash", result: "a\nb" }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({ kind: "stream", event: { type: "tool_use_start", toolCall: { id: "tc1", toolName: "Bash", args: { command: "ls" } } }, timestamp: 1 });
    expect(items[1]).toEqual({ kind: "stream", event: { type: "tool_result", result: { id: "tc1", toolName: "Bash", result: "a\nb", error: undefined } }, timestamp: 1 });
  });

  it("extracts text from assistant content blocks", () => {
    const jsonl = line("message", {
      role: "assistant",
      content: [{ type: "text", text: "block one" }, { type: "tool_use", id: "t", name: "X", input: {} }],
    });
    const items = transcriptToFoldItems(jsonl);
    const delta = items.find((i) => i.kind === "stream" && i.event.type === "text_delta");
    expect(delta).toEqual({ kind: "stream", event: { type: "text_delta", text: "block one" }, timestamp: 1 });
  });

  it("skips malformed lines without throwing", () => {
    const jsonl = ["not json", line("message", { role: "user", content: "ok" })].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items).toEqual([{ kind: "user", text: "ok", timestamp: 1 }]);
  });

  it("maps summary and error", () => {
    const jsonl = [line("summary", { summary: "s" }), line("error", { error: "boom" })].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items[0]).toEqual({ kind: "stream", event: { type: "context_compact", strategy: "summary", before: 0, after: 0 }, timestamp: 1 });
    expect(items[1]).toEqual({ kind: "stream", event: { type: "error", error: "boom" }, timestamp: 1 });
  });

  it("uses the event's turn number for assistant stream_request_start", () => {
    const t1 = JSON.stringify({ id: "x", type: "message", timestamp: 1, turnNumber: 1, data: { role: "assistant", content: "second" } });
    const items = transcriptToFoldItems(t1);
    const reqStart = items.find((i) => i.kind === "stream" && i.event.type === "stream_request_start");
    expect(reqStart).toEqual({ kind: "stream", event: { type: "stream_request_start", turnNumber: 1 }, timestamp: 1 });
  });
});

describe("getSessionTranscript", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-tr-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns [] for a missing session", async () => {
    expect(await getSessionTranscript("nope", dir)).toEqual([]);
  });

  it("reads a session dir transcript.jsonl", async () => {
    const sdir = path.join(dir, "sess-9");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), line("message", { role: "user", content: "yo" }) + "\n");
    expect(await getSessionTranscript("sess-9", dir)).toEqual([{ kind: "user", text: "yo", timestamp: 1 }]);
  });
});

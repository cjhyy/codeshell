import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../packages/core/src/session/session-manager.js";
import { Transcript, hasCompleteContextToolPairs } from "../../../packages/core/src/session/transcript.js";
import type { ContentBlock } from "../../../packages/core/src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seed() {
  const root = mkdtempSync(join(tmpdir(), "audit-r9-session-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  const source = manager.create(join(root, "普通 project"), "audit-model", "audit-provider", "source");
  const from = source.transcript.appendMessage("user", "读取两项并保留多模态结果", { clientMessageId: "input-1" });
  source.transcript.appendMessage("assistant", [
    { type: "text", text: "先读取" },
    { type: "tool_use", id: "text-call", name: "Read", input: { file_path: "plain.txt" } },
    { type: "tool_use", id: "image-call", name: "Read", input: { file_path: "image.png" } },
  ]);
  source.transcript.appendToolUse("Read", "text-call", { file_path: "plain.txt" });
  source.transcript.appendToolUse("Read", "image-call", { file_path: "image.png" });
  source.transcript.appendToolResult("text-call", "Read", "scalar factual result");
  const content: ContentBlock[] = [
    { type: "text", text: "structured factual result" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aW4tbWVtb3J5LWZpeHR1cmU=" } },
  ];
  source.transcript.appendToolResult("image-call", "Read", "display fallback", undefined, content);
  const to = source.transcript.appendMessage("assistant", "两个结果均已读取");
  source.transcript.appendTurnBoundary();
  return { root, manager, source, from, to };
}

describe("round9 ordinary session data controls", () => {
  test("disk reload, full fork and selected range preserve paired structured results without changing the source", () => {
    const { root, manager, source, from, to } = seed();
    const file = source.transcript.getFilePath();
    const before = readFileSync(file, "utf8");
    const original = source.transcript.toMessages();
    const selected = manager.selectContextPackage("source", { fromEventId: from.id, toEventId: to.id });
    const forked = manager.fork("source", { targetSessionId: "child" });
    const loaded = new SessionManager(join(root, "sessions")).resume("child");
    expect(hasCompleteContextToolPairs(original)).toBe(true);
    expect(selected.messages).toEqual(original);
    expect(loaded.transcript.toMessages()).toEqual(original);
    expect(forked.bundle.transcript.toMessages()).toEqual(original);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(loaded.state.cwd).toBe(source.state.cwd);
    const result = loaded.transcript.toMessages().flatMap(m => Array.isArray(m.content) ? m.content : [])
      .find(b => b.type === "tool_result" && b.tool_use_id === "image-call");
    expect(result?.content).toEqual([
      { type: "text", text: "structured factual result" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW4tbWVtb3J5LWZpeHR1cmU=" } },
    ]);
    const parentIds = new Set(source.transcript.getEvents().map(e => e.id));
    expect(loaded.transcript.getEvents().some(e => parentIds.has(e.id))).toBe(false);
  });

  test("modifying a replay or selected package cannot rewrite the original transcript result", () => {
    const { manager, source, from, to } = seed();
    const beforeMessages = source.transcript.toMessages();
    const beforeBytes = readFileSync(source.transcript.getFilePath(), "utf8");
    const replay = source.transcript.toMessages();
    const result = replay.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .find(b => b.type === "tool_result" && b.tool_use_id === "image-call")!;
    (result.content as ContentBlock[])[0]!.text = "changed replay copy";
    const selected = manager.selectContextPackage("source", { fromEventId: from.id, toEventId: to.id });
    const use = selected.events.find(e => e.type === "message" && e.data.role === "assistant")!;
    (use.data.content as ContentBlock[])[0]!.text = "changed selected copy";
    expect(source.transcript.toMessages()).toEqual(beforeMessages);
    expect(Transcript.loadFromFile(source.transcript.getFilePath()).toMessages()).toEqual(beforeMessages);
    expect(readFileSync(source.transcript.getFilePath(), "utf8")).toBe(beforeBytes);
  });
});

import { describe, expect, test } from "bun:test";
import { maskOldObservations } from "./compaction.js";
import type { Message } from "../types.js";

/** Build a turn: assistant tool_use(browser_observe snapshot) + user tool_result. */
function snapTurn(id: string, content: string, mode?: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "browser_observe", input: mode ? { mode } : {} }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

describe("maskOldObservations", () => {
  test("keeps only the latest snapshot, collapses older ones", () => {
    const messages: Message[] = [
      ...snapTurn("s1", "[ref=e1] button 旧页面A"),
      ...snapTurn("s2", "[ref=e1] button 旧页面B"),
      ...snapTurn("s3", "[ref=e1] button 当前页面"),
    ];
    const { messages: out, maskedCount } = maskOldObservations(messages);
    expect(maskedCount).toBe(2);
    const results = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
    expect(results[0]!.content).toContain("collapsed");
    expect(results[1]!.content).toContain("collapsed");
    expect(results[2]!.content).toBe("[ref=e1] button 当前页面"); // latest kept verbatim
  });

  test("explicit mode:snapshot is masked same as default", () => {
    const messages: Message[] = [
      ...snapTurn("s1", "snap A", "snapshot"),
      ...snapTurn("s2", "snap B", "snapshot"),
    ];
    expect(maskOldObservations(messages).maskedCount).toBe(1);
  });

  test("single snapshot → untouched", () => {
    const messages = snapTurn("s1", "[ref=e1] button x");
    expect(maskOldObservations(messages).maskedCount).toBe(0);
  });

  test("does NOT mask browser_observe read/extract observations", () => {
    const messages: Message[] = [
      ...snapTurn("r1", "page article text", "read"),
      ...snapTurn("e1", "links...", "extract"),
      ...snapTurn("s1", "snap A"),
      ...snapTurn("s2", "snap B"),
    ];
    const { maskedCount } = maskOldObservations(messages);
    expect(maskedCount).toBe(1); // only the older of the two snapshots
  });

  test("does not touch non-browser tool results", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "file body" }] },
      ...snapTurn("s1", "snap A"),
      ...snapTurn("s2", "snap B"),
    ];
    const { messages: out, maskedCount } = maskOldObservations(messages);
    expect(maskedCount).toBe(1); // only s1 masked
    const read = out[1]!.content as Array<{ content?: string }>;
    expect(read[0]!.content).toBe("file body"); // Read untouched
  });

  test("idempotent — re-running doesn't re-mask the placeholder", () => {
    const messages: Message[] = [...snapTurn("s1", "snap A"), ...snapTurn("s2", "snap B")];
    const once = maskOldObservations(messages);
    const twice = maskOldObservations(once.messages);
    expect(twice.maskedCount).toBe(0);
  });
});

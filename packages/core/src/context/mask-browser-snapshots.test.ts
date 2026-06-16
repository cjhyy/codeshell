import { describe, expect, test } from "bun:test";
import { maskOldBrowserSnapshots } from "./compaction.js";
import type { Message } from "../types.js";

/** Build a turn: assistant tool_use(browser_snapshot) + user tool_result. */
function snapTurn(id: string, content: string): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "browser_snapshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

describe("maskOldBrowserSnapshots", () => {
  test("keeps only the latest snapshot, collapses older ones", () => {
    const messages: Message[] = [
      ...snapTurn("s1", "[ref=e1] button 旧页面A"),
      ...snapTurn("s2", "[ref=e1] button 旧页面B"),
      ...snapTurn("s3", "[ref=e1] button 当前页面"),
    ];
    const { messages: out, maskedCount } = maskOldBrowserSnapshots(messages);
    expect(maskedCount).toBe(2);
    const results = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
    expect(results[0]!.content).toContain("collapsed");
    expect(results[1]!.content).toContain("collapsed");
    expect(results[2]!.content).toBe("[ref=e1] button 当前页面"); // latest kept verbatim
  });

  test("single snapshot → untouched", () => {
    const messages = snapTurn("s1", "[ref=e1] button x");
    expect(maskOldBrowserSnapshots(messages).maskedCount).toBe(0);
  });

  test("does not touch non-browser_snapshot tool results", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "file body" }] },
      ...snapTurn("s1", "snap A"),
      ...snapTurn("s2", "snap B"),
    ];
    const { messages: out, maskedCount } = maskOldBrowserSnapshots(messages);
    expect(maskedCount).toBe(1); // only s1 masked
    const read = out[1]!.content as Array<{ content?: string }>;
    expect(read[0]!.content).toBe("file body"); // Read untouched
  });

  test("idempotent — re-running doesn't re-mask the placeholder", () => {
    const messages: Message[] = [...snapTurn("s1", "snap A"), ...snapTurn("s2", "snap B")];
    const once = maskOldBrowserSnapshots(messages);
    const twice = maskOldBrowserSnapshots(once.messages);
    expect(twice.maskedCount).toBe(0);
  });
});

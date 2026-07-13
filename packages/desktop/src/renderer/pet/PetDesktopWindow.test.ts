import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectMiniChatMessages } from "./PetDesktopWindow";

describe("Pet desktop mini chat", () => {
  test("projects the shared durable transcript into compact chat bubbles", () => {
    expect(
      selectMiniChatMessages([
        { kind: "user", id: "u1", text: "安排修复" },
        { kind: "thinking", id: "t1", text: "scope", done: true },
        {
          kind: "assistant",
          id: "a1",
          text: "我会先整理范围\n<!--PET:AUTO_DELEGATE-->",
          done: true,
        },
      ]),
    ).toEqual([
      { id: "u1", role: "user", text: "安排修复" },
      { id: "a1", role: "assistant", text: "我会先整理范围" },
    ]);
  });

  test("keeps ordinary session progress collapsed but surfaces a real attention peek", () => {
    const source = readFileSync(join(import.meta.dir, "PetDesktopWindow.tsx"), "utf8");
    const projectionStart = source.indexOf("const applyEvent =");
    const projectionEnd = source.indexOf(
      "const unsubscribe = api.onProjectionEvent",
      projectionStart,
    );
    const attentionStart = source.indexOf("const applyAttention =");
    const attentionEnd = source.indexOf("const unsubscribe = api.onAttentionEvent", attentionStart);

    expect(projectionStart).toBeGreaterThanOrEqual(0);
    expect(attentionStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(projectionStart, projectionEnd)).not.toContain("showPanel()");
    expect(source.slice(attentionStart, attentionEnd)).toContain("showPanel()");
  });
});

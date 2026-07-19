import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectMiniChatMessages, selectMiniChatRows } from "./PetDesktopWindow";

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

  test("auto-expands the first session activity and still surfaces a real attention peek", () => {
    const source = readFileSync(join(import.meta.dir, "PetDesktopWindow.tsx"), "utf8");
    const attentionStart = source.indexOf("const applyAttention =");
    const attentionEnd = source.indexOf("const unsubscribe = api.onAttentionEvent", attentionStart);

    expect(attentionStart).toBeGreaterThanOrEqual(0);
    expect(source).toContain("autoExpandedWorkRef.current || workActivity.items.length === 0");
    expect(source).toContain("autoExpandedWorkRef.current = true");
    expect(source.slice(attentionStart, attentionEnd)).toContain("showPanel()");
    expect(source).toContain("const state = usePetProjectionState(api)");
    expect(source).toContain("bufferPetAttentionEvent(buffered, event)");
    expect(source).toContain('data-pet-global-session-list="true"');
    expect(source).toContain("sessions={globalOverview.sessions}");
    expect(source).toContain("globalOverview.sessions.length");
    expect(source).not.toContain("workActivity.items.slice(0, 4)");
    expect(source).not.toContain("void api.getSnapshot()");
  });

  test("renders delegation receipts as compact live session cards", () => {
    const rows = selectMiniChatRows(
      [
        { kind: "user", id: "u1", text: "去下载视频", clientMessageId: "client-1" },
        { kind: "assistant", id: "a1", text: "已经派出去了", done: true },
      ],
      [
        {
          originClientMessageId: "client-1",
          delegations: [
            {
              sessionId: "session-1",
              task: "下载视频",
              workspacePath: "/tmp/video",
              reusedSession: false,
            },
          ],
        },
      ],
    );

    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "delegation"]);
    expect(rows.at(-1)?.delegation?.sessionId).toBe("session-1");

    const source = readFileSync(join(import.meta.dir, "PetDesktopWindow.tsx"), "utf8");
    expect(source).toContain("<PetDelegationCard");
    expect(source).toContain("compact");
    expect(source).toContain("onOpen={() => openDelegation");
  });
});

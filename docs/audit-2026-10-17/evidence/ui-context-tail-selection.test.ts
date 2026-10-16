import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionTranscriptPage, DEFAULT_TRANSCRIPT_PAGE_BYTES } from "../../../packages/desktop/src/main/transcript-reader";
import { getSessionEvents } from "../../../packages/desktop/src/main/rawTranscript";
import { foldTranscript } from "../../../packages/desktop/src/renderer/automation/foldTranscript";
import { buildSelectableContextTurns, groupStreamItemsIntoContextTurns, selectedTurnRange } from "../../../packages/desktop/src/renderer/contextSelection";

const event = (id: string, type: string, turnNumber: number, data: Record<string, unknown> = {}) => ({ id, type, turnNumber, timestamp: 1000 + turnNumber, data });

test("round 4: default transcript tail selects the oldest raw turn by index", async () => {
  const base = await mkdtemp(join(tmpdir(), "codeshell-ui-context-audit-"));
  try {
    const sessionId = "audit-context-window";
    await mkdir(join(base, sessionId));
    const events = [
      event("meta", "session_meta", 0),
      event("old-user", "message", 0, { role: "user", content: "OLD confidential unrelated task" }),
      event("old-answer", "message", 0, { role: "assistant", content: "x".repeat(DEFAULT_TRANSCRIPT_PAGE_BYTES + 1000) }),
      event("old-boundary", "turn_boundary", 1),
      event("recent-user", "message", 1, { role: "user", content: "RECENT visible task to forward" }),
      event("recent-answer", "message", 1, { role: "assistant", content: "Recent complete answer" }),
      event("recent-boundary", "turn_boundary", 2),
    ];
    await writeFile(join(base, sessionId, "transcript.jsonl"), events.map(item => JSON.stringify(item)).join("\n") + "\n");
    const page = await getSessionTranscriptPage(sessionId, {}, base);
    const displayGroups = groupStreamItemsIntoContextTurns(foldTranscript(page.items).messages);
    const rawTurns = buildSelectableContextTurns(await getSessionEvents(sessionId, undefined, base), false);
    const visible = displayGroups.find(group => group.selectionIndex !== null)!;
    const selectedRange = selectedTurnRange(rawTurns, visible.selectionIndex!, visible.selectionIndex!);
    expect(page.hasMore).toBe(true);
    expect(visible.items[0]).toMatchObject({ kind: "user", text: "RECENT visible task to forward" });
    expect(visible.selectionIndex).toBe(0);
    expect(rawTurns).toHaveLength(2);
    expect(selectedRange).toEqual({ fromEventId: "old-user", toEventId: "old-boundary" });
    console.log(JSON.stringify({ observation: "tail-visible-turn-wrong-raw-range", loadedBytes: page.loadedBytes, hasMore: page.hasMore, visibleUser: visible.items[0], displaySelectionIndex: visible.selectionIndex, selectedRawPreview: rawTurns[visible.selectionIndex!]!.preview, selectedRange }));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("round 4 control: a complete visible transcript maps to the matching raw turn", () => {
  const raw = [event("u1", "message", 0, { role: "user", content: "first" }), event("b1", "turn_boundary", 1), event("u2", "message", 1, { role: "user", content: "second" }), event("b2", "turn_boundary", 2)];
  const turns = buildSelectableContextTurns(raw, false);
  const groups = groupStreamItemsIntoContextTurns([{ id: "ui-u1", kind: "user", text: "first" }, { id: "ui-u2", kind: "user", text: "second" }]);
  expect(selectedTurnRange(turns, groups[1]!.selectionIndex!, groups[1]!.selectionIndex!)).toEqual({ fromEventId: "u2", toEventId: "b2" });
});

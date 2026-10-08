import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../core/src/session/session-manager.js";
import {
  readOutputJournal,
  SessionOutputJournal,
} from "../../../core/src/session/output-journal.js";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { applyOutputJournalPage, type OutputJournalRecovery } from "./outputJournalRecovery.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-output-reducer-"));
  directories.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "stream");
  manager.startSessionRun(session.state, "run");
  return { root, writer: new SessionOutputJournal(root, "stream", "run", "legacy-base") };
}
test("frozen multipage recovery reconstructs UTF-8 fragments and leaves unfinished runs unfinished", () => {
  const f = fixture();
  const large = "汉🙂".repeat(50_000);
  f.writer.append({ type: "stream_request_start", turnNumber: 1 });
  f.writer.append({ type: "text_delta", text: large });
  const state: OutputJournalRecovery = { incomplete: false };
  const events: StreamEvent[] = [];
  let page = readOutputJournal(f.root, "stream", { maxFrames: 2 });
  expect(applyOutputJournalPage(state, page, (event) => events.push(event))).toBe(false);
  expect(state.pending).toBeDefined();
  expect(state.appliedCursor).not.toBe(state.cursor);
  f.writer.append({ type: "text_delta", text: "after frozen head" });
  while (!page.complete) {
    page = readOutputJournal(f.root, "stream", {
      after: state.cursor,
      through: state.through,
      maxFrames: 2,
    });
    applyOutputJournalPage(state, page, (event) => events.push(event));
  }
  expect(state.incomplete).toBe(false);
  expect(state.pending).toBeUndefined();
  expect(state.appliedCursor).toBe(state.cursor);
  expect(state.legacyBaseThroughEventId).toBe("legacy-base");
  expect(events.map((event) => event.type)).toEqual(["stream_request_start", "text_delta"]);
  expect((events[1] as { text: string }).text).toBe(large);
  expect(events.some((event) => event.type === "turn_complete")).toBe(false);
  // Restart from the last complete event with no fragment RAM retained.
  const restarted: OutputJournalRecovery = { incomplete: false, cursor: state.appliedCursor };
  const newer = readOutputJournal(f.root, "stream", { after: restarted.cursor });
  expect(applyOutputJournalPage(restarted, newer, (event) => events.push(event))).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "text_delta", text: "after frozen head" });
});
test("duplicate, skipped, replaced and incomplete pages preserve an explicit recovery barrier", () => {
  const f = fixture();
  f.writer.append({ type: "text_delta", text: "a" });
  f.writer.append({ type: "text_delta", text: "b" });
  const first = readOutputJournal(f.root, "stream", { maxFrames: 1 });
  const second = readOutputJournal(f.root, "stream", { after: first.next, through: first.through });
  for (const pages of [
    [second],
    [first, first],
    [{ ...first, complete: true }],
    [{ ...first, status: "incomplete" as const }],
    [{ ...first, frames: [] }],
  ]) {
    const state: OutputJournalRecovery = { incomplete: false };
    for (const page of pages) applyOutputJournalPage(state, page, () => {});
    expect(state.incomplete).toBe(true);
  }
  const state: OutputJournalRecovery = { incomplete: false };
  applyOutputJournalPage(state, first, () => {});
  expect(applyOutputJournalPage(state, second, () => {})).toBe(true);
  expect(state.incomplete).toBe(false);
});

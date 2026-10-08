import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import {
  readOutputJournal,
  readOutputJournalLegacyBase,
  SessionOutputJournal,
} from "./output-journal.js";
import { buildWrappedOnStream } from "../engine/run-stream.js";
import type { StreamEvent } from "../types.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(id = "journal-session") {
  const root = mkdtempSync(join(tmpdir(), "codeshell-output-test-"));
  directories.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  const runId = session.transcript.appendMessage("user", "hello").id;
  manager.startSessionRun(session.state, runId);
  const file = join(root, id, "output-journal.jsonl");
  const writer = new SessionOutputJournal(root, id, runId, session.transcript.getEvents()[0].id);
  return { root, manager, session, runId, file, writer, id };
}

describe("Session output journal", () => {
  test("freezes contiguous bounded pages while subsequent appends advance another head", () => {
    const f = fixture();
    for (let index = 0; index < 12; index++)
      f.writer.append({ type: "text_delta", text: `片段-${index}-🙂` });
    const first = readOutputJournal(f.root, f.id, { maxFrames: 3 });
    expect(first.status).toBe("ok");
    expect(first.complete).toBe(false);
    expect(first.frames.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
    f.writer.append({ type: "text_delta", text: "newer" });
    const sequences = first.frames.map((frame) => frame.sequence);
    let page = first;
    while (!page.complete) {
      page = readOutputJournal(f.root, f.id, {
        after: page.next,
        through: first.through,
        maxFrames: 3,
      });
      expect(page.status).toBe("ok");
      sequences.push(...page.frames.map((frame) => frame.sequence));
    }
    expect(sequences).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(readOutputJournal(f.root, f.id).through).not.toBe(first.through);
    expect(
      readOutputJournal(f.root, f.id, { after: first.through, through: first.through }).complete,
    ).toBe(true);
  });
  test("storage scope, file replacement, Session deletion/reuse and stale run owners invalidate cursors", () => {
    const f = fixture();
    const cursor = f.writer.append({ type: "text_delta", text: "before" });
    f.manager.startSessionRun(f.session.state, "next-run");
    expect(() => f.writer.append({ type: "text_delta", text: "late" })).toThrow("superseded");
    const other = fixture("other-session");
    expect(readOutputJournal(other.root, other.id, { after: cursor }).status).toBe(
      "cursor_invalid",
    );
    copyFileSync(f.file, f.file + ".replacement");
    renameSync(f.file + ".replacement", f.file);
    expect(readOutputJournal(f.root, f.id, { after: cursor }).status).toBe("cursor_invalid");
    rmSync(join(f.root, f.id), { recursive: true });
    expect(readOutputJournal(f.root, f.id).status).toBe("unavailable");
    const newSession = f.manager.create(f.root, "fixture", "fixture", f.id);
    f.manager.startSessionRun(newSession.state, "new-run");
    new SessionOutputJournal(f.root, f.id, "new-run").append({ type: "text_delta", text: "fresh" });
    expect(readOutputJournal(f.root, f.id, { after: cursor }).status).toBe("cursor_invalid");
    expect(() => f.writer.append({ type: "text_delta", text: "recreated-late" })).toThrow();
  });
  test("only an uncommitted final tail is isolated; committed interior corruption is never skipped", () => {
    const f = fixture();
    const cursor = f.writer.append({ type: "text_delta", text: "完整🙂" });
    const committed = readFileSync(f.file);
    appendFileSync(f.file, Buffer.from([0x7b, 0xe4, 0xb8]));
    const torn = readOutputJournal(f.root, f.id);
    expect(torn.status).toBe("ok");
    expect(torn.through).toBe(cursor);
    expect(torn.uncommittedTail).toBe(true);
    const recovered = new SessionOutputJournal(f.root, f.id, f.runId);
    expect(readFileSync(f.file)).toEqual(committed);
    recovered.append({ type: "text_delta", text: "after crash" });
    const raw = readFileSync(f.file, "utf8");
    writeFileSync(f.file, raw.replace("完整🙂", "changed"));
    expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow("continuity");
  });
  test("a truncated frozen upper bound is invalid and malformed complete records are incomplete", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "one" });
    const first = readOutputJournal(f.root, f.id);
    const second = f.writer.append({ type: "text_delta", text: "two" });
    truncateSync(
      f.file,
      readFileSync(f.file, "utf8").lastIndexOf("\n", statSync(f.file).size - 2) + 1,
    );
    expect(readOutputJournal(f.root, f.id, { through: second }).status).toBe("cursor_invalid");
    expect(readOutputJournal(f.root, f.id, { through: first.through }).status).toBe("ok");
    appendFileSync(f.file, "{broken}\n");
    expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
  });
  test("large UTF-8 events are bounded fragments and pending final fragments never become coverage", () => {
    const f = fixture();
    const text = "汉🙂".repeat(40_000);
    const cursor = f.writer.append({
      type: "assistant_message",
      message: { role: "assistant", content: text },
    });
    const page = readOutputJournal(f.root, f.id);
    expect(page.status).toBe("ok");
    expect(page.through).toBe(cursor);
    expect(page.frames.length).toBeGreaterThan(2);
    expect(readOutputJournal(f.root, f.id, { through: page.frames[0].cursor }).status).toBe(
      "cursor_invalid",
    );
    expect(
      page.frames.every(
        (frame) => frame.fragment && Buffer.from(frame.fragment.data, "base64").length <= 64 * 1024,
      ),
    ).toBe(true);
    const values = readFileSync(f.file, "utf8").trimEnd().split("\n");
    writeFileSync(f.file, values.slice(0, -1).join("\n") + "\n");
    const incompleteGroup = readOutputJournal(f.root, f.id);
    expect(incompleteGroup.frames).toEqual([]);
    expect(incompleteGroup.uncommittedTail).toBe(true);
    new SessionOutputJournal(f.root, f.id, f.runId);
    expect(readFileSync(f.file, "utf8").trimEnd().split("\n").length).toBe(1);
  });
  test("legacy cutover requires the exact bounded prefix and never reads a huge later reply", () => {
    const f = fixture();
    const anchor = f.session.transcript.getEvents()[0].id;
    f.session.transcript.appendMessage("assistant", "later".repeat(300_000));
    const base = readOutputJournalLegacyBase(f.root, f.id, anchor);
    expect(base.complete).toBe(true);
    expect(base.events.map((event) => event.id)).toEqual([anchor]);
    expect(readOutputJournalLegacyBase(f.root, f.id, "missing")).toEqual({
      complete: false,
      events: [],
    });
    expect(readOutputJournalLegacyBase(f.root, "../escape", anchor).complete).toBe(false);
  });
  test("the journal storage budget fails closed without deleting an old prefix", () => {
    const f = fixture();
    const huge = { type: "text_delta" as const, text: "x".repeat(15 * 1024 * 1024) };
    for (let index = 0; index < 6; index++) f.writer.append(huge);
    const size = statSync(f.file).size;
    expect(size).toBeLessThan(128 * 1024 * 1024);
    expect(() => f.writer.append(huge)).toThrow("storage budget");
    expect(statSync(f.file).size).toBe(size);
  });
  test("archive follows the existing read policy; ephemeral Sessions create no journal", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "archived" });
    f.manager.setSessionArchived(f.id, Date.now());
    expect(readOutputJournal(f.root, f.id).status).toBe("ok");
    const local = f.manager.create(
      f.root,
      "fixture",
      "fixture",
      "ephemeral-output",
      null,
      undefined,
      "work",
      true,
    );
    const runId = local.transcript.appendMessage("user", "private").id;
    f.manager.startSessionRun(local.state, runId);
    const events: StreamEvent[] = [];
    buildWrappedOnStream({
      getSession: () => local,
      setLatestTodos: () => {},
      userOnStream: (event) => {
        events.push(event);
      },
      outputJournal: {
        root: f.root,
        getRunId: () => runId,
        onFailure: () => {
          throw new Error("must not happen");
        },
      },
    })({ type: "text_delta", text: "process-local" });
    expect(events[0].outputCursor).toBeUndefined();
    expect(existsSync(join(f.root, local.state.sessionId))).toBe(false);
    expect(readOutputJournal(f.root, local.state.sessionId).status).toBe("unavailable");
  });
  test("persistence/budget failure fences ordinary events and never publishes completed", () => {
    const f = fixture();
    const published: StreamEvent[] = [];
    const wrapped = buildWrappedOnStream({
      getSession: () => f.session,
      setLatestTodos: () => {},
      userOnStream: (event) => {
        published.push(event);
      },
      outputJournal: {
        root: f.root,
        getRunId: () => f.runId,
        onFailure: () => {
          f.manager.updateSessionState(f.id, { outputRecoveryIncomplete: true }, f.runId);
        },
      },
    });
    expect(() => wrapped({ type: "text_delta", text: "x".repeat(16 * 1024 * 1024 + 1) })).toThrow(
      "16 MiB",
    );
    expect(published).toEqual([]);
    expect(() => wrapped({ type: "turn_complete", reason: "completed" })).toThrow("incomplete");
    wrapped({ type: "error", error: "storage unavailable" });
    wrapped({ type: "turn_complete", reason: "model_error" });
    expect(published.map((event) => event.outputRecovery)).toEqual(["incomplete", "incomplete"]);
    expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
  });
  test("a physical write denial cannot publish a cursor or a completed event", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const f = fixture();
    chmodSync(f.file, 0o400);
    try {
      expect(() => f.writer.append({ type: "text_delta", text: "denied" })).toThrow();
    } finally {
      chmodSync(f.file, 0o600);
    }
    expect(readOutputJournal(f.root, f.id).frames).toEqual([]);
  });
  test("rejects malformed options and too-small byte pages without inventing empty completeness", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "hello" });
    for (const options of [
      { maxFrames: 0 },
      { maxBytes: 1 },
      { maxBytes: 1024 * 1024 + 1 },
      { after: "invalid" },
      { through: null },
    ]) {
      const page = readOutputJournal(f.root, f.id, options as any);
      expect(page.status).toBe("cursor_invalid");
      expect(page.complete).toBe(false);
    }
  });
});

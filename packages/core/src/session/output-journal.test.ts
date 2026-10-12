import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
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
    expect(readOutputJournal(f.root, f.id).status).toBe("cursor_invalid");
    expect(() => new SessionOutputJournal(f.root, f.id, "next-run")).toThrow();
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
    const originalEvidence = readFileSync(f.file);
    const torn = readOutputJournal(f.root, f.id);
    expect(torn.status).toBe("ok");
    expect(torn.through).toBe(cursor);
    expect(torn.uncommittedTail).toBe(true);
    const recovered = new SessionOutputJournal(f.root, f.id, f.runId);
    expect(readFileSync(f.file)).toEqual(committed);
    const directory = join(f.root, f.id);
    const receiptName = readdirSync(directory).find((name) =>
      /^\.output-repair-.*\.json$/.test(name),
    )!;
    const receipt = JSON.parse(readFileSync(join(directory, receiptName), "utf8"));
    expect(readFileSync(join(directory, receipt.evidence))).toEqual(originalEvidence);
    expect(receipt.sha256).toBe(createHash("sha256").update(originalEvidence).digest("hex"));
    expect(receipt.published.offset).toBe(committed.length);
    expect(readOutputJournal(f.root, f.id).through).toBe(cursor);
    recovered.append({ type: "text_delta", text: "after crash" });
    const raw = readFileSync(f.file, "utf8");
    writeFileSync(f.file, raw.replace("完整🙂", "changed"));
    expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow("continuity");
  });
  test("a committed identity pin fences missing/zero/replaced journals after a cold owner restart", () => {
    for (const mode of ["empty", "missing", "header"] as const) {
      const f = fixture();
      const published = f.writer.append({ type: "text_delta", text: "published-prefix" });
      expect(f.manager.saveState(f.session.state)).toBe(true);
      expect(f.manager.readSessionState(f.id)?.outputJournalIdentity).toEqual(expect.any(String));
      if (mode === "empty") truncateSync(f.file, 0);
      else if (mode === "missing") rmSync(f.file);
      else {
        const text = readFileSync(f.file, "utf8");
        writeFileSync(f.file, text.replace(/"journalId":"[^"]+"/, '"journalId":"replaced"'));
      }
      expect(["incomplete", "cursor_invalid"]).toContain(readOutputJournal(f.root, f.id).status);
      expect(readOutputJournal(f.root, f.id, { after: published }).complete).toBe(false);
      const restarted = new SessionManager(f.root);
      const state = restarted.readSessionState(f.id)!;
      restarted.startSessionRun(state, "new-owner");
      expect(() => new SessionOutputJournal(f.root, f.id, "new-owner")).toThrow();
      if (mode === "empty") expect(statSync(f.file).size).toBe(0);
      if (mode === "missing") expect(existsSync(f.file)).toBe(false);
    }
  });
  test("a live writer cannot ignore a removed/replaced identity pin", () => {
    for (const pin of [undefined, "a".repeat(64)]) {
      const f = fixture();
      f.writer.append({ type: "text_delta", text: "committed" });
      const state = JSON.parse(readFileSync(join(f.root, f.id, "state.json"), "utf8"));
      if (pin === undefined) delete state.outputJournalIdentity;
      else state.outputJournalIdentity = pin;
      writeFileSync(join(f.root, f.id, "state.json"), JSON.stringify(state));
      expect(() => f.writer.append({ type: "text_delta", text: "late" })).toThrow("pin");
      expect(readOutputJournal(f.root, f.id).complete).toBe(false);
    }
  });
  test("cached positions still detect same-size corruption before after, even with restored mtime", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "before" });
    f.writer.append({ type: "text_delta", text: "second" });
    const first = readOutputJournal(f.root, f.id, { maxFrames: 1 });
    const stat = statSync(f.file);
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace('"before"', '"broken"'));
    utimesSync(f.file, stat.atime, stat.mtime);
    expect(
      readOutputJournal(f.root, f.id, { after: first.next, through: first.through }).status,
    ).toBe("incomplete");
  });
  test("a live writer refuses same-length committed record/header rewrites before publishing another cursor", () => {
    for (const mode of ["record", "header"] as const) {
      const f = fixture();
      f.writer.append({ type: "text_delta", text: "before" });
      f.writer.append({ type: "text_delta", text: "second" });
      const stat = statSync(f.file);
      const raw = readFileSync(f.file, "utf8");
      const lines = raw.split("\n");
      if (mode === "record") lines[1] = lines[1].replace('"before"', '"broken"');
      else {
        const header = JSON.parse(lines[0]);
        header.journalId = `${header.journalId[0] === "a" ? "b" : "a"}${header.journalId.slice(1)}`;
        lines[0] = JSON.stringify(header);
      }
      const changed = lines.join("\n");
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(raw));
      writeFileSync(f.file, changed);
      utimesSync(f.file, stat.atime, stat.mtime);
      expect(() => f.writer.append({ type: "text_delta", text: "never published" })).toThrow();
      expect(readFileSync(f.file, "utf8")).toBe(changed);
    }
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "intact" });
    const stat = statSync(f.file);
    utimesSync(f.file, stat.atime, new Date(stat.mtimeMs + 1000));
    expect(f.writer.append({ type: "text_delta", text: "still intact" })).toEqual(
      expect.any(String),
    );
    expect(readOutputJournal(f.root, f.id).status).toBe("ok");
  });
  test("a mutation while assembling a page rechecks header, pin and sticky failure, while allowing a new run owner", () => {
    for (const mode of ["header", "pin", "failure", "run-owner"] as const) {
      const f = fixture();
      f.writer.append({ type: "text_delta", text: "mutation-boundary" });
      const first = readOutputJournal(f.root, f.id);
      expect(first.status).toBe("ok");
      let changed = false;
      const byteLength = Buffer.byteLength;
      // Schedule actual file/state mutations after the cached prefix/header
      // read and frame parse. Do not replace file I/O or its return values.
      const hook = spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
        const length = byteLength(value, encoding);
        if (
          !changed &&
          typeof value === "string" &&
          value.includes('"cursor":') &&
          value.includes("mutation-boundary")
        ) {
          changed = true;
          if (mode === "header") {
            const lines = readFileSync(f.file, "utf8").split("\n");
            const header = JSON.parse(lines[0]);
            header.journalId = `${header.journalId[0] === "a" ? "b" : "a"}${header.journalId.slice(1)}`;
            lines[0] = JSON.stringify(header);
            writeFileSync(f.file, lines.join("\n"));
          } else {
            const file = join(f.root, f.id, "state.json");
            const state = JSON.parse(readFileSync(file, "utf8"));
            if (mode === "pin") delete state.outputJournalIdentity;
            else if (mode === "failure") state.outputRecoveryIncomplete = true;
            else state.runId = "new-owner";
            writeFileSync(file, JSON.stringify(state));
          }
        }
        return length;
      });
      try {
        const page = readOutputJournal(f.root, f.id, { through: first.through });
        expect(changed).toBe(true);
        if (mode === "run-owner") expect(page.status).toBe("ok");
        else {
          expect(["incomplete", "cursor_invalid"]).toContain(page.status);
          expect(page.complete).toBe(false);
          expect(page.frames).toEqual([]);
        }
      } finally {
        hook.mockRestore();
      }
    }
  });
  test("an append between the captured size and stamp cannot poison the current-head cache", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "old prefix" });
    const inode = statSync(f.file).ino;
    const original = fs.fstatSync;
    let appended = false;
    let latest: string | undefined;
    const hook = spyOn(fs, "fstatSync").mockImplementation(((
      fd: number,
      options?: { bigint?: boolean },
    ) => {
      const stat = original(fd, options as never);
      if (!appended && options?.bigint && Number(stat.ino) === inode) {
        appended = true;
        latest = f.writer.append({ type: "text_delta", text: "last durable append" });
        return original(fd, options as never);
      }
      return stat;
    }) as typeof fs.fstatSync);
    try {
      // Appending at the first journal stamp happens after readOutputJournal
      // has captured its scan size. This request may freeze the older prefix.
      expect(readOutputJournal(f.root, f.id).status).toBe("ok");
      expect(appended).toBe(true);
    } finally {
      hook.mockRestore();
    }
    // No further append changes the stamp: a fresh read must see the last
    // published cursor rather than reuse an old head under that newer stamp.
    const current = readOutputJournal(f.root, f.id);
    expect(current.status).toBe("ok");
    expect(current.through).toBe(latest!);
    expect(current.frames.at(-1)?.event).toMatchObject({
      type: "text_delta",
      text: "last durable append",
    });
  });
  test("child forwarding retains origin while the parent commits its own distinct scope", () => {
    const parent = fixture(),
      child = fixture("child-session");
    const origin = child.writer.append({ type: "text_delta", text: "child output" });
    const output: StreamEvent[] = [];
    const wrapped = buildWrappedOnStream({
      getSession: () => parent.session,
      setLatestTodos: () => {},
      userOnStream: (event) => {
        output.push(event);
      },
      outputJournal: { root: parent.root, getRunId: () => parent.runId, onFailure: () => {} },
    });
    wrapped({ type: "text_delta", text: "child output", agentId: "child", outputCursor: origin });
    expect(output[0].outputOriginCursor).toBe(origin);
    expect(output[0].outputCursor).not.toBe(origin);
    expect(readOutputJournal(parent.root, parent.id).through).toBe(output[0].outputCursor);
    expect(readOutputJournal(child.root, child.id).through).toBe(origin);
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
    expect(readOutputJournal(f.root, f.id, { through: second }).status).toBe("incomplete");
    expect(readOutputJournal(f.root, f.id, { through: first.through }).status).toBe("incomplete");
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
    const damaged = readFileSync(f.file);
    const incompleteGroup = readOutputJournal(f.root, f.id);
    expect(incompleteGroup.status).toBe("incomplete");
    expect(incompleteGroup.frames).toEqual([]);
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow(
      "Published output prefix",
    );
    expect(readFileSync(f.file)).toEqual(damaged);
  });
  test("an unpublished partial event repairs only after the complete original evidence is durable", () => {
    const f = fixture();
    const published = f.writer.append({ type: "text_delta", text: "published" });
    const headFile = join(f.root, f.id, "output-journal-head.json");
    const beforeAttempt = readFileSync(headFile);
    const prefix = readFileSync(f.file);
    f.writer.append({ type: "text_delta", text: "汉🙂".repeat(40_000) });
    // Crash while writing fragments, before committing the publish watermark.
    writeFileSync(headFile, beforeAttempt);
    const lines = readFileSync(f.file, "utf8").trimEnd().split("\n");
    writeFileSync(f.file, lines.slice(0, -1).join("\n") + "\n");
    const original = readFileSync(f.file);
    expect(readOutputJournal(f.root, f.id).through).toBe(published);
    expect(readOutputJournal(f.root, f.id).uncommittedTail).toBe(true);
    const restarted = new SessionOutputJournal(f.root, f.id, f.runId);
    expect(readFileSync(f.file)).toEqual(prefix);
    expect(readOutputJournal(f.root, f.id).through).toBe(published);
    const directory = join(f.root, f.id);
    const receiptName = readdirSync(directory).find((name) =>
      /^\.output-repair-.*\.json$/.test(name),
    )!;
    const receipt = JSON.parse(readFileSync(join(directory, receiptName), "utf8"));
    expect(readFileSync(join(directory, receipt.evidence))).toEqual(original);
    expect(receipt.bytes).toBe(original.length);
    expect(receipt.published.offset).toBe(prefix.length);
    restarted.append({ type: "text_delta", text: "resumed" });
    expect(readOutputJournal(f.root, f.id).frames.at(-1)?.event?.type).toBe("text_delta");
  });
  test("lost or malformed published watermarks fail closed and whole-state saves preserve the watermark", () => {
    for (const mode of ["missing", "identity", "hash", "position"] as const) {
      const f = fixture();
      const published = f.writer.append({ type: "text_delta", text: "durable" });
      const persisted = f.manager.readSessionState(f.id)!.outputJournalHead;
      expect(persisted?.version).toBe(2);
      expect(persisted?.sequence).toBe(0); // Immutable admission floor, not a per-frame state rewrite.
      expect(f.manager.saveState(f.session.state)).toBe(true);
      expect(f.manager.readSessionState(f.id)!.outputJournalHead).toEqual(persisted);
      const stateFile = join(f.root, f.id, "state.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      if (mode === "missing") delete state.outputJournalHead;
      else if (mode === "identity") state.outputJournalHead.identity = "a".repeat(64);
      else if (mode === "hash") state.outputJournalHead.hash = "b".repeat(64);
      else state.outputJournalHead.offset = 0;
      writeFileSync(stateFile, JSON.stringify(state));
      const original = readFileSync(f.file);
      expect(readOutputJournal(f.root, f.id).complete).toBe(false);
      expect(readOutputJournal(f.root, f.id, { through: published }).complete).toBe(false);
      expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow();
      expect(() => f.writer.append({ type: "text_delta", text: "late" })).toThrow();
      expect(readFileSync(f.file)).toEqual(original);
    }
  });
  test("repair receipt failure retains the original source and never truncates unpublished bytes", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "durable" });
    appendFileSync(f.file, "{torn");
    const original = readFileSync(f.file);
    const real = fs.openSync;
    const denied = spyOn(fs, "openSync").mockImplementation(((path: any, ...args: any[]) => {
      if (/\.output-repair-.*\.json$/.test(String(path)))
        throw Object.assign(new Error("repair receipt denied"), { code: "EACCES" });
      return (real as any)(path, ...args);
    }) as any);
    try {
      expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow("receipt denied");
      expect(readFileSync(f.file)).toEqual(original);
    } finally {
      denied.mockRestore();
    }
  });
  test("a lost, replaced, truncated or damaged head never falls back to the admission floor", () => {
    for (const mode of ["missing", "replaced", "truncated", "checksum", "symlink"] as const) {
      const f = fixture();
      const published = f.writer.append({ type: "text_delta", text: "durable" });
      const headFile = join(f.root, f.id, "output-journal-head.json");
      const block = readFileSync(headFile);
      if (mode === "missing") rmSync(headFile);
      else if (mode === "replaced" || mode === "symlink") {
        renameSync(headFile, headFile + ".old");
        if (mode === "replaced") writeFileSync(headFile, block);
        else fs.symlinkSync(headFile + ".old", headFile);
      } else if (mode === "truncated") truncateSync(headFile, 100);
      else {
        block[30] = block[30] === 0x61 ? 0x62 : 0x61;
        writeFileSync(headFile, block);
      }
      const original = readFileSync(f.file);
      expect(readOutputJournal(f.root, f.id).complete).toBe(false);
      expect(readOutputJournal(f.root, f.id, { through: published }).complete).toBe(false);
      expect(() => f.writer.append({ type: "text_delta", text: "late" })).toThrow();
      expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow();
      expect(readFileSync(f.file)).toEqual(original);
    }
  });
  test("a torn head update retains the journal and blocks recovery instead of publishing", () => {
    const f = fixture();
    const published = f.writer.append({ type: "text_delta", text: "durable" });
    const head = statSync(join(f.root, f.id, "output-journal-head.json"));
    const real = fs.writeSync;
    let attempted = false;
    const torn = spyOn(fs, "writeSync").mockImplementation(((fd: number, ...args: any[]) => {
      const at = fs.fstatSync(fd);
      if (at.dev === head.dev && at.ino === head.ino) {
        if (attempted) throw new Error("head write interrupted");
        attempted = true;
        return (real as any)(fd, args[0], args[1], 200, args[3]);
      }
      return (real as any)(fd, ...args);
    }) as any);
    try {
      expect(() => f.writer.append({ type: "text_delta", text: "unpublished" })).toThrow(
        "head write interrupted",
      );
    } finally {
      torn.mockRestore();
    }
    const original = readFileSync(f.file);
    expect(readOutputJournal(f.root, f.id).complete).toBe(false);
    expect(readOutputJournal(f.root, f.id, { through: published }).complete).toBe(false);
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow();
    expect(readFileSync(f.file)).toEqual(original);
  });
  test("watermark commit failure never publishes or adopts a complete uncommitted event", () => {
    const f = fixture();
    const published = f.writer.append({ type: "text_delta", text: "durable" });
    const head = statSync(join(f.root, f.id, "output-journal-head.json"));
    const real = fs.writeSync;
    const denied = spyOn(fs, "writeSync").mockImplementation(((fd: number, ...args: any[]) => {
      const at = fs.fstatSync(fd);
      if (at.dev === head.dev && at.ino === head.ino) throw new Error("watermark commit denied");
      return (real as any)(fd, ...args);
    }) as any);
    try {
      expect(() => f.writer.append({ type: "text_delta", text: "unpublished" })).toThrow(
        "watermark commit denied",
      );
    } finally {
      denied.mockRestore();
    }
    const original = readFileSync(f.file);
    const page = readOutputJournal(f.root, f.id);
    expect(page.through).toBe(published);
    expect(page.frames).toHaveLength(1);
    expect(page.uncommittedTail).toBe(true);
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow("requires repair");
    expect(() => f.writer.append({ type: "text_delta", text: "late" })).toThrow();
    expect(readFileSync(f.file)).toEqual(original);
  });
  test("inline watermarks migrate without changing cursors and frame publication does not replace state", () => {
    const f = fixture();
    const published = f.writer.append({ type: "text_delta", text: "inline format" });
    const directory = join(f.root, f.id);
    const headFile = join(directory, "output-journal-head.json");
    const stateFile = join(directory, "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.outputJournalHead = JSON.parse(readFileSync(headFile, "utf8")).head;
    writeFileSync(stateFile, JSON.stringify(state));
    rmSync(headFile);
    const migrated = new SessionOutputJournal(f.root, f.id, f.runId);
    expect(readOutputJournal(f.root, f.id).through).toBe(published);
    const saved = readFileSync(stateFile);
    const savedIdentity = statSync(stateFile).ino;
    const watermarkIdentity = statSync(headFile).ino;
    migrated.append({ type: "text_delta", text: "same files" });
    expect(readFileSync(stateFile)).toEqual(saved);
    expect(statSync(stateFile).ino).toBe(savedIdentity);
    expect(statSync(headFile).ino).toBe(watermarkIdentity);
    expect(readOutputJournal(f.root, f.id, { after: published }).frames).toHaveLength(1);
  });
  test("a head fsync failure blocks publication and does not silently reuse the old watermark", () => {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "durable" });
    const head = statSync(join(f.root, f.id, "output-journal-head.json"));
    const real = fs.fsyncSync;
    let failed = false;
    const denied = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const at = fs.fstatSync(fd);
      if (!failed && at.dev === head.dev && at.ino === head.ino) {
        failed = true;
        throw new Error("head fsync denied");
      }
      return real(fd);
    });
    try {
      expect(() => f.writer.append({ type: "text_delta", text: "unpublished" })).toThrow(
        "head fsync denied",
      );
    } finally {
      denied.mockRestore();
    }
    const original = readFileSync(f.file);
    expect(readOutputJournal(f.root, f.id).complete).toBe(false);
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow();
    expect(readFileSync(f.file)).toEqual(original);
  });
  test("complete historical v1 data keeps its cursor during watermark migration; unknown old tails stay intact", () => {
    for (const torn of [false, true]) {
      const f = fixture();
      f.writer.append({ type: "text_delta", text: "historical" });
      const stored = readFileSync(f.file, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      delete stored[0].durableHead;
      const header = JSON.stringify(stored[0]) + "\n";
      const pin = createHash("sha256").update(header).digest("hex");
      const record = stored[1];
      delete record.version;
      record.runId = record.run.id;
      delete record.run;
      record.previousHash = pin;
      delete record.hash;
      record.hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
      writeFileSync(f.file, header + JSON.stringify(record) + "\n" + (torn ? "{old-torn" : ""));
      const stateFile = join(f.root, f.id, "state.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      state.outputJournalIdentity = pin;
      delete state.outputJournalHead;
      writeFileSync(stateFile, JSON.stringify(state));
      rmSync(join(f.root, f.id, "output-journal-head.json"));
      const previous = readOutputJournal(f.root, f.id);
      expect(previous.status).toBe("ok");
      expect(previous.frames[0].runId).toBe(f.runId);
      const original = readFileSync(f.file);
      if (torn) {
        expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow(
          "no published watermark",
        );
        expect(readFileSync(f.file)).toEqual(original);
      } else {
        const migrated = new SessionOutputJournal(f.root, f.id, f.runId);
        expect(readOutputJournal(f.root, f.id).through).toBe(previous.through);
        migrated.append({ type: "text_delta", text: "current" });
        const page = readOutputJournal(f.root, f.id, { after: previous.through });
        expect(page.status).toBe("ok");
        expect(page.frames).toHaveLength(1);
        expect(page.frames[0].runId).toBe(f.runId);
      }
    }
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
  test("whole-event rotation keeps previously published and frozen cursors in the same domain", () => {
    const f = fixture();
    const huge = { type: "text_delta" as const, text: "x".repeat(15 * 1024 * 1024) };
    const originalInode = statSync(f.file).ino;
    const first = f.writer.append(huge);
    for (let index = 0; index < 6; index++) f.writer.append(huge);
    expect(statSync(f.file).ino).toBe(originalInode);
    expect(statSync(f.file).size).toBeLessThan(16 * 1024 * 1024);
    const frozen = readOutputJournal(f.root, f.id, { after: first, through: first });
    expect(frozen.status).toBe("ok");
    expect(frozen.complete).toBe(true);
    expect(frozen.through).toBe(first);
    const restarted = new SessionOutputJournal(f.root, f.id, f.runId);
    const latest = restarted.append({ type: "text_delta", text: "after rotation" });
    expect(readOutputJournal(f.root, f.id, { after: latest, through: latest }).complete).toBe(true);
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

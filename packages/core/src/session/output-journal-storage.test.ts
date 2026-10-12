import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "./session-manager.js";
import { readOutputJournal, SessionOutputJournal } from "./output-journal.js";
import { SegmentedOutputFile } from "./output-journal-storage.js";
import {
  readOutputJournal as oldRead,
  SessionOutputJournal as OldWriter,
} from "../../../../tests/fixtures/output-journal-0.9.34.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "codeshell-storage-test-"));
  directories.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "storage-session");
  const runId = session.transcript.appendMessage("user", "fixture").id;
  manager.startSessionRun(session.state, runId);
  const directory = join(root, session.state.sessionId);
  const file = join(directory, "output-journal.jsonl");
  const writer = new SessionOutputJournal(root, session.state.sessionId, runId);
  return { root, manager, session, runId, directory, file, writer, id: session.state.sessionId };
}
const huge = { type: "text_delta" as const, text: "x".repeat(15 * 1024 * 1024) };
function manifest(f: ReturnType<typeof fixture>) {
  return JSON.parse(fs.readFileSync(join(f.directory, "output-journal-segments.json"), "utf8"))
    .manifest;
}
function assertOldRejected(f: ReturnType<typeof fixture>) {
  const before = fs.readFileSync(f.file);
  expect(oldRead(f.root, f.id).complete).toBe(false);
  expect(() => new OldWriter(f.root, f.id, f.runId)).toThrow();
  expect(fs.readFileSync(f.file)).toEqual(before);
}

test("the compatibility fixture is the exact historical git blob except relocated imports", () => {
  const source = fs
    .readFileSync(
      join(import.meta.dir, "../../../../tests/fixtures/output-journal-0.9.34.ts"),
      "utf8",
    )
    .replaceAll('"../../packages/core/src/types.js"', '"../types.js"')
    .replaceAll('"../../packages/core/src/utils/lockfile.js"', '"../utils/lockfile.js"')
    .replaceAll(
      '"../../packages/core/src/session/output-coverage-state.js"',
      '"./output-coverage-state.js"',
    );
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
  ).toBe("4e5b336b9efca1fe890e41b286fa03eb28372537");
});
test("the actual historical reader and writer reject a migrated header-only anchor and leave its bytes intact", () => {
  const f = fixture();
  expect(oldRead(f.root, f.id).status).toBe("ok");
  const inode = fs.statSync(f.file).ino;
  const first = f.writer.append(huge);
  assertOldRejected(f);
  expect(readOutputJournal(f.root, f.id, { after: first, through: first }).complete).toBe(true);
  expect(fs.statSync(f.file).ino).toBe(inode);
  expect(fs.readFileSync(f.file, "utf8").split("\n")[1]).toContain("codeshell-output-segments");
});
test("retention expires old frozen ranges explicitly, preserves the original inode and resumes retained cursors", () => {
  const f = fixture();
  const inode = fs.statSync(f.file).ino;
  const cursors: string[] = [];
  for (let index = 0; index < 18; index++) cursors.push(f.writer.append(huge));
  const stored = manifest(f);
  expect(stored.segments.length).toBeLessThanOrEqual(16);
  expect(stored.anchor.retained).toBe(false);
  expect(stored.floor.sequence).toBeGreaterThan(0);
  expect(fs.statSync(f.file).ino).toBe(inode);
  expect(fs.readFileSync(f.file, "utf8").split("\n")[1]).toContain("codeshell-output-segments");
  assertOldRejected(f);
  for (const options of [undefined, { after: cursors[0], through: cursors[1] }]) {
    const expired = readOutputJournal(f.root, f.id, options);
    expect(expired.status).toBe("incomplete");
    expect(expired.reason).toBe("retention_expired");
    expect(expired.complete).toBe(false);
    expect(expired.frames).toEqual([]);
  }
  const retained = cursors.at(-2)!;
  const page = readOutputJournal(f.root, f.id, { after: retained, through: retained });
  expect(page.status).toBe("ok");
  expect(page.complete).toBe(true);
  const restarted = new SessionOutputJournal(f.root, f.id, f.runId);
  const latest = restarted.append({ type: "text_delta", text: "retained restart" });
  expect(readOutputJournal(f.root, f.id, { after: latest, through: latest }).complete).toBe(true);
  const files = fs
    .readdirSync(f.directory)
    .filter(
      (name) =>
        name === "output-journal.jsonl" ||
        name === "output-journal-head.json" ||
        name === "output-journal-segments.json" ||
        name.startsWith("output-segment-"),
    );
  expect(
    files.reduce((sum, name) => sum + fs.statSync(join(f.directory, name)).size, 0),
  ).toBeLessThan(256 * 1024 * 1024);
});
test("lost, replaced and corrupted storage manifests or segments never become complete recovery", () => {
  for (const mode of ["pin", "manifest", "segment", "replace", "symlink"] as const) {
    const f = fixture();
    const published = f.writer.append(huge);
    const stored = manifest(f);
    const target = join(
      f.directory,
      mode === "manifest" ? "output-journal-segments.json" : stored.segments[0].name,
    );
    if (mode === "pin") {
      const path = join(f.directory, "state.json");
      const state = JSON.parse(fs.readFileSync(path, "utf8"));
      delete state.outputJournalStorage;
      fs.writeFileSync(path, JSON.stringify(state));
    } else if (mode === "replace" || mode === "symlink") {
      fs.renameSync(target, target + ".old");
      if (mode === "replace") fs.copyFileSync(target + ".old", target);
      else fs.symlinkSync(target + ".old", target);
    } else {
      const fd = fs.openSync(target, "r+");
      try {
        fs.writeSync(fd, Buffer.from("!"), 0, 1, 0);
      } finally {
        fs.closeSync(fd);
      }
    }
    const original = fs.readFileSync(f.file);
    expect(readOutputJournal(f.root, f.id, { after: published, through: published }).complete).toBe(
      false,
    );
    expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow();
    expect(() => f.writer.append({ type: "text_delta", text: "late" })).toThrow();
    expect(fs.readFileSync(f.file)).toEqual(original);
  }
});
test("failure after the durable format barrier keeps real historical algorithms fenced", () => {
  const f = fixture();
  const real = fs.renameSync;
  const denied = spyOn(fs, "renameSync").mockImplementation(((from: any, to: any) => {
    if (String(to).endsWith("state.json")) throw new Error("storage admission denied");
    return real(from, to);
  }) as any);
  try {
    expect(() => f.writer.append(huge)).toThrow("storage admission denied");
  } finally {
    denied.mockRestore();
  }
  assertOldRejected(f);
  const frozen = readOutputJournal(f.root, f.id);
  expect(frozen.status).toBe("ok");
  expect(frozen.frames).toEqual([]); // Only the independently proved pre-migration prefix.
  expect(frozen.complete).toBe(true);
  expect(() => new SessionOutputJournal(f.root, f.id, f.runId)).toThrow();
});
test("every first-migration flush failure preserves rejecting bytes or an unchanged unpublished prefix", () => {
  for (let step = 1; step <= 9; step++) {
    const f = fixture();
    const original = fs.readFileSync(f.file);
    const real = fs.fsyncSync;
    let calls = 0;
    const denied = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === step) throw new Error(`migration flush ${step}`);
      return real(fd);
    });
    try {
      expect(() => f.writer.append(huge)).toThrow(`migration flush ${step}`);
    } finally {
      denied.mockRestore();
    }
    const anchor = fs.readFileSync(f.file);
    if (anchor.includes(Buffer.from("codeshell-output-segments"))) assertOldRejected(f);
    else expect(anchor).toEqual(original);
    const page = readOutputJournal(f.root, f.id);
    expect(page.frames).toEqual([]); // No attempt returned a publishable cursor.
    if (page.status !== "ok") expect(page.complete).toBe(false);
  }
});
test("retention faults never expose a header-only anchor and preserve retained cursor recovery", () => {
  for (let step = 1; step <= 6; step++) {
    const f = fixture();
    f.writer.append({ type: "text_delta", text: "retired anchor content" });
    let retained = "";
    for (let index = 0; index < 12; index++) retained = f.writer.append(huge);
    const inode = fs.statSync(f.file).ino;
    const realSync = fs.fsyncSync;
    const realTruncate = fs.ftruncateSync;
    let calls = 0;
    const denied = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === step) throw new Error(`retention flush ${step}`);
      return realSync(fd);
    });
    const checkedTruncate = spyOn(fs, "ftruncateSync").mockImplementation((fd, length) => {
      expect(fs.readFileSync(f.file, "utf8").split("\n")[1]).toContain("codeshell-output-segments");
      return realTruncate(fd, length);
    });
    try {
      expect(() => f.writer.append(huge)).toThrow(`retention flush ${step}`);
    } finally {
      denied.mockRestore();
      checkedTruncate.mockRestore();
    }
    expect(fs.statSync(f.file).ino).toBe(inode);
    assertOldRejected(f);
    const page = readOutputJournal(f.root, f.id, { after: retained, through: retained });
    expect(page.status).toBe("ok");
    expect(page.complete).toBe(true);
    expect(page.through).toBe(retained);
    const restarted = new SessionOutputJournal(f.root, f.id, f.runId);
    const latest = restarted.append({ type: "text_delta", text: "fault recovery" });
    expect(readOutputJournal(f.root, f.id, { after: latest, through: latest }).complete).toBe(true);
  }
});
test("retention truncate failure keeps a durable rejecting marker and a valid retained prefix", () => {
  const f = fixture();
  f.writer.append({ type: "text_delta", text: "retired anchor content" });
  let retained = "";
  for (let index = 0; index < 12; index++) retained = f.writer.append(huge);
  const denied = spyOn(fs, "ftruncateSync").mockImplementation(() => {
    throw new Error("retention truncate denied");
  });
  try {
    expect(() => f.writer.append(huge)).toThrow("retention truncate denied");
  } finally {
    denied.mockRestore();
  }
  expect(fs.readFileSync(f.file, "utf8").split("\n")[1]).toContain("codeshell-output-segments");
  assertOldRejected(f);
  expect(readOutputJournal(f.root, f.id, { after: retained, through: retained }).complete).toBe(
    true,
  );
});

test("active segment growth after opening a view preserves an older frozen prefix", () => {
  const f = fixture();
  f.writer.append(huge);
  const frozen = f.writer.append({ type: "text_delta", text: "frozen boundary" });
  const original = SegmentedOutputFile.prototype.currentSize;
  let appended = false;
  let latest = "";
  // The reader has opened the manifest/segment descriptors, but has not yet
  // captured its scan size. Perform a real durable append at that exact cut.
  const hook = spyOn(SegmentedOutputFile.prototype, "currentSize").mockImplementation(function () {
    if (!appended) {
      appended = true;
      latest = f.writer.append({ type: "text_delta", text: "independent late append" });
    }
    return original.call(this);
  });
  try {
    const page = readOutputJournal(f.root, f.id, { after: frozen, through: frozen });
    expect(appended).toBe(true);
    expect(page.status).toBe("ok");
    expect(page.complete).toBe(true);
    expect(page.next).toBe(frozen);
    expect(page.through).toBe(frozen);
  } finally {
    hook.mockRestore();
  }
  const current = readOutputJournal(f.root, f.id, { after: frozen });
  expect(current.status).toBe("ok");
  expect(current.through).toBe(latest);
  expect(current.frames.map((frame) => frame.event)).toEqual([
    { type: "text_delta", text: "independent late append" },
  ]);
});

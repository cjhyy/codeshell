import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { join, win32, posix } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const denied = () => {
  throw new Error("Output repair fixture forbids network");
};
const network = [
  [globalThis, "fetch"],
  [http, "get"],
  [http, "request"],
  [https, "get"],
  [https, "request"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
  [tls, "connect"],
] as const;
const originals = network.map(([target, key]) => ({
  target: target as any,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
for (const { target, key } of originals) target[key] = denied;
syncBuiltinESMExports();
afterAll(() => {
  for (const { target, key, descriptor } of originals) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  syncBuiltinESMExports();
});
const { SessionManager } = await import("../packages/core/src/session/session-manager.js");
const { SessionOutputJournal, readOutputJournal } =
  await import("../packages/core/src/session/output-journal.js");
const { readOutputJournal: oldRead, SessionOutputJournal: OldWriter } =
  await import("./fixtures/output-journal-0.9.34.js");
const {
  backupOutputJournal,
  restoreOutputJournalBackup,
  inspectOutputJournalRepair,
  outputRepairPathsOverlap,
} = await import("../packages/core/src/session/output-journal-manual-repair.js");
const { initializeOutputStorage, rotateOutputStorage, SegmentedOutputFile } =
  await import("../packages/core/src/session/output-journal-storage.js");
const { readPublishedOutputHead } =
  await import("../packages/core/src/session/output-journal-head.js");
const { lockSync } = await import("../packages/core/src/utils/lockfile.js");
const { applyOutputJournalPage } = await import("../packages/web/src/lib/outputJournalRecovery.js");
const { OUTPUT_REPAIR_PENDING, OUTPUT_BACKUP_MANIFEST } =
  await import("../packages/core/src/session/output-journal-backup-format.js");

const roots: string[] = [];
const cutCounts: Record<string, number> = {};
afterAll(() => console.log(JSON.stringify({ realRepairCutCounts: cutCounts })));
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function fixture() {
  const parent = fs.mkdtempSync(join(tmpdir(), "codeshell-manual-repair-"));
  roots.push(parent);
  const root = join(parent, "sessions");
  fs.mkdirSync(root, { mode: 0o700 });
  const manager = new SessionManager(root),
    session = manager.create(root, "fixture", "fixture", "repair-session");
  manager.startSessionRun(session.state, "fixture-run");
  const writer = new SessionOutputJournal(root, session.state.sessionId, "fixture-run");
  const first = writer.append({ type: "text_delta", text: "first published body" });
  const large = "汉🙂".repeat(50000);
  const through = writer.append({ type: "text_delta", text: large });
  const directory = join(root, session.state.sessionId),
    file = join(directory, "output-journal.jsonl"),
    statePath = join(directory, "state.json");
  return {
    parent,
    root,
    manager,
    session,
    writer,
    id: session.state.sessionId,
    directory,
    file,
    statePath,
    backup: join(parent, "backup"),
    first,
    through,
    large,
  };
}
function state(f: ReturnType<typeof fixture>) {
  return JSON.parse(fs.readFileSync(f.statePath, "utf8"));
}
function manifest(f: ReturnType<typeof fixture>) {
  return JSON.parse(fs.readFileSync(join(f.directory, "output-journal-segments.json"), "utf8"))
    .manifest;
}
function corrupt(path: string): Buffer {
  const bytes = fs.readFileSync(path);
  if (bytes.length) {
    const changed = Buffer.from(bytes);
    changed[Math.floor(changed.length / 2)] ^= 1;
    fs.writeFileSync(path, changed);
  } else fs.writeFileSync(path, "corrupt\n");
  return fs.readFileSync(path);
}
function segment(f: ReturnType<typeof fixture>, retire = false): void {
  const release = lockSync(f.statePath, { realpath: false, retries: 0 });
  const fd = fs.openSync(f.file, "r+");
  try {
    const current = state(f),
      head = readPublishedOutputHead(f.directory, current.outputJournalHead);
    const bytes = fs.readFileSync(f.file),
      end = bytes.indexOf(10) + 1;
    const start = { sequence: 0, offset: end, hash: current.outputJournalIdentity };
    if (!current.outputJournalStorage)
      initializeOutputStorage(
        fd,
        f.directory,
        head.identity,
        start,
        head,
        {
          sequence: current.outputJournalHead.sequence,
          offset: current.outputJournalHead.offset,
          hash: current.outputJournalHead.hash,
        },
        (pin) =>
          fs.writeFileSync(
            f.statePath,
            JSON.stringify({ ...current, outputJournalStorage: pin }) + "\n",
            { mode: 0o600, flush: true },
          ),
      );
    else if (retire) {
      const view = new SegmentedOutputFile(
        fd,
        f.directory,
        f.file,
        end,
        current.outputJournalStorage,
        head.identity,
      );
      try {
        rotateOutputStorage(view, f.directory, end, head, 16 * 1024 * 1024);
      } finally {
        view.close();
      }
    }
  } finally {
    fs.closeSync(fd);
    release();
  }
}
function fold(f: ReturnType<typeof fixture>, after?: string): any[] {
  const recovery: any = { incomplete: false, ...(after ? { cursor: after } : {}) },
    events: any[] = [];
  let page = readOutputJournal(f.root, f.id, { after, maxFrames: 2 });
  for (;;) {
    applyOutputJournalPage(recovery, page, (event) => events.push(event));
    expect(recovery.incomplete).toBe(false);
    if (page.complete) break;
    page = readOutputJournal(f.root, f.id, {
      after: recovery.cursor,
      through: recovery.through,
      maxFrames: 2,
    });
  }
  return events;
}

test("backup path containment rejects parent/child directories with POSIX and Windows semantics", () => {
  for (const flavor of [posix, win32]) {
    const base = flavor === win32 ? "C:\\sessions\\one" : "/sessions/one";
    expect(outputRepairPathsOverlap(base, base, flavor)).toBe(true);
    expect(outputRepairPathsOverlap(base, flavor.join(base, "backup"), flavor)).toBe(true);
    expect(outputRepairPathsOverlap(base, flavor.dirname(base), flavor)).toBe(true);
    expect(outputRepairPathsOverlap(base, base + "-other", flavor)).toBe(false);
    expect(
      outputRepairPathsOverlap(base, flavor.join(flavor.dirname(base), "backup"), flavor),
    ).toBe(false);
  }
  expect(outputRepairPathsOverlap("C:\\sessions\\one", "D:\\backup", win32)).toBe(false);
  expect(outputRepairPathsOverlap("C:\\sessions\\one", "c:\\SESSIONS\\ONE\\backup", win32)).toBe(
    true,
  );
  const f = fixture();
  expect(() => backupOutputJournal(f.root, f.id, join(f.directory, "backup"))).toThrow("separate");
  expect(fs.existsSync(join(f.directory, "backup"))).toBe(false);
});

test("explicit full backup repairs damaged bytes on the same anchor inode and the actual Web consumer preserves old cursors", () => {
  const f = fixture(),
    inode = fs.statSync(f.file).ino,
    original = fs.readFileSync(f.file);
  const snapshot = backupOutputJournal(f.root, f.id, f.backup);
  expect(snapshot.through).toBe(f.through);
  const damaged = corrupt(f.file);
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
  const repaired = restoreOutputJournalBackup(f.root, f.id, f.backup);
  expect(repaired.coverage).toBe("ok");
  expect(fs.statSync(f.file).ino).toBe(inode);
  expect(fs.readFileSync(f.file)).toEqual(original);
  expect(readOutputJournal(f.root, f.id, { after: f.first, through: f.through }).through).toBe(
    f.through,
  );
  const receipt = JSON.parse(
    fs.readFileSync(join(repaired.evidenceDirectory, "receipt.json"), "utf8"),
  ).value;
  const source = receipt.files.find((x: any) => x.name === "output-journal.jsonl");
  expect(source.sha256).toBe(hash(damaged));
  expect(fs.readFileSync(join(repaired.evidenceDirectory, "source/output-journal.jsonl"))).toEqual(
    damaged,
  );
  const events = fold(f);
  expect(events.map((event) => event.text)).toEqual(["first published body", f.large]);
  const restarted = new SessionOutputJournal(f.root, f.id, "fixture-run");
  const next = restarted.append({ type: "text_delta", text: "after repair" });
  expect(readOutputJournal(f.root, f.id, { after: f.through, through: next }).complete).toBe(true);
});

test("stale head, wrong root, lost head, replaced anchor and unsafe bundle fail before source mutation", () => {
  for (const mode of [
    "stale",
    "root",
    "head",
    "head-corrupt",
    "anchor",
    "manifest-inode",
    "symlink",
    "checksum",
  ] as const) {
    const f = fixture();
    backupOutputJournal(f.root, f.id, f.backup);
    if (mode === "stale") f.writer.append({ type: "text_delta", text: "newer published bytes" });
    if (mode === "root") {
      const copied = join(f.parent, "copied");
      fs.cpSync(f.root, copied, { recursive: true });
      expect(() => restoreOutputJournalBackup(copied, f.id, f.backup)).toThrow();
      continue;
    }
    if (mode === "head") fs.unlinkSync(join(f.directory, "output-journal-head.json"));
    if (mode === "head-corrupt") corrupt(join(f.directory, "output-journal-head.json"));
    if (mode === "manifest-inode") {
      segment(f);
      const path = join(f.directory, "output-journal-segments.json");
      fs.renameSync(path, path + ".old");
      fs.copyFileSync(path + ".old", path);
    }
    if (mode === "anchor") {
      fs.renameSync(f.file, f.file + ".old");
      fs.copyFileSync(f.file + ".old", f.file);
    }
    if (mode === "symlink") {
      const path = join(f.backup, "output-journal.jsonl");
      fs.renameSync(path, path + ".old");
      fs.symlinkSync(path + ".old", path);
    }
    if (mode === "checksum") corrupt(join(f.backup, "output-journal.jsonl"));
    const bytes = fs.readFileSync(f.file);
    expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow();
    expect(fs.readFileSync(f.file)).toEqual(bytes);
    expect(fs.existsSync(join(f.directory, OUTPUT_REPAIR_PENDING))).toBe(false);
  }
});

test("repair never clears sticky output failures or unpaired coverage evidence", () => {
  const f = fixture();
  backupOutputJournal(f.root, f.id, f.backup);
  const before = state(f);
  before.outputRecoveryIncomplete = true;
  before.outputCoverage = { version: 1, unpaired: true, inputIds: ["unpaired-input"] };
  fs.writeFileSync(f.statePath, JSON.stringify(before));
  const saved = fs.readFileSync(f.statePath);
  corrupt(f.file);
  expect(restoreOutputJournalBackup(f.root, f.id, f.backup).coverage).toBe("incomplete");
  expect(fs.readFileSync(f.statePath)).toEqual(saved);
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
  expect(inspectOutputJournalRepair(f.root, f.id).stickyGap).toBe(true);
});

test("segmented corruption and a truly missing retained segment recover with durable physical-pin receipts and unchanged cursors", () => {
  const f = fixture();
  segment(f);
  f.writer.append({ type: "text_delta", text: "retained segment output" });
  const current = manifest(f),
    name = current.segments[0].name,
    old = fs.statSync(join(f.directory, name)).ino;
  const through = readOutputJournal(f.root, f.id).through;
  backupOutputJournal(f.root, f.id, f.backup);
  const anchorInode = fs.statSync(f.file).ino,
    manifestInode = fs.statSync(join(f.directory, "output-journal-segments.json")).ino;
  fs.unlinkSync(join(f.directory, name));
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
  const repaired = restoreOutputJournalBackup(f.root, f.id, f.backup);
  expect(manifest(f).segments[0].ino).not.toBe(old);
  expect(fs.statSync(f.file).ino).toBe(anchorInode);
  expect(fs.statSync(join(f.directory, "output-journal-segments.json")).ino).toBe(manifestInode);
  expect(readOutputJournal(f.root, f.id).through).toBe(through);
  expect(fold(f).at(-1).text).toBe("retained segment output");
  expect(fs.existsSync(join(repaired.evidenceDirectory, `created-${name}.json`))).toBe(true);
  expect(oldRead(f.root, f.id).complete).toBe(false);
  expect(() => new OldWriter(f.root, f.id, "fixture-run")).toThrow();
  const next = new SessionOutputJournal(f.root, f.id, "fixture-run").append({
    type: "text_delta",
    text: "after missing repair",
  });
  expect(readOutputJournal(f.root, f.id, { after: through, through: next }).complete).toBe(true);
});

test("segment replacement and an unproved manifest floor are refused without overwriting the live source", () => {
  for (const mode of ["replace", "manifest"] as const) {
    const f = fixture();
    segment(f);
    f.writer.append({ type: "text_delta", text: "segment" });
    backupOutputJournal(f.root, f.id, f.backup);
    const name = manifest(f).segments[0].name;
    if (mode === "replace") {
      const path = join(f.directory, name);
      fs.renameSync(path, path + ".old");
      fs.copyFileSync(path + ".old", path);
    } else corrupt(join(f.directory, "output-journal-segments.json"));
    const saved = fs.readFileSync(f.file);
    expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow();
    expect(fs.readFileSync(f.file)).toEqual(saved);
    expect(fs.existsSync(join(f.directory, OUTPUT_REPAIR_PENDING))).toBe(false);
  }
});

test("a restored retained range never resurrects expired cursors or moves the retention floor backwards", () => {
  const f = fixture();
  segment(f);
  for (let i = 0; i < 18; i++) {
    f.writer.append({ type: "text_delta", text: `retained-${i}` });
    segment(f, true);
  }
  const saved = manifest(f),
    floor = Buffer.from(
      JSON.stringify({ identity: state(f).outputJournalHead.identity, ...saved.floor }),
    ).toString("base64url");
  expect(saved.floor.sequence).toBeGreaterThan(0);
  expect(readOutputJournal(f.root, f.id, { after: f.first, through: f.first }).reason).toBe(
    "retention_expired",
  );
  backupOutputJournal(f.root, f.id, f.backup);
  const middle = saved.segments[Math.floor(saved.segments.length / 2)].name;
  fs.unlinkSync(join(f.directory, middle));
  restoreOutputJournalBackup(f.root, f.id, f.backup);
  expect(manifest(f).floor).toEqual(saved.floor);
  expect(readOutputJournal(f.root, f.id, { after: f.first, through: f.first }).reason).toBe(
    "retention_expired",
  );
  expect(fold(f, floor).at(-1).text).toBe("retained-17");
});

function faultFixture(segmented = false) {
  const f = fixture();
  if (segmented) {
    segment(f);
    f.writer.append({ type: "text_delta", text: "segment repair fault" });
  }
  backupOutputJournal(f.root, f.id, f.backup);
  if (segmented) fs.unlinkSync(join(f.directory, manifest(f).segments[0].name));
  else corrupt(f.file);
  return f;
}
test("every real repair fsync cut remains proved or incomplete and retries from durable evidence", () => {
  for (const segmented of [false, true]) {
    const counting = faultFixture(segmented);
    let count = 0;
    const real = fs.fsyncSync;
    const counter = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      count++;
      return real(fd);
    });
    try {
      restoreOutputJournalBackup(counting.root, counting.id, counting.backup);
    } finally {
      counter.mockRestore();
    }
    cutCounts[segmented ? "segmented-fsync" : "single-fsync"] = count;
    expect(count).toBeGreaterThan(12);
    for (let step = 1; step <= count; step++) {
      const f = faultFixture(segmented);
      let calls = 0;
      const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (++calls === step) throw new Error(`repair flush ${step}`);
        return real(fd);
      });
      try {
        expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
          `repair flush ${step}`,
        );
      } finally {
        fault.mockRestore();
      }
      const page = readOutputJournal(f.root, f.id);
      if (page.complete) expect(page.status).toBe("ok");
      const result = restoreOutputJournalBackup(f.root, f.id, f.backup);
      expect(result.coverage).toBe("ok");
      expect(readOutputJournal(f.root, f.id).complete).toBe(true);
      expect(fold(f).at(-1).text).toBe(segmented ? "segment repair fault" : f.large);
    }
  }
}, 120000);

test("real header write and pending-marker unlink failures fence new and historical algorithms until retry", () => {
  for (const mode of ["poison", "clear", "unlink"] as const) {
    const f = faultFixture(),
      write = fs.writeSync,
      unlink = fs.unlinkSync;
    let fired = false;
    const fault =
      mode === "unlink"
        ? spyOn(fs, "unlinkSync").mockImplementation(((path: any) => {
            if (String(path).endsWith(OUTPUT_REPAIR_PENDING) && !fired) {
              fired = true;
              throw new Error("marker unlink failure");
            }
            return unlink(path);
          }) as any)
        : spyOn(fs, "writeSync").mockImplementation(((fd: any, data: any, ...args: any[]) => {
            if (
              Buffer.isBuffer(data) &&
              data.length === 1 &&
              ((mode === "poison" && data[0] === 33) || (mode === "clear" && data[0] !== 33)) &&
              !fired
            ) {
              fired = true;
              throw new Error("header write failure");
            }
            return (write as any)(fd, data, ...args);
          }) as any);
    try {
      expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow();
    } finally {
      fault.mockRestore();
    }
    expect(fired).toBe(true);
    const page = readOutputJournal(f.root, f.id);
    expect(page.complete).toBe(false);
    if (mode !== "unlink") {
      expect(oldRead(f.root, f.id).complete).toBe(false);
      expect(() => new OldWriter(f.root, f.id, "fixture-run")).toThrow();
    }
    restoreOutputJournalBackup(f.root, f.id, f.backup);
    expect(fold(f).at(-1).text).toBe(f.large);
  }
});

test("every real write, truncate and exclusive publication cut is resumable without clearing a gap", () => {
  for (const method of ["writeSync", "ftruncateSync", "linkSync", "unlinkSync"] as const) {
    const counting = faultFixture(true);
    const real = fs[method] as (...args: any[]) => any;
    let count = 0;
    const counter = spyOn(fs, method).mockImplementation(((...args: any[]) => {
      count++;
      return real(...args);
    }) as any);
    try {
      restoreOutputJournalBackup(counting.root, counting.id, counting.backup);
    } finally {
      counter.mockRestore();
    }
    cutCounts[method] = count;
    expect(count).toBeGreaterThan(0);
    for (let step = 1; step <= count; step++) {
      const f = faultFixture(true);
      let calls = 0;
      const fault = spyOn(fs, method).mockImplementation(((...args: any[]) => {
        if (++calls === step) throw new Error(`${method} cut ${step}`);
        return real(...args);
      }) as any);
      try {
        expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
          `${method} cut ${step}`,
        );
      } finally {
        fault.mockRestore();
      }
      const page = readOutputJournal(f.root, f.id);
      if (page.complete) expect(fold(f).at(-1).text).toBe("segment repair fault");
      const repaired = restoreOutputJournalBackup(f.root, f.id, f.backup);
      expect(repaired.coverage).toBe("ok");
      expect(fold(f).at(-1).text).toBe("segment repair fault");
    }
  }
}, 120000);

test("torn pending metadata and manifest writes recover only through complete durable receipts", () => {
  for (const mode of ["pending", "manifest"] as const) {
    const f = faultFixture(true),
      write = fs.writeSync;
    let fired = false;
    const fault = spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      data: any,
      ...args: any[]
    ) => {
      const marker = Buffer.isBuffer(data) && data.includes(Buffer.from('"evidence":'));
      if (
        !fired &&
        Buffer.isBuffer(data) &&
        (mode === "pending" ? marker : data.length === 32768)
      ) {
        fired = true;
        (write as any)(fd, data, args[0], Math.min(17, args[1]), args[2]);
        throw new Error("partial metadata write");
      }
      return (write as any)(fd, data, ...args);
    }) as any);
    try {
      expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
        "partial metadata write",
      );
    } finally {
      fault.mockRestore();
    }
    expect(fired).toBe(true);
    expect(readOutputJournal(f.root, f.id).complete).toBe(false);
    if (mode === "manifest") expect(oldRead(f.root, f.id).complete).toBe(false);
    restoreOutputJournalBackup(f.root, f.id, f.backup);
    expect(fold(f).at(-1).text).toBe("segment repair fault");
  }
});

test("a concurrent missing-segment path is refused and preserved, including on retry", () => {
  const f = faultFixture(true),
    name = manifest(f).segments[0].name,
    path = join(fs.realpathSync(f.directory), name),
    link = fs.linkSync;
  let fired = false;
  const fault = spyOn(fs, "linkSync").mockImplementation(((from: any, to: any) => {
    if (String(to) === path && !fired) {
      fired = true;
      fs.writeFileSync(path, "unknown concurrent source", { flag: "wx" });
    }
    return link(from, to);
  }) as any);
  try {
    expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow();
  } finally {
    fault.mockRestore();
  }
  expect(fired).toBe(true);
  expect(fs.readFileSync(path, "utf8")).toBe("unknown concurrent source");
  expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
    "replaced during repair",
  );
  expect(fs.readFileSync(path, "utf8")).toBe("unknown concurrent source");
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
});

test("source changes after complete evidence capture stay refused on retries before the mutation checkpoint", () => {
  const f = faultFixture(),
    link = fs.linkSync;
  let fired = false;
  const changed = Buffer.from("new damaged source outside the captured receipt");
  const fault = spyOn(fs, "linkSync").mockImplementation(((from: any, to: any) => {
    const result = link(from, to);
    if (String(to) === join(fs.realpathSync(f.directory), OUTPUT_REPAIR_PENDING) && !fired) {
      fired = true;
      fs.writeFileSync(f.file, changed);
    }
    return result;
  }) as any);
  try {
    expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
      "changed after evidence",
    );
  } finally {
    fault.mockRestore();
  }
  expect(fired).toBe(true);
  expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
    "changed after evidence",
  );
  expect(fs.readFileSync(f.file)).toEqual(changed);
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
});

test("a segment damaged in place and multiple missing segments restore from one complete bundle", () => {
  const f = fixture();
  segment(f);
  for (let index = 0; index < 3; index++) {
    f.writer.append({ type: "text_delta", text: `multiple-${index}` });
    segment(f, true);
  }
  const saved = manifest(f);
  backupOutputJournal(f.root, f.id, f.backup);
  const same = join(f.directory, saved.segments[0].name),
    inode = fs.statSync(same).ino,
    damaged = corrupt(same);
  for (const item of saved.segments.slice(1, 3)) fs.unlinkSync(join(f.directory, item.name));
  const restored = restoreOutputJournalBackup(f.root, f.id, f.backup);
  expect(fs.statSync(same).ino).toBe(inode);
  expect(
    fs.readFileSync(join(restored.evidenceDirectory, "source", saved.segments[0].name)),
  ).toEqual(damaged);
  expect(fold(f).at(-1).text).toBe("multiple-2");
  expect(backupOutputJournal(f.root, f.id, join(f.parent, "after-repair")).through).toBe(
    restored.through,
  );
});

test("a stale bundle cannot reverse a retention floor even when the published head is unchanged", () => {
  const f = fixture();
  segment(f);
  for (let index = 0; index < 15; index++) {
    f.writer.append({ type: "text_delta", text: `before-floor-${index}` });
    segment(f, true);
  }
  f.writer.append({ type: "text_delta", text: "active segment before a preappend rotation" });
  backupOutputJournal(f.root, f.id, f.backup);
  const before = manifest(f),
    through = readPublishedOutputHead(f.directory, state(f).outputJournalHead);
  segment(f, true);
  expect(readPublishedOutputHead(f.directory, state(f).outputJournalHead)).toEqual(through);
  expect(manifest(f).floor.sequence).toBeGreaterThan(before.floor.sequence);
  const saved = fs.readFileSync(join(f.directory, "output-journal-segments.json"));
  expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
    "differs from the backup",
  );
  expect(fs.readFileSync(join(f.directory, "output-journal-segments.json"))).toEqual(saved);
  expect(fs.existsSync(join(f.directory, OUTPUT_REPAIR_PENDING))).toBe(false);
});

test("a replaced pending marker and a competing state lease both refuse before publication", () => {
  const f = faultFixture(),
    release = lockSync(f.statePath, { realpath: false, retries: 0 });
  try {
    expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow();
  } finally {
    release();
  }
  expect(fs.existsSync(join(f.directory, OUTPUT_REPAIR_PENDING))).toBe(false);
  const write = fs.writeSync;
  let fired = false;
  const fault = spyOn(fs, "writeSync").mockImplementation(((fd: any, data: any, ...args: any[]) => {
    const result = (write as any)(fd, data, ...args);
    if (!fired && Buffer.isBuffer(data) && data.length === 1 && data[0] === 33) {
      fired = true;
      const path = join(f.directory, OUTPUT_REPAIR_PENDING);
      fs.renameSync(path, path + ".original");
      fs.writeFileSync(path, "unknown marker replacement", { flag: "wx" });
    }
    return result;
  }) as any);
  try {
    expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow("replaced");
  } finally {
    fault.mockRestore();
  }
  expect(fired).toBe(true);
  expect(fs.readFileSync(join(f.directory, OUTPUT_REPAIR_PENDING), "utf8")).toBe(
    "unknown marker replacement",
  );
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
  expect(oldRead(f.root, f.id).complete).toBe(false);
  expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow();
});

function historicalFixture() {
  const f = fixture(),
    current = state(f);
  fs.unlinkSync(f.file);
  fs.unlinkSync(join(f.directory, "output-journal-head.json"));
  delete current.outputJournalIdentity;
  delete current.outputJournalHead;
  fs.writeFileSync(f.statePath, JSON.stringify(current));
  const historical = new OldWriter(f.root, f.id, "fixture-run");
  const first = historical.append({ type: "text_delta", text: "historical first" }),
    through = historical.append({ type: "text_delta", text: "historical second" });
  expect(oldRead(f.root, f.id).through).toBe(through);
  // The actual current constructor migrates the head on its original inode
  // without inserting a v2 record or modifying any historical journal byte.
  const before = fs.readFileSync(f.file),
    writer = new SessionOutputJournal(f.root, f.id, "fixture-run");
  expect(fs.readFileSync(f.file)).toEqual(before);
  expect(state(f).outputJournalHead.version).toBe(2);
  expect(readOutputJournal(f.root, f.id).through).toBe(through);
  backupOutputJournal(f.root, f.id, f.backup);
  fs.truncateSync(f.file, JSON.parse(Buffer.from(first, "base64url").toString()).offset);
  expect(readOutputJournal(f.root, f.id).complete).toBe(false);
  expect(oldRead(f.root, f.id).complete).toBe(true); // Pre-existing old-algorithm limitation.
  return { ...f, first, through, writer };
}

test("real historical v1 with an admitted durable head restores its published tail and fences old parsers after poison", () => {
  const counting = historicalFixture();
  let count = 0;
  const real = fs.fsyncSync,
    counter = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      count++;
      return real(fd);
    });
  try {
    restoreOutputJournalBackup(counting.root, counting.id, counting.backup);
  } finally {
    counter.mockRestore();
  }
  cutCounts["historical-v1-fsync"] = count;
  expect(oldRead(counting.root, counting.id).through).toBe(counting.through);
  for (let step = 1; step <= count; step++) {
    const f = historicalFixture(),
      truncated = fs.readFileSync(f.file);
    let calls = 0;
    const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === step) throw new Error(`historical flush ${step}`);
      return real(fd);
    });
    try {
      expect(() => restoreOutputJournalBackup(f.root, f.id, f.backup)).toThrow(
        `historical flush ${step}`,
      );
    } finally {
      fault.mockRestore();
    }
    const bytes = fs.readFileSync(f.file),
      old = oldRead(f.root, f.id);
    if (bytes[0] === 33) {
      expect(old.complete).toBe(false);
      expect(() => new OldWriter(f.root, f.id, "fixture-run")).toThrow();
    } else if (bytes.equals(truncated)) {
      // Evidence must be durable before poisoning. An early refusal leaves the
      // exact source and its pre-existing old-reader limitation untouched.
      expect(old.through).toBe(f.first);
      expect(readOutputJournal(f.root, f.id).complete).toBe(false);
    } else {
      // A clear historical header is allowed only for the fully restored bytes.
      expect(bytes).toEqual(fs.readFileSync(join(f.backup, "output-journal.jsonl")));
      expect(old.through).toBe(f.through);
    }
    const repaired = restoreOutputJournalBackup(f.root, f.id, f.backup);
    expect(repaired.through).toBe(f.through);
    expect(fold(f).map((event) => event.text)).toEqual(["historical first", "historical second"]);
    expect(oldRead(f.root, f.id).through).toBe(f.through);
  }
});

test("real CLI backup, diagnose and restore use only the explicit isolated root", () => {
  const f = fixture(),
    cli = join(import.meta.dir, "../packages/core/src/cli/output-journal-repair.ts");
  const guard = join(f.parent, "deny-network.mjs");
  fs.writeFileSync(
    guard,
    `import http from "node:http"; import https from "node:https"; import net from "node:net"; import tls from "node:tls"; import { syncBuiltinESMExports } from "node:module"; const deny=()=>{throw new Error("CLI fixture denied network")}; globalThis.fetch=deny; http.get=http.request=https.get=https.request=net.connect=net.createConnection=net.Socket.prototype.connect=tls.connect=deny; syncBuiltinESMExports();`,
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--preload", guard, cli, ...args], {
      encoding: "utf8",
      env: process.env,
    });
  const backed = run("backup", f.root, f.id, f.backup);
  expect(backed.status).toBe(0);
  expect(JSON.parse(backed.stdout).through).toBe(f.through);
  corrupt(f.file);
  expect(JSON.parse(run("inspect", f.root, f.id).stdout).status).toBe("incomplete");
  const restored = run("restore", f.root, f.id, f.backup);
  expect(restored.status).toBe(0);
  expect(JSON.parse(restored.stdout).coverage).toBe("ok");
  expect(run("restore", "relative", f.id, f.backup).status).toBe(1);
  expect(fs.existsSync(join(f.backup, OUTPUT_BACKUP_MANIFEST))).toBe(true);
});

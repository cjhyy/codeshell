import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionOutputJournal,
  readOutputJournal,
  readOutputJournalLegacyBase,
} from "./output-journal.js";
import { SessionManager } from "./session-manager.js";
import { buildWrappedOnStream } from "../engine/run-stream.js";
import * as locks from "../utils/lockfile.js";

const roots: string[] = [];
const MiB = 1024 * 1024;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function record(id: string, text = "", type = "message") {
  return JSON.stringify({ id, type, timestamp: 1, data: { text } }) + "\n";
}
function prefix(size: number) {
  const meta = record("meta", "", "session_meta");
  let middle = "";
  while (size - meta.length - middle.length > 900_100)
    middle += record(`middle${middle.length}`, "x".repeat(900_000));
  const tail = record(
    "base",
    "x".repeat(size - meta.length - middle.length - record("base").length),
  );
  return meta + middle + tail;
}
function fixture(data: string | Buffer, baseId = "base", oldHeader = true, fields = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "journal-legacy-base-")));
  roots.push(root);
  const id = "session",
    dir = join(root, id);
  fs.mkdirSync(dir);
  const transcript = join(dir, "transcript.jsonl"),
    journal = join(dir, "output-journal.jsonl");
  fs.writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ sessionId: id, startedAt: 1, runId: "run" }),
  );
  fs.writeFileSync(transcript, data);
  if (oldHeader)
    fs.writeFileSync(
      journal,
      JSON.stringify({
        version: 1,
        storageScope: hash(root),
        sessionIncarnation: "incarnation",
        journalId: "journal",
        sessionId: id,
        startedAt: 1,
        legacyBaseThroughEventId: baseId,
        ...fields,
      }) + "\n",
    );
  return {
    root,
    id,
    dir,
    transcript,
    journal,
    read: (maxBytes?: number) => readOutputJournalLegacyBase(root, id, baseId, { maxBytes }),
  };
}

function duringTranscriptRead<T>(transcript: string, change: () => void, run: () => T) {
  const real = fs.readSync,
    ino = fs.statSync(transcript).ino;
  let changed = false;
  const hook = spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: any[]) => {
    const result = (real as any)(fd, ...args);
    if (!changed && fs.fstatSync(fd).ino === ino) {
      changed = true;
      change();
    }
    return result;
  }) as typeof fs.readSync);
  try {
    return run();
  } finally {
    hook.mockRestore();
    expect(changed).toBe(true);
  }
}

for (const size of [1024, 2_400_000]) {
  for (const sealed of [false, true]) {
    test(`${sealed ? "sealed" : "old"} header tolerates a legal append during a ${size}-byte base read`, () => {
      const data = prefix(size),
        f = fixture(data, "base", !sealed);
      if (sealed) new SessionOutputJournal(f.root, f.id, "run", "base");
      const tail = record("later", "new output");
      const base = duringTranscriptRead(
        f.transcript,
        () => fs.appendFileSync(f.transcript, tail),
        () => f.read(),
      );
      expect(base.complete).toBe(true);
      expect(base.events.at(-1)?.id).toBe("base");
      expect(base.events.some((event) => event.id === "later")).toBe(false);
      expect(fs.readFileSync(f.transcript, "utf8")).toBe(data + tail);
    });
  }
  test(`first capture seals the prefix despite a legal append during its ${size}-byte scan`, () => {
    const data = prefix(size),
      f = fixture(data, "base", false),
      tail = record("later");
    duringTranscriptRead(
      f.transcript,
      () => fs.appendFileSync(f.transcript, tail),
      () => new SessionOutputJournal(f.root, f.id, "run", "base"),
    );
    const header = JSON.parse(fs.readFileSync(f.journal, "utf8").split("\n")[0]);
    expect(header.legacyBaseEndOffset).toBe(size);
    expect(header.legacyBaseSha256).toBe(hash(data));
    expect(f.read().events.at(-1)?.id).toBe("base");
    expect(fs.readFileSync(f.transcript, "utf8")).toBe(data + tail);
  });
}

for (const sealed of [false, true])
  for (const damage of ["truncate", "rewrite", "rewrite-and-append"] as const)
    test(`${sealed ? "sealed" : "old"} header rejects ${damage} of the prefix during its read`, () => {
      const data = prefix(1024),
        f = fixture(data, "base", !sealed);
      if (sealed) new SessionOutputJournal(f.root, f.id, "run", "base");
      const changed = data.replace('"text":"x', '"text":"y');
      const result = duringTranscriptRead(
        f.transcript,
        () => {
          if (damage === "truncate") fs.truncateSync(f.transcript, data.length - 1);
          else
            fs.writeFileSync(
              f.transcript,
              changed + (damage === "rewrite-and-append" ? record("later") : ""),
            );
        },
        () => f.read(),
      );
      expect(result).toEqual({ complete: false, events: [] });
    });

for (const damage of ["truncate", "rewrite", "rewrite-and-append"] as const)
  test(`first capture omits a proof if ${damage} races the prefix scan`, () => {
    const data = prefix(1024),
      f = fixture(data, "base", false);
    const changed = data.replace('"text":"x', '"text":"y');
    duringTranscriptRead(
      f.transcript,
      () => {
        if (damage === "truncate") fs.truncateSync(f.transcript, data.length - 1);
        else
          fs.writeFileSync(
            f.transcript,
            changed + (damage === "rewrite-and-append" ? record("later") : ""),
          );
      },
      () => new SessionOutputJournal(f.root, f.id, "run", "base"),
    );
    const header = JSON.parse(fs.readFileSync(f.journal, "utf8").split("\n")[0]);
    expect(header.legacyBaseEndOffset).toBeUndefined();
    expect(header.legacyBaseSha256).toBeUndefined();
  });

for (const [name, data] of [
  ["the 1,963,815-byte regression", prefix(1_963_815)],
  [
    "more than 4096 small events",
    record("meta", "", "session_meta") +
      Array.from({ length: 5000 }, (_, i) => record(i === 4999 ? "base" : `e${i}`, "中文🙂")).join(
        "",
      ),
  ],
] as const)
  test(`old headers recover ${name}`, () => {
    const f = fixture(data);
    const before = hash(fs.readFileSync(f.transcript));
    expect(f.read().complete).toBe(true);
    expect(f.read().events.at(-1)?.id).toBe("base");
    expect(hash(fs.readFileSync(f.transcript))).toBe(before);
    expect(f.read(MiB).complete).toBe(Buffer.byteLength(data) <= MiB);
  });

test("old base byte boundary is inclusive, independent of page limits", () => {
  for (const size of [MiB - 1, MiB, MiB + 1]) {
    const f = fixture(prefix(size));
    expect(fs.statSync(f.transcript).size).toBe(size);
    expect(f.read().complete).toBe(true);
    expect(f.read(MiB).complete).toBe(size <= MiB);
  }
});

test("first writer seals raw BOM/CRLF bytes and a cold reader ignores a huge later line", () => {
  const data = Buffer.from(
    "\ufeff" +
      (record("meta", "", "session_meta") + record("base", "中🙂".repeat(30000))).replaceAll(
        "\n",
        "\r\n",
      ),
  );
  const f = fixture(data, "base", false);
  new SessionOutputJournal(f.root, f.id, "run", "base");
  const header = JSON.parse(fs.readFileSync(f.journal, "utf8").split("\n")[0]);
  expect(header.legacyBaseEndOffset).toBe(data.length);
  expect(header.legacyBaseSha256).toBe(hash(data));
  fs.appendFileSync(f.transcript, record("later", "z".repeat(2 * MiB)));
  expect(f.read().events.at(-1)?.data.text).toBe("中🙂".repeat(30000));
  expect(f.read().complete).toBe(true);
  const changed = Buffer.from(data);
  changed[changed.indexOf(Buffer.from("中"))] = 0xe5;
  fs.writeFileSync(f.transcript, changed);
  const before = hash(fs.readFileSync(f.transcript));
  expect(f.read()).toEqual({ complete: false, events: [] });
  expect(hash(fs.readFileSync(f.transcript))).toBe(before);
});

test("pinned offsets and hashes never fall back to finding an id", () => {
  const data = record("meta", "", "session_meta") + record("base");
  for (const fields of [
    { legacyBaseEndOffset: data.length - 1, legacyBaseSha256: hash(data) },
    { legacyBaseEndOffset: data.length + 1, legacyBaseSha256: hash(data) },
    { legacyBaseEndOffset: data.length, legacyBaseSha256: "0".repeat(64) },
    {
      legacyBaseEndOffset: record("meta", "", "session_meta").length,
      legacyBaseSha256: hash(record("meta", "", "session_meta")),
    },
  ]) {
    const f = fixture(data, "base", true, fields);
    expect(f.read()).toEqual({ complete: false, events: [] });
  }
});

test("rejects malformed paired header fields even when the header is otherwise readable", () => {
  const data = record("meta", "", "session_meta") + record("base");
  for (const fields of [
    { legacyBaseEndOffset: 10 },
    { legacyBaseSha256: hash(data) },
    ...[0, -1, 1.5, 32 * MiB + 1, Number.MAX_SAFE_INTEGER + 1, "10"].map((legacyBaseEndOffset) => ({
      legacyBaseEndOffset,
      legacyBaseSha256: hash(data),
    })),
    ...["x".repeat(64), "a".repeat(63), 123, null].map((legacyBaseSha256) => ({
      legacyBaseEndOffset: data.length,
      legacyBaseSha256,
    })),
    {
      legacyBaseThroughEventId: undefined,
      legacyBaseEndOffset: data.length,
      legacyBaseSha256: hash(data),
    },
  ]) {
    const f = fixture(data, "base", true, fields);
    expect(f.read()).toEqual({ complete: false, events: [] });
    expect(readOutputJournal(f.root, f.id).complete).toBe(false);
  }
});

test("invalid budgets and untrusted requested ids fail closed", () => {
  const f = fixture(record("meta", "", "session_meta") + record("base"));
  for (const budget of [0, -1, NaN, Infinity, 1.5, 32 * MiB + 1])
    expect(f.read(budget)).toEqual({ complete: false, events: [] });
  expect(readOutputJournalLegacyBase(f.root, f.id, "meta")).toEqual({
    complete: false,
    events: [],
  });
  fs.unlinkSync(f.journal);
  expect(f.read()).toEqual({ complete: false, events: [] });
});

test("damaged, truncated, non-meta, overlong and invalid UTF8 bases preserve all data", () => {
  const meta = record("meta", "", "session_meta");
  for (const data of [
    record("base"),
    meta + "bad json\n" + record("base"),
    meta + '{"type":"message","data":{}}\n' + record("base"),
    meta + record("base").trimEnd(),
    meta + record("base", "x".repeat(MiB)),
    Buffer.concat([Buffer.from(meta), Buffer.from([0xff, 0x0a]), Buffer.from(record("base"))]),
  ]) {
    const f = fixture(data);
    const before = hash(fs.readFileSync(f.transcript));
    expect(f.read()).toEqual({ complete: false, events: [] });
    expect(hash(fs.readFileSync(f.transcript))).toBe(before);
  }
});

test("existing journals do not rescan and failed first capture keeps run admission compatible", () => {
  const f = fixture(record("base"), "base", false);
  new SessionOutputJournal(f.root, f.id, "run", "base");
  const header = JSON.parse(fs.readFileSync(f.journal, "utf8").split("\n")[0]);
  expect(header.legacyBaseThroughEventId).toBe("base");
  expect(header.legacyBaseEndOffset).toBeUndefined();
  const real = fs.openSync;
  const hook = spyOn(fs, "openSync").mockImplementation(((path: any, ...args: any[]) => {
    if (path === f.transcript) throw new Error("must not scan an existing journal");
    return (real as any)(path, ...args);
  }) as typeof fs.openSync);
  try {
    expect(() => new SessionOutputJournal(f.root, f.id, "run", "base")).not.toThrow();
  } finally {
    hook.mockRestore();
  }
});

test("transcript symlinks and path replacement during a read are rejected", () => {
  const data = record("meta", "", "session_meta") + record("base");
  const f = fixture(data);
  const moved = f.transcript + ".old";
  fs.renameSync(f.transcript, moved);
  fs.symlinkSync(moved, f.transcript);
  expect(f.read()).toEqual({ complete: false, events: [] });
  fs.unlinkSync(f.transcript);
  fs.renameSync(moved, f.transcript);
  const real = fs.readSync;
  let replaced = false;
  const hook = spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: any[]) => {
    const result = (real as any)(fd, ...args);
    if (!replaced && fs.fstatSync(fd).ino === fs.statSync(f.transcript).ino) {
      replaced = true;
      fs.renameSync(f.transcript, moved);
      fs.writeFileSync(f.transcript, data);
    }
    return result;
  }) as typeof fs.readSync);
  try {
    expect(f.read()).toEqual({ complete: false, events: [] });
  } finally {
    hook.mockRestore();
  }
});

test("capture runs outside the state lock and discards a replaced transcript before sealing", () => {
  const data = record("meta", "", "session_meta") + record("base");
  const f = fixture(data, "base", false);
  const real = fs.readSync;
  let scanned = false;
  const hook = spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: any[]) => {
    const result = (real as any)(fd, ...args);
    if (!scanned && fs.fstatSync(fd).ino === fs.statSync(f.transcript).ino) {
      scanned = true;
      expect(fs.existsSync(join(f.dir, "state.json.lock"))).toBe(false);
      fs.renameSync(f.transcript, f.transcript + ".old");
      fs.writeFileSync(f.transcript, data);
    }
    return result;
  }) as typeof fs.readSync);
  try {
    new SessionOutputJournal(f.root, f.id, "run", "base");
  } finally {
    hook.mockRestore();
  }
  expect(scanned).toBe(true);
  expect(
    JSON.parse(fs.readFileSync(f.journal, "utf8").split("\n")[0]).legacyBaseEndOffset,
  ).toBeUndefined();
  expect(fs.readFileSync(f.transcript + ".old", "utf8")).toBe(data);
});

test("legacy scanning enforces an independent finite event budget", () => {
  for (const count of [262144, 262145]) {
    const data =
      record("meta", "", "session_meta") + record("e").repeat(count - 2) + record("base");
    const f = fixture(data);
    expect(f.read().complete).toBe(count === 262144);
  }
});

test("the 32 MiB base budget accepts its exact boundary and rejects one byte beyond it", () => {
  for (const size of [32 * MiB, 32 * MiB + 1]) {
    const f = fixture(prefix(size));
    expect(f.read().complete).toBe(size === 32 * MiB);
  }
});

test("the first header rechecks the captured path after taking the lock", () => {
  const data = record("meta", "", "session_meta") + record("base");
  const f = fixture(data, "base", false);
  const real = locks.lockSync;
  const hook = spyOn(locks, "lockSync").mockImplementation((...args) => {
    const unlock = real(...args);
    fs.renameSync(f.transcript, f.transcript + ".old");
    fs.writeFileSync(f.transcript, data);
    return unlock;
  });
  try {
    new SessionOutputJournal(f.root, f.id, "run", "base");
  } finally {
    hook.mockRestore();
  }
  const header = JSON.parse(fs.readFileSync(f.journal, "utf8").split("\n")[0]);
  expect(header.legacyBaseThroughEventId).toBe("base");
  expect(header.legacyBaseEndOffset).toBeUndefined();
  expect(header.legacyBaseSha256).toBeUndefined();
});

test("a replaced Session directory cannot release the base recovery barrier", () => {
  const data = record("meta", "", "session_meta") + record("base");
  const f = fixture(data);
  const real = fs.readSync,
    transcriptIno = fs.statSync(f.transcript).ino;
  let changed = false;
  const hook = spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: any[]) => {
    const result = (real as any)(fd, ...args);
    if (!changed && fs.fstatSync(fd).ino === transcriptIno) {
      changed = true;
      fs.renameSync(f.dir, f.dir + ".old");
      fs.cpSync(f.dir + ".old", f.dir, { recursive: true });
    }
    return result;
  }) as typeof fs.readSync);
  try {
    expect(f.read()).toEqual({ complete: false, events: [] });
  } finally {
    hook.mockRestore();
  }
  expect(changed).toBe(true);
  expect(fs.readFileSync(join(f.dir + ".old", "transcript.jsonl"), "utf8")).toBe(data);
});

test("wrapped Engine publication seals a large pre-run base and cold recovery joins output", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "journal-engine-legacy-")));
  roots.push(root);
  const manager = new SessionManager(root),
    session = manager.create(root, "fixture", "fixture", "session");
  for (let i = 0; i < 3; i++) session.transcript.appendMessage("assistant", "中".repeat(220000));
  const legacyId = session.transcript.getEvents().at(-1)!.id;
  const run = session.transcript.appendMessage("user", "new input");
  manager.startSessionRun(session.state, run.id);
  const wrapped = buildWrappedOnStream({
    getSession: () => session,
    setLatestTodos() {},
    outputJournal: {
      root,
      getRunId: () => run.id,
      onFailure() {
        throw new Error("publication failed");
      },
    },
  });
  wrapped({ type: "text_delta", text: "new reply" });
  wrapped({ type: "turn_complete", reason: "completed" });
  const page = readOutputJournal(root, "session");
  expect(page.legacyBaseThroughEventId).toBe(legacyId);
  const base = readOutputJournalLegacyBase(root, "session", page.legacyBaseThroughEventId);
  expect(base.complete).toBe(true);
  expect(base.events).toHaveLength(4);
  expect(page.frames.map((frame) => frame.event?.type)).toEqual([
    "session_user_message",
    "text_delta",
    "turn_complete",
  ]);
});

for (const sealed of [false, true])
  test(`${sealed ? "sealed" : "old"} complete base exposes its exact raw prefix identity only on success`, () => {
    const data = prefix(3 * MiB),
      f = fixture(data, "base", !sealed);
    if (sealed) new SessionOutputJournal(f.root, f.id, "run", "base");
    const base = f.read();
    expect(base.complete).toBe(true);
    expect((base as any).identity).toEqual({
      endOffset: Buffer.byteLength(data),
      sha256: hash(data),
    });
    fs.appendFileSync(f.transcript, record("later"));
    expect((f.read() as any).identity).toEqual((base as any).identity);
    expect(f.read(MiB)).toEqual({ complete: false, events: [] });
  });

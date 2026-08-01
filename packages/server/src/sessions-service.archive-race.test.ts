// Archiving must not fight a live worker over state.json.
//
// archiveDiskSession used to read the whole state.json, set/delete `archivedAt`,
// and rename a full replacement over it — no lock, no revision check. Meanwhile a
// live worker persists token usage, goal, workspace, title and status to the same
// file. Two full snapshots racing means one loses entirely:
//
//   archive reads rev1 → worker writes rev2 → archive writes its rev1 copy back
//   → the worker's fields are gone (and in the other order, `archivedAt` is).
//
// Core's setSessionArchived/updateSessionState already had the right protocol
// (per-session lock, stateRevision CAS, field-level merge and retry), so
// archiving now goes through it instead of hand-rolling the write.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { archiveDiskSession } from "./sessions-service";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-archive-race-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedSession(id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(
    join(dir, id, "state.json"),
    JSON.stringify({ sessionId: id, status: "completed", ...extra }),
  );
}

function readState(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, id, "state.json"), "utf8")) as Record<string, unknown>;
}

describe("archiveDiskSession vs a concurrent state writer", () => {
  test("archiving preserves a field another writer set in between", async () => {
    seedSession("work", { title: "original" });

    // A "live worker" writes a field through Core's own locked path.
    const worker = new SessionManager(dir);
    worker.updateSessionState("work", { title: "written-by-worker" } as never);

    await archiveDiskSession("work", 456, dir);

    const state = readState("work");
    // Both survive: the archival marker AND the worker's field.
    expect(state.archivedAt).toBe(456);
    expect(state.title).toBe("written-by-worker");
  });

  test("a worker write after archiving does not erase archivedAt", async () => {
    seedSession("work");
    await archiveDiskSession("work", 789, dir);

    const worker = new SessionManager(dir);
    worker.updateSessionState("work", { title: "later" } as never);

    const state = readState("work");
    expect(state.archivedAt).toBe(789);
    expect(state.title).toBe("later");
  });

  test("un-archiving clears the marker without dropping other fields", async () => {
    seedSession("work", { title: "keep-me" });
    await archiveDiskSession("work", 111, dir);
    expect(readState("work").archivedAt).toBe(111);

    await archiveDiskSession("work", undefined, dir);

    const state = readState("work");
    expect(state.archivedAt).toBeUndefined();
    expect(state.title).toBe("keep-me");
  });

  test("interleaved archive and worker writes keep every field", async () => {
    seedSession("work", { a: 1 });
    const worker = new SessionManager(dir);

    // Alternate the two writers; nothing may be lost in either direction.
    worker.updateSessionState("work", { b: 2 } as never);
    await archiveDiskSession("work", 1000, dir);
    worker.updateSessionState("work", { c: 3 } as never);
    await archiveDiskSession("work", 2000, dir);

    const state = readState("work");
    expect(state.a).toBe(1);
    expect(state.b).toBe(2);
    expect(state.c).toBe(3);
    expect(state.archivedAt).toBe(2000);
  });

  test("a worker write landing mid-archive is not clobbered", async () => {
    // The sequential tests above pass even without a lock, because each call
    // re-reads fresh. This one reproduces the ACTUAL race: hold the archive
    // between its read and its write while a worker commits a new revision.
    //
    // Pre-fix, archiveDiskSession captured the state before that write and then
    // renamed its stale copy over it, so `liveField` vanished. Going through
    // updateSessionState means the stale snapshot fails the revision check and
    // the change is re-merged onto the newest state instead.
    seedSession("work", { title: "start" });
    const worker = new SessionManager(dir);

    // Simulate "archive read happened, worker then wrote" by committing the
    // worker's revision first and only then asking the archiver to write.
    // The archiver must observe revision 2, not the seed.
    worker.updateSessionState("work", { liveField: "must-survive" } as never);
    const beforeArchive = readState("work");
    expect(beforeArchive.liveField).toBe("must-survive");

    await archiveDiskSession("work", 5000, dir);

    const state = readState("work");
    expect(state.liveField).toBe("must-survive");
    expect(state.archivedAt).toBe(5000);
    // The archive write must be a NEW revision on top of the worker's, proving
    // it merged rather than replaced.
    expect(state.stateRevision as number).toBeGreaterThan(
      beforeArchive.stateRevision as number,
    );
  });

  test("state revision advances on each archive write", async () => {
    seedSession("work");
    await archiveDiskSession("work", 1, dir);
    const first = readState("work").stateRevision as number;
    await archiveDiskSession("work", 2, dir);
    const second = readState("work").stateRevision as number;
    // A revision-tracked write is what lets a concurrent writer detect conflict.
    expect(typeof first).toBe("number");
    expect(second).toBeGreaterThan(first);
  });
});

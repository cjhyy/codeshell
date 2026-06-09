import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RingFile } from "./ring-file.js";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ringfile-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("RingFile", () => {
  test("writes append within cap, no wraparound", () => {
    const path = join(tmp(), "out.log");
    const rf = new RingFile(path, 1024);
    rf.write(Buffer.from("hello "));
    rf.write(Buffer.from("world"));
    rf.close();
    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(rf.didWrap()).toBe(false);
  });

  test("wraps around the oldest bytes when over cap", () => {
    const path = join(tmp(), "out.log");
    const rf = new RingFile(path, 10); // tiny cap
    rf.write(Buffer.from("0123456789")); // exactly fills
    rf.write(Buffer.from("ABCDE")); // overflows: oldest dropped
    rf.close();
    // Retained = last 10 bytes of the logical stream "0123456789ABCDE"
    expect(readFileSync(path, "utf8")).toBe("56789ABCDE");
    expect(rf.didWrap()).toBe(true);
  });

  test("a single write larger than cap keeps only the tail", () => {
    const path = join(tmp(), "out.log");
    const rf = new RingFile(path, 5);
    rf.write(Buffer.from("ABCDEFGH"));
    rf.close();
    expect(readFileSync(path, "utf8")).toBe("DEFGH");
    expect(rf.didWrap()).toBe(true);
  });

  test("readAll returns retained bytes as string", () => {
    const path = join(tmp(), "out.log");
    const rf = new RingFile(path, 100);
    rf.write(Buffer.from("abc"));
    expect(rf.readAll()).toBe("abc");
    rf.close();
  });

  test("absolute cursor survives wraparound (incremental read never loses data)", () => {
    const path = join(tmp(), "out.log");
    const rf = new RingFile(path, 10);
    rf.write(Buffer.from("0123456789")); // total=10, full
    let cursor = 0;
    expect(rf.sliceFromAbsolute(cursor).toString()).toBe("0123456789");
    cursor = rf.totalWritten();
    expect(cursor).toBe(10);

    rf.write(Buffer.from("ABCDE")); // total=15, window slid to "56789ABCDE"
    // Incremental read from the old cursor must still surface the NEW bytes.
    expect(rf.sliceFromAbsolute(cursor).toString()).toBe("ABCDE");
    cursor = rf.totalWritten();
    expect(cursor).toBe(15);

    // No new data → empty.
    expect(rf.sliceFromAbsolute(cursor).toString()).toBe("");
    rf.close();
  });

  test("absolute cursor older than the retained window clamps to window start", () => {
    const path = join(tmp(), "out.log");
    const rf = new RingFile(path, 5);
    rf.write(Buffer.from("ABCDEFGHIJ")); // total=10, window="FGHIJ"
    // A cursor pointing at byte 0 (long discarded) returns the whole window,
    // not a crash or negative slice.
    expect(rf.sliceFromAbsolute(0).toString()).toBe("FGHIJ");
    rf.close();
  });

  // Recovered orphan shell: a second RingFile opened read-only on an existing
  // .log must surface its captured output WITHOUT truncating the file (#7 — the
  // old reap path opened a fresh empty ring, so an orphan always showed "(无输出)").
  test("readonly mode loads the existing file tail and does not truncate it", () => {
    const path = join(tmp(), "out.log");
    const writer = new RingFile(path, 1024);
    writer.write(Buffer.from("hello from background shell\n"));
    writer.close();

    const ro = new RingFile(path, 1024, true);
    expect(ro.readAll()).toBe("hello from background shell\n");

    // The original file is intact (not truncated by the read-only open).
    const reopen = new RingFile(path, 1024, true);
    expect(reopen.readAll()).toBe("hello from background shell\n");
  });

  test("readonly mode on a missing file yields empty output (no crash)", () => {
    const ro = new RingFile(join(tmp(), "does-not-exist.log"), 1024, true);
    expect(ro.readAll()).toBe("");
  });

  // The read-only open must NOT slurp the whole file when it exceeds the cap —
  // it reads only the trailing capBytes (a multi-MB .log would otherwise block
  // the worker's event loop on startup). The retained tail, didWrap, and the
  // absolute stream length must still match a full read.
  test("readonly mode on an over-cap file keeps only the tail but reports full length", () => {
    const path = join(tmp(), "big.log");
    const writer = new RingFile(path, 1_000_000); // big cap so the file isn't wrapped on write
    writer.write(Buffer.from("0123456789ABCDE")); // 15 bytes on disk
    writer.close();

    const ro = new RingFile(path, 10, true); // tiny read cap → only the last 10 bytes
    expect(ro.readAll()).toBe("56789ABCDE"); // trailing 10 of the 15
    expect(ro.didWrap()).toBe(true); // file bigger than the read cap
    expect(ro.totalWritten()).toBe(15); // logical stream length = full file size
    // Absolute cursor math uses the full length: a cursor at byte 5 maps into
    // the retained window correctly (window starts at abs position 5).
    expect(ro.sliceFromAbsolute(5).toString()).toBe("56789ABCDE");
  });
});

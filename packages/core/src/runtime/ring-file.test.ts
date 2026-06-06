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
});

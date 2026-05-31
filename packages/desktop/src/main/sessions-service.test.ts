import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteSessionDir } from "./sessions-service";

describe("deleteSessionDir", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ss-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("removes a session directory", async () => {
    const sdir = path.join(dir, "sess-1");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "transcript.jsonl"), "x");
    await deleteSessionDir("sess-1", dir);
    expect(fs.existsSync(sdir)).toBe(false);
  });

  it("removes a legacy flat file", async () => {
    fs.writeFileSync(path.join(dir, "sess-2.jsonl"), "x");
    await deleteSessionDir("sess-2", dir);
    expect(fs.existsSync(path.join(dir, "sess-2.jsonl"))).toBe(false);
  });

  it("is a no-op (no throw) when nothing exists", async () => {
    await deleteSessionDir("ghost", dir);
    expect(true).toBe(true);
  });

  it("refuses to delete for an unsafe id (path traversal)", async () => {
    // Create a sibling dir one level above baseDir's child to prove no escape.
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim, { recursive: true });
    await deleteSessionDir("..", dir);          // bare ".." must be rejected
    await deleteSessionDir("../victim", dir);    // slashes + .. rejected
    expect(fs.existsSync(victim)).toBe(true);
  });
});

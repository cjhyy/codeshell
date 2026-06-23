import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "./read.js";
import type { ToolContext } from "../context.js";

let dir: string;
let n = 0;
const ctx = () => ({ cwd: dir }) as unknown as ToolContext;
// Unique path per write so the module-level fileCache never serves a stale hit.
const fresh = (content: string): string => {
  const p = join(dir, `f${n++}.txt`);
  writeFileSync(p, content);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "read-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readTool", () => {
  it("requires file_path", async () => {
    expect(await readTool({}, ctx())).toContain("file_path is required");
  });

  it("errors clearly when the file does not exist", async () => {
    expect(await readTool({ file_path: join(dir, "nope.txt") }, ctx())).toContain(
      "File not found",
    );
  });

  it("returns line-numbered content", async () => {
    const p = fresh("alpha\nbeta\ngamma");
    const out = await readTool({ file_path: p }, ctx());
    expect(out).toContain("1\talpha");
    expect(out).toContain("2\tbeta");
    expect(out).toContain("3\tgamma");
  });

  it("windows with offset + limit and adds a header", async () => {
    const p = fresh(Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const out = await readTool({ file_path: p, offset: 3, limit: 2 }, ctx());
    expect(out).toContain("3\tline3");
    expect(out).toContain("4\tline4");
    expect(out).not.toContain("5\tline5");
    // partial read → metadata header present
    expect(out).toContain("10 lines total, showing 3-4");
  });

  it("clamps a negative limit to a normal read (no all-but-last-N slice)", async () => {
    // A misbehaving caller passing limit:-5 must NOT get lines.slice(0, -5)
    // (= all but the last 5). Limit floors to >=1 → a normal read from offset.
    const p = fresh(Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const out = await readTool({ file_path: p, offset: 1, limit: -5 }, ctx());
    expect(out).toContain("1\tline1");
    expect(out).toContain("10\tline10"); // last line present, NOT dropped
  });

  it("renders an empty file as a single empty numbered line", async () => {
    // "" splits to [""] → one (empty) line; the tool numbers it "1\t".
    const p = fresh("");
    expect(await readTool({ file_path: p }, ctx())).toBe("1\t");
  });
});

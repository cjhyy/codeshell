import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "./read.js";
import type { ToolContext } from "../context.js";

let dir: string;
let n = 0;
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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
    expect(await readTool({ file_path: join(dir, "nope.txt") }, ctx())).toContain("File not found");
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

  it("returns image metadata and view_image guidance instead of binary text", async () => {
    const p = join(dir, "shot.png");
    writeFileSync(p, Buffer.from(PNG_B64, "base64"));
    const out = await readTool({ file_path: "shot.png" }, ctx());
    expect(out).toContain("Image file");
    expect(out).toContain("Path: shot.png");
    expect(out).toContain("MIME: image/png");
    expect(out).toContain("SHA-256:");
    expect(out).toContain('Use view_image({ path: "shot.png" }) to inspect pixels.');
    expect(out).not.toContain("\u0000");
  });

  it("returns metadata for unknown binary files", async () => {
    const p = join(dir, "blob.bin");
    writeFileSync(p, Buffer.from([0, 1, 2, 3, 4, 5]));
    const out = await readTool({ file_path: p }, ctx());
    expect(out).toContain("Binary file");
    expect(out).toContain("blob.bin");
    expect(out).toContain("Size: 6 bytes");
    expect(out).toContain("SHA-256:");
    expect(out).not.toContain("view_image");
  });

  it("returns metadata for large binary files instead of the large-text error", async () => {
    const p = join(dir, "large.bin");
    writeFileSync(p, Buffer.alloc(6 * 1024 * 1024));
    const out = await readTool({ file_path: p }, ctx());
    expect(out).toContain("Binary file");
    expect(out).toContain("Size: 6291456 bytes");
    expect(out).not.toContain("File is too large");
  });
});

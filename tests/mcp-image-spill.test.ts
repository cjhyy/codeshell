import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spillMcpImage } from "../packages/core/src/tool-system/mcp-manager";

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "mcp-image-spill-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const oneByteB64 = Buffer.alloc(1024, 0x55).toString("base64");

describe("spillMcpImage", () => {
  it("writes the image to disk and returns a path-reference note", async () => {
    const note = await spillMcpImage(
      "playwright",
      "screenshot",
      oneByteB64,
      "image/png",
      { baseDir, now: () => 1700000000000 },
    );
    expect(note).toContain("[mcp-image]");
    expect(note).toContain("server=playwright");
    expect(note).toContain("tool=screenshot");
    expect(note).toContain("saved=");
    // The file actually exists, with the decoded payload.
    const files = await readdir(baseDir);
    expect(files).toHaveLength(1);
    const buf = await readFile(join(baseDir, files[0]!));
    expect(buf.byteLength).toBe(1024);
  });

  it("uses the right extension for the declared mime type", async () => {
    const note = await spillMcpImage("s", "t", oneByteB64, "image/jpeg", {
      baseDir,
    });
    expect(note).toMatch(/\.jpg /);
    const note2 = await spillMcpImage("s", "t", oneByteB64, "image/webp", {
      baseDir,
    });
    expect(note2).toMatch(/\.webp /);
  });

  it("sanitises server / tool names in the on-disk filename", async () => {
    await spillMcpImage(
      "evil/server name",
      "weird tool/x",
      oneByteB64,
      "image/png",
      { baseDir },
    );
    // The filename portion must not contain path separators or spaces
    // — otherwise a malicious MCP server could write outside baseDir.
    const files = await readdir(baseDir);
    expect(files).toHaveLength(1);
    expect(files[0]!).not.toContain("/");
    expect(files[0]!).not.toContain(" ");
  });

  it("skips oversized images with a SKIPPED note (no file written)", async () => {
    // Build a base64 string whose decoded length exceeds the 8 MB cap.
    const big = Buffer.alloc(9 * 1024 * 1024, 0).toString("base64");
    const note = await spillMcpImage("s", "t", big, "image/png", { baseDir });
    expect(note).toContain("SKIPPED");
    expect(note).toContain("size=");
    const files = await readdir(baseDir);
    expect(files).toHaveLength(0);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CloudflaredBinary, cloudflaredDownloadUrl } from "./cloudflared-binary.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "cloudflared-"));
  return dir;
}

describe("cloudflaredDownloadUrl", () => {
  test("arm64 → darwin-arm64 official url", () => {
    const url = cloudflaredDownloadUrl("arm64");
    expect(url).toContain("github.com/cloudflare/cloudflared");
    expect(url).toContain("darwin-arm64");
  });

  test("x64 → darwin-amd64 official url", () => {
    const url = cloudflaredDownloadUrl("x64");
    expect(url).toContain("github.com/cloudflare/cloudflared");
    expect(url).toContain("darwin-amd64");
  });
});

describe("CloudflaredBinary", () => {
  test("binaryPath resolves under baseDir/bin/cloudflared", () => {
    const base = freshDir();
    const bin = new CloudflaredBinary({ baseDir: base });
    expect(bin.binaryPath()).toBe(join(base, "bin", "cloudflared"));
  });

  test("isInstalled false when missing, true when present + executable", async () => {
    const base = freshDir();
    const bin = new CloudflaredBinary({
      baseDir: base,
      arch: "arm64",
      download: async (_url, dest) => {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(base, "bin"), { recursive: true });
        writeFileSync(dest, "#!/bin/sh\necho ok\n");
      },
    });
    expect(bin.isInstalled()).toBe(false);
    await bin.ensureBinary();
    expect(bin.isInstalled()).toBe(true);
  });

  test("ensureBinary does not re-download when already installed", async () => {
    const base = freshDir();
    let downloads = 0;
    const bin = new CloudflaredBinary({
      baseDir: base,
      arch: "arm64",
      download: async (_url, dest) => {
        downloads++;
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(base, "bin"), { recursive: true });
        writeFileSync(dest, "binary-bytes");
      },
    });
    const p1 = await bin.ensureBinary();
    const p2 = await bin.ensureBinary();
    expect(p1).toBe(p2);
    expect(downloads).toBe(1);
  });

  test("successful download lands at final path, chmod executable", async () => {
    const base = freshDir();
    const bin = new CloudflaredBinary({
      baseDir: base,
      arch: "arm64",
      download: async (_url, dest) => {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(base, "bin"), { recursive: true });
        writeFileSync(dest, "binary-bytes");
      },
    });
    const finalPath = await bin.ensureBinary();
    expect(finalPath).toBe(bin.binaryPath());
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath, "utf-8")).toBe("binary-bytes");
    // executable bit set (owner exec)
    const mode = statSync(finalPath).mode;
    expect(mode & 0o100).toBe(0o100);
    // no leftover temp file
    expect(existsSync(`${finalPath}.download`)).toBe(false);
  });

  test("download failure throws and leaves no .download residue", async () => {
    const base = freshDir();
    const bin = new CloudflaredBinary({
      baseDir: base,
      arch: "arm64",
      download: async (_url, dest) => {
        // simulate writing a partial temp file then failing
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(base, "bin"), { recursive: true });
        writeFileSync(dest, "partial");
        throw new Error("network down");
      },
    });
    await expect(bin.ensureBinary()).rejects.toThrow("network down");
    expect(existsSync(`${bin.binaryPath()}.download`)).toBe(false);
    expect(bin.isInstalled()).toBe(false);
  });
});

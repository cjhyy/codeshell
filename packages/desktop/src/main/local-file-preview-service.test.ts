import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileExists, readDirectory, readFile } from "./fs-service.js";
import { localFileExists, readLocalFilePreview } from "./local-file-preview-service.js";

describe("explicit local file preview", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codeshell-local-preview-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("previews an external file without granting its directory as a workspace root", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const path = join(root, "outside.md");
    await writeFile(path, "# 外部文件\n");

    expect(await localFileExists(path)).toBe(true);
    expect(await readLocalFilePreview(path)).toEqual({
      path: await realpath(path),
      text: "# 外部文件\n",
      size: Buffer.byteLength("# 外部文件\n"),
    });
    expect(await fileExists(workspace, path)).toBe(false);
    await expect(readFile(workspace, path)).rejects.toThrow("path escapes workspace root");
    await expect(readDirectory(workspace, root)).rejects.toThrow("path escapes workspace root");
  });

  test("rejects directories, missing files, relative paths, NUL and oversized path values", async () => {
    const invalid = [
      root,
      join(root, "missing.md"),
      "README.md",
      "/tmp/\0file",
      "/".repeat(32_769),
    ];
    for (const path of invalid) {
      expect(await localFileExists(path)).toBe(false);
      await expect(readLocalFilePreview(path)).rejects.toThrow();
    }
    expect(await localFileExists(null)).toBe(false);
    await expect(readLocalFilePreview(null)).rejects.toThrow();
    if (process.platform !== "win32") {
      expect(await localFileExists("/dev/null")).toBe(false);
      await expect(readLocalFilePreview("/dev/null")).rejects.toThrow("regular file");
    }
  });

  test("opens an explicitly named file symlink without widening workspace symlink authority", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const target = join(root, "target.txt");
    const path = join(workspace, "link.txt");
    await writeFile(target, "target");
    await symlink(target, path);

    expect(await localFileExists(path)).toBe(true);
    expect((await readLocalFilePreview(path)).text).toBe("target");
    expect(await fileExists(workspace, path)).toBe(false);
    expect(await readDirectory(workspace, workspace)).toEqual([]);
  });

  test("returns an image data URL only for the explicitly requested image", async () => {
    const path = join(root, "diagram.svg");
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    await writeFile(path, image);
    const preview = await readLocalFilePreview(path);
    expect(preview.imageDataUrl).toBe(
      `data:image/svg+xml;base64,${Buffer.from(image).toString("base64")}`,
    );
    expect(preview.text).toBeNull();
    expect(preview.size).toBe(Buffer.byteLength(image));
  });

  test("keeps text/image byte limits and binary fallback", async () => {
    const text = join(root, "large.txt");
    await writeFile(text, "");
    await truncate(text, 2_000_001);
    expect(await readLocalFilePreview(text)).toMatchObject({ text: null, reason: "too-large" });

    const image = join(root, "large.png");
    await writeFile(image, "");
    await truncate(image, 25 * 1024 * 1024 + 1);
    expect(await readLocalFilePreview(image)).toMatchObject({ text: null, reason: "too-large" });
    expect((await readLocalFilePreview(image)).imageDataUrl).toBeUndefined();

    const binary = join(root, "binary.dat");
    await writeFile(binary, Buffer.from([1, 0, 2]));
    expect(await readLocalFilePreview(binary)).toMatchObject({
      text: null,
      reason: "binary",
      size: 3,
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectReadableImage, readImageDataUrl } from "./image-read-service.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("image-read-service", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  test("reads image files inside the session workspace", async () => {
    const cwd = tempRoot("cs-image-cwd-");
    const file = join(cwd, "shot.png");
    writeFileSync(file, PNG);

    const dataUrl = await readImageDataUrl(file, { cwd });
    expect(dataUrl).toStartWith("data:image/png;base64,");
    expect(await inspectReadableImage(file, { cwd })).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
      size: PNG.byteLength,
    });
  });

  test("rejects absolute image paths outside the workspace", async () => {
    const cwd = tempRoot("cs-image-cwd-");
    const outside = tempRoot("cs-image-out-");
    const file = join(outside, "secret.png");
    writeFileSync(file, PNG);

    expect(await readImageDataUrl(file, { cwd })).toBeNull();
  });

  test("rejects symlink image paths even when the link is under the workspace", async () => {
    const cwd = tempRoot("cs-image-cwd-");
    const outside = tempRoot("cs-image-out-");
    const target = join(outside, "secret.png");
    const link = join(cwd, "link.png");
    writeFileSync(target, PNG);
    symlinkSync(target, link);

    expect(await readImageDataUrl(link, { cwd })).toBeNull();
  });

  test("reads staged attachment images under the owning workspace", async () => {
    const cwd = tempRoot("cs-image-cwd-");
    const dir = join(cwd, ".code-shell", "attachments", "sid");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "shot.png");
    writeFileSync(file, PNG);

    const dataUrl = await readImageDataUrl(file, { cwd, sessionId: "sid" });
    expect(dataUrl).toStartWith("data:image/png;base64,");
  });

  test("rejects legacy calls without workspace context", async () => {
    const cwd = tempRoot("cs-image-cwd-");
    const file = join(cwd, "shot.png");
    writeFileSync(file, PNG);

    expect(await readImageDataUrl(file)).toBeNull();
  });
});

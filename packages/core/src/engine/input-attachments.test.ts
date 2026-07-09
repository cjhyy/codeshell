import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_LIMITS } from "./image-policy.js";
import { buildInputAttachmentContext } from "./input-attachments.js";
import type { InputAttachmentMeta } from "../protocol/types.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("buildInputAttachmentContext", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "input-attachments-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function meta(overrides: Partial<InputAttachmentMeta>): InputAttachmentMeta {
    return {
      id: "att_1",
      sessionId: "sid",
      kind: "image",
      origin: "paste",
      path: ".code-shell/attachments/sid/shot.png",
      absPath: join(cwd, ".code-shell", "attachments", "sid", "shot.png"),
      relPath: ".code-shell/attachments/sid/shot.png",
      mime: "image/png",
      size: 1,
      sha256: "0".repeat(64),
      createdAt: 1,
      ...overrides,
    };
  }

  test("loads image attachments into ParsedImage blocks", async () => {
    const abs = join(cwd, ".code-shell", "attachments", "sid", "shot.png");
    mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
    writeFileSync(abs, Buffer.from(PNG_B64, "base64"));

    const out = await buildInputAttachmentContext([meta({ absPath: abs })], cwd);
    expect(out.errors).toEqual([]);
    expect(out.hasStructuredImageAttachments).toBe(true);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mime).toBe("image/png");
    expect(out.images[0]!.base64).toBe(PNG_B64);
    expect(out.images[0]!.path).toBe(".code-shell/attachments/sid/shot.png");
    expect(out.images[0]!.hash).toStartWith("sha256:");
  });

  test("non-image file attachments produce text metadata only", async () => {
    const abs = join(cwd, "notes.txt");
    writeFileSync(abs, "hello", "utf-8");
    const out = await buildInputAttachmentContext(
      [
        meta({
          id: "file_1",
          kind: "file",
          path: "notes.txt",
          absPath: abs,
          relPath: "notes.txt",
          mime: "text/plain",
          size: 5,
          sha256: "1".repeat(64),
          origin: "mention",
        }),
      ],
      cwd,
    );
    expect(out.errors).toEqual([]);
    expect(out.images).toEqual([]);
    expect(out.text).toContain('<attached-file path="notes.txt">');
    expect(out.text).toContain("mime: text/plain");
    expect(out.text).toContain(`sha256: ${"1".repeat(64)}`);
  });

  test("rejects paths outside cwd without reading them", async () => {
    const outside = mkdtempSync(join(tmpdir(), "input-attachments-outside-"));
    try {
      const secret = join(outside, "secret.png");
      writeFileSync(secret, Buffer.from(PNG_B64, "base64"));
      const out = await buildInputAttachmentContext(
        [meta({ path: secret, absPath: secret, relPath: undefined })],
        cwd,
      );
      expect(out.images).toEqual([]);
      expect(out.errors.join("\n")).toContain("blocked by path policy");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("reports missing paths as errors", async () => {
    const out = await buildInputAttachmentContext(
      [meta({ path: "missing.png", absPath: join(cwd, "missing.png"), relPath: "missing.png" })],
      cwd,
    );
    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("stat failed");
  });

  test("rejects sensitive paths through path-policy before reading image bytes", async () => {
    const abs = join(cwd, ".env");
    writeFileSync(abs, Buffer.from(PNG_B64, "base64"));

    const out = await buildInputAttachmentContext(
      [
        meta({
          path: ".env",
          absPath: abs,
          relPath: ".env",
          mime: "image/png",
        }),
      ],
      cwd,
    );

    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("blocked by path policy");
    expect(out.errors.join("\n")).toContain("sensitive path");
  });

  test("rejects oversized image attachments by stat size before readFile", async () => {
    const abs = join(cwd, ".code-shell", "attachments", "sid", "huge.png");
    mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
    writeFileSync(abs, "");
    truncateSync(abs, IMAGE_LIMITS.maxBytesPerImage + 1);

    const out = await buildInputAttachmentContext([meta({ path: abs, absPath: abs })], cwd);

    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("image attachment size policy failed");
  });

  test("non-vision callers receive image metadata without reading bytes", async () => {
    const abs = join(cwd, ".code-shell", "attachments", "sid", "huge.png");
    mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
    writeFileSync(abs, "");
    truncateSync(abs, IMAGE_LIMITS.maxBytesPerImage + 1);

    const out = await buildInputAttachmentContext([meta({ path: abs, absPath: abs })], cwd, {
      includeImageBytes: false,
    });

    expect(out.errors).toEqual([]);
    expect(out.images).toEqual([]);
    expect(out.hasStructuredImageAttachments).toBe(true);
    expect(out.text).toContain('<attached-file path="');
    expect(out.text).toContain(`size: ${IMAGE_LIMITS.maxBytesPerImage + 1}`);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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

    const out = await buildInputAttachmentContext([meta({ absPath: abs })], cwd, {
      expectedSessionId: "sid",
    });
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
      { expectedSessionId: "sid" },
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
        { expectedSessionId: "sid" },
      );
      expect(out.images).toEqual([]);
      expect(out.errors.join("\n")).toContain("blocked by path policy");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects workspace symlink file attachments whose realpath escapes cwd", async () => {
    const outside = mkdtempSync(join(tmpdir(), "input-attachments-symlink-file-outside-"));
    try {
      const secretContent = "outside attachment payload should stay unread";
      const secret = join(outside, "notes.txt");
      const linkRel = "linked-notes.txt";
      const linkAbs = join(cwd, linkRel);
      writeFileSync(secret, secretContent, "utf-8");
      symlinkSync(secret, linkAbs);

      const out = await buildInputAttachmentContext(
        [
          meta({
            id: "link_file_1",
            kind: "file",
            path: linkRel,
            absPath: linkAbs,
            relPath: linkRel,
            mime: "text/plain",
            size: secretContent.length,
            sha256: "2".repeat(64),
            origin: "mention",
          }),
        ],
        cwd,
        { expectedSessionId: "sid" },
      );

      expect(out.images).toEqual([]);
      expect(out.text).toBe("");
      expect(out.hasStructuredImageAttachments).toBe(false);
      expect(out.errors.join("\n")).toContain("blocked by path policy");
      expect(out.errors.join("\n")).toContain("outside workspace");
      expect(JSON.stringify(out)).not.toContain(secretContent);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("reports missing paths as errors", async () => {
    const out = await buildInputAttachmentContext(
      [meta({ path: "missing.png", absPath: join(cwd, "missing.png"), relPath: "missing.png" })],
      cwd,
      { expectedSessionId: "sid" },
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
      { expectedSessionId: "sid" },
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

    const out = await buildInputAttachmentContext([meta({ path: abs, absPath: abs })], cwd, {
      expectedSessionId: "sid",
    });

    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("image attachment size policy failed");
  });

  test("image bytes disabled still exposes structured-image signal for engine gate", async () => {
    const abs = join(cwd, ".code-shell", "attachments", "sid", "huge.png");
    mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
    writeFileSync(abs, "");
    truncateSync(abs, IMAGE_LIMITS.maxBytesPerImage + 1);

    const out = await buildInputAttachmentContext([meta({ path: abs, absPath: abs })], cwd, {
      includeImageBytes: false,
      expectedSessionId: "sid",
    });

    expect(out.errors).toEqual([]);
    expect(out.images).toEqual([]);
    expect(out.hasStructuredImageAttachments).toBe(true);
    expect(out.text).toContain('<attached-file path="');
    expect(out.text).toContain(`size: ${IMAGE_LIMITS.maxBytesPerImage + 1}`);
  });

  test("rejects cross-session attachment metadata before touching the path", async () => {
    const out = await buildInputAttachmentContext(
      [
        meta({
          sessionId: "other",
          path: "missing.png",
          absPath: join(cwd, "missing.png"),
          relPath: "missing.png",
        }),
      ],
      cwd,
      { expectedSessionId: "sid" },
    );

    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("session mismatch");
    expect(out.errors.join("\n")).not.toContain("stat failed");
  });

  test("rejects staged attachments whose realpath is outside the expected session dir", async () => {
    const otherAbs = join(cwd, ".code-shell", "attachments", "other", "shot.png");
    mkdirSync(join(cwd, ".code-shell", "attachments", "other"), { recursive: true });
    mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
    writeFileSync(otherAbs, Buffer.from(PNG_B64, "base64"));

    const out = await buildInputAttachmentContext(
      [
        meta({
          path: ".code-shell/attachments/other/shot.png",
          absPath: otherAbs,
          relPath: ".code-shell/attachments/other/shot.png",
        }),
      ],
      cwd,
      { expectedSessionId: "sid" },
    );

    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("staged path is outside .code-shell/attachments/sid");
  });

  test("rejects staged symlinks whose realpath escapes the workspace before reading bytes", async () => {
    const outside = mkdtempSync(join(tmpdir(), "input-attachments-symlink-outside-"));
    try {
      const secret = join(outside, "secret.png");
      const linkRel = ".code-shell/attachments/sid/link.png";
      const linkAbs = join(cwd, linkRel);
      mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
      writeFileSync(secret, Buffer.from(PNG_B64, "base64"));
      symlinkSync(secret, linkAbs);

      const out = await buildInputAttachmentContext(
        [
          meta({
            id: "link_1",
            path: linkRel,
            absPath: linkAbs,
            relPath: linkRel,
          }),
        ],
        cwd,
        { expectedSessionId: "sid" },
      );

      expect(out.images).toEqual([]);
      expect(out.text).toBe("");
      expect(out.errors.join("\n")).toContain("blocked by path policy");
      expect(out.errors.join("\n")).toContain("outside workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

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

  test("full access loads outside image attachments through their canonical path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "input-attachments-full-access-"));
    try {
      const image = join(outside, "shot.png");
      const linkRel = "linked-shot.png";
      const linkAbs = join(cwd, linkRel);
      writeFileSync(image, Buffer.from(PNG_B64, "base64"));
      symlinkSync(image, linkAbs);

      const out = await buildInputAttachmentContext(
        [meta({ path: linkRel, absPath: linkAbs, relPath: linkRel })],
        cwd,
        { expectedSessionId: "sid", permissionMode: "bypassPermissions" },
      );

      expect(out.errors).toEqual([]);
      expect(out.images).toHaveLength(1);
      expect(out.images[0]!.base64).toBe(PNG_B64);
      expect(out.images[0]!.path).toBe(linkRel);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("full access lists outside directory children while hiding symlinks escaping that directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "input-attachments-outside-directory-"));
    try {
      const selected = join(outside, "selected");
      mkdirSync(join(selected, "nested"), { recursive: true });
      writeFileSync(join(selected, "notes.txt"), "selected file");
      writeFileSync(join(selected, "nested", "inside.txt"), "nested file");
      const hidden = join(outside, "hidden.txt");
      writeFileSync(hidden, "outside selected directory");
      symlinkSync(hidden, join(selected, "escape.txt"));

      const out = await buildInputAttachmentContext(
        [
          meta({
            kind: "directory",
            path: selected,
            absPath: selected,
            relPath: undefined,
            mime: undefined,
            origin: "mention",
          }),
        ],
        cwd,
        { expectedSessionId: "sid", permissionMode: "bypassPermissions" },
      );

      expect(out.errors).toEqual([]);
      expect(out.images).toEqual([]);
      expect(out.text).toContain('entries="3" truncated="false"');
      expect(out.text).toContain("file notes.txt");
      expect(out.text).toContain("dir nested");
      expect(out.text).toContain("file nested/inside.txt");
      expect(out.text).not.toContain("escape.txt");
      expect(out.text).not.toContain("hidden.txt");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accepts attachments from a declared secondary workspace root", async () => {
    const secondary = mkdtempSync(join(tmpdir(), "input-attachments-secondary-"));
    try {
      const note = join(secondary, "notes.txt");
      writeFileSync(note, "secondary", "utf-8");
      const out = await buildInputAttachmentContext(
        [
          meta({
            id: "secondary-file",
            kind: "file",
            path: note,
            absPath: note,
            relPath: undefined,
            mime: "text/plain",
            size: 9,
            origin: "mention",
          }),
        ],
        cwd,
        { expectedSessionId: "sid", workspaceRoots: [cwd, secondary] },
      );
      expect(out.errors).toEqual([]);
      expect(out.text).toContain(`path="${note}"`);
    } finally {
      rmSync(secondary, { recursive: true, force: true });
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

  test("reports malformed runtime path metadata instead of throwing", async () => {
    const malformed = {
      ...meta({}),
      path: 42,
      absPath: undefined,
      relPath: undefined,
      vision: { include: true, mediaPath: null },
    } as unknown as InputAttachmentMeta;

    const out = await buildInputAttachmentContext([malformed], cwd, {
      expectedSessionId: "sid",
    });

    expect(out.images).toEqual([]);
    expect(out.errors.join("\n")).toContain("has no valid path");
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

  test("full access loads sensitive image attachments", async () => {
    const abs = join(cwd, ".env.png");
    writeFileSync(abs, Buffer.from(PNG_B64, "base64"));

    const out = await buildInputAttachmentContext(
      [meta({ path: ".env.png", absPath: abs, relPath: ".env.png", mime: "image/png" })],
      cwd,
      { expectedSessionId: "sid", permissionMode: "bypassPermissions" },
    );

    expect(out.errors).toEqual([]);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.base64).toBe(PNG_B64);
  });

  test.each(["default", "bypassPermissions"] as const)(
    "rejects oversized image attachments before readFile in %s mode",
    async (permissionMode) => {
      const abs = join(cwd, ".code-shell", "attachments", "sid", "huge.png");
      mkdirSync(join(cwd, ".code-shell", "attachments", "sid"), { recursive: true });
      writeFileSync(abs, "");
      truncateSync(abs, IMAGE_LIMITS.maxBytesPerImage + 1);

      const out = await buildInputAttachmentContext([meta({ path: abs, absPath: abs })], cwd, {
        expectedSessionId: "sid",
        permissionMode,
      });

      expect(out.images).toEqual([]);
      expect(out.errors.join("\n")).toContain("image attachment size policy failed");
    },
  );

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

  test.each(["default", "bypassPermissions"] as const)(
    "rejects cross-session attachment metadata before touching the path in %s mode",
    async (permissionMode) => {
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
        { expectedSessionId: "sid", permissionMode },
      );

      expect(out.images).toEqual([]);
      expect(out.errors.join("\n")).toContain("session mismatch");
      expect(out.errors.join("\n")).not.toContain("stat failed");
    },
  );

  test.each(["default", "bypassPermissions"] as const)(
    "rejects staged attachments outside the expected session dir in %s mode",
    async (permissionMode) => {
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
        { expectedSessionId: "sid", permissionMode },
      );

      expect(out.images).toEqual([]);
      expect(out.errors.join("\n")).toContain("staged path is outside .code-shell/attachments/sid");
    },
  );

  test.each(["default", "bypassPermissions"] as const)(
    "rejects staged symlinks escaping session custody before reading bytes in %s mode",
    async (permissionMode) => {
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
          { expectedSessionId: "sid", permissionMode },
        );

        expect(out.images).toEqual([]);
        expect(out.text).toBe("");
        expect(out.errors.join("\n")).toContain(
          permissionMode === "bypassPermissions"
            ? "staged path is outside .code-shell/attachments/sid"
            : "blocked by path policy",
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

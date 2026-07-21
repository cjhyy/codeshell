import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  DRAFT_ATTACHMENT_TTL_MS,
  MAX_STAGED_IMAGE_BYTES,
  SENT_ATTACHMENT_TTL_MS,
  cleanupAttachments,
  listRecentAttachments,
  markAttachmentsSent,
  stageImageBytes,
  stageImageDataUrl,
  stageFileBytes,
} from "./attachment-service.js";
import { probeImageBytes } from "./image-byte-probe.js";

export const IMAGE_FIXTURES = {
  "image/png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
  "image/jpeg": Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
    "base64",
  ),
  "image/gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  "image/webp": Buffer.from("UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==", "base64"),
} as const;

const PNG_URL = `data:image/png;base64,${IMAGE_FIXTURES["image/png"].toString("base64")}`;

describe("attachment-service", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "cs-attachments-")));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("writes a png data URL under .code-shell/attachments/<sessionId>", async () => {
    const meta = await stageImageDataUrl({
      cwd,
      sessionId: "sid-1",
      name: "截图.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });

    expect(meta.sessionId).toBe("sid-1");
    expect(meta.origin).toBe("paste");
    expect(meta.mime).toBe("image/png");
    expect(meta.size).toBeGreaterThan(0);
    expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.relPath).toStartWith(".code-shell/attachments/sid-1/");
    expect(meta.path).toBe(meta.relPath);
    expect(meta.absPath).toEndWith(meta.relPath!.replace(/\//g, "/"));
    expect(existsSync(meta.absPath)).toBe(true);
    expect(
      relative(cwd, meta.absPath).startsWith(join(".code-shell", "attachments", "sid-1")),
    ).toBe(true);
  });

  test("reuses the same file for the same hash in one session", async () => {
    const first = await stageImageDataUrl({
      cwd,
      sessionId: "sid-1",
      name: "a.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });
    const second = await stageImageDataUrl({
      cwd,
      sessionId: "sid-1",
      name: "b.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "os-drop",
    });

    expect(second.absPath).toBe(first.absPath);
    expect(second.relPath).toBe(first.relPath);
    expect(second.id).not.toBe(first.id);
  });

  test("stages mobile raw bytes and source files through the canonical attachment path", async () => {
    const bytes = Buffer.from(PNG_URL.slice(PNG_URL.indexOf(",") + 1), "base64");
    const spool = join(cwd, "mobile-upload.bin");
    writeFileSync(spool, bytes);
    const fromBytes = await stageImageBytes({
      cwd,
      sessionId: "sid-mobile",
      name: "phone.png",
      mime: "image/png",
      bytes,
      origin: "mobile",
    });
    const fromFile = await stageImageBytes({
      cwd,
      sessionId: "sid-mobile",
      name: "phone-copy.png",
      mime: "image/png",
      sourceFile: spool,
      origin: "mobile",
    });

    expect(fromBytes.origin).toBe("mobile");
    expect(fromFile.absPath).toBe(fromBytes.absPath);
    expect(fromFile.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(fromFile.relPath).toStartWith(".code-shell/attachments/sid-mobile/");
    expect(existsSync(spool)).toBe(true);
  });

  test("stages IM files under the Pet session attachment root", async () => {
    const meta = await stageFileBytes({
      cwd,
      sessionId: "pet-session",
      name: "../../notes.txt",
      mime: "text/plain",
      bytes: Buffer.from("hello"),
      origin: "im-gateway",
    });
    expect(meta).toMatchObject({
      kind: "file",
      origin: "im-gateway",
      mime: "text/plain",
      size: 5,
      originalName: "notes.txt",
    });
    expect(relative(cwd, meta.absPath)).toStartWith(
      join(".code-shell", "attachments", "pet-session"),
    );
    expect(readFileSync(meta.absPath, "utf-8")).toBe("hello");
  });

  test("accepts structurally valid PNG, JPEG, GIF, and WebP bytes", async () => {
    for (const [mime, bytes] of Object.entries(IMAGE_FIXTURES)) {
      const meta = await stageImageBytes({
        cwd,
        sessionId: `valid-${mime.slice(mime.indexOf("/") + 1)}`,
        name: `fixture.${mime.slice(mime.indexOf("/") + 1)}`,
        mime,
        bytes,
        origin: "mobile",
      });
      expect(meta.mime).toBe(mime);
      expect(meta.size).toBe(bytes.length);
    }
  });

  test("strips bytes after JPEG EOI before staging while keeping strict probing", async () => {
    const jpeg = IMAGE_FIXTURES["image/jpeg"];
    const trailers = [
      Buffer.from([0x00]),
      Buffer.alloc(16),
      jpeg,
      Buffer.from("00000018667479706d703432", "hex"),
    ];
    const expectedSha256 = createHash("sha256").update(jpeg).digest("hex");

    for (const [index, trailer] of trailers.entries()) {
      const bytes = Buffer.concat([jpeg, trailer]);
      expect(() => probeImageBytes("image/jpeg", bytes)).toThrow(
        "invalid JPEG image structure: trailing bytes after EOI",
      );

      const meta = await stageImageBytes({
        cwd,
        sessionId: `jpeg-trailer-${index}`,
        name: "photo.jpg",
        mime: "image/jpeg",
        bytes,
        origin: "im-gateway",
      });

      expect(meta.size).toBe(jpeg.length);
      expect(meta.sha256).toBe(expectedSha256);
      expect(readFileSync(meta.absPath)).toEqual(jpeg);
    }
  });

  test("does not strip trailing bytes from non-JPEG image formats", async () => {
    for (const mime of ["image/png", "image/gif", "image/webp"] as const) {
      await expect(
        stageImageBytes({
          cwd,
          sessionId: `trailing-${mime.slice(mime.indexOf("/") + 1)}`,
          mime,
          bytes: Buffer.concat([IMAGE_FIXTURES[mime], Buffer.from([0x00])]),
          origin: "im-gateway",
        }),
      ).rejects.toThrow(/invalid|mismatch/i);
    }
  });

  test("rejects truncated or malformed image structures for every allowed MIME", async () => {
    for (const [mime, bytes] of Object.entries(IMAGE_FIXTURES)) {
      await expect(
        stageImageBytes({
          cwd,
          sessionId: "truncated",
          name: "truncated.bin",
          mime,
          bytes: bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
          origin: "mobile",
        }),
      ).rejects.toThrow(/invalid|truncated|structure/i);
    }
    await expect(
      stageImageBytes({
        cwd,
        sessionId: "malformed",
        name: "magic-only.png",
        mime: "image/png",
        bytes: Buffer.from("89504e470d0a1a0a", "hex"),
        origin: "mobile",
      }),
    ).rejects.toThrow(/invalid|truncated|structure/i);
  });

  test("rejects declared MIME that does not match the actual image bytes", async () => {
    await expect(
      stageImageBytes({
        cwd,
        sessionId: "confused",
        name: "not-a-jpeg.jpg",
        mime: "image/jpeg",
        bytes: IMAGE_FIXTURES["image/png"],
        origin: "mobile",
      }),
    ).rejects.toThrow(/MIME|signature/i);
    await expect(
      stageImageDataUrl({
        cwd,
        sessionId: "confused-inline",
        name: "not-a-png.png",
        mime: "image/png",
        dataUrl: `data:image/png;base64,${IMAGE_FIXTURES["image/gif"].toString("base64")}`,
        origin: "mobile",
      }),
    ).rejects.toThrow(/MIME|signature/i);
  });

  test("rejects unsafe session ids", async () => {
    await expect(
      stageImageDataUrl({
        cwd,
        sessionId: "../x",
        name: "a.png",
        mime: "image/png",
        dataUrl: PNG_URL,
        origin: "paste",
      }),
    ).rejects.toThrow("invalid session id");

    await expect(
      stageImageDataUrl({
        cwd,
        sessionId: "bad\nid",
        name: "a.png",
        mime: "image/png",
        dataUrl: PNG_URL,
        origin: "paste",
      }),
    ).rejects.toThrow("invalid session id");
  });

  test("rejects unsupported data URL MIME", async () => {
    await expect(
      stageImageDataUrl({
        cwd,
        sessionId: "sid-1",
        name: "a.bin",
        mime: "application/octet-stream",
        dataUrl: "data:application/octet-stream;base64,AAAA",
        origin: "paste",
      }),
    ).rejects.toThrow("unsupported image data URL MIME");
  });

  test("rejects decoded image data URLs above the main-process size cap", async () => {
    const tooLargeBase64 = "A".repeat(Math.ceil((MAX_STAGED_IMAGE_BYTES + 1) / 3) * 4);

    await expect(
      stageImageDataUrl({
        cwd,
        sessionId: "sid-1",
        name: "huge.png",
        mime: "image/png",
        dataUrl: `data:image/png;base64,${tooLargeBase64}`,
        origin: "paste",
      }),
    ).rejects.toThrow("decoded size limit");
  });

  test("rejects a pre-existing symlink attachments root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cs-attachments-outside-"));
    try {
      mkdirSync(join(cwd, ".code-shell"), { recursive: true });
      symlinkSync(outside, join(cwd, ".code-shell", "attachments"), "dir");

      await expect(
        stageImageDataUrl({
          cwd,
          sessionId: "sid-1",
          name: "a.png",
          mime: "image/png",
          dataUrl: PNG_URL,
          origin: "paste",
        }),
      ).rejects.toThrow("symlink");

      expect(existsSync(join(outside, "sid-1"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a pre-existing symlink attachment session directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cs-attachments-outside-"));
    try {
      mkdirSync(join(cwd, ".code-shell", "attachments"), { recursive: true });
      symlinkSync(outside, join(cwd, ".code-shell", "attachments", "sid-1"), "dir");

      await expect(
        stageImageDataUrl({
          cwd,
          sessionId: "sid-1",
          name: "a.png",
          mime: "image/png",
          dataUrl: PNG_URL,
          origin: "paste",
        }),
      ).rejects.toThrow("symlink");

      expect(existsSync(join(outside, "manifest.jsonl"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a pre-existing symlink file matching the attachment hash", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cs-attachments-outside-"));
    try {
      const sessionDir = join(cwd, ".code-shell", "attachments", "sid-1");
      mkdirSync(sessionDir, { recursive: true });
      const bytes = IMAGE_FIXTURES["image/png"];
      const sha16 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const outsideFile = join(outside, "secret.png");
      writeFileSync(outsideFile, "keep", "utf-8");
      symlinkSync(outsideFile, join(sessionDir, `${sha16}-evil.png`));

      await expect(
        stageImageDataUrl({
          cwd,
          sessionId: "sid-1",
          name: "a.png",
          mime: "image/png",
          dataUrl: PNG_URL,
          origin: "paste",
        }),
      ).rejects.toThrow("symlink");

      expect(readFileSync(outsideFile, "utf-8")).toBe("keep");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("writes .code-shell/.gitignore without touching the repo root gitignore", async () => {
    await stageImageDataUrl({
      cwd,
      sessionId: "sid-1",
      name: "a.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });

    expect(readFileSync(join(cwd, ".code-shell", ".gitignore"), "utf-8")).toBe("*\n!.gitignore\n");
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
  });

  test("listRecentAttachments returns sent manifest entries only", async () => {
    const meta = await stageImageDataUrl({
      cwd,
      sessionId: "sid-1",
      name: "a.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });

    expect(await listRecentAttachments({ cwd })).toEqual([]);
    await markAttachmentsSent(cwd, "sid-1", [meta]);
    const recent = await listRecentAttachments({ cwd });
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(meta.id);
  });

  test("cleanup removes expired draft and sent files by TTL", async () => {
    const draft = await stageImageDataUrl({
      cwd,
      sessionId: "sid-draft",
      name: "a.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });
    const sent = await stageImageDataUrl({
      cwd,
      sessionId: "sid-sent",
      name: "b.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });
    await markAttachmentsSent(cwd, "sid-sent", [sent]);

    const tooEarly = await cleanupAttachments({
      cwd,
      now: draft.createdAt + DRAFT_ATTACHMENT_TTL_MS - 1,
    });
    expect(tooEarly.removed).toEqual([]);

    const draftCleanup = await cleanupAttachments({
      cwd,
      now: draft.createdAt + DRAFT_ATTACHMENT_TTL_MS + 1,
    });
    expect(draftCleanup.removed).toContain(draft.absPath);
    expect(existsSync(draft.absPath)).toBe(false);
    expect(existsSync(sent.absPath)).toBe(true);

    const sentCleanup = await cleanupAttachments({
      cwd,
      now: Date.now() + SENT_ATTACHMENT_TTL_MS + 1,
    });
    expect(sentCleanup.removed).toContain(sent.absPath);
    expect(existsSync(sent.absPath)).toBe(false);
  });

  test("session cleanup removes only the target session", async () => {
    const one = await stageImageDataUrl({
      cwd,
      sessionId: "one",
      name: "a.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });
    const two = await stageImageDataUrl({
      cwd,
      sessionId: "two",
      name: "b.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });

    const result = await cleanupAttachments({ cwd, sessionId: "one" });
    expect(result.sessionsRemoved).toEqual(["one"]);
    expect(existsSync(dirname(one.absPath))).toBe(false);
    expect(existsSync(two.absPath)).toBe(true);
  });

  test("cleanup ignores manifest paths outside the attachments root", async () => {
    const meta = await stageImageDataUrl({
      cwd,
      sessionId: "sid-1",
      name: "a.png",
      mime: "image/png",
      dataUrl: PNG_URL,
      origin: "paste",
    });
    const outside = join(cwd, "outside-secret.txt");
    writeFileSync(outside, "keep", "utf-8");
    const manifest = join(cwd, ".code-shell", "attachments", "sid-1", "manifest.jsonl");
    writeFileSync(
      manifest,
      JSON.stringify({
        event: "staged",
        id: "evil",
        sessionId: "sid-1",
        kind: "file",
        origin: "picker",
        path: "outside-secret.txt",
        absPath: outside,
        relPath: "outside-secret.txt",
        size: 4,
        sha256: "0".repeat(64),
        createdAt: 1,
      }) + "\n",
      { flag: "a" },
    );

    const result = await cleanupAttachments({ cwd, now: Date.now() + DRAFT_ATTACHMENT_TTL_MS + 1 });
    expect(result.removed).not.toContain(outside);
    expect(existsSync(outside)).toBe(true);
    expect(result.removed).toContain(meta.absPath);
  });
});

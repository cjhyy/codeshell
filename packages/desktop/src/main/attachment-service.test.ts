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
} from "./attachment-service.js";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

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
      const bytes = Buffer.from("iVBORw0KGgo=", "base64");
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
      dataUrl: "data:image/png;base64,QUFBQQ==",
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
      dataUrl: "data:image/png;base64,QUFBQQ==",
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

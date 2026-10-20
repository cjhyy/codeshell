import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CODE_SHELL_TEST_HOME) {
  throw new Error("Audit fixture requires the repository guarded test runner");
}

// The two product modules import only crypto, fs, fs/promises and path.
// No Core, worker, application, HTTP client or account module is imported.
globalThis.fetch = (() => {
  throw new Error("Attachment audit does not allow network access");
}) as typeof fetch;

const {
  DRAFT_ATTACHMENT_TTL_MS,
  SENT_ATTACHMENT_TTL_MS,
  cleanupAttachments,
  listRecentAttachments,
  markAttachmentsSent,
  stageImageDataUrl,
} = await import("../../../packages/server/src/attachment-service.ts");

// The ordinary one-pixel PNG already used by attachment-service.test.ts.
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("records shared-file deletion of a sent attachment before its retention deadline", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-audit-shared-attachment-")));
  try {
    const draft = await stageImageDataUrl({
      cwd,
      sessionId: "shared-session",
      name: "draft.png",
      dataUrl: png,
      origin: "paste",
    });
    const sent = await stageImageDataUrl({
      cwd,
      sessionId: "shared-session",
      name: "sent.png",
      dataUrl: png,
      origin: "paste",
    });
    await markAttachmentsSent(cwd, "shared-session", [sent]);

    const control = await stageImageDataUrl({
      cwd,
      sessionId: "control-session",
      name: "control.png",
      dataUrl: png,
      origin: "paste",
    });
    await markAttachmentsSent(cwd, "control-session", [control]);

    expect(draft.id).not.toBe(sent.id);
    expect(draft.absPath).toBe(sent.absPath);
    expect(control.absPath).not.toBe(sent.absPath);
    expect(existsSync(sent.absPath)).toBe(true);
    expect((await listRecentAttachments({ cwd, sessionId: "shared-session" })).map((x) => x.id))
      .toEqual([sent.id]);

    // Use the public cleanup clock parameter; do not change Date or sleep.
    const now = Date.now() + DRAFT_ATTACHMENT_TTL_MS + 1_000;
    expect(now - sent.createdAt).toBeLessThan(SENT_ATTACHMENT_TTL_MS);
    const cleaned = await cleanupAttachments({ cwd, now });

    // These assertions describe the current defect, not a fixed regression.
    expect(cleaned.removed).toContain(sent.absPath);
    expect(existsSync(sent.absPath)).toBe(false);
    expect(await listRecentAttachments({ cwd, sessionId: "shared-session" })).toEqual([]);
    expect(existsSync(control.absPath)).toBe(true);
    expect((await listRecentAttachments({ cwd, sessionId: "control-session" })).map((x) => x.id))
      .toEqual([control.id]);
    console.log(JSON.stringify({
      case: "expired draft deletes the deduplicated sent image",
      samePhysicalPath: draft.absPath === sent.absPath,
      distinctIds: draft.id !== sent.id,
      sentAgeBelowRetention: now - sent.createdAt < SENT_ATTACHMENT_TTL_MS,
      removedSentFile: cleaned.removed.includes(sent.absPath),
      independentSentControlRetained: existsSync(control.absPath),
    }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

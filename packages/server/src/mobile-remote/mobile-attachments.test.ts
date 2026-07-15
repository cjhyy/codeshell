import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MOBILE_ATTACHMENTS, materializeMobileAttachments } from "./mobile-attachments.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cs-mobile-materialize-"));
  roots.push(cwd);
  return cwd;
}

describe("materializeMobileAttachments", () => {
  test("stages ordered inline and uploaded descriptors as mobile attachments", async () => {
    const cwd = makeCwd();
    const inlineBytes = Buffer.from(PNG_URL.slice(PNG_URL.indexOf(",") + 1), "base64");
    const uploadedBytes = PNG_BYTES;
    const spool = join(cwd, "spool.upload");
    writeFileSync(spool, uploadedBytes);
    const uploads = {
      claim: (deviceId: string, uploadId: string) => {
        expect(deviceId).toBe("device-1");
        expect(uploadId).toBe("upload-1");
        return {
          uploadId,
          claimId: "claim-1",
          clientId: "b",
          name: "large.png",
          mime: "image/png" as const,
          size: uploadedBytes.byteLength,
          path: spool,
          sha256: "ignored",
        };
      },
      release: async () => undefined,
    };

    const result = await materializeMobileAttachments({
      deviceId: "device-1",
      cwd,
      sessionId: "session-1",
      uploads,
      attachments: [
        {
          transport: "inline",
          clientId: "a",
          name: "small.png",
          mime: "image/png",
          size: inlineBytes.byteLength,
          dataUrl: PNG_URL,
        },
        {
          transport: "upload",
          clientId: "b",
          name: "large.png",
          mime: "image/png",
          size: uploadedBytes.byteLength,
          uploadId: "upload-1",
        },
      ],
    });

    expect(result.metas.map((meta) => meta.originalName)).toEqual(["small.png", "large.png"]);
    expect(result.metas.every((meta) => meta.origin === "mobile")).toBe(true);
    expect(result.claims.map((claim) => claim.uploadId)).toEqual(["upload-1"]);
    expect(result.summaries.map((summary) => summary.clientId)).toEqual(["a", "b"]);
  });

  test("rejects duplicate ids, declared-size lies, and too many images", async () => {
    const cwd = makeCwd();
    const bytes = Buffer.from(PNG_URL.slice(PNG_URL.indexOf(",") + 1), "base64");
    const inline = {
      transport: "inline" as const,
      clientId: "same",
      name: "small.png",
      mime: "image/png" as const,
      size: bytes.byteLength,
      dataUrl: PNG_URL,
    };
    const base = {
      deviceId: "device-1",
      cwd,
      sessionId: "session-1",
      uploads: {
        claim() {
          throw new Error("unused");
        },
        release: async () => undefined,
      },
    };

    await expect(
      materializeMobileAttachments({ ...base, attachments: [inline, inline] }),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      materializeMobileAttachments({
        ...base,
        attachments: [{ ...inline, size: inline.size + 1 }],
      }),
    ).rejects.toThrow(/size/i);
    await expect(
      materializeMobileAttachments({
        ...base,
        attachments: Array.from({ length: MAX_MOBILE_ATTACHMENTS + 1 }, (_, index) => ({
          ...inline,
          clientId: `id-${index}`,
        })),
      }),
    ).rejects.toThrow(/at most/i);
  });

  test("atomically prevents concurrent chat/room materialization from replaying one upload", async () => {
    const cwd = makeCwd();
    const spool = join(cwd, "replay.upload");
    writeFileSync(spool, PNG_BYTES);
    let activeClaim: string | undefined;
    const uploads = {
      claim(_deviceId: string, uploadId: string) {
        if (activeClaim) throw new Error("upload is already claimed");
        activeClaim = `${uploadId}-claim`;
        return {
          claimId: activeClaim,
          uploadId,
          clientId: "replay",
          name: "photo.png",
          mime: "image/png" as const,
          size: PNG_BYTES.length,
          path: spool,
          sha256: "a".repeat(64),
        };
      },
      async release(_deviceId: string, _uploadId: string, claimId: string) {
        if (claimId === activeClaim) activeClaim = undefined;
      },
    };
    const descriptor = {
      transport: "upload" as const,
      uploadId: "ticket-1",
      clientId: "replay",
      name: "photo.png",
      mime: "image/png" as const,
      size: PNG_BYTES.length,
    };

    const results = await Promise.allSettled([
      materializeMobileAttachments({
        deviceId: "device-1",
        cwd,
        sessionId: "chat-session",
        attachments: [descriptor],
        uploads,
      }),
      materializeMobileAttachments({
        deviceId: "device-1",
        cwd,
        sessionId: "room-session",
        attachments: [descriptor],
        uploads,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

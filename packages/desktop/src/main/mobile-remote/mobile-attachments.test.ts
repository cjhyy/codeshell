import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MOBILE_ATTACHMENTS, materializeMobileAttachments } from "./mobile-attachments.js";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
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
    const uploadedBytes = Buffer.from([9, 8, 7, 6]);
    const spool = join(cwd, "spool.upload");
    writeFileSync(spool, uploadedBytes);
    const uploads = {
      resolve: (deviceId: string, uploadId: string) => {
        expect(deviceId).toBe("device-1");
        expect(uploadId).toBe("upload-1");
        return {
          clientId: "b",
          name: "large.png",
          mime: "image/png" as const,
          size: uploadedBytes.byteLength,
          path: spool,
          sha256: "ignored",
        };
      },
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
    expect(result.uploadIds).toEqual(["upload-1"]);
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
        resolve() {
          throw new Error("unused");
        },
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
});

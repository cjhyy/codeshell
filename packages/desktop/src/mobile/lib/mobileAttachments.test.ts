import { describe, expect, test } from "bun:test";
import {
  MOBILE_INLINE_IMAGE_BYTES,
  MOBILE_INLINE_TOTAL_BYTES,
  prepareMobileAttachments,
} from "./mobileAttachments";

describe("prepareMobileAttachments", () => {
  test("encodes small images inline without requesting an upload ticket", async () => {
    let begins = 0;
    const file = new File([new Uint8Array([1, 2, 3])], "small.png", { type: "image/png" });
    const result = await prepareMobileAttachments([{ clientId: "a", file }], {
      beginUpload: async () => {
        begins += 1;
        throw new Error("unused");
      },
      fetch: async () => new Response(null, { status: 201 }),
    });

    expect(begins).toBe(0);
    expect(result[0]).toMatchObject({
      transport: "inline",
      clientId: "a",
      name: "small.png",
      mime: "image/png",
      size: 3,
    });
    expect(result[0]?.transport === "inline" && result[0].dataUrl).toStartWith(
      "data:image/png;base64,",
    );
  });

  test("uploads large images with a ticket and preserves descriptor order", async () => {
    const large = new File([new Uint8Array(MOBILE_INLINE_IMAGE_BYTES + 1)], "large.jpg", {
      type: "image/jpeg",
    });
    const small = new File([new Uint8Array([4])], "small.png", { type: "image/png" });
    const puts: Array<{ url: string; size: number; type: string }> = [];
    const result = await prepareMobileAttachments(
      [
        { clientId: "large", file: large },
        { clientId: "small", file: small },
      ],
      {
        beginUpload: async (metadata) => ({
          clientId: metadata.clientId,
          uploadId: "upload-1",
          putUrl: "/api/mobile/uploads/ticket",
          expiresAt: Date.now() + 1000,
        }),
        fetch: async (url, init) => {
          const body = init?.body as Blob;
          puts.push({
            url: String(url),
            size: body.size,
            type: String(init?.headers && (init.headers as Record<string, string>)["Content-Type"]),
          });
          return new Response(null, { status: 201 });
        },
      },
    );

    expect(puts).toEqual([
      {
        url: "/api/mobile/uploads/ticket",
        size: MOBILE_INLINE_IMAGE_BYTES + 1,
        type: "image/jpeg",
      },
    ]);
    expect(result.map((attachment) => attachment.clientId)).toEqual(["large", "small"]);
    expect(result[0]).toMatchObject({ transport: "upload", uploadId: "upload-1" });
    expect(result[1]).toMatchObject({ transport: "inline" });
  });

  test("moves later small images to HTTP when the inline message budget is exhausted", async () => {
    const size = Math.floor(MOBILE_INLINE_TOTAL_BYTES / 3);
    const attachments = Array.from({ length: 4 }, (_, index) => ({
      clientId: `image-${index}`,
      file: new File([new Uint8Array(size)], `image-${index}.png`, { type: "image/png" }),
    }));
    const uploaded: string[] = [];

    const result = await prepareMobileAttachments(attachments, {
      beginUpload: async (metadata) => ({
        clientId: metadata.clientId,
        uploadId: `upload-${metadata.clientId}`,
        putUrl: `/api/mobile/uploads/${metadata.clientId}`,
        expiresAt: Date.now() + 1000,
      }),
      fetch: async (url) => {
        uploaded.push(String(url));
        return new Response(null, { status: 201 });
      },
    });

    expect(result.map((attachment) => attachment.transport)).toEqual([
      "inline",
      "inline",
      "inline",
      "upload",
    ]);
    expect(uploaded).toEqual(["/api/mobile/uploads/image-3"]);
  });

  test("rejects unsupported images when browser conversion is unavailable", async () => {
    const file = new File([new Uint8Array([1])], "photo.heic", { type: "image/heic" });
    await expect(
      prepareMobileAttachments([{ clientId: "a", file }], {
        beginUpload: async () => {
          throw new Error("unused");
        },
        fetch: async () => new Response(null, { status: 201 }),
      }),
    ).rejects.toThrow(/format/i);
  });
});

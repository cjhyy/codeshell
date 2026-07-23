import { describe, expect, test } from "bun:test";
import {
  downloadRemoteAttachment,
  mediaKind,
  OutgoingDeliveryTracker,
  outgoingAttachments,
  remoteAttachment,
} from "./media.js";

describe("shared channel media", () => {
  test("classifies media consistently from MIME and filename", () => {
    expect(mediaKind("image/png", "x.bin")).toBe("image");
    expect(mediaKind(undefined, "voice.opus")).toBe("audio");
    expect(mediaKind(undefined, "clip.mp4")).toBe("video");
    expect(mediaKind("application/pdf", "report.pdf")).toBe("file");
  });

  test("keeps authenticated inbound downloads lazy and bounded", async () => {
    let fetches = 0;
    const attachment = remoteAttachment({
      id: "private-1",
      name: "../photo.png",
      mimeType: "image/png",
      size: 3,
      url: "https://media.example/private-1",
      headers: { authorization: "Bearer secret" },
      fetch: async (_url, init) => {
        fetches += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: { "content-length": "3" },
        });
      },
    });

    expect(attachment).toMatchObject({ id: "private-1", kind: "image", name: "photo.png" });
    expect(fetches).toBe(0);
    expect(await attachment.load()).toEqual(Uint8Array.from([1, 2, 3]));
    expect(fetches).toBe(1);
  });

  test("rejects private media URLs before issuing a request", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      return new Response(Uint8Array.from([1]));
    }) as typeof fetch;

    await expect(downloadRemoteAttachment(fetchFn, "https://127.0.0.1/private")).rejects.toThrow(
      "私有网络",
    );
    expect(fetches).toBe(0);
  });

  test("validates every redirect target before following it", async () => {
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      });
    }) as typeof fetch;

    await expect(downloadRemoteAttachment(fetchFn, "https://media.example/file")).rejects.toThrow(
      "私有网络",
    );
    expect(requested).toEqual(["https://media.example/file"]);
  });

  test("does not forward platform credentials across redirect origins", async () => {
    const authorizations: Array<string | null> = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (authorizations.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/file" },
        });
      }
      return new Response(Uint8Array.from([9]));
    }) as typeof fetch;

    await expect(
      downloadRemoteAttachment(fetchFn, "https://api.example/file", {
        headers: { authorization: "Bearer secret" },
      }),
    ).resolves.toEqual(Uint8Array.from([9]));
    expect(authorizations).toEqual(["Bearer secret", null]);
  });

  test("allows an explicitly configured self-hosted platform origin", async () => {
    const fetchFn = (async () => new Response(Uint8Array.from([7]))) as typeof fetch;

    await expect(
      downloadRemoteAttachment(fetchFn, "http://192.168.1.20/media", {
        allowPrivateNetwork: true,
      }),
    ).resolves.toEqual(Uint8Array.from([7]));
  });

  test("rejects unsupported outbound kinds before a platform request", () => {
    expect(() =>
      outgoingAttachments(
        {
          text: "",
          attachments: [
            {
              kind: "video",
              name: "clip.mp4",
              mimeType: "video/mp4",
              data: Uint8Array.from([1]),
            },
          ],
        },
        ["image"],
      ),
    ).toThrow("不支持发送 video");
  });

  test("resumes a multi-request send without repeating completed steps", async () => {
    const tracker = new OutgoingDeliveryTracker();
    const message = { text: "reply" };
    let first = 0;
    let second = 0;
    const create = () => [
      async () => void (first += 1),
      async () => {
        second += 1;
        if (second === 1) throw new Error("temporary failure");
      },
    ];

    await expect(tracker.run(message, create)).rejects.toThrow("temporary failure");
    await tracker.run(message, create);

    expect(first).toBe(1);
    expect(second).toBe(2);
  });
});

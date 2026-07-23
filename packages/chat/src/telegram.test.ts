import { describe, expect, test } from "bun:test";
import { TelegramAdapter } from "./telegram.js";

describe("TelegramAdapter", () => {
  test("maps updates into the channel abstraction and advances the offset", async () => {
    const abort = new AbortController();
    const calls: Array<{ url: string; body: any }> = [];
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 41,
              message: { text: "/status", chat: { id: -1001 }, from: { id: 7 } },
            },
          ],
        });
      },
    });

    const received: string[] = [];
    await adapter.run(async (message) => {
      received.push(`${message.target}:${message.senderId}:${message.text}`);
      abort.abort();
    }, abort.signal);

    expect(received).toEqual(["-1001:7:/status"]);
    expect(calls[0]?.url).toContain("/botsecret/getUpdates");
    expect(calls[0]?.body.allowed_updates).toEqual(["message"]);
  });

  test("sends a URL inline keyboard with the pairing link", async () => {
    let body: any;
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ ok: true, result: {} });
      },
    });
    await adapter.send("123", {
      text: "ready",
      button: { text: "open", url: "https://demo.trycloudflare.com/mobile?pairing=x" },
    });
    expect(body.chat_id).toBe("123");
    expect(body.reply_markup.inline_keyboard[0][0].url).toContain("pairing=x");
  });

  test("sends generated images through Telegram sendPhoto", async () => {
    let endpoint = "";
    let form: FormData | undefined;
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async (url, init) => {
        endpoint = String(url);
        form = init?.body as FormData;
        return Response.json({ ok: true, result: {} });
      },
    });

    await adapter.send("123", {
      text: "",
      attachments: [
        {
          kind: "image",
          name: "comic.png",
          mimeType: "image/png",
          data: Uint8Array.from([1, 2, 3]),
        },
      ],
    });

    expect(endpoint).toEndWith("/botsecret/sendPhoto");
    expect(form?.get("chat_id")).toBe("123");
    const photo = form?.get("photo") as File;
    expect(photo.name).toBe("comic.png");
    expect(photo.type).toBe("image/png");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  test("sends ordinary files through Telegram sendDocument", async () => {
    let endpoint = "";
    let form: FormData | undefined;
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async (url, init) => {
        endpoint = String(url);
        form = init?.body as FormData;
        return Response.json({ ok: true, result: {} });
      },
    });

    await adapter.send("123", {
      text: "",
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          data: Uint8Array.from([4, 5, 6]),
        },
      ],
    });

    expect(endpoint).toEndWith("/botsecret/sendDocument");
    const document = form?.get("document") as File;
    expect(document.name).toBe("report.pdf");
    expect(document.type).toBe("application/pdf");
  });

  test.each([
    ["audio", "audio/mpeg", "song.mp3", "sendAudio", "audio"],
    ["video", "video/mp4", "clip.mp4", "sendVideo", "video"],
  ] as const)(
    "sends %s attachments through Telegram native media",
    async (kind, mimeType, name, method, field) => {
      let endpoint = "";
      let form: FormData | undefined;
      const adapter = new TelegramAdapter(baseConfig(), {
        fetch: async (url, init) => {
          endpoint = String(url);
          form = init?.body as FormData;
          return Response.json({ ok: true, result: {} });
        },
      });

      await adapter.send("123", {
        text: "",
        attachments: [{ kind, name, mimeType, data: Uint8Array.from([1, 2]) }],
      });

      expect(endpoint).toEndWith(`/botsecret/${method}`);
      expect((form?.get(field) as File).name).toBe(name);
    },
  );

  test("redacts the bot token from polling failures", async () => {
    const abort = new AbortController();
    const logs: string[] = [];
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async () => {
        throw new Error("request to /botsecret/getUpdates failed");
      },
      sleep: async () => abort.abort(),
      log: (message) => logs.push(message),
    });

    await adapter.run(async () => undefined, abort.signal);
    expect(logs[0]).toContain("[REDACTED]");
    expect(logs[0]).not.toContain("secret");
  });

  test("does not advance the polling cursor until the durable handler accepts an update", async () => {
    const abort = new AbortController();
    const offsets: Array<number | undefined> = [];
    let attempts = 0;
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async (_url, init) => {
        offsets.push(JSON.parse(String(init?.body)).offset);
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 41,
              message: { message_id: 9, text: "/status", chat: { id: 123 }, from: { id: 7 } },
            },
          ],
        });
      },
    });

    await adapter.run(async () => {
      attempts++;
      if (attempts === 1) throw new Error("inbox full");
      abort.abort();
    }, abort.signal);

    expect(attempts).toBe(2);
    expect(offsets).toEqual([undefined, undefined]);
  });

  test("backs off before re-polling when the handler keeps failing", async () => {
    const abort = new AbortController();
    const sleeps: number[] = [];
    let handlerCalls = 0;
    const adapter = new TelegramAdapter(baseConfig(), {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () =>
        Response.json({
          ok: true,
          result: [
            {
              update_id: 41,
              message: { message_id: 9, text: "/status", chat: { id: 123 }, from: { id: 7 } },
            },
          ],
        }),
    });

    await adapter.run(async () => {
      handlerCalls++;
      // Fail twice (offset never advances, so the same batch reprocesses),
      // then stop. Each failure must insert a backoff sleep before re-polling.
      if (handlerCalls >= 3) abort.abort();
      throw new Error("inbox full");
    }, abort.signal);

    // Without a backoff the loop hot-spins; with it every handler failure
    // sleeps at least once before the next getUpdates.
    expect(handlerCalls).toBeGreaterThanOrEqual(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps.every((ms) => ms >= 1_000)).toBe(true);
  });

  test("does not replay stale control commands after a polling restart", async () => {
    const abort = new AbortController();
    let handled = 0;
    const adapter = new TelegramAdapter(baseConfig(), {
      now: () => 1_000_000,
      maxMessageAgeMs: 60_000,
      fetch: async () => {
        abort.abort();
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 99,
              message: { text: "/open", date: 100, chat: { id: 123 }, from: { id: 123 } },
            },
          ],
        });
      },
    });

    await adapter.run(async () => {
      handled++;
    }, abort.signal);
    expect(handled).toBe(0);
  });

  test("exposes Telegram media lazily and downloads it only after dispatch", async () => {
    const abort = new AbortController();
    const requested: string[] = [];
    const adapter = new TelegramAdapter(baseConfig(), {
      fetch: async (url) => {
        requested.push(String(url));
        if (String(url).endsWith("/getUpdates")) {
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 5,
                message: {
                  message_id: 9,
                  caption: "inspect",
                  chat: { id: 123 },
                  from: { id: 7 },
                  document: {
                    file_id: "file-secret",
                    file_unique_id: "stable-file",
                    file_name: "notes.txt",
                    mime_type: "text/plain",
                    file_size: 3,
                  },
                },
              },
            ],
          });
        }
        if (String(url).endsWith("/getFile")) {
          return Response.json({ ok: true, result: { file_path: "docs/notes.txt" } });
        }
        if (String(url).includes("/file/botsecret/docs/notes.txt")) {
          return new Response(Uint8Array.from([1, 2, 3]), {
            headers: { "content-length": "3" },
          });
        }
        throw new Error(`unexpected request ${url}`);
      },
    });
    await adapter.run(async (message) => {
      expect(message.text).toBe("inspect");
      expect(message.attachments?.[0]).toMatchObject({
        id: "stable-file",
        kind: "file",
        name: "notes.txt",
      });
      expect(requested.some((url) => url.includes("/getFile"))).toBe(false);
      expect(await message.attachments![0]!.load()).toEqual(Uint8Array.from([1, 2, 3]));
      abort.abort();
    }, abort.signal);
  });
});

function baseConfig() {
  return {
    channel: "telegram" as const,
    botToken: "secret",
    allowedTargetIds: ["123"],
    allowedUserIds: [],
    apiBaseUrl: "https://api.telegram.org",
  };
}

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

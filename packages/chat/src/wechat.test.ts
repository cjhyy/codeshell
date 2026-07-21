import { describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  loginWechatWithQr,
  WechatAdapter,
  type WechatAdapterState,
  type WechatStateStore,
} from "./wechat.js";

describe("personal WeChat ClawBot", () => {
  test("logs in through Tencent's QR flow and returns reusable credentials", async () => {
    const qrUrls: string[] = [];
    const statuses: string[] = [];
    let pollCount = 0;
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    const result = await loginWechatWithQr({
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("get_bot_qrcode")) {
          return Response.json({ qrcode: "qr-secret", qrcode_img_content: "https://qr.example/1" });
        }
        if (url.includes("get_qrcode_status")) {
          pollCount += 1;
          if (pollCount === 1) return Response.json({ status: "scaned" });
          return Response.json({
            status: "confirmed",
            bot_token: "bot-secret",
            ilink_bot_id: "abc@im.bot",
            ilink_user_id: "owner-user",
            baseurl: "https://ilinkai.weixin.qq.com",
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
      sleep: async () => undefined,
      onQrCode: (url) => void qrUrls.push(url),
      onStatus: (status) => void statuses.push(status),
    });

    expect(result).toEqual({
      connected: true,
      credentials: {
        accountId: "abc@im.bot",
        token: "bot-secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
        userId: "owner-user",
      },
    });
    expect(qrUrls).toEqual(["https://qr.example/1"]);
    expect(statuses).toEqual(["scaned", "confirmed"]);
    expect(new Headers(requests[0]?.init?.headers).get("authorizationtype")).toBe(
      "ilink_bot_token",
    );
    expect(new Headers(requests[1]?.init?.headers).has("authorizationtype")).toBe(false);
  });

  test("polls text messages, persists context, and replies with the pairing URL", async () => {
    const controller = new AbortController();
    const store = memoryStore({ cursor: "cursor-1", contextTokens: {} });
    const sentBodies: Array<Record<string, any>> = [];
    const adapter = new WechatAdapter(
      {
        accountId: "abc-im-bot",
        token: "bot-secret",
      },
      {
        now: () => 1_000,
        stateStore: store,
        sleep: async () => undefined,
        fetch: async (input, init) => {
          const url = String(input);
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            expect(body.get_updates_buf).toBe("cursor-1");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bot-secret");
            return Response.json({
              ret: 0,
              get_updates_buf: "cursor-2",
              msgs: [
                {
                  message_id: 42,
                  from_user_id: "owner-user",
                  to_user_id: "abc@im.bot",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  context_token: "context-secret",
                  item_list: [{ type: 1, text_item: { text: "/open" } }],
                },
              ],
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            sentBodies.push(body);
            return Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async (message) => {
      expect(message).toMatchObject({
        channel: "wechat",
        target: "owner-user",
        senderId: "owner-user",
        text: "/open",
        messageId: "42",
      });
      await adapter.send(message.target, {
        text: "隧道已开启",
        button: { text: "打开", url: "https://pair.example/secret" },
      });
      controller.abort();
    }, controller.signal);

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]?.msg.context_token).toBe("context-secret");
    expect(sentBodies[0]?.msg.item_list[0].text_item.text).toContain(
      "打开: https://pair.example/secret",
    );
    expect(store.current()).toEqual({
      cursor: "cursor-2",
      contextTokens: { "owner-user": "context-secret" },
    });
  });

  test("downloads and decrypts personal WeChat image media lazily", async () => {
    const controller = new AbortController();
    const key = randomBytes(16);
    const plaintext = Buffer.from("image-bytes");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const requests: string[] = [];
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        now: () => 1_000,
        fetch: async (input) => {
          const url = String(input);
          requests.push(url);
          if (url.endsWith("/ilink/bot/msg/notifystart")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/msg/notifystop")) return Response.json({ ret: 0 });
          if (url.endsWith("/ilink/bot/getupdates")) {
            return Response.json({
              ret: 0,
              msgs: [
                {
                  message_id: 43,
                  from_user_id: "owner-user",
                  create_time_ms: 1_000,
                  message_type: 1,
                  message_state: 2,
                  item_list: [
                    {
                      type: 2,
                      msg_id: "image-43",
                      image_item: {
                        media: {
                          full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?id=43",
                          aes_key: key.toString("base64"),
                        },
                      },
                    },
                  ],
                },
              ],
            });
          }
          if (url.includes("novac2c.cdn.weixin.qq.com")) return new Response(encrypted);
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );

    await adapter.run(async (message) => {
      expect(message.text).toBe("");
      expect(message.attachments?.[0]).toMatchObject({ id: "image-43", kind: "image" });
      expect(requests.some((url) => url.includes("novac2c.cdn.weixin.qq.com"))).toBe(false);
      expect(Buffer.from(await message.attachments![0]!.load())).toEqual(plaintext);
      controller.abort();
    }, controller.signal);
  });

  test("uploads encrypted generated images and sends the returned CDN media reference", async () => {
    const requestedBodies: Record<string, any> = {};
    let encryptedUpload = Buffer.alloc(0);
    const adapter = new WechatAdapter(
      { accountId: "abc-im-bot", token: "bot-secret" },
      {
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/ilink/bot/getuploadurl")) {
            requestedBodies.getUploadUrl = JSON.parse(String(init?.body));
            return Response.json({ ret: 0, upload_param: "upload-secret" });
          }
          if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?")) {
            encryptedUpload = Buffer.from(init?.body as Uint8Array);
            return new Response(null, {
              status: 200,
              headers: { "x-encrypted-param": "download-secret" },
            });
          }
          if (url.endsWith("/ilink/bot/sendmessage")) {
            requestedBodies.sendMessage = JSON.parse(String(init?.body));
            return Response.json({ ret: 0 });
          }
          throw new Error(`unexpected request: ${url}`);
        },
      },
    );
    const plaintext = Uint8Array.from([1, 2, 3, 4, 5]);

    await adapter.send("owner-user", {
      text: "",
      attachments: [
        {
          kind: "image",
          name: "comic.png",
          mimeType: "image/png",
          data: plaintext,
        },
      ],
    });

    expect(requestedBodies.getUploadUrl).toMatchObject({
      media_type: 1,
      to_user_id: "owner-user",
      rawsize: plaintext.byteLength,
      no_need_thumb: true,
    });
    expect(requestedBodies.getUploadUrl.rawfilemd5).toMatch(/^[a-f0-9]{32}$/);
    expect(requestedBodies.getUploadUrl.aeskey).toMatch(/^[a-f0-9]{32}$/);
    expect(encryptedUpload.byteLength).toBe(16);
    expect(encryptedUpload.equals(Buffer.from(plaintext))).toBe(false);
    expect(requestedBodies.sendMessage.msg.item_list).toEqual([
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "download-secret",
            aes_key: Buffer.from(requestedBodies.getUploadUrl.aeskey).toString("base64"),
            encrypt_type: 1,
          },
          mid_size: 16,
        },
      },
    ]);
  });
});

function memoryStore(initial: WechatAdapterState): WechatStateStore & {
  current(): WechatAdapterState;
} {
  let value = structuredClone(initial);
  return {
    load: async () => structuredClone(value),
    save: async (next) => {
      value = structuredClone(next);
    },
    current: () => structuredClone(value),
  };
}

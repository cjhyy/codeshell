import { describe, expect, test } from "bun:test";
import { DiscordAdapter } from "./discord.js";
import { LarkAdapter } from "./lark.js";
import { MatrixAdapter } from "./matrix.js";
import { MattermostAdapter } from "./mattermost.js";
import { SlackAdapter } from "./slack.js";
import { TeamsAdapter } from "./teams.js";
import { WeComAdapter } from "./wecom.js";

const imageMessage = {
  text: "caption",
  attachments: [
    {
      kind: "image" as const,
      name: "comic.png",
      mimeType: "image/png",
      data: Uint8Array.from([1, 2, 3]),
    },
  ],
};

describe("native media adapters", () => {
  test("Discord sends text and files in one platform request", async () => {
    let payload: any;
    const adapter = new DiscordAdapter({ botToken: "discord-token" });
    (adapter as any).client.channels.fetch = async () => ({
      type: 0,
      isSendable: () => true,
      send: async (value: unknown) => void (payload = value),
    });

    await adapter.send("channel-1", imageMessage);

    expect(payload.content).toBe("caption");
    expect(payload.files[0]).toMatchObject({ name: "comic.png" });
    expect(new Uint8Array(payload.files[0].attachment)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  test("Slack publishes uploads with an atomic initial comment", async () => {
    let payload: any;
    const adapter = new SlackAdapter({ botToken: "xoxb-token", appToken: "xapp-token" });
    (adapter as any).web.filesUploadV2 = async (value: unknown) => void (payload = value);

    await adapter.send("C1", imageMessage);

    expect(payload).toMatchObject({ channel_id: "C1", initial_comment: "caption" });
    expect(payload.file_uploads[0].filename).toBe("comic.png");
  });

  test("Lark uploads an image key before creating the media message", async () => {
    const sent: any[] = [];
    const adapter = new LarkAdapter({ appId: "app-id", appSecret: "secret" });
    (adapter as any).client.im.v1.image.create = async () => ({ image_key: "img-key" });
    (adapter as any).client.im.v1.message.create = async (value: unknown) => {
      sent.push(value);
      return { code: 0 };
    };

    await adapter.send("chat-1", imageMessage);

    expect(sent).toHaveLength(2);
    expect(sent[1].data).toMatchObject({
      receive_id: "chat-1",
      msg_type: "image",
      content: JSON.stringify({ image_key: "img-key" }),
    });
  });

  test("WeCom uploads and proactively sends native media", async () => {
    const sent: any[] = [];
    const adapter = new WeComAdapter({ botId: "bot-id", secret: "secret" });
    (adapter as any).client.sendMessage = async (...args: unknown[]) => void sent.push(args);
    (adapter as any).client.uploadMedia = async () => ({ media_id: "media-id" });
    (adapter as any).client.sendMediaMessage = async (...args: unknown[]) => void sent.push(args);

    await adapter.send("chat-1", imageMessage);

    expect(sent[0][0]).toBe("chat-1");
    expect(sent[1]).toEqual(["chat-1", "image", "media-id", undefined]);
  });

  test("Matrix uploads MXC media and sends a typed room event", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const adapter = new MatrixAdapter(
      { homeserverUrl: "https://matrix.example", accessToken: "token" },
      async (url, init) => {
        requests.push({ url: String(url), body: init?.body });
        return String(url).includes("/upload?")
          ? Response.json({ content_uri: "mxc://matrix.example/media-1" })
          : Response.json({ event_id: "$event" });
      },
    );

    await adapter.send("!room:matrix.example", imageMessage);

    expect(requests.map(({ url }) => url)).toEqual([
      expect.stringContaining("/send/m.room.message/"),
      expect.stringContaining("/_matrix/media/v3/upload?"),
      expect.stringContaining("/send/m.room.message/"),
    ]);
    expect(JSON.parse(String(requests[2]?.body))).toMatchObject({
      msgtype: "m.image",
      url: "mxc://matrix.example/media-1",
    });
  });

  test("Mattermost uploads first and publishes one post with file_ids", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const adapter = new MattermostAdapter(
      { serverUrl: "https://mattermost.example", botToken: "token" },
      async (url, init) => {
        requests.push({ url: String(url), body: init?.body });
        return String(url).endsWith("/files")
          ? Response.json({ file_infos: [{ id: "file-1" }] })
          : Response.json({ id: "post-1" });
      },
    );

    await adapter.send("channel-1", imageMessage);

    expect(requests[0]?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(requests[1]?.body))).toMatchObject({
      channel_id: "channel-1",
      message: "caption",
      file_ids: ["file-1"],
    });
  });

  test("Teams sends inline Bot Framework attachments", async () => {
    let activity: any;
    const adapter = new TeamsAdapter({ appId: "app-id", appPassword: "password" });
    (adapter as any).contexts.set("conversation-1", {
      sendActivity: async (value: unknown) => void (activity = value),
    });

    await adapter.send("conversation-1", imageMessage);

    expect(activity).toMatchObject({ type: "message", text: "caption" });
    expect(activity.attachments[0].contentUrl).toStartWith("data:image/png;base64,");
  });

  test("Teams enforces the platform inline-picture limit", async () => {
    const adapter = new TeamsAdapter({ appId: "app-id", appPassword: "password" });

    await expect(
      adapter.send("conversation-1", {
        text: "",
        attachments: [
          {
            kind: "image",
            name: "large.png",
            mimeType: "image/png",
            data: new Uint8Array(1024 * 1024 + 1),
          },
        ],
      }),
    ).rejects.toThrow("1048576");
  });
});

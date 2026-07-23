import { describe, expect, test } from "bun:test";
import {
  BUILTIN_CHANNEL_CAPABILITIES,
  channelCapabilities,
  supportsOutgoingAttachment,
  type ChannelAdapter,
} from "./channel.js";

describe("built-in channel capabilities", () => {
  test("declares every configured adapter in one capability matrix", () => {
    expect(Object.keys(BUILTIN_CHANNEL_CAPABILITIES).sort()).toEqual(
      [
        "dingtalk",
        "discord",
        "lark",
        "line",
        "matrix",
        "mattermost",
        "slack",
        "teams",
        "telegram",
        "wechat",
        "wecom",
        "whatsapp",
      ].sort(),
    );
    expect(BUILTIN_CHANNEL_CAPABILITIES.telegram).toMatchObject({
      inbound: { text: true, attachments: ["image", "file", "audio", "video"] },
      outbound: {
        text: true,
        button: "native",
        attachments: ["image", "file", "audio", "video"],
      },
    });
    expect(BUILTIN_CHANNEL_CAPABILITIES.wechat).toMatchObject({
      inbound: { text: true, attachments: ["image", "file", "audio", "video"] },
      outbound: {
        text: true,
        button: "link",
        attachments: ["image", "file", "audio", "video"],
      },
    });
    expect(BUILTIN_CHANNEL_CAPABILITIES.whatsapp.outbound.attachments).toEqual([
      "image",
      "file",
      "audio",
      "video",
    ]);
    expect(BUILTIN_CHANNEL_CAPABILITIES.line).toMatchObject({
      inbound: { attachments: ["image", "file", "audio", "video"] },
      outbound: { attachments: [] },
    });
    expect(BUILTIN_CHANNEL_CAPABILITIES.dingtalk).toMatchObject({
      inbound: { attachments: [] },
      outbound: { attachments: [] },
    });
    expect(BUILTIN_CHANNEL_CAPABILITIES.teams).toMatchObject({
      inbound: { attachments: ["image", "file", "audio", "video"] },
      outbound: { attachments: ["image"], maxAttachmentBytes: 1024 * 1024 },
    });
    for (const capability of Object.values(BUILTIN_CHANNEL_CAPABILITIES)) {
      expect(capability.outbound.maxTextLength).toBe(8_000);
      expect(["native", "link"]).toContain(capability.outbound.button);
    }
  });

  test("uses granular kinds while preserving legacy third-party adapters", () => {
    const adapter: ChannelAdapter = {
      channel: "custom",
      supportsOutgoingAttachments: true,
      run: async () => undefined,
      send: async () => undefined,
    };
    expect(channelCapabilities(adapter).outbound.attachments).toEqual([
      "image",
      "file",
      "audio",
      "video",
    ]);
    expect(supportsOutgoingAttachment(adapter, "file")).toBe(true);
  });
});

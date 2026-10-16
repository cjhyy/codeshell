import { expect, test } from "bun:test";
import { remoteAttachment, safeAttachmentName } from "../../../packages/chat/src/media.ts";
import { materializeChatAttachments } from "../../../packages/chat/src/attachments.ts";
import { splitNotificationText, splitNotificationTextForChannel } from "../../../packages/chat/src/notification-relay.ts";
import { BUILTIN_CHANNEL_CAPABILITIES } from "../../../packages/chat/src/channel.ts";

test("observation: truncating a valid 255-codepoint attachment label creates a lone surrogate", async () => {
  const original = "a".repeat(254) + "😀";
  expect(Array.from(original)).toHaveLength(255);
  const lazy = remoteAttachment({
    id: "local-attachment", kind: "file", name: original,
    mimeType: "application/octet-stream", url: "https://unused.invalid/local",
    fetch: (async () => { throw new Error("This local metadata fixture must not fetch"); }) as any,
  });
  const materialized = await materializeChatAttachments([{ ...lazy, load: async () => Uint8Array.from([1]) }]);
  const name = materialized[0].name!;
  expect(name.length).toBe(255);
  expect(name.charCodeAt(254)).toBe(0xd83d);
  expect(Buffer.from(name).toString("utf8")).toBe("a".repeat(254) + "�");
  expect(safeAttachmentName("report-😀.txt")).toBe("report-😀.txt");
  console.log(JSON.stringify({ case: "attachment-name-unicode-truncation", inputCodepoints: Array.from(original).length, outputCodeUnits: name.length, lastCodeUnit: name.charCodeAt(254), encodedNameTail: Buffer.from(name).toString("utf8").slice(-2) }));
});

test("normal channel text splits preserve Unicode and all whitespace exactly", () => {
  const text = "intro\n" + "项目 😀 line with spaces\n".repeat(300);
  for (const maximum of [2, 17, 1_800]) {
    const chunks = splitNotificationText(text, maximum);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= maximum)).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  }
  expect(splitNotificationTextForChannel("中".repeat(3_500), "wechat", BUILTIN_CHANNEL_CAPABILITIES.wechat)).toHaveLength(1);
  expect(splitNotificationTextForChannel("中".repeat(3_500), "discord", BUILTIN_CHANNEL_CAPABILITIES.discord)).toHaveLength(2);
});

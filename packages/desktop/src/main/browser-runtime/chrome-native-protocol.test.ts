import { describe, expect, test } from "bun:test";
import {
  ChromeNativeMessageDecoder,
  CODESHELL_CHROME_EXTENSION_ID,
  CODESHELL_CHROME_EXTENSION_ORIGIN,
  JsonLineDecoder,
  MAX_EXTENSION_TO_NATIVE_HOST_BYTES,
  MAX_NATIVE_HOST_TO_EXTENSION_BYTES,
  encodeChromeNativeMessage,
  nativeMessagingOriginFromArgv,
} from "./chrome-native-protocol.js";

describe("Chrome Native Messaging protocol", () => {
  test("frames UTF-8 by byte length and decodes fragmented/coalesced messages", () => {
    const first = encodeChromeNativeMessage({ text: "登录态 ✓" });
    const second = encodeChromeNativeMessage({ n: 2 });
    expect(first.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify({ text: "登录态 ✓" })));

    const decoder = new ChromeNativeMessageDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { text: "登录态 ✓" },
      { n: 2 },
    ]);
  });

  test("accepts only a Chrome extension origin-shaped argv entry", () => {
    expect(
      nativeMessagingOriginFromArgv([
        "/Applications/code-shell",
        "--codeshell-native-messaging-host",
        CODESHELL_CHROME_EXTENSION_ORIGIN,
      ]),
    ).toBe(CODESHELL_CHROME_EXTENSION_ORIGIN);
    expect(nativeMessagingOriginFromArgv([`chrome-extension://${CODESHELL_CHROME_EXTENSION_ID}`])).toBeUndefined();
    expect(nativeMessagingOriginFromArgv(["https://example.test/"])).toBeUndefined();
  });

  test("retains the native frame byte limits in both directions", () => {
    const atLimit = "x".repeat(MAX_NATIVE_HOST_TO_EXTENSION_BYTES - 2);
    expect(encodeChromeNativeMessage(atLimit).readUInt32LE(0)).toBe(
      MAX_NATIVE_HOST_TO_EXTENSION_BYTES,
    );
    expect(() => encodeChromeNativeMessage(atLimit + "x")).toThrow(/native message exceeds/);

    const length = Buffer.alloc(4);
    length.writeUInt32LE(MAX_EXTENSION_TO_NATIVE_HOST_BYTES);
    expect(new ChromeNativeMessageDecoder().push(length)).toEqual([]);
    length.writeUInt32LE(MAX_EXTENSION_TO_NATIVE_HOST_BYTES + 1);
    expect(() => new ChromeNativeMessageDecoder().push(length)).toThrow(
      /native input message exceeds/,
    );
  });

  test("native frames still reject malformed JSON and consume the failed frame", () => {
    const malformed = Buffer.from([1, 0, 0, 0, 0x7b]);
    const decoder = new ChromeNativeMessageDecoder();
    expect(() => decoder.push(malformed)).toThrow(SyntaxError);
    expect(decoder.push(encodeChromeNativeMessage({ recovered: true }))).toEqual([
      { recovered: true },
    ]);
  });
});

describe("JSON line decoding", () => {
  test.each([
    { text: "中文 🐈", nested: { text: "拼音 café 日本語" } },
    { text: "ASCII only", escaped: "line\nquote\"tab\t" },
  ])("preserves a message at every UTF-8 byte split: %j", (message) => {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new JsonLineDecoder();
      expect([
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
      ]).toEqual([message]);
    }
    const decoder = new JsonLineDecoder();
    const decoded = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])));
    expect(decoded).toEqual([message]);
  });

  test("handles all splits of coalesced lines, blank lines and a partial trailing line", () => {
    const messages = [{ text: "中文\n🐈" }, ["emoji 🦊", 2], null, "最后一行"];
    const bytes = Buffer.from(` \r\n${messages.map((value) => JSON.stringify(value)).join("\r\n\n")}\n`);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new JsonLineDecoder();
      expect([
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
      ]).toEqual(messages);
    }
    const decoder = new JsonLineDecoder();
    expect(decoder.push(Buffer.concat([bytes, Buffer.from('{"pending":"终')]))).toEqual(messages);
    expect(decoder.push(Buffer.alloc(0))).toEqual([]);
    expect(decoder.push(Buffer.from('点"}\n'))).toEqual([{ pending: "终点" }]);
  });

  test("preserves existing string chunks and complete Buffer/string transitions", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"text":"中文 \ud83d')).toEqual([]);
    expect(decoder.push('\udc08"}\n')).toEqual([{ text: "中文 🐈" }]);
    expect(decoder.push(Buffer.from('{"text":'))).toEqual([]);
    expect(decoder.push('"string continuation"}\n')).toEqual([{ text: "string continuation" }]);
  });

  test("rejects a malformed line and retains subsequent complete and partial UTF-8 lines", () => {
    const decoder = new JsonLineDecoder();
    const malformed = Buffer.from('{"text":"中文",}\n');
    const following = Buffer.from('{"recovered":"🐈"}\n{"later":"中');
    // Leave the final character unfinished across the throwing push.
    expect(() => decoder.push(Buffer.concat([malformed, following.subarray(0, -1)]))).toThrow(
      SyntaxError,
    );
    expect(decoder.push(Buffer.alloc(0))).toEqual([{ recovered: "🐈" }]);
    expect(decoder.push(Buffer.concat([following.subarray(-1), Buffer.from('文"}\n')]))).toEqual([
      { later: "中文" },
    ]);
    expect(decoder.push('{"stillUsable":true}\n')).toEqual([{ stillUsable: true }]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  ChromeNativeMessageDecoder,
  CODESHELL_CHROME_EXTENSION_ID,
  CODESHELL_CHROME_EXTENSION_ORIGIN,
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
});

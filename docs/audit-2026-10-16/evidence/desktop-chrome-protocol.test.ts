import { expect, test } from "bun:test";
import {
  ChromeNativeMessageDecoder,
  JsonLineDecoder,
  encodeChromeNativeMessage,
} from "../../../packages/desktop/src/main/browser-runtime/chrome-native-protocol";

test("audit D03: JSON-lines decoder corrupts UTF-8 when TCP splits a character", () => {
  const value = { type: "echo", text: "中文 🐈" };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const firstChinese = bytes.indexOf(Buffer.from("中"));
  const decoder = new JsonLineDecoder();
  expect(decoder.push(bytes.subarray(0, firstChinese + 1))).toEqual([]);
  const decoded = decoder.push(bytes.subarray(firstChinese + 1));
  console.log("D03", JSON.stringify({ original: value, decoded }));
  expect(decoded).not.toEqual([value]);
  expect((decoded[0] as { text: string }).text).toContain("\uFFFD");
});

test("audit D03: every JSON-lines byte boundary preserves ASCII; UTF-8 has failing boundaries", () => {
  const splitResults = (value: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const failures: number[] = [];
    for (let split = 1; split < bytes.length; split++) {
      const decoder = new JsonLineDecoder();
      const decoded = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
      if (JSON.stringify(decoded) !== JSON.stringify([value])) failures.push(split);
    }
    return failures;
  };
  expect(splitResults({ type: "echo", text: "ASCII" })).toEqual([]);
  const failures = splitResults({ type: "echo", text: "中文 🐈" });
  console.log("D03-fragment-boundaries", JSON.stringify({ failures }));
  expect(failures).toHaveLength(7);
});

test("audit D03 controls: unfragmented JSON-lines and all fragmented Native frames preserve UTF-8", () => {
  const value = { type: "echo", text: "中文 🐈" };
  expect(new JsonLineDecoder().push(Buffer.from(`${JSON.stringify(value)}\n`))).toEqual([value]);
  const bytes = encodeChromeNativeMessage(value);
  for (let split = 1; split < bytes.length; split++) {
    const decoder = new ChromeNativeMessageDecoder();
    const decoded = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
    expect(decoded).toEqual([value]);
  }
});

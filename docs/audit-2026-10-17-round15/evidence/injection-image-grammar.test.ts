import { describe, expect, test } from "bun:test";
import { parseTaskWithImages, ImageParseError } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/parse-task.ts";

const dataUrl = "data:image/png;base64,YQ==";
const block = `<codeshell-image mime="image/png" name="ordinary.png">${dataUrl}</codeshell-image>`;

describe("round15 inline-image grammar characterization", () => {
  test("plain text without reserved image marker remains byte-for-byte unchanged", () => {
    const text = "  ordinary XML <example>\n\n\ntext\n  ";
    const parsed = parseTaskWithImages(text);
    expect(parsed.text).toBe(text);
    expect(parsed.images).toEqual([]);
    expect(parsed.hasImages).toBe(false);
  });

  test("valid source-order images and escaped metadata round-trip in the actual parser", () => {
    const first = `<codeshell-image mime="image/png" name="&amp;quot; &quot; &lt;a&gt;.png" path=".owned/a&amp;b.png" size="1" sessionId="owned-session">${dataUrl}</codeshell-image>`;
    const parsed = parseTaskWithImages(`before\n${first}\nbetween\n${block}\nafter`);
    expect(parsed.text).toBe("before\n\nbetween\n\nafter");
    expect(parsed.images.map((image) => image.name)).toEqual(['&quot; " <a>.png', "ordinary.png"]);
    expect(parsed.images[0]!.path).toBe(".owned/a&b.png");
    expect(parsed.images[0]!.size).toBe(1);
    expect(parsed.images[0]!.sessionId).toBe("owned-session");
    expect(parsed.images[0]!.base64).toBe("YQ==");
    expect(parsed.hasImages).toBe(true);
  });

  test("controls: true unbalanced tags and an invalid body are rejected", () => {
    expect(() => parseTaskWithImages(`<codeshell-image mime="image/png">${dataUrl}`)).toThrow(ImageParseError);
    expect(() => parseTaskWithImages('<codeshell-image mime="image/png">not-data</codeshell-image>')).toThrow(ImageParseError);
    expect(parseTaskWithImages(block).images).toHaveLength(1);
  });

  test("candidate: reversed but equally numerous tags silently return no images", () => {
    const malformed = `</codeshell-image><codeshell-image mime="image/png">${dataUrl}`;
    const parsed = parseTaskWithImages(malformed);
    expect(parsed.text).toBe(malformed);
    expect(parsed.images).toEqual([]);
    expect(parsed.hasImages).toBe(false);
    console.log("IMAGE-R15-C1", JSON.stringify({ input: malformed, output: parsed, normalEncoderProducerEstablished: false }));
  });

  test("same candidate: a valid block plus reversed pair leaves unparsed image marker text", () => {
    const malformedTail = `</codeshell-image><codeshell-image mime="image/png">${dataUrl}`;
    const parsed = parseTaskWithImages(`${block}\n${malformedTail}`);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.hasImages).toBe(true);
    expect(parsed.text).toBe(malformedTail);
  });

  test("ordinary literal opener is explicitly rejected by the existing reserved-marker policy", () => {
    const ordinaryTask = 'Explain the literal string "<codeshell-image" in this source file.';
    expect(() => parseTaskWithImages(ordinaryTask)).toThrow(ImageParseError);
    // Existing parse-task.test.ts pins this rejection. Do not promote as a new
    // correctness bug or treat this as a rerun of the failed Web display route.
  });
});

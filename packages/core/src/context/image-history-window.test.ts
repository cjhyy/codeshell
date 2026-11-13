import { describe, expect, test } from "bun:test";
import type { ContentBlock, Message } from "../types.js";
import { collectBase64Images } from "./compaction.js";
import { ImageHistoryWindow, IMAGE_HISTORY_WINDOW } from "./image-history-window.js";

function imageMessage(data: string): Message {
  return {
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
  };
}

describe("bounded image evidence", () => {
  test("retains evidence across successful requests, expires after six, and does not age on retry", () => {
    const original = imageMessage("original pixels");
    const window = new ImageHistoryWindow();
    window.track(original);
    let messages = [original];
    for (let turn = 0; turn < IMAGE_HISTORY_WINDOW.modelResponses; turn++) {
      expect(window.planBatch(messages).replacedCount).toBe(0);
      messages = window.prepare(messages).messages;
      expect(collectBase64Images(messages)).toHaveLength(1);
      expect(collectBase64Images(window.prepare(messages).messages)).toHaveLength(1);
      messages = window.consume(messages).messages;
    }
    // Expired but within the hard caps: the replacement waits for the rewrite gate.
    expect(collectBase64Images(messages)).toHaveLength(1);
    const batch = window.planBatch(messages);
    expect(batch.forced).toBe(false);
    expect(batch.replacedCount).toBe(1);
    expect(JSON.stringify(batch.messages)).toContain("pixels omitted");
    expect(JSON.stringify(batch.messages)).not.toContain("already provided");
    // Once adopted, the image stays replaced even where its bytes reappear.
    batch.commit();
    expect(collectBase64Images(window.prepare(messages).messages)).toHaveLength(0);
    expect(collectBase64Images([original])).toHaveLength(1);
  });

  test("a hard cap forces the whole pending batch, expired images included", () => {
    const window = new ImageHistoryWindow();
    const old = imageMessage("old pixels");
    window.track(old);
    let messages = [old];
    for (let turn = 0; turn < IMAGE_HISTORY_WINDOW.modelResponses; turn++) {
      messages = window.consume(messages).messages;
    }
    expect(collectBase64Images(messages)).toHaveLength(1);
    const newer = Array.from({ length: 4 }, (_, i) => imageMessage(`new ${i}`));
    newer.forEach((message) => window.track(message));
    messages = [...messages, ...newer];
    // Five images exceed the count cap: the expired one cannot wait for the gate.
    const prepared = window.prepare(messages);
    expect(prepared.forced).toBe(true);
    expect(collectBase64Images(prepared.messages).map((entry) => entry.imageNumber)).toEqual([
      2, 3, 4, 5,
    ]);
    // Already replaced in a request, it stays replaced in the history it came from.
    expect(collectBase64Images(window.consume(messages).messages)).toHaveLength(4);
  });

  test("images from earlier history are deferrable while within the caps", () => {
    const window = new ImageHistoryWindow();
    const earlier = imageMessage("earlier run pixels");
    expect(window.prepare([earlier]).replacedCount).toBe(0);
    const batch = window.planBatch([earlier]);
    expect(batch.forced).toBe(false);
    expect(batch.replacedCount).toBe(1);
  });

  test("fresh batches get one request, then only four newest images remain with stable numbers", () => {
    const window = new ImageHistoryWindow();
    const originals = Array.from({ length: 6 }, (_, i) => imageMessage(`pixels ${i}`));
    originals.forEach((message) => window.track(message));
    expect(collectBase64Images(window.prepare(originals).messages)).toHaveLength(6);
    const retained = window.consume(originals).messages;
    expect(collectBase64Images(retained).map((entry) => entry.imageNumber)).toEqual([3, 4, 5, 6]);
    expect(collectBase64Images(originals)).toHaveLength(6);
  });

  test("bounds encoded bytes and retains no oversized historical payload", () => {
    const window = new ImageHistoryWindow();
    const huge = imageMessage("H".repeat(IMAGE_HISTORY_WINDOW.maxEncodedBytes + 1));
    window.track(huge);
    expect(collectBase64Images(window.prepare([huge]).messages)).toHaveLength(1);
    expect(collectBase64Images(window.consume([huge]).messages)).toHaveLength(0);

    const medium = Array.from({ length: 3 }, () => imageMessage("M".repeat(3 * 1024 * 1024)));
    medium.forEach((message) => window.track(message));
    const retained = window.consume(medium).messages;
    expect(collectBase64Images(retained).map((entry) => entry.imageNumber)).toEqual([2, 3]);
  });

  test("handles nested tool images and survives container copies by preserving block identity", () => {
    const block: ContentBlock = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    } as unknown as ContentBlock;
    const message: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "view", content: [block] }],
    };
    const window = new ImageHistoryWindow();
    window.track(message);
    const cloned: Message = { ...message, content: [...(message.content as ContentBlock[])] };
    const retained = window.consume([cloned]).messages;
    expect(collectBase64Images(retained)[0]?.block).toBe(block);
    expect(window.hasFreshImages).toBe(false);
  });

  test("compaction drops references; old transcript pixels are not silently reactivated", () => {
    const old = imageMessage("old pixels");
    const window = new ImageHistoryWindow();
    window.track(old);
    window.prepare([{ role: "user", content: "compacted history" }]);
    expect(window.hasFreshImages).toBe(false);
    expect(collectBase64Images(window.prepare([old]).messages)).toHaveLength(0);
  });

  test("counts repeated references by serialized occurrences when applying history caps", () => {
    const original = imageMessage("same image pixels");
    const repeated = Array.from({ length: 5 }, () => ({ ...original }));
    const window = new ImageHistoryWindow();
    repeated.forEach((message) => window.track(message));
    expect(collectBase64Images(window.prepare(repeated).messages)).toHaveLength(5);
    expect(collectBase64Images(window.consume(repeated).messages).length).toBeLessThanOrEqual(
      IMAGE_HISTORY_WINDOW.maxImages,
    );

    const large = imageMessage("L".repeat(4 * 1024 * 1024));
    const repeatedLarge = Array.from({ length: 3 }, () => ({ ...large }));
    repeatedLarge.forEach((message) => window.track(message));
    const retainedBytes = collectBase64Images(window.consume(repeatedLarge).messages).reduce(
      (sum, { block }) => sum + (block.source?.data?.length ?? 0),
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(IMAGE_HISTORY_WINDOW.maxEncodedBytes);
  });
});

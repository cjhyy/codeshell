import { beforeEach, describe, expect, test } from "bun:test";
import { ContextManager } from "./manager.js";
import { decideRewriteBatch, resetPromptCacheWarmthForTests } from "./rewrite-gate.js";
import { collectBase64Images } from "./compaction.js";
import { IMAGE_HISTORY_WINDOW, ImageHistoryWindow } from "./image-history-window.js";
import type { ManageOptions } from "./manager.js";
import type { Message } from "../types.js";

const MINUTE = 60_000;

function imageMessage(data: string): Message {
  return {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ],
  };
}

function snapTurn(id: string, content: string): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "browser_observe", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

function prose(tokens: number, seed = "word"): string {
  return `${seed} `.repeat(Math.ceil((tokens * 3) / (seed.length + 1)));
}

/** A window whose single image has aged past `modelResponses`. */
function expiredImage(): { window: ImageHistoryWindow; message: Message } {
  const window = new ImageHistoryWindow();
  const message = imageMessage("expired pixels");
  window.track(message);
  for (let i = 0; i < IMAGE_HISTORY_WINDOW.modelResponses; i++) window.consume([message]);
  return { window, message };
}

type Runner = (
  cm: ContextManager,
  messages: Message[],
  options: ManageOptions,
) => Promise<Message[]>;
const runners: Array<[string, Runner]> = [
  ["manage", async (cm, messages, options) => cm.manage(messages, options)],
  ["manageAsync", (cm, messages, options) => cm.manageAsync(messages, undefined, options)],
];

beforeEach(() => {
  resetPromptCacheWarmthForTests();
});

describe("decideRewriteBatch hard cap", () => {
  test("a forced member applies the batch even when warm and small", () => {
    expect(
      decideRewriteBatch({
        now: 10 * MINUTE,
        lastRequestAt: 10 * MINUTE - 1_000,
        promptCacheTtlMs: 30 * MINUTE,
        pendingSavedTokens: 10,
        totalTokens: 100_000,
        minSavedTokens: 4_000,
        savedRatio: 0.15,
        pressureTokens: 170_000,
        forced: true,
      }),
    ).toBe("hard_cap");
  });
});

for (const [name, run] of runners) {
  describe(`image placeholders join the rewrite batch (${name})`, () => {
    test("warm + within the hard caps → no rewrite; the boundary is the image message", async () => {
      const clock = { now: 1_000_000 };
      const cm = new ContextManager({ maxTokens: 200_000, now: () => clock.now });
      cm.noteModelRequestCompleted();
      const { window, message } = expiredImage();
      const messages: Message[] = [
        { role: "user", content: "start" },
        message,
        { role: "assistant", content: "seen" },
      ];

      const out = await run(cm, messages, { externalRewrite: (m) => window.planBatch(m) });

      expect(out).toEqual(messages);
      expect(out[1]).toBe(message);
      expect(collectBase64Images(out)).toHaveLength(1);
      expect(cm.getPendingRewriteBoundary()).toBe(1);
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(message);
    });

    test("the pending boundary is the earliest of image and text rewrites", async () => {
      const clock = { now: 1_000_000 };
      const cm = new ContextManager({ maxTokens: 200_000, now: () => clock.now });
      cm.noteModelRequestCompleted();
      const { window, message } = expiredImage();
      const messages: Message[] = [
        { role: "user", content: "start" },
        message,
        ...snapTurn("s1", prose(500, "one")),
        ...snapTurn("s2", prose(500, "two")),
      ];
      await run(cm, messages, { externalRewrite: (m) => window.planBatch(m) });
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(message);

      // Image after the pending text rewrite: the text rewrite is earliest.
      const later = expiredImage();
      const reordered: Message[] = [
        { role: "user", content: "start" },
        ...snapTurn("s1", prose(500, "one")),
        ...snapTurn("s2", prose(500, "two")),
        later.message,
      ];
      await run(cm, reordered, { externalRewrite: (m) => later.window.planBatch(m) });
      expect(cm.getPendingRewriteBoundaryMessage()).toBe(reordered[2]);
    });

    test("cold → the image batch is applied with the text batch and committed", async () => {
      const clock = { now: 1_000_000 };
      const cm = new ContextManager({ maxTokens: 200_000, now: () => clock.now });
      cm.noteModelRequestCompleted();
      const { window, message } = expiredImage();
      const messages: Message[] = [
        { role: "user", content: "start" },
        message,
        ...snapTurn("s1", prose(500, "one")),
        ...snapTurn("s2", prose(500, "two")),
      ];

      clock.now += 31 * MINUTE;
      const out = await run(cm, messages, { externalRewrite: (m) => window.planBatch(m) });

      expect(collectBase64Images(out)).toHaveLength(0);
      expect(JSON.stringify(out[1])).toContain("pixels omitted");
      expect(JSON.stringify(out[3])).toContain("collapsed");
      expect(cm.getPendingRewriteBoundary()).toBeUndefined();
      // Committed: the image stays replaced even where its bytes reappear.
      expect(collectBase64Images(window.prepare(messages).messages)).toHaveLength(0);
    });

    test("hard cap exceeded → applied immediately while warm", async () => {
      const clock = { now: 1_000_000 };
      const cm = new ContextManager({ maxTokens: 200_000, now: () => clock.now });
      cm.noteModelRequestCompleted();
      const window = new ImageHistoryWindow();
      const recent = Array.from({ length: IMAGE_HISTORY_WINDOW.maxImages }, (_, i) =>
        imageMessage(`recent ${i}`),
      );
      recent.forEach((message) => window.track(message));
      window.consume(recent);
      // An image from earlier history no longer fits beside four in-window ones.
      const earlier = imageMessage("earlier pixels");
      const sent: Message[] = [{ role: "user", content: "start" }, earlier, ...recent];
      expect(window.planBatch(sent).forced).toBe(true);

      const out = await run(cm, sent, { externalRewrite: (m) => window.planBatch(m) });

      expect(collectBase64Images(out)).toHaveLength(IMAGE_HISTORY_WINDOW.maxImages);
      expect(cm.getPendingRewriteBoundary()).toBeUndefined();
    });
  });
}

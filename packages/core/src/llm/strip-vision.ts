/**
 * History-image stripping for non-vision models.
 *
 * Why this exists: the vision gate in `Engine.run` only rejects *new* image
 * attachments on the current turn. But a conversation can accumulate image
 * content blocks while a vision-capable model is active, then the user
 * switches to a non-vision model (e.g. DeepSeek) mid-session. Those
 * *historical* image blocks are still in the transcript and get re-serialized
 * on every subsequent request — OpenAI-compat backends 400 with
 * `unknown variant 'image_url', expected 'text'`, which then falls back out
 * of streaming and degrades the turn.
 *
 * Fix: when the active model has `supportsVision: false`, replace each
 * message's image blocks with a single text placeholder before the request
 * is built. The transcript/store is untouched — only the outgoing copy is
 * sanitized — so switching back to a vision model still sees the images.
 *
 * Pure function, no I/O. Tested in `strip-vision.test.ts`.
 */

import type { Message, ContentBlock } from "../types.js";

/** Text we substitute for an elided image block. Surfaced to the model so it
 *  knows an image *was* here (vs silently vanishing the context). */
export const VISION_PLACEHOLDER =
  "[图片已省略:当前模型不支持视觉输入]";

/**
 * Return a copy of `messages` with image content blocks replaced by a text
 * placeholder, but only when `supportsVision` is false.
 *
 * Identity-preserving: when vision is supported, or no message carries an
 * image, the original array (and untouched message objects) are returned as-is
 * so callers pay nothing on the common path.
 */
export function stripVisionFromHistory(
  messages: Message[],
  supportsVision: boolean,
): Message[] {
  if (supportsVision) return messages;

  let changed = false;
  const out = messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    if (!msg.content.some((b) => b.type === "image")) return msg;

    changed = true;
    const rebuilt: ContentBlock[] = [];
    let placeholderInserted = false;
    for (const block of msg.content) {
      if (block.type === "image") {
        // Collapse runs of images into a single placeholder per message —
        // five screenshots don't need five identical notes.
        if (!placeholderInserted) {
          rebuilt.push({ type: "text", text: VISION_PLACEHOLDER });
          placeholderInserted = true;
        }
        continue;
      }
      rebuilt.push(block);
    }
    return { ...msg, content: rebuilt };
  });

  return changed ? out : messages;
}

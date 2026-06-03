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
    // Need to process if there's a top-level image, OR a tool_result whose
    // own content array carries a nested image (view_image-produced screenshots
    // live in `tool_result.content: ContentBlock[]`).
    if (!msg.content.some(needsStrip)) return msg;

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
      if (
        block.type === "tool_result" &&
        Array.isArray(block.content) &&
        block.content.some((b) => b.type === "image")
      ) {
        rebuilt.push({ ...block, content: stripImageBlocks(block.content) });
        continue;
      }
      rebuilt.push(block);
    }
    return { ...msg, content: rebuilt };
  });

  return changed ? out : messages;
}

/** True if this block holds an image we must elide — either it *is* an image,
 *  or it's a tool_result whose nested content array contains one. */
function needsStrip(block: ContentBlock): boolean {
  if (block.type === "image") return true;
  return (
    block.type === "tool_result" &&
    Array.isArray(block.content) &&
    block.content.some((b) => b.type === "image")
  );
}

/** Replace image blocks in a ContentBlock[] with a single text placeholder
 *  (consecutive/multiple images collapse to one), preserving other blocks.
 *  Used for both the message top level and nested tool_result.content. */
function stripImageBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const rebuilt: ContentBlock[] = [];
  let placeholderInserted = false;
  for (const block of blocks) {
    if (block.type === "image") {
      if (!placeholderInserted) {
        rebuilt.push({ type: "text", text: VISION_PLACEHOLDER });
        placeholderInserted = true;
      }
      continue;
    }
    rebuilt.push(block);
  }
  return rebuilt;
}

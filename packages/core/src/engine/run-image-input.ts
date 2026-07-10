import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { capabilitiesFor } from "../llm/capabilities/index.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";
import { logger } from "../logging/logger.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { ContentBlock, LLMConfig } from "../types.js";
import { tryCompressImages } from "./image-compression.js";
import {
  byteLengthFromBase64,
  collectAttachedImagePaths,
  dropOversizedImages,
  enforceImagePolicy,
} from "./image-policy.js";
import { buildInputAttachmentContext, type InputAttachmentContext } from "./input-attachments.js";
import { parseTaskWithImages, type ParsedTask } from "./parse-task.js";
import type { EngineResult } from "./types.js";

export interface PreparedRunImageInput {
  parsedTask: ParsedTask;
  taskText: string;
}

export type PrepareRunImageInputResult =
  | ({ ok: true } & PreparedRunImageInput)
  | { ok: false; result: EngineResult };

export async function prepareRunImageInput(args: {
  task: string;
  cwd: string;
  llm: Pick<LLMConfig, "provider" | "providerKind" | "model">;
  sessionId?: string;
  attachments?: readonly InputAttachmentMeta[];
}): Promise<PrepareRunImageInputResult> {
  const { task, cwd, llm, sessionId } = args;

  // Parse `<codeshell-image>` blocks out of the raw task string before
  // any other gate looks at it. Two concerns:
  //   1. The noise detector sees raw base64 as gibberish and would reject the
  //      whole turn — split images out first so it only inspects prose.
  //   2. Models that don't accept vision must be refused immediately, with the
  //      image bytes intact for the user to retry on another model.
  let parsedTask: ParsedTask;
  try {
    parsedTask = parseTaskWithImages(task);
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn("engine.run.image_parse_failed", { error: msg });
    return {
      ok: false,
      result: {
        text: `ERROR: image attachment is malformed (${msg}). Drop the image and try again, or re-attach it.`,
        reason: "image_error",
        sessionId: sessionId ?? "image-parse-failed",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  }

  const cap = capabilitiesFor((llm.providerKind ?? llm.provider) as ProviderKindName, llm.model);
  let attachmentContext: InputAttachmentContext;
  try {
    attachmentContext = await buildInputAttachmentContext(args.attachments, cwd, {
      includeImageBytes: cap.supportsVision,
      expectedSessionId: sessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("engine.run.input_attachment_exception", {
      stage: "build_input_attachment_context",
      attachmentCount: args.attachments?.length ?? 0,
      error: message,
    });
    return {
      ok: false,
      result: {
        text: `ERROR: input attachment could not be prepared (${message}). Re-attach it or choose a path inside the workspace.`,
        reason: "image_error",
        sessionId: sessionId ?? "input-attachment-exception",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  }
  if (attachmentContext.errors.length > 0) {
    const detail = attachmentContext.errors.join("; ");
    logger.warn("engine.run.input_attachment_failed", { error: detail });
    return {
      ok: false,
      result: {
        text: `ERROR: input attachment could not be read (${detail}). Re-attach it or choose a path inside the workspace.`,
        reason: "image_error",
        sessionId: sessionId ?? "input-attachment-failed",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  }
  if (attachmentContext.text || attachmentContext.hasStructuredImageAttachments) {
    parsedTask = {
      text: [parsedTask.text, attachmentContext.text].filter(Boolean).join("\n\n"),
      images: [...parsedTask.images, ...attachmentContext.images],
      hasImages:
        parsedTask.hasImages ||
        attachmentContext.images.length > 0 ||
        attachmentContext.hasStructuredImageAttachments,
    };
  }

  if (parsedTask.hasImages) {
    if (!cap.supportsVision) {
      logger.warn("engine.run.vision_not_supported", {
        provider: llm.provider,
        model: llm.model,
        imageCount: parsedTask.images.length,
      });
      return {
        ok: false,
        result: {
          text:
            `ERROR: model "${llm.model}" does not accept image input. ` +
            `Switch to a vision-capable model (e.g. gpt-4o, claude-sonnet, gemini-1.5-pro) and resend.`,
          reason: "image_error",
          sessionId: sessionId ?? "vision-not-supported",
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      };
    }

    // Size gate. Hosts are expected to pre-compress to IMAGE_TARGETS; this is
    // the last cheap refusal point before a provider request carries the bytes.
    let verdict = enforceImagePolicy(parsedTask.images);
    if (!verdict.ok && verdict.code === "image_too_large") {
      const compressed = await tryCompressImages(parsedTask.images);
      if (compressed.anyCompressed) {
        parsedTask.images = compressed.images;
        logger.info("engine.run.image_compressed", {
          before: verdict.offender?.bytes,
          after: compressed.images.reduce((s, i) => s + byteLengthFromBase64(i.base64), 0),
        });
        verdict = enforceImagePolicy(parsedTask.images);
      }
    }

    // After compression, anything still over the per-image cap is dropped with
    // a textual placeholder so oversized bytes do not poison conversation history.
    if (!verdict.ok && verdict.code === "image_too_large") {
      const drop = dropOversizedImages(parsedTask.images);
      if (drop.droppedCount > 0) {
        parsedTask.images = drop.kept;
        parsedTask.hasImages = drop.kept.length > 0;
        parsedTask.text = drop.placeholder + "\n\n" + parsedTask.text;
        logger.warn("engine.run.image_dropped", {
          droppedCount: drop.droppedCount,
          keptCount: drop.kept.length,
        });
        verdict = enforceImagePolicy(parsedTask.images);
      }
    }

    if (!verdict.ok) {
      logger.warn("engine.run.image_policy_failed", {
        code: verdict.code,
        imageCount: verdict.totals.imageCount,
        totalBytes: verdict.totals.totalBytes,
        offender: verdict.offender,
      });
      return {
        ok: false,
        result: {
          text: `ERROR: ${verdict.message}`,
          reason: "image_error",
          sessionId: sessionId ?? `image-policy-${verdict.code}`,
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      };
    }
  }

  // For downstream noise-detection + transcript persistence we want the text
  // portion only. Image bytes ride in parsedTask.images and re-enter the message
  // tree below.
  const taskText = parsedTask.text;

  return { ok: true, parsedTask, taskText };
}

export function buildRunUserMessageContent(
  parsedTask: ParsedTask,
  cwd: string,
  taskText: string,
): string | ContentBlock[] {
  // Compose the user-turn payload once so resume + cold paths agree on shape.
  // When an attached image came from a workspace file, surface that path to the
  // model as text so file-oriented tools can use the real on-disk path.
  const attachedPaths = collectAttachedImagePaths(
    parsedTask.images,
    (name) => (isAbsolute(name) ? name : join(cwd, name)),
    existsSync,
  );
  const pathHint =
    attachedPaths.length > 0
      ? `\n\n<attached-image-paths>\n${attachedPaths.join("\n")}\n</attached-image-paths>\n` +
        `(上面附带的图片在工作区的真实路径，如需把它们作为工具输入（例如 GenerateImage 的 referenceImages、图生图参考图），直接使用这些路径。)`
      : "";

  const userMessageContent: string | ContentBlock[] = parsedTask.hasImages
    ? [
        ...(parsedTask.text || pathHint
          ? [{ type: "text" as const, text: `${parsedTask.text}${pathHint}` }]
          : []),
        ...parsedTask.images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mime,
            data: img.base64,
          },
        })),
      ]
    : taskText;
  logger.info("engine.run.user_message_content_built", {
    contentShape: Array.isArray(userMessageContent) ? "content_blocks" : "text",
    textBlockCount: Array.isArray(userMessageContent)
      ? userMessageContent.filter((block) => block.type === "text").length
      : userMessageContent
        ? 1
        : 0,
    imageBlockCount: Array.isArray(userMessageContent)
      ? userMessageContent.filter((block) => block.type === "image").length
      : 0,
    attachedPathCount: attachedPaths.length,
    textLength: taskText.length,
  });
  return userMessageContent;
}

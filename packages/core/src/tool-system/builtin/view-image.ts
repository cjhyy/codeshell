/**
 * Built-in view_image tool — 把一个本地图片文件或历史图片以 base64 image
 * ContentBlock 回传进上下文,让 vision 模型「看」它(对照 codex 的 view_image)。
 *
 * 典型用法:模型先写 SVG/Mermaid 并用 shell 转成 PNG,再调 view_image(png)
 * 检查图画对没有(标签是否重叠、文字是否溢出),不对就改源再重转。
 *
 * 三道闸门,避免污染上下文 / 浪费 token:
 *   1. vision gate —— 当前模型不支持视觉时不读文件,只回文字占位。
 *   2. 格式 gate —— 只支持 png/jpeg/gif/webp(provider image 块能吃的);
 *      svg/pdf 等回文字提示「先转 PNG」。
 *   3. 大小 gate —— 超过 MAX_BYTES 回文字提示,不读进 base64。
 */

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import type { BuiltinToolReturn } from "./index.js";
import { capabilitiesFor } from "../../llm/capabilities/index.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";
import { collectBase64Images, findImageByNumber } from "../../context/compaction.js";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB —— vision 模型按 tile 计 token,大图无益且撑大请求

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const viewImageToolDef: ToolDefinition = {
  name: "view_image",
  description:
    "Load an image into the conversation so you can SEE it (vision). Pass path to view a " +
    "workspace image file, or pass imageNumber to retrieve the original image behind an " +
    "earlier [image #N, already provided] history placeholder. Use exactly one of path or " +
    "imageNumber. File paths support PNG/JPEG/GIF/WebP only; convert SVG/PDF to PNG first. " +
    "Requires a vision-capable model; otherwise the image is skipped.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the image file (absolute, or relative to the working directory).",
      },
      imageNumber: {
        type: "number",
        description:
          "Image history number N from an earlier [image #N, already provided] placeholder.",
      },
      detail: {
        type: "string",
        enum: ["low", "standard", "high"],
        description:
          "Optional image detail preference. Accepted for compatibility; current providers use the runtime image detail default.",
      },
    },
  },
};

export async function viewImageTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<BuiltinToolReturn> {
  const rawPath = args.path;
  const rawImageNumber = args.imageNumber;
  const hasPath = typeof rawPath === "string" && rawPath.trim().length > 0;
  const hasImageNumber = rawImageNumber !== undefined && rawImageNumber !== null;

  if (hasPath === hasImageNumber) {
    return "Error: provide exactly one of path or imageNumber";
  }
  const detail = args.detail;
  if (detail !== undefined && detail !== "low" && detail !== "standard" && detail !== "high") {
    return "Error: detail must be one of low, standard, high";
  }

  if (hasImageNumber) {
    if (
      typeof rawImageNumber !== "number" ||
      !Number.isSafeInteger(rawImageNumber) ||
      rawImageNumber <= 0
    ) {
      return "Error: imageNumber must be a positive integer";
    }
    return viewHistoricalImage(rawImageNumber, ctx);
  }

  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return "Error: path must be a non-empty string";
  }
  const cwd = ctx?.cwd ?? process.cwd();
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  // 闸门 1:vision gate —— 不支持视觉就不读文件。
  // 缺 llmConfig 时按「非视觉」处理(fail closed),对齐 DEFAULT_CAPABILITY
  // 的保守姿态:运行时 ToolContext.llmConfig 必有,缺失只发生在测试 / 异常
  // 装配下,此时绝不把 base64 读进上下文。
  if (!supportsVision(ctx)) {
    return `[图片未加载: ${abs} —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再 view_image。]`;
  }

  // 闸门 2:格式 gate
  const ext = extname(abs).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) {
    return `[图片未加载: ${abs} —— 格式 ${ext || "(无扩展名)"} 不支持视觉预览,请先转成 PNG/JPEG。]`;
  }

  // 闸门 3:大小 gate(读 stat,不读全文件)
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch (err) {
    return `Error: 无法读取 ${abs}: ${(err as Error).message}`;
  }
  if (size > MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return `[图片未加载: ${abs} —— 文件过大 (${mb} MB > 5 MB),请先压缩或缩放再 view_image。]`;
  }

  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    return `Error: 无法读取 ${abs}: ${(err as Error).message}`;
  }

  const data = buf.toString("base64");
  const kb = Math.round(buf.length / 1024);
  return {
    contentBlocks: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }],
    result: `[已加载图片: ${abs} (${mediaType}, ${kb} KB)]`,
  };
}

function supportsVision(ctx?: ToolContext): boolean {
  if (!ctx?.llmConfig) return false;
  const kind = (ctx.llmConfig.providerKind ?? ctx.llmConfig.provider) as ProviderKindName;
  return capabilitiesFor(kind, ctx.llmConfig.model).supportsVision;
}

async function viewHistoricalImage(
  imageNumber: number,
  ctx?: ToolContext,
): Promise<BuiltinToolReturn> {
  if (!supportsVision(ctx)) {
    return `[图片未取回: image #${imageNumber} —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再 view_image。]`;
  }

  const sessionManager = ctx?.engine?.getSessionManager?.();
  const sessionId = ctx?.sessionId;
  if (!sessionManager || !sessionId) {
    return `Error: 无法取回 image #${imageNumber}: 当前工具上下文没有可读取的 session 历史。`;
  }

  let messages;
  try {
    messages = sessionManager.resume(sessionId).transcript.toMessages();
  } catch (err) {
    return `Error: 无法读取 session 历史以取回 image #${imageNumber}: ${(err as Error).message}`;
  }

  const images = collectBase64Images(messages);
  const found = findImageByNumber(messages, imageNumber);
  if (!found) {
    return `Error: 未找到 image #${imageNumber}; 当前 session 历史中共有 ${images.length} 张可取回图片。`;
  }

  const block = normalizeImageBlockForReturn(found.block);
  const size = decodedImageBlockBytes(block);
  if (size !== undefined && size > MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return `[图片未取回: image #${imageNumber} —— 图片过大 (${mb} MB > 5 MB),请先压缩或缩放原图。]`;
  }

  const kb = size === undefined ? "unknown" : String(Math.round(size / 1024));
  const mediaType = mediaTypeOfImageBlock(block) ?? "base64 image";
  return {
    contentBlocks: [block],
    result: `[已取回 image #${imageNumber}: ${mediaType}, ${kb} KB]`,
  };
}

function normalizeImageBlockForReturn(
  block: import("../../types.js").ContentBlock,
): import("../../types.js").ContentBlock {
  if (block.type === "image" && block.source?.type === "base64") return block;
  const source = openAIDataUrlImageSource(block);
  return source ? { type: "image", source } : block;
}

function decodedImageBlockBytes(block: import("../../types.js").ContentBlock): number | undefined {
  const data = base64DataOfImageBlock(block);
  if (!data) return undefined;
  return Buffer.byteLength(data, "base64");
}

function base64DataOfImageBlock(block: import("../../types.js").ContentBlock): string | undefined {
  if (block.type === "image" && block.source?.type === "base64") {
    return block.source.data;
  }
  return openAIDataUrlImageSource(block)?.data;
}

function mediaTypeOfImageBlock(block: import("../../types.js").ContentBlock): string | undefined {
  if (block.type === "image" && block.source?.type === "base64") {
    return block.source.media_type;
  }
  return openAIDataUrlImageSource(block)?.media_type;
}

function openAIDataUrlImageSource(
  block: import("../../types.js").ContentBlock,
): { type: "base64"; media_type: string; data: string } | undefined {
  const maybeOpenAI = block as unknown as { type?: string; image_url?: { url?: string } };
  const match = maybeOpenAI.image_url?.url?.match(/^data:(image\/[^;,]+);base64,(.+)$/i);
  if (maybeOpenAI.type !== "image_url" || !match?.[1] || !match[2]) return undefined;
  return { type: "base64", media_type: match[1], data: match[2] };
}

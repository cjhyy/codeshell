/**
 * Built-in view_image tool — 把一个本地图片文件以 base64 image ContentBlock
 * 回传进上下文,让 vision 模型「看」它(对照 codex 的 view_image)。
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
import type { BuiltinToolResult } from "./index.js";
import { capabilitiesFor } from "../../llm/capabilities/index.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";

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
    "Load a local image file into the conversation so you can SEE it (vision). " +
    "Use after generating or rendering an image (e.g. SVG/Mermaid → PNG) to verify it " +
    "looks right — check for overlapping labels, clipped text, wrong layout — then fix the " +
    "source and re-render if needed. Supports PNG/JPEG/GIF/WebP only; convert SVG/PDF to PNG " +
    "first. Requires a vision-capable model; otherwise the image is skipped.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the image file (absolute, or relative to the working directory).",
      },
    },
    required: ["path"],
  },
};

export async function viewImageTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<BuiltinToolResult> {
  const rawPath = args.path;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return "Error: path is required";
  }

  const cwd = ctx?.cwd ?? process.cwd();
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  // 闸门 1:vision gate —— 不支持视觉就不读文件
  if (ctx?.llmConfig) {
    const kind = (ctx.llmConfig.providerKind ?? ctx.llmConfig.provider) as ProviderKindName;
    const cap = capabilitiesFor(kind, ctx.llmConfig.model);
    if (!cap.supportsVision) {
      return `[图片未加载: ${abs} —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再 view_image。]`;
    }
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
    contentBlocks: [
      { type: "image", source: { type: "base64", media_type: mediaType, data } },
    ],
    result: `[已加载图片: ${abs} (${mediaType}, ${kb} KB)]`,
  };
}

/**
 * Built-in Read file tool.
 */

import { createHash } from "node:crypto";
import { readFile, stat, open } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { fileCache } from "./file-cache.js";
import { toLf } from "./eol.js";

export const readToolDef: ToolDefinition = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns the file content with line numbers. " +
    "By default reads up to 2000 lines from the beginning. " +
    "Use offset and limit to read specific portions of large files. " +
    "For images and binary files, returns path/metadata instead of raw bytes. " +
    "For large text files, consider using Grep first to find the relevant lines.\n\n" +
    "Do NOT re-read a file you just edited to verify — Edit/Write would have errored " +
    "if the change failed.\n" +
    "Do NOT re-read a file (or the same range of a file) you've already read earlier in " +
    "this conversation. The content is already in your context. If you need a different " +
    "part of the file, read a different offset; otherwise decide with what you have.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to read" },
      offset: { type: "number", description: "Line number to start reading from (1-based)" },
      limit: { type: "number", description: "Number of lines to read (default: 2000)" },
    },
    required: ["file_path"],
  },
};

const MAX_CONTENT_CHARS = 200_000;
const LARGE_TEXT_BYTES = 5 * 1024 * 1024;
const SAMPLE_BYTES = 8192;

const IMAGE_EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function readTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const rawPath = args.file_path as string;
  if (!rawPath) return "Error: file_path is required";
  const cwd = ctx?.cwd ?? process.cwd();
  const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  try {
    // Get file info first
    const fileInfo = await stat(filePath);
    const sizeKB = Math.round(fileInfo.size / 1024);
    const sample = await readSample(filePath, Math.min(fileInfo.size, SAMPLE_BYTES));
    const binary = detectBinary(filePath, sample);
    if (binary) {
      const sha256 = await sha256File(filePath);
      return formatBinaryReadResult({
        filePath,
        cwd,
        size: fileInfo.size,
        sha256,
        mime: binary.mime,
        isImage: binary.kind === "image",
      });
    }

    // Skip binary or excessively large files
    if (fileInfo.size > LARGE_TEXT_BYTES) {
      return `Error: File is too large (${sizeKB}KB). Use Grep to search for specific content, or provide offset and limit to read a portion.`;
    }

    // Try cache first, fall back to disk read
    let content = await fileCache.get(filePath);
    if (content === null) {
      content = await readFile(filePath, "utf-8");
      fileCache.set(filePath, content, fileInfo.mtimeMs);
    }
    // Split on LF after normalizing CRLF → LF so a Windows (CRLF) file doesn't
    // render a trailing ^M on every line. Display-only; the file isn't written.
    const lines = toLf(content).split("\n");
    const totalLines = lines.length;
    const offset = Math.max(1, (args.offset as number) || 1);
    // A non-positive limit (a misbehaving caller passing 0 / -5 / NaN) falls back
    // to the default page size — NOT through to `lines.slice(start, start+limit)`
    // with a NEGATIVE end, which JS reads as "all but the last N" and would
    // silently return the wrong window. `|| 2000` only caught 0/NaN, not negatives.
    const rawLimit = args.limit as number;
    const limit = typeof rawLimit === "number" && rawLimit > 0 ? rawLimit : 2000;
    const end = Math.min(totalLines, offset - 1 + limit);
    const selected = lines.slice(offset - 1, end);

    let numbered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");

    // Truncate if too much content
    if (numbered.length > MAX_CONTENT_CHARS) {
      numbered = numbered.slice(0, MAX_CONTENT_CHARS) + "\n\n... content truncated";
    }

    // Add file metadata header
    let header = "";
    if (totalLines > limit || offset > 1) {
      header = `[${filePath} — ${totalLines} lines total, showing ${offset}-${end}]\n`;
    }

    return header + (numbered || "(empty file)");
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}

async function readSample(filePath: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function detectBinary(
  filePath: string,
  sample: Buffer,
): { kind: "image" | "binary"; mime?: string } | null {
  const imageMime = detectImageMime(filePath, sample);
  if (imageMime) return { kind: "image", mime: imageMime };
  if (sample.length === 0) return null;
  if (sample.includes(0)) return { kind: "binary" };
  try {
    // `stream: true` tolerates a multi-byte UTF-8 char truncated by the sample
    // boundary (e.g. a CJK char split at byte 8192). Without it, a valid UTF-8
    // text file gets misdetected as binary whenever the sample cut lands mid-char.
    // A genuinely invalid byte in the MIDDLE of the sample still throws.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
  } catch {
    return { kind: "binary" };
  }
  let controls = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controls += 1;
  }
  return controls > Math.max(8, sample.length * 0.01) ? { kind: "binary" } : null;
}

function detectImageMime(filePath: string, sample: Buffer): string | undefined {
  if (
    sample.length >= 8 &&
    sample[0] === 0x89 &&
    sample[1] === 0x50 &&
    sample[2] === 0x4e &&
    sample[3] === 0x47 &&
    sample[4] === 0x0d &&
    sample[5] === 0x0a &&
    sample[6] === 0x1a &&
    sample[7] === 0x0a
  ) {
    return "image/png";
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return "image/jpeg";
  }
  const header = sample.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  return IMAGE_EXT_MIME[extname(filePath).toLowerCase()];
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function formatBinaryReadResult(input: {
  filePath: string;
  cwd: string;
  size: number;
  sha256: string;
  mime?: string;
  isImage: boolean;
}): string {
  const path = displayPath(input.filePath, input.cwd);
  const lines = [
    input.isImage ? "Image file (not displayed by Read)." : "Binary file (not displayed by Read).",
    `Path: ${path}`,
    `Absolute path: ${input.filePath}`,
    ...(input.mime ? [`MIME: ${input.mime}`] : []),
    `Size: ${input.size} bytes`,
    `SHA-256: ${input.sha256}`,
  ];
  if (input.isImage) {
    lines.push(`Use view_image({ path: "${path}" }) to inspect pixels.`);
  }
  return lines.join("\n");
}

function displayPath(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    return sep === "\\" ? rel.replace(/\\/g, "/") : rel;
  }
  return filePath;
}

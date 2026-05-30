/**
 * /image — attach a local image file to the next user message.
 *
 * Why
 * ---
 * The desktop UI has paste + drag-drop for images, but the TUI runs in a
 * terminal that can't accept image data through stdin. The escape hatch
 * is a slash command that reads a path off disk, base64-encodes the
 * bytes, and queues them for the next `submitToEngine` call to wrap in
 * the same `<codeshell-image>` blocks the desktop already uses.
 *
 * Behavior
 * --------
 *   /image                          → list currently queued images
 *   /image <path>                   → stage one image
 *   /image <path1> <path2> …        → stage several (one per arg)
 *   /image clear                    → drop the queue
 *
 * Sizing: this command does NOT compress. The engine's image-policy gate
 * (packages/core/src/engine/image-policy.ts) refuses oversize bytes with
 * a clear Chinese message telling the user to compress first. TUI users
 * are power users who can run `cwebp` / `magick convert` themselves; we
 * keep the TUI dep tree free of native image codecs.
 */

import type { SlashCommand } from "../registry.js";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, basename } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function detectMime(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

/**
 * Format a byte count compactly for status output. Mirrors the engine's
 * `fmtMB` so users see consistent units across UIs.
 */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Read one path from disk and return a wire-format `<codeshell-image>`
 * block ready to be prepended to a user message. Throws with a user-
 * friendly message on any failure — the caller surfaces via addStatus.
 */
function readImageBlock(rawPath: string, cwd: string): string {
  const path = resolve(cwd, rawPath);
  const mime = detectMime(path);
  if (!mime) {
    throw new Error(
      `不支持的图片扩展名：${basename(path)}。请用 .png / .jpg / .jpeg / .webp / .gif。`,
    );
  }
  let bytes: Buffer;
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("不是文件");
    size = st.size;
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(`读取失败：${path}（${(err as Error).message}）`, { cause: err });
  }
  const base64 = bytes.toString("base64");
  const name = basename(path);
  // Wire format mirrors `packages/desktop/src/renderer/chat/attachments.ts`
  // so the engine's parse-task.ts handles both UIs identically.
  return [
    `<codeshell-image mime="${mime}" name="${escapeAttr(name)}">`,
    `data:${mime};base64,${base64}`,
    `</codeshell-image>`,
    `[${name}, ${fmtBytes(size)}]`,
  ].join("\n");
}

export const imageCommand: SlashCommand = {
  name: "/image",
  aliases: ["/img"],
  group: "core",
  description: "Attach one or more local images to the next user message",
  usage: "/image <path> [more paths...]   |   /image           |   /image clear",
  execute: (arg, ctx) => {
    const queue = ctx.pendingImages;
    if (!queue) {
      ctx.addStatus(
        "图片功能在当前 TUI 版本未启用（CommandContext 缺少 pendingImages）。",
      );
      return;
    }
    const trimmed = arg.trim();
    if (trimmed === "") {
      if (queue.list().length === 0) {
        ctx.addStatus("当前没有暂存的图片。用法： /image <路径>");
      } else {
        const lines = queue.list().map((s, i) => {
          // Each stored block ends with a "[name, size]" caption line —
          // surface that instead of the multi-MB base64 above it.
          const caption = s.trimEnd().split("\n").at(-1) ?? "(image)";
          return `  ${i + 1}. ${caption}`;
        });
        ctx.addStatus(
          `已暂存 ${queue.list().length} 张图片（下一条消息发送时会自动附上）:\n${lines.join("\n")}`,
        );
      }
      return;
    }
    if (trimmed === "clear" || trimmed === "reset") {
      const n = queue.list().length;
      queue.clear();
      ctx.addStatus(`已清空暂存图片（${n} 张）。`);
      return;
    }
    // Split arg on whitespace, but allow paths quoted with "double quotes"
    // for filenames containing spaces. Keep this simple — POSIX-style
    // shell quoting is out of scope.
    const paths = parsePaths(trimmed);
    let added = 0;
    for (const p of paths) {
      try {
        const block = readImageBlock(p, ctx.cwd);
        queue.add(block);
        added++;
        // Echo each accepted image as a status line. The caption (last
        // line of the block) is the human-friendly "[name, size]".
        const caption = block.trimEnd().split("\n").at(-1) ?? p;
        ctx.addStatus(`✓ 已暂存 ${caption}`);
      } catch (err) {
        ctx.addStatus(`✗ ${(err as Error).message}`);
      }
    }
    if (added > 0) {
      ctx.addStatus(`下一条消息发送时会附上这 ${queue.list().length} 张图片。`);
    }
  },
};

/**
 * Split a quoted/unquoted path argument string into individual paths.
 *
 *   `/image foo.png bar.jpg`           → ["foo.png", "bar.jpg"]
 *   `/image "name with spaces.png"`    → ["name with spaces.png"]
 *
 * Exported for unit tests.
 */
export function parsePaths(arg: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < arg.length) {
    while (i < arg.length && /\s/.test(arg[i]!)) i++;
    if (i >= arg.length) break;
    if (arg[i] === '"') {
      i++;
      const start = i;
      while (i < arg.length && arg[i] !== '"') i++;
      out.push(arg.slice(start, i));
      if (i < arg.length) i++; // skip closing quote
    } else {
      const start = i;
      while (i < arg.length && !/\s/.test(arg[i]!)) i++;
      out.push(arg.slice(start, i));
    }
  }
  return out;
}

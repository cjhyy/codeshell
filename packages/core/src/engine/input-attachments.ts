import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { logger } from "../logging/logger.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import { classifyPath } from "../tool-system/path-policy.js";
import { enforceImageBytePolicy } from "./image-policy.js";
import type { ParsedImage } from "./parse-task.js";

export interface InputAttachmentContext {
  text: string;
  images: ParsedImage[];
  errors: string[];
  hasStructuredImageAttachments: boolean;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_DIRECTORY_TREE_ENTRIES = 200;
const MAX_DIRECTORY_TREE_DEPTH = 2;

export interface BuildInputAttachmentContextOptions {
  includeImageBytes?: boolean;
  expectedSessionId?: string;
}

interface PendingImageAttachment {
  attachment: InputAttachmentMeta;
  displayPath: string;
  realPath: string;
  mime: string;
  size: number;
  diagnostic: AttachmentDiagnostic;
}

interface AttachmentDiagnostic {
  index: number;
  id: string;
  kind: string;
  path: string | null;
  mime: string | null;
  stage: string;
}

export async function buildInputAttachmentContext(
  attachments: readonly InputAttachmentMeta[] | undefined,
  cwd: string,
  options: BuildInputAttachmentContextOptions = {},
): Promise<InputAttachmentContext> {
  if (!attachments || attachments.length === 0) {
    return { text: "", images: [], errors: [], hasStructuredImageAttachments: false };
  }

  const cwdReal = await realpath(cwd);
  const includeImageBytes = options.includeImageBytes ?? true;
  const expectedSessionId = options.expectedSessionId;
  const textBlocks: string[] = [];
  const images: ParsedImage[] = [];
  const errors: string[] = [];
  const pendingImages: PendingImageAttachment[] = [];
  const diagnostics: AttachmentDiagnostic[] = [];
  let hasStructuredImageAttachments = false;

  logger.info("engine.run.input_attachments.start", {
    attachmentCount: attachments.length,
    expectedSessionId: expectedSessionId ?? null,
    includeImageBytes,
  });

  if (!expectedSessionId) {
    logger.warn("engine.run.input_attachments.invalid_session", {
      attachmentCount: attachments.length,
      reason: "missing_expected_session_id",
    });
    return {
      text: "",
      images: [],
      errors: ["input attachments require an expected sessionId"],
      hasStructuredImageAttachments: false,
    };
  }
  if (!isSafeSessionPathSegment(expectedSessionId)) {
    logger.warn("engine.run.input_attachments.invalid_session", {
      attachmentCount: attachments.length,
      reason: "unsafe_expected_session_id",
    });
    return {
      text: "",
      images: [],
      errors: [`expected sessionId "${expectedSessionId}" is not a safe path segment`],
      hasStructuredImageAttachments: false,
    };
  }

  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment !== "object") {
      errors.push(`attachment at index ${index} is not an object`);
      diagnostics.push({
        index,
        id: "(unknown)",
        kind: typeof attachment,
        path: null,
        mime: null,
        stage: "invalid_metadata",
      });
      continue;
    }
    const id = stringField(attachment.id) ?? "(unknown)";
    const kind = stringField(attachment.kind) ?? "(unknown)";
    const declaredMime = stringField(attachment.mime);
    const displayPath = firstString(attachment.path, attachment.relPath, attachment.absPath);
    if (!displayPath) {
      errors.push(`attachment ${id} has no valid path`);
      diagnostics.push({
        index,
        id,
        kind,
        path: null,
        mime: declaredMime ?? null,
        stage: "invalid_path_metadata",
      });
      continue;
    }
    if (attachment.sessionId !== expectedSessionId) {
      errors.push(
        `attachment ${id === "(unknown)" ? displayPath : id} session mismatch: expected ${expectedSessionId}, got ${attachment.sessionId}`,
      );
      diagnostics.push({
        index,
        id,
        kind,
        path: displayPath,
        mime: declaredMime ?? null,
        stage: "session_mismatch",
      });
      continue;
    }

    const resolved = resolveAttachmentPath(attachment, cwd, displayPath);
    let info;
    try {
      info = await stat(resolved);
    } catch (err) {
      errors.push(
        `attachment ${id === "(unknown)" ? displayPath : id} stat failed: ${(err as Error).message}`,
      );
      diagnostics.push({
        index,
        id,
        kind,
        path: displayPath,
        mime: declaredMime ?? null,
        stage: "stat_failed",
      });
      continue;
    }

    const policy = classifyPath(resolved, { workspaceRoot: cwdReal, operation: "read" });
    if (policy.decision !== "allow") {
      errors.push(
        `attachment ${id === "(unknown)" ? displayPath : id} blocked by path policy: ${policy.reason}`,
      );
      diagnostics.push({
        index,
        id,
        kind,
        path: displayPath,
        mime: declaredMime ?? null,
        stage: "path_policy_blocked",
      });
      continue;
    }
    const realPath = policy.resolvedPath;
    const stagedPathError = await validateStagedAttachmentPath(
      attachment,
      realPath,
      cwdReal,
      expectedSessionId,
      displayPath,
    );
    if (stagedPathError) {
      errors.push(stagedPathError);
      diagnostics.push({
        index,
        id,
        kind,
        path: displayPath,
        mime: declaredMime ?? null,
        stage: "staged_path_blocked",
      });
      continue;
    }

    if (attachment.kind === "directory" || info.isDirectory()) {
      const tree = await directoryTree(realPath, cwdReal).catch((err) => ({
        lines: [`(directory tree unavailable: ${(err as Error).message})`],
        truncated: true,
        entryCount: 0,
      }));
      textBlocks.push(
        [
          `<attached-directory path="${escapeText(displayPath)}" entries="${tree.entryCount}" truncated="${tree.truncated}">`,
          ...tree.lines,
          `</attached-directory>`,
        ].join("\n"),
      );
      diagnostics.push({
        index,
        id,
        kind: "directory",
        path: displayPath,
        mime: declaredMime ?? null,
        stage: tree.truncated ? "directory_metadata_truncated" : "directory_metadata",
      });
      continue;
    }

    if (!info.isFile()) {
      errors.push(
        `attachment ${id === "(unknown)" ? displayPath : id} is not a regular file or directory`,
      );
      diagnostics.push({
        index,
        id,
        kind,
        path: displayPath,
        mime: declaredMime ?? null,
        stage: "unsupported_filesystem_entry",
      });
      continue;
    }

    const mime = declaredMime || IMAGE_MIME_BY_EXT[extname(realPath).toLowerCase()];
    if (attachment.kind === "image") {
      hasStructuredImageAttachments = true;
      if (!includeImageBytes || attachment.vision?.include === false) {
        textBlocks.push(formatFileMetadata(attachment, displayPath, realPath, info.size, mime));
        diagnostics.push({
          index,
          id,
          kind,
          path: displayPath,
          mime: mime ?? null,
          stage: "image_metadata_only",
        });
        continue;
      }
      if (
        !mime ||
        !mime.startsWith("image/") ||
        !IMAGE_MIME_BY_EXT[extname(realPath).toLowerCase()]
      ) {
        errors.push(
          `image attachment ${id === "(unknown)" ? displayPath : id} has unsupported image type`,
        );
        diagnostics.push({
          index,
          id,
          kind,
          path: displayPath,
          mime: mime ?? null,
          stage: "unsupported_image_type",
        });
        continue;
      }
      const diagnostic: AttachmentDiagnostic = {
        index,
        id,
        kind,
        path: displayPath,
        mime,
        stage: "image_pending_bytes",
      };
      pendingImages.push({
        attachment,
        displayPath,
        realPath,
        mime,
        size: info.size,
        diagnostic,
      });
      diagnostics.push(diagnostic);
      continue;
    }

    textBlocks.push(formatFileMetadata(attachment, displayPath, realPath, info.size, mime));
    diagnostics.push({
      index,
      id,
      kind,
      path: displayPath,
      mime: mime ?? null,
      stage: "file_metadata",
    });
  }

  if (errors.length === 0 && includeImageBytes && pendingImages.length > 0) {
    const verdict = enforceImageBytePolicy(
      pendingImages.map((image) => ({
        name: image.attachment.originalName || image.displayPath,
        mime: image.mime,
        bytes: image.size,
      })),
    );
    if (!verdict.ok) {
      errors.push(`image attachment size policy failed: ${verdict.message}`);
      for (const diagnostic of diagnostics) {
        if (diagnostic.stage === "image_pending_bytes") {
          diagnostic.stage = "image_size_policy_failed";
        }
      }
    } else {
      for (const image of pendingImages) {
        let bytes: Buffer;
        try {
          bytes = await readFile(image.realPath);
        } catch (err) {
          errors.push(
            `image attachment ${
              image.attachment.id || image.displayPath
            } read failed: ${(err as Error).message}`,
          );
          image.diagnostic.stage = "image_read_failed";
          continue;
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const base64 = bytes.toString("base64");
        images.push({
          mime: image.mime,
          name: image.attachment.originalName || image.displayPath,
          dataUrl: `data:${image.mime};base64,${base64}`,
          base64,
          path: image.displayPath,
          hash: `sha256:${sha256}`,
          size: image.size,
          origin: image.attachment.origin,
          sessionId: image.attachment.sessionId,
        });
        image.diagnostic.stage = "image_bytes_loaded";
      }
    }
  }

  logger.info("engine.run.input_attachments.complete", {
    attachmentCount: attachments.length,
    textBlockCount: textBlocks.length,
    imageCount: images.length,
    errorCount: errors.length,
    attachments: diagnostics,
  });

  return { text: textBlocks.join("\n\n"), images, errors, hasStructuredImageAttachments };
}

function resolveAttachmentPath(
  attachment: InputAttachmentMeta,
  cwd: string,
  displayPath: string,
): string {
  const visionPath =
    attachment.vision && typeof attachment.vision === "object"
      ? stringField(attachment.vision.mediaPath)
      : undefined;
  const candidate =
    visionPath ??
    firstString(attachment.absPath, attachment.relPath, attachment.path) ??
    displayPath;
  if (isAbsolute(candidate)) return candidate;
  return resolve(cwd, candidate);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function validateStagedAttachmentPath(
  attachment: InputAttachmentMeta,
  realPath: string,
  cwdReal: string,
  expectedSessionId: string,
  displayPath: string,
): Promise<string | undefined> {
  if (!isStagedAttachmentReference(attachment, realPath, cwdReal)) return undefined;
  const expectedDir = resolve(cwdReal, ".code-shell", "attachments", expectedSessionId);
  let expectedDirReal: string;
  try {
    expectedDirReal = await realpath(expectedDir);
  } catch (err) {
    return `attachment ${attachment.id || displayPath} staged session directory is unavailable: ${
      (err as Error).message
    }`;
  }
  if (isPathInside(realPath, expectedDirReal)) return undefined;
  return `attachment ${
    attachment.id || displayPath
  } staged path is outside .code-shell/attachments/${expectedSessionId}`;
}

function isStagedAttachmentReference(
  attachment: InputAttachmentMeta,
  realPath: string,
  cwdReal: string,
): boolean {
  const fields = [
    attachment.path,
    attachment.absPath,
    attachment.relPath,
    attachment.vision?.mediaPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (fields.some((value) => looksLikeStagedAttachmentPath(value))) return true;
  return isPathInside(realPath, resolve(cwdReal, ".code-shell", "attachments"));
}

function looksLikeStagedAttachmentPath(value: string): boolean {
  const normalized = normalizePath(value);
  return (
    normalized === ".code-shell/attachments" ||
    normalized.startsWith(".code-shell/attachments/") ||
    normalized.includes("/.code-shell/attachments/")
  );
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function isSafeSessionPathSegment(sessionId: string): boolean {
  if (!sessionId) return false;
  return (
    !sessionId.includes("/") && !sessionId.includes("\\") && sessionId !== "." && sessionId !== ".."
  );
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatFileMetadata(
  attachment: InputAttachmentMeta,
  displayPath: string,
  realPath: string,
  size: number,
  mime?: string,
): string {
  const lines = [
    `<attached-file path="${escapeText(displayPath)}">`,
    `absolutePath: ${realPath}`,
    ...(mime ? [`mime: ${mime}`] : []),
    `size: ${size}`,
    `sha256: ${attachment.sha256}`,
    `origin: ${attachment.origin}`,
    `</attached-file>`,
  ];
  return lines.join("\n");
}

async function directoryTree(
  dir: string,
  cwdReal: string,
): Promise<{ lines: string[]; truncated: boolean; entryCount: number }> {
  const lines: string[] = [];
  let entryCount = 0;
  let truncated = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (entryCount >= MAX_DIRECTORY_TREE_ENTRIES) {
      truncated = true;
      return;
    }
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entryCount >= MAX_DIRECTORY_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = join(current, entry.name);
      const real = await realpath(abs).catch(() => null);
      if (!real) continue;
      const rel = relative(cwdReal, real);
      if (rel === ".." || rel.startsWith(`..${sep}`)) continue;
      entryCount += 1;
      lines.push(`${"  ".repeat(depth)}${entry.isDirectory() ? "dir " : "file "}${slash(rel)}`);
      if (entry.isDirectory() && depth + 1 < MAX_DIRECTORY_TREE_DEPTH) {
        await walk(real, depth + 1);
      }
    }
  }

  await walk(dir, 0);
  return { lines, truncated, entryCount };
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function slash(value: string): string {
  return sep === "\\" ? value.replace(/\\/g, "/") : value;
}

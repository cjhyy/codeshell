import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ImageReadContext {
  cwd?: string;
  sessionId?: string;
}

const IMG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REPLY_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const FILE_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".amr": "audio/amr",
  ".silk": "audio/silk",
};

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".3gp": "video/3gpp",
};

const OUTGOING_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BLOCKED_REPLY_PATH_SEGMENTS = new Set([".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const BLOCKED_REPLY_FILE_NAMES = [
  /^\.env(?:\..+)?$/iu,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/iu,
  /\.(?:pem|p12|pfx|key)$/iu,
  /^(?:secrets?|credentials?|token)(?:\.[^.]+)?$/iu,
  /^\.(?:git-credentials|npmrc|netrc|pgpass)$/iu,
];

export interface ReadableImageFile {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ReadableReplyAttachment {
  kind: "image" | "file" | "audio" | "video";
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export async function inspectReadableImage(
  absPath: string,
  context: ImageReadContext = {},
): Promise<ReadableImageFile | null> {
  try {
    if (typeof absPath !== "string" || !isAbsolute(absPath)) return null;
    const mimeType = IMG_MIME[extname(absPath).toLowerCase()];
    if (!mimeType) return null;

    const info = await lstat(absPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_IMAGE_BYTES) return null;

    const fileReal = await realpath(absPath);
    if (!(await isAllowedImagePath(fileReal, context))) return null;
    return { path: fileReal, name: basename(fileReal), mimeType, size: info.size };
  } catch {
    return null;
  }
}

export async function readImageDataUrl(
  absPath: string,
  context: ImageReadContext = {},
): Promise<string | null> {
  try {
    const image = await inspectReadableImage(absPath, context);
    if (!image) return null;
    const buf = await readFile(image.path);
    return `data:${image.mimeType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Validate a local file for an outbound Mimi IM reply. The file must be a
 * non-symlink regular file inside the declared workspace/no-repo root. Common
 * credential paths are denied even when they sit inside a workspace.
 */
export async function inspectReadableReplyAttachment(
  absPath: string,
  context: ImageReadContext = {},
): Promise<ReadableReplyAttachment | null> {
  try {
    if (typeof absPath !== "string" || !isAbsolute(absPath)) return null;
    const info = await lstat(absPath);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size < 1 ||
      info.size > MAX_REPLY_ATTACHMENT_BYTES
    ) {
      return null;
    }
    const fileReal = await realpath(absPath);
    if (!(await isAllowedImagePath(fileReal, context)) || isBlockedReplyPath(fileReal)) return null;
    const extension = extname(fileReal).toLowerCase();
    const imageMime = IMG_MIME[extension];
    const audioMime = AUDIO_MIME[extension];
    const videoMime = VIDEO_MIME[extension];
    const kind =
      imageMime && OUTGOING_IMAGE_MIMES.has(imageMime)
        ? "image"
        : audioMime
          ? "audio"
          : videoMime
            ? "video"
            : "file";
    return {
      kind,
      path: fileReal,
      name: basename(fileReal),
      mimeType:
        kind === "image"
          ? imageMime!
          : kind === "audio"
            ? audioMime
            : kind === "video"
              ? videoMime
              : (FILE_MIME[extension] ?? "application/octet-stream"),
      size: info.size,
    };
  } catch {
    return null;
  }
}

function isBlockedReplyPath(fileReal: string): boolean {
  const parts = resolve(fileReal).split(sep).filter(Boolean);
  if (parts.some((part) => BLOCKED_REPLY_PATH_SEGMENTS.has(part.toLowerCase()))) return true;
  const name = basename(fileReal);
  return name.startsWith(".") || BLOCKED_REPLY_FILE_NAMES.some((pattern) => pattern.test(name));
}

async function isAllowedImagePath(fileReal: string, context: ImageReadContext): Promise<boolean> {
  const roots = await imageReadRoots(context);
  if (roots.length === 0) return false;
  return roots.some((root) => isInside(fileReal, root));
}

async function imageReadRoots(context: ImageReadContext): Promise<string[]> {
  if (typeof context.cwd !== "string" || context.cwd.length === 0) return [];
  const cwdReal = await realDirectory(context.cwd, { rejectSymlink: false }).catch(() => null);
  if (!cwdReal) return [];

  const roots = new Set<string>([cwdReal]);
  const codeShellDir = await realDirectory(join(cwdReal, ".code-shell")).catch(() => null);
  if (codeShellDir) {
    await addExistingDirectory(roots, join(codeShellDir, "generated_images"), codeShellDir);
    const attachmentsRoot = await addExistingDirectory(
      roots,
      join(codeShellDir, "attachments"),
      codeShellDir,
    );
    if (attachmentsRoot && typeof context.sessionId === "string" && context.sessionId) {
      await addExistingDirectory(roots, join(attachmentsRoot, context.sessionId), attachmentsRoot);
    }
  }
  return [...roots];
}

async function addExistingDirectory(
  roots: Set<string>,
  path: string,
  containmentRoot: string,
): Promise<string | null> {
  const real = await realDirectory(path).catch(() => null);
  if (!real || !isInside(real, containmentRoot)) return null;
  roots.add(real);
  return real;
}

async function realDirectory(
  path: string,
  opts: { rejectSymlink?: boolean } = { rejectSymlink: true },
): Promise<string> {
  const info = await lstat(path);
  if (opts.rejectSymlink !== false && info.isSymbolicLink()) {
    throw new Error("not a real directory");
  }
  if (info.isSymbolicLink()) {
    const target = await stat(path);
    if (!target.isDirectory()) throw new Error("not a real directory");
  } else if (!info.isDirectory()) {
    throw new Error("not a real directory");
  }
  return realpath(path);
}

function isInside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

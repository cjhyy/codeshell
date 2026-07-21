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

export interface ReadableImageFile {
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

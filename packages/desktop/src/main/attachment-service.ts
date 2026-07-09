import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export type InputAttachmentKind = "image" | "file" | "directory";

export type InputAttachmentOrigin =
  | "paste"
  | "os-drop"
  | "file-panel"
  | "picker"
  | "mention"
  | "generated"
  | "tool";

export interface InputAttachmentMeta {
  id: string;
  sessionId: string;
  kind: InputAttachmentKind;
  origin: InputAttachmentOrigin;
  path: string;
  absPath: string;
  relPath?: string;
  mime?: string;
  size: number;
  sha256: string;
  originalName?: string;
  createdAt: number;
  sourcePath?: string;
  width?: number;
  height?: number;
  vision?: {
    include: boolean;
    mediaPath?: string;
    detail?: "low" | "standard" | "high";
  };
  directory?: {
    treePath?: string;
    truncated?: boolean;
    entryCount?: number;
  };
}

export interface StageImageDataUrlInput {
  cwd: string;
  sessionId: string;
  name?: string;
  mime?: string;
  dataUrl: string;
  origin: InputAttachmentOrigin;
}

export interface AttachmentCleanupInput {
  cwd: string;
  sessionId?: string;
  now?: number;
}

export interface AttachmentInspectInput {
  cwd: string;
  sessionId?: string;
}

interface ManifestRecord {
  event: "staged" | "sent" | "removedFromDraft" | "cleanup";
  id?: string;
  sessionId: string;
  kind?: InputAttachmentKind;
  origin?: InputAttachmentOrigin;
  path?: string;
  absPath?: string;
  relPath?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  originalName?: string;
  createdAt?: number;
  sentAt?: number;
  removedAt?: number;
  cleanedAt?: number;
  status?: "draft" | "sent";
}

const CODE_SHELL_DIR = ".code-shell";
const ATTACHMENTS_DIR = "attachments";
const MANIFEST_FILE = "manifest.jsonl";
const GITIGNORE_CONTENT = "*\n!.gitignore\n";
export const DRAFT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const SENT_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STAGED_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const ALLOWED_IMAGE_MIMES = new Set(Object.keys(IMAGE_MIME_EXT));

let idCounter = 0;

export async function stageImageDataUrl(
  input: StageImageDataUrlInput,
): Promise<InputAttachmentMeta> {
  const cwd = await resolveExistingDirectory(input.cwd, "cwd");
  assertSafeSessionId(input.sessionId);
  const parsed = parseDataUrl(input.dataUrl);
  if (!parsed || !ALLOWED_IMAGE_MIMES.has(parsed.mime)) {
    throw new Error(`unsupported image data URL MIME`);
  }
  if (input.mime && normalizeMime(input.mime) !== parsed.mime) {
    throw new Error(`data URL MIME ${parsed.mime} does not match declared MIME ${input.mime}`);
  }

  const attachmentsRoot = await ensureAttachmentsRoot(cwd);
  const sessionDir = await ensureSessionDir(attachmentsRoot, input.sessionId);
  const sha256 = createHash("sha256").update(parsed.buffer).digest("hex");
  const sha16 = sha256.slice(0, 16);
  const ext = IMAGE_MIME_EXT[parsed.mime] ?? ".bin";
  const safeBase = safeSlug(input.name, "image");
  const existing = await findExistingSessionFile(sessionDir, sha16);
  const filename = existing ?? `${sha16}-${safeBase}${ext}`;
  const absPath = await safeJoin(sessionDir, filename, sessionDir);

  if (!existing) {
    const tmpPath = await safeJoin(
      sessionDir,
      `.${filename}.${process.pid}.${Date.now()}.tmp`,
      sessionDir,
    );
    await writeFile(tmpPath, parsed.buffer, { flag: "wx" });
    try {
      await rename(tmpPath, absPath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  const relPath = normalizePath(relative(cwd, absPath));
  const createdAt = Date.now();
  idCounter += 1;
  const meta: InputAttachmentMeta = {
    id: `att_${sha16}_${idCounter.toString(36)}`,
    sessionId: input.sessionId,
    kind: "image",
    origin: input.origin,
    path: relPath,
    absPath,
    relPath,
    mime: parsed.mime,
    size: parsed.buffer.byteLength,
    sha256,
    ...(input.name ? { originalName: input.name } : {}),
    createdAt,
    vision: { include: true },
  };
  await appendManifest(sessionDir, { event: "staged", status: "draft", ...meta });
  return meta;
}

export async function markAttachmentsSent(
  cwd: string,
  sessionId: string,
  attachments: InputAttachmentMeta[],
): Promise<void> {
  if (attachments.length === 0) return;
  const resolvedCwd = await resolveExistingDirectory(cwd, "cwd");
  assertSafeSessionId(sessionId);
  const sessionDir = await ensureSessionDir(await ensureAttachmentsRoot(resolvedCwd), sessionId);
  const sentAt = Date.now();
  for (const attachment of attachments) {
    if (attachment.sessionId !== sessionId) continue;
    await appendManifest(sessionDir, {
      event: "sent",
      id: attachment.id,
      sessionId,
      kind: attachment.kind,
      origin: attachment.origin,
      path: attachment.path,
      absPath: attachment.absPath,
      relPath: attachment.relPath,
      mime: attachment.mime,
      size: attachment.size,
      sha256: attachment.sha256,
      originalName: attachment.originalName,
      sentAt,
      status: "sent",
    });
  }
}

export async function listRecentAttachments(
  input: AttachmentInspectInput,
): Promise<InputAttachmentMeta[]> {
  const cwd = await resolveExistingDirectory(input.cwd, "cwd");
  const root = await resolveAttachmentsRoot(cwd);
  if (!root) return [];
  const sessionIds = input.sessionId ? [input.sessionId] : await listSafeSessionDirs(root);
  const staged = new Map<string, InputAttachmentMeta>();
  const sent = new Set<string>();
  for (const sessionId of sessionIds) {
    assertSafeSessionId(sessionId);
    const sessionDir = await safeJoin(root, sessionId, root).catch(() => null);
    if (!sessionDir) continue;
    const records = await readManifest(sessionDir);
    for (const record of records) {
      if (record.event === "staged") {
        const meta = recordToMeta(record);
        if (meta && (await pathExistsInside(meta.absPath, root))) {
          staged.set(meta.id, meta);
        }
      } else if (record.event === "sent" && record.id) {
        sent.add(record.id);
      } else if ((record.event === "removedFromDraft" || record.event === "cleanup") && record.id) {
        staged.delete(record.id);
      }
    }
  }
  return [...staged.values()]
    .filter((meta) => sent.has(meta.id) || meta.kind !== "image")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}

export async function cleanupAttachments(input: AttachmentCleanupInput): Promise<{
  removed: string[];
  sessionsRemoved: string[];
}> {
  const cwd = await resolveExistingDirectory(input.cwd, "cwd");
  const root = await resolveAttachmentsRoot(cwd);
  if (!root) return { removed: [], sessionsRemoved: [] };
  const now = input.now ?? Date.now();
  const sessionIds = input.sessionId ? [input.sessionId] : await listSafeSessionDirs(root);
  const removed: string[] = [];
  const sessionsRemoved: string[] = [];

  for (const sessionId of sessionIds) {
    assertSafeSessionId(sessionId);
    const sessionDir = await safeJoin(root, sessionId, root).catch(() => null);
    if (!sessionDir) continue;
    const records = await readManifest(sessionDir);
    if (input.sessionId) {
      const files = await manifestFilesInside(records, root);
      for (const file of files) {
        await rm(file, { force: true }).catch(() => undefined);
        removed.push(file);
      }
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      sessionsRemoved.push(sessionId);
      continue;
    }

    const latest = latestAttachmentState(records);
    for (const state of latest.values()) {
      const createdAt = state.createdAt ?? 0;
      const sentAt = state.sentAt;
      const isSent = typeof sentAt === "number";
      const ttl = isSent ? SENT_ATTACHMENT_TTL_MS : DRAFT_ATTACHMENT_TTL_MS;
      const basis = isSent ? sentAt : createdAt;
      if (!basis || now - basis < ttl) continue;
      if (!state.absPath || !(await pathExistsInside(state.absPath, root))) continue;
      await rm(state.absPath, { force: true }).catch(() => undefined);
      removed.push(state.absPath);
      await appendManifest(sessionDir, {
        event: "cleanup",
        id: state.id,
        sessionId,
        absPath: state.absPath,
        relPath: state.relPath,
        path: state.path,
        sha256: state.sha256,
        cleanedAt: now,
      });
    }
  }

  return { removed, sessionsRemoved };
}

export async function cleanupSessionAttachments(cwd: string, sessionId: string): Promise<void> {
  await cleanupAttachments({ cwd, sessionId }).catch(() => undefined);
}

function normalizeMime(mime: string | undefined): string {
  return String(mime ?? "")
    .trim()
    .toLowerCase();
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const mime = normalizeMime(match[1]);
  const base64 = (match[2] ?? "").replace(/\s+/g, "");
  const decodedSize = byteLengthFromBase64(base64);
  if (decodedSize > MAX_STAGED_IMAGE_BYTES) {
    throw new Error(
      `image attachment exceeds decoded size limit (${formatBytes(MAX_STAGED_IMAGE_BYTES)})`,
    );
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    if (buffer.byteLength > MAX_STAGED_IMAGE_BYTES) {
      throw new Error(
        `image attachment exceeds decoded size limit (${formatBytes(MAX_STAGED_IMAGE_BYTES)})`,
      );
    }
    return { mime, buffer };
  } catch (error) {
    if (String((error as Error).message).includes("decoded size limit")) throw error;
    return null;
  }
}

function byteLengthFromBase64(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

async function resolveExistingDirectory(path: string, label: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const resolved = resolve(path);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  return realpath(resolved);
}

export function assertSafeSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`invalid session id: must be a non-empty string`);
  }
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error(`invalid session id: contains path separator`);
  }
  if (sessionId === "." || sessionId === ".." || sessionId.includes("..")) {
    throw new Error(`invalid session id: contains parent-dir token`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    throw new Error(`invalid session id: unexpected characters`);
  }
  if (sessionId.length > 128) {
    throw new Error(`invalid session id: too long`);
  }
}

async function ensureAttachmentsRoot(cwd: string): Promise<string> {
  const codeShellDir = await safeJoin(cwd, CODE_SHELL_DIR, cwd);
  await rejectSymlinkIfExists(codeShellDir, "CodeShell state directory");
  await mkdir(codeShellDir, { recursive: true });
  const codeShellReal = await realDirectoryInside(codeShellDir, cwd, {
    label: "CodeShell state directory",
    allowSame: false,
  });
  const gitignore = await safeJoin(codeShellReal, ".gitignore", codeShellReal);
  await writeFile(gitignore, GITIGNORE_CONTENT, "utf-8");
  const attachmentsRoot = await safeJoin(codeShellReal, ATTACHMENTS_DIR, codeShellReal);
  await rejectSymlinkIfExists(attachmentsRoot, "attachments root");
  await mkdir(attachmentsRoot, { recursive: true });
  return realDirectoryInside(attachmentsRoot, codeShellReal, {
    label: "attachments root",
    allowSame: false,
  });
}

async function resolveAttachmentsRoot(cwd: string): Promise<string | null> {
  const root = join(cwd, CODE_SHELL_DIR, ATTACHMENTS_DIR);
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink()) throw new Error(`attachments root must not be a symlink`);
    if (!info.isDirectory()) return null;
    return realDirectoryInside(root, join(cwd, CODE_SHELL_DIR), {
      label: "attachments root",
      allowSame: false,
    });
  } catch {
    return null;
  }
}

async function ensureSessionDir(attachmentsRoot: string, sessionId: string): Promise<string> {
  const sessionDir = await safeJoin(attachmentsRoot, sessionId, attachmentsRoot);
  await rejectSymlinkIfExists(sessionDir, "attachment session directory");
  await mkdir(sessionDir, { recursive: true });
  return realDirectoryInside(sessionDir, attachmentsRoot, {
    label: "attachment session directory",
    allowSame: false,
  });
}

async function safeJoin(root: string, child: string, containmentRoot: string): Promise<string> {
  const parent = await realpath(root);
  const normalizedContainment = await realpath(containmentRoot);
  const target = resolve(parent, child);
  assertInside(target, normalizedContainment, {
    label: "attachment path",
    allowSame: false,
  });
  assertInside(target, parent, {
    label: "attachment path",
    allowSame: false,
  });
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`attachment path must not be a symlink`);
    const targetReal = await realpath(target);
    assertInside(targetReal, normalizedContainment, {
      label: "attachment path",
      allowSame: false,
    });
    assertInside(targetReal, parent, {
      label: "attachment path",
      allowSame: false,
    });
    return targetReal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
}

async function rejectSymlinkIfExists(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function realDirectoryInside(
  path: string,
  containmentRoot: string,
  opts: { label: string; allowSame: boolean },
): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${opts.label} must not be a symlink`);
  if (!info.isDirectory()) throw new Error(`${opts.label} must be a directory`);
  const real = await realpath(path);
  const rootReal = await realpath(containmentRoot);
  assertInside(real, rootReal, opts);
  return real;
}

function assertInside(
  target: string,
  containmentRoot: string,
  opts: { label: string; allowSame: boolean },
): void {
  const rel = relative(containmentRoot, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    (!opts.allowSame && resolve(target) === resolve(containmentRoot))
  ) {
    throw new Error(`path escapes attachment root`);
  }
}

async function pathExistsInside(absPath: string, root: string): Promise<boolean> {
  try {
    const info = await lstat(absPath);
    if (info.isSymbolicLink()) return false;
    const fileReal = await realpath(absPath);
    const rootReal = await realpath(root);
    const rel = relative(rootReal, fileReal);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
  } catch {
    return false;
  }
}

function safeSlug(name: string | undefined, fallback: string): string {
  const base = basename(String(name ?? fallback));
  const noExt = base.slice(0, base.length - extname(base).length) || fallback;
  const slug = noExt
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/[-. ]+$/g, "");
  return slug || fallback;
}

async function findExistingSessionFile(sessionDir: string, sha16: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return null;
  }
  return entries.find((entry) => entry.startsWith(`${sha16}-`) && entry !== MANIFEST_FILE) ?? null;
}

async function appendManifest(sessionDir: string, record: ManifestRecord): Promise<void> {
  const manifest = await safeJoin(sessionDir, MANIFEST_FILE, sessionDir);
  await appendFile(manifest, `${JSON.stringify(record)}\n`, "utf-8");
}

async function readManifest(sessionDir: string): Promise<ManifestRecord[]> {
  try {
    const manifest = await safeJoin(sessionDir, MANIFEST_FILE, sessionDir);
    const raw = await readFile(manifest, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as ManifestRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is ManifestRecord => !!record);
  } catch {
    return [];
  }
}

async function listSafeSessionDirs(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        assertSafeSessionId(name);
        return true;
      } catch {
        return false;
      }
    });
}

function normalizePath(p: string): string {
  return sep === "\\" ? p.replace(/\\/g, "/") : p;
}

function recordToMeta(record: ManifestRecord): InputAttachmentMeta | null {
  if (
    !record.id ||
    !record.sessionId ||
    !record.kind ||
    !record.origin ||
    !record.path ||
    !record.absPath ||
    typeof record.size !== "number" ||
    !record.sha256 ||
    typeof record.createdAt !== "number"
  ) {
    return null;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    kind: record.kind,
    origin: record.origin,
    path: record.path,
    absPath: record.absPath,
    relPath: record.relPath,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    originalName: record.originalName,
    createdAt: record.createdAt,
    vision: record.kind === "image" ? { include: true } : undefined,
  };
}

async function manifestFilesInside(records: ManifestRecord[], root: string): Promise<string[]> {
  const files = new Set<string>();
  for (const record of records) {
    if (!record.absPath) continue;
    if (await pathExistsInside(record.absPath, root)) files.add(record.absPath);
  }
  return [...files];
}

function latestAttachmentState(records: ManifestRecord[]): Map<string, ManifestRecord> {
  const latest = new Map<string, ManifestRecord>();
  for (const record of records) {
    if (!record.id) continue;
    if (record.event === "staged") latest.set(record.id, record);
    if (record.event === "sent") {
      const prev = latest.get(record.id) ?? record;
      latest.set(record.id, { ...prev, ...record, status: "sent" });
    }
    if (record.event === "removedFromDraft" || record.event === "cleanup") latest.delete(record.id);
  }
  return latest;
}

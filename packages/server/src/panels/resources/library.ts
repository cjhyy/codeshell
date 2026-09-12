import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Readable } from "node:stream";
import { mediaDirectory, mediaScopeKey, readMediaJson, writeMediaJson } from "./storage.js";
import type { MediaAsset, MediaScope } from "./types.js";

const ASSET_ID = /^asset-[a-f0-9]{64}$/;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".json": "application/json",
  ".srt": "application/x-subrip",
  ".opus": "audio/ogg",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".vtt": "text/vtt",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".zip": "application/zip",
};
const SAFE_MIME_TYPES = new Set([
  ...Object.values(MIME_BY_EXTENSION),
  "audio/webm",
  "application/octet-stream",
]);

export interface MediaLibraryOptions {
  rootDirectory: string;
  maxFileBytes?: number;
  now?: () => number;
  isScopeAuthorized?: (scope: MediaScope) => boolean | Promise<boolean>;
}

export interface MediaImportOptions {
  name?: string;
  mimeType?: string;
  signal?: AbortSignal;
  onProgress?: (copiedBytes: number, totalBytes: number) => void;
  /** Identity captured by Host selection, before a job can queue or survive restart. */
  expectedSource?: MediaSourceIdentity;
  expectedBytes?: number;
  expectedSha256?: string;
  /** Host grant/ancestor identity checks during copy and before publication. */
  assertAuthorized?: () => void | Promise<void>;
}

export interface MediaSourceIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export function mediaSourceIdentity(info: MediaSourceIdentity): MediaSourceIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

export interface MediaReadResult {
  status: 200 | 206 | 405 | 416;
  headers: Record<string, string>;
  body: Readable | null;
}

export function resourceName(value: string): string {
  return (
    basename(value)
      .replace(/[\x00-\x1f\x7f]/g, "_")
      .slice(0, 240) || "media"
  );
}

function assetRecord(raw: unknown, id: string): MediaAsset {
  const value = raw as Partial<MediaAsset> | null;
  if (
    !value ||
    value.id !== id ||
    !ASSET_ID.test(id) ||
    value.sha256 !== id.slice(6) ||
    typeof value.name !== "string" ||
    value.name !== resourceName(value.name) ||
    !SAFE_MIME_TYPES.has(value.mimeType!) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes! <= 0 ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt! < 0
  )
    throw new Error("Invalid stored media asset");
  return {
    id,
    name: value.name,
    mimeType: value.mimeType!,
    bytes: value.bytes!,
    sha256: value.sha256!,
    createdAt: value.createdAt!,
  };
}

function rangeBounds(range: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return null;
  if (first === undefined) {
    if (!last || last <= 0) return null;
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/**
 * Host-owned immutable, scope-local media. importFile accepts only paths already
 * authorized by the caller (for example native file selection); guest APIs must
 * never pass unchecked paths through this internal method.
 */
export class ResourceLibrary {
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly isScopeAuthorized?: MediaLibraryOptions["isScopeAuthorized"];
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(options: MediaLibraryOptions) {
    this.root = options.rootDirectory;
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 ** 3;
    this.now = options.now ?? Date.now;
    this.isScopeAuthorized = options.isScopeAuthorized;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes <= 0)
      throw new Error("Invalid media file budget");
  }

  private async authorize(scope: MediaScope): Promise<void> {
    mediaScopeKey(scope);
    if (this.isScopeAuthorized && !(await this.isScopeAuthorized(scope)))
      throw new Error("Resource authorization was revoked");
  }

  private directory(scope: MediaScope, segments: string[], create = true): Promise<string> {
    return mediaDirectory(
      this.root,
      ["scopes", mediaScopeKey(scope), "assets", ...segments],
      create,
    );
  }

  async importFile(
    scope: MediaScope,
    sourcePath: string,
    options: MediaImportOptions = {},
  ): Promise<MediaAsset> {
    const verify = async () => {
      options.signal?.throwIfAborted();
      await this.authorize(scope);
      await options.assertAuthorized?.();
      options.signal?.throwIfAborted();
    };
    await verify();
    if (
      options.expectedBytes !== undefined &&
      (!Number.isSafeInteger(options.expectedBytes) ||
        options.expectedBytes < 1 ||
        options.expectedBytes > this.maxFileBytes)
    )
      throw new Error("Invalid expected resource size");
    if (options.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedSha256))
      throw new Error("Invalid expected resource digest");
    const scopeKey = mediaScopeKey(scope);
    const staging = await mediaDirectory(this.root, ["scopes", scopeKey, "imports"]);
    const stagingIdentity = await lstat(staging);
    const verifyStaging = async () => {
      const currentPath = await mediaDirectory(this.root, ["scopes", scopeKey, "imports"], false);
      const current = await lstat(currentPath);
      if (current.dev !== stagingIdentity.dev || current.ino !== stagingIdentity.ino)
        throw new Error("Resource staging directory changed during import");
    };
    const temporary = join(staging, `${randomUUID()}.partial`);
    const source = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    let destination: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const initial = await source.stat();
      if (!initial.isFile() || initial.size <= 0 || initial.size > this.maxFileBytes)
        throw new Error("Source must be a nonempty regular file within the media file budget");
      if (
        options.expectedSource &&
        Object.entries(mediaSourceIdentity(initial)).some(
          ([key, value]) => options.expectedSource![key as keyof MediaSourceIdentity] !== value,
        )
      )
        throw new Error("Source changed since it was selected; select the media file again");
      if (options.expectedBytes !== undefined && initial.size !== options.expectedBytes)
        throw new Error("Resource size does not match the expected size");
      const verifySource = async () => {
        await verify();
        await verifyStaging();
        const current = await lstat(sourcePath);
        if (
          current.isSymbolicLink() ||
          Object.entries(mediaSourceIdentity(initial)).some(
            ([key, value]) => current[key as keyof MediaSourceIdentity] !== value,
          )
        )
          throw new Error("Source changed during media import; select the file again");
      };
      await verifySource();
      const digest = createHash("sha256");
      let copied = 0;
      destination = await open(temporary, "wx", 0o600);
      // A fixed-size buffer keeps large imports streaming while retaining both
      // file descriptors for post-copy identity checks and an explicit fsync.
      const buffer = Buffer.allocUnsafe(256 * 1024);
      while (true) {
        await verifySource();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, copied);
        if (!bytesRead) break;
        if (copied + bytesRead > this.maxFileBytes) throw new Error("Media file budget exceeded");
        digest.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          options.signal?.throwIfAborted();
          const { bytesWritten } = await destination.write(
            buffer,
            written,
            bytesRead - written,
            copied + written,
          );
          if (!bytesWritten) throw new Error("Media copy stopped making progress");
          written += bytesWritten;
        }
        copied += bytesRead;
        try {
          options.onProgress?.(copied, initial.size);
        } catch {
          /* Detached guests do not abort copies. */
        }
      }
      const after = await source.stat();
      if (
        copied !== initial.size ||
        after.size !== initial.size ||
        after.mtimeMs !== initial.mtimeMs ||
        after.ctimeMs !== initial.ctimeMs ||
        after.ino !== initial.ino ||
        after.dev !== initial.dev
      ) {
        throw new Error("Source changed during media import; select the file again");
      }
      await verifySource();
      await destination.sync();
      await destination.close();
      destination = undefined;
      options.signal?.throwIfAborted();
      const sha256 = digest.digest("hex");
      if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256)
        throw new Error("Resource digest does not match the expected digest");
      const id = `asset-${sha256}`;
      const name = resourceName(options.name ?? sourcePath);
      const requestedMime = options.mimeType?.split(";", 1)[0].toLowerCase();
      const mimeType =
        requestedMime && SAFE_MIME_TYPES.has(requestedMime)
          ? requestedMime
          : (MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream");
      const record: MediaAsset = {
        id,
        name,
        mimeType,
        bytes: copied,
        sha256,
        createdAt: this.now(),
      };
      const key = `${scopeKey}:${id}`;
      const operation = (this.writes.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await verifySource();
          try {
            const existing = await this.get(scope, id);
            await this.verifyContent(scope, id, verifySource);
            return existing;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const parent = await this.directory(scope, []);
          const parentIdentity = await lstat(parent);
          const directory = join(parent, id);
          const committed = join(staging, `${randomUUID()}.commit`);
          let published = false;
          let publishedIdentity: { dev: number; ino: number } | undefined;
          try {
            await mkdir(committed, { mode: 0o700 });
            publishedIdentity = await lstat(committed);
            await rename(temporary, join(committed, "content"));
            await writeMediaJson(join(committed, "asset.json"), record);
            await verifySource();
            const currentParent = await lstat(await this.directory(scope, [], false));
            if (
              currentParent.dev !== parentIdentity.dev ||
              currentParent.ino !== parentIdentity.ino
            )
              throw new Error("Resource storage directory changed during import");
            try {
              await rename(committed, directory);
              published = true;
            } catch (error) {
              if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw error;
              await this.verifyContent(scope, id, verifySource);
              return this.get(scope, id);
            }
            await verify();
            return structuredClone(record);
          } catch (error) {
            if (published && publishedIdentity) {
              const current = await lstat(directory).catch(() => undefined);
              if (current?.dev === publishedIdentity.dev && current?.ino === publishedIdentity.ino)
                await rm(directory, { recursive: true, force: true }).catch(() => {});
            }
            throw error;
          } finally {
            await rm(committed, { recursive: true, force: true }).catch(() => {});
          }
        });
      this.writes.set(key, operation);
      try {
        return await operation;
      } finally {
        if (this.writes.get(key) === operation) this.writes.delete(key);
      }
    } finally {
      await source.close().catch(() => {});
      await destination?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async get(scope: MediaScope, id: string): Promise<MediaAsset> {
    await this.authorize(scope);
    if (!ASSET_ID.test(id)) throw new Error("Invalid media asset ID");
    const directory = await this.directory(scope, [id], false);
    const result = assetRecord(await readMediaJson(join(directory, "asset.json")), id);
    await this.authorize(scope);
    return result;
  }

  async list(scope: MediaScope): Promise<MediaAsset[]> {
    await this.authorize(scope);
    let directory: string;
    try {
      directory = await this.directory(scope, [], false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const assets: MediaAsset[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!ASSET_ID.test(entry.name)) continue;
      assets.push(await this.get(scope, entry.name));
    }
    return assets.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  /** Host-only path resolution for registered processors, not a renderer DTO. */
  async resolvePath(scope: MediaScope, id: string): Promise<string> {
    const asset = await this.get(scope, id);
    const directory = await this.directory(scope, [id], false);
    const path = join(directory, "content");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== asset.bytes)
        throw new Error("Stored media content is missing or changed");
    } finally {
      await handle.close();
    }
    return path;
  }

  /** Revalidate bytes before reuse/hand-off rather than trusting metadata alone. */
  async verifyContent(
    scope: MediaScope,
    id: string,
    check?: () => void | Promise<void>,
  ): Promise<void> {
    const asset = await this.get(scope, id);
    const source = await this.openRead(scope, id);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of source.body!) {
        await this.authorize(scope);
        await check?.();
        bytes += chunk.length;
        if (bytes > asset.bytes) throw new Error("Stored media content changed");
        hash.update(chunk);
      }
      if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256)
        throw new Error("Stored media content changed");
    } finally {
      source.body?.destroy();
    }
  }

  async openRead(
    scope: MediaScope,
    id: string,
    options: { range?: string; method?: string } = {},
  ): Promise<MediaReadResult> {
    const method = options.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      return { status: 405, headers: { Allow: "GET, HEAD" }, body: null };
    const asset = await this.get(scope, id);
    const path = await this.resolvePath(scope, id);
    const headers: Record<string, string> = {
      "Content-Type": asset.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ETag: `"${asset.sha256}"`,
    };
    if (!/^(?:audio|video|image)\//.test(asset.mimeType))
      headers["Content-Disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/['()*!]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    const bounds = options.range
      ? rangeBounds(options.range, asset.bytes)
      : { start: 0, end: asset.bytes - 1 };
    if (!bounds)
      return {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${asset.bytes}` },
        body: null,
      };
    headers["Content-Length"] = String(bounds.end - bounds.start + 1);
    if (options.range)
      headers["Content-Range"] = `bytes ${bounds.start}-${bounds.end}/${asset.bytes}`;
    const status = options.range ? 206 : 200;
    if (method === "HEAD") return { status, headers, body: null };
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== asset.bytes)
        throw new Error("Stored media content changed");
      await this.authorize(scope);
      return { status, headers, body: handle.createReadStream({ ...bounds, autoClose: true }) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

export { ResourceLibrary as MediaLibrary };
export type ResourceLibraryOptions = MediaLibraryOptions;
export type ResourceImportOptions = MediaImportOptions;

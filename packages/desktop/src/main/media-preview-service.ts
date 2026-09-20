import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MEDIA_PREVIEW_SCHEME,
  mediaTypeForPath,
  type MediaPreviewRequest,
  type MediaPreviewResult,
} from "../shared/media-preview.js";

export interface MediaPreviewAuthority {
  mainRootId: string;
  roots: Array<{ id: string; path: string; role: "primary" | "secondary" }>;
}

interface MediaPreviewDependencies {
  /** Must resolve fresh Main-owned Session authority and verify owner access. */
  resolveAuthority(sessionId: string, ownerId: number): Promise<MediaPreviewAuthority>;
  isOwnerAlive(ownerId: number): boolean;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface MediaGrant {
  ownerId: number;
  request: MediaPreviewRequest;
  rootId: string;
  mainRootId: string;
  rootPath: string;
  rootIdentity: Pick<FileIdentity, "dev" | "ino">;
  path: string;
  identity: FileIdentity;
  preview: MediaPreviewResult;
  reads: Set<() => void>;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function identity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof FileIdentity] === b[key as keyof FileIdentity],
  );
}

/** Refuse every symlink below the authorized canonical root, not only the final file. */
async function inspectPath(root: string, path: string): Promise<Stats> {
  if (!contains(root, path)) throw new Error("Media path is outside its task workspace");
  const parts = relative(root, path).split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Media symlinks are not allowed");
    if (index !== parts.length - 1 && !info.isDirectory()) throw new Error("Invalid media parent");
    if (index === parts.length - 1) {
      if (!info.isFile() || info.size < 1 || !Number.isSafeInteger(info.size))
        throw new Error("Media must be a nonempty regular file");
      if ((await realpath(path)) !== path) throw new Error("Media path changed");
      return info;
    }
  }
  throw new Error("Missing media file");
}

function bounds(range: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return null;
  if (first === undefined)
    return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  if (first >= size || (last !== undefined && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

function tokenFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== `${MEDIA_PREVIEW_SCHEME}:` ||
      parsed.host !== "preview" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\/[a-f0-9]{64}$/.test(parsed.pathname)
    )
      return null;
    return parsed.pathname.slice(1);
  } catch {
    return null;
  }
}

export class MediaPreviewService {
  private readonly grants = new Map<string, MediaGrant>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly activeAuthorities = new Map<
    string,
    {
      ownerId: number;
      sessionId: string;
      checkedAt: number;
      authority?: MediaPreviewAuthority;
      pending?: Promise<MediaPreviewAuthority>;
    }
  >();
  constructor(private readonly deps: MediaPreviewDependencies) {}

  async create(ownerId: number, input: unknown): Promise<MediaPreviewResult | null> {
    const ownerEpoch = this.ownerEpochs.get(ownerId) ?? 0;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const request = input as MediaPreviewRequest;
      if (
        Object.keys(request).some((key) => !["sessionId", "path", "rootId"].includes(key)) ||
        typeof request.sessionId !== "string" ||
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(request.sessionId) ||
        request.sessionId.includes("..") ||
        typeof request.path !== "string" ||
        !request.path ||
        request.path.length > 16_384 ||
        request.path.includes("\0") ||
        (request.rootId !== undefined &&
          (typeof request.rootId !== "string" || !request.rootId || request.rootId.length > 512)) ||
        !this.deps.isOwnerAlive(ownerId)
      )
        return null;
      const type = mediaTypeForPath(request.path);
      if (!type) return null;
      const authority = await this.deps.resolveAuthority(request.sessionId, ownerId);
      if (request.rootId !== undefined && request.rootId !== authority.mainRootId) return null;
      const primary = authority.roots.find((root) => root.role === "primary");
      if (!primary) return null;
      const requestedPath = resolve(primary.path, request.path);
      for (const root of authority.roots) {
        const rootPath = await realpath(root.path);
        // Preserve permitted root aliases (e.g. /var -> /private/var) without
        // resolving an untrusted child symlink before inspecting its segments.
        const path = contains(resolve(root.path), requestedPath)
          ? resolve(rootPath, relative(resolve(root.path), requestedPath))
          : requestedPath;
        if (!contains(rootPath, path)) continue;
        const rootInfo = await stat(rootPath);
        const info = await inspectPath(rootPath, path);
        const token = randomBytes(32).toString("hex");
        const preview = {
          url: `${MEDIA_PREVIEW_SCHEME}://preview/${token}`,
          ...type,
          name: basename(path),
        };
        const grant: MediaGrant = {
          ownerId,
          request: { ...request },
          rootId: root.id,
          mainRootId: authority.mainRootId,
          rootPath,
          rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino },
          path,
          identity: identity(info),
          preview,
          reads: new Set(),
        };
        // Awaited filesystem work may race renderer destruction or root removal.
        await this.validate(grant);
        if (ownerEpoch !== (this.ownerEpochs.get(ownerId) ?? 0)) return null;
        if ([...this.grants.values()].filter((value) => value.ownerId === ownerId).length >= 512)
          return null;
        this.grants.set(token, grant);
        return preview;
      }
      return null;
    } catch {
      return null;
    }
  }

  release(ownerId: number, url: string): void {
    const token = typeof url === "string" ? tokenFor(url) : null;
    const grant = token ? this.grants.get(token) : undefined;
    if (token && grant?.ownerId === ownerId) this.revoke(token, grant);
  }

  releaseOwner(ownerId: number): void {
    this.ownerEpochs.set(ownerId, (this.ownerEpochs.get(ownerId) ?? 0) + 1);
    for (const [key, entry] of this.activeAuthorities)
      if (entry.ownerId === ownerId) this.activeAuthorities.delete(key);
    for (const [token, grant] of this.grants)
      if (grant.ownerId === ownerId) this.revoke(token, grant);
  }

  releaseSession(sessionId: string): void {
    for (const [key, entry] of this.activeAuthorities)
      if (entry.sessionId === sessionId) this.activeAuthorities.delete(key);
    for (const [token, grant] of this.grants)
      if (grant.request.sessionId === sessionId) this.revoke(token, grant);
  }

  private revoke(token: string, grant: MediaGrant): void {
    this.grants.delete(token);
    for (const cancel of grant.reads) cancel();
    grant.reads.clear();
    if (
      ![...this.grants.values()].some(
        (other) =>
          other.ownerId === grant.ownerId && other.request.sessionId === grant.request.sessionId,
      )
    )
      this.activeAuthorities.delete(`${grant.ownerId}/${grant.request.sessionId}`);
  }

  /** Concurrent active players share the expensive Session/worktree lookup. */
  private activeAuthority(grant: MediaGrant): Promise<MediaPreviewAuthority> {
    const key = `${grant.ownerId}/${grant.request.sessionId}`;
    let entry = this.activeAuthorities.get(key);
    if (!entry) {
      entry = { ownerId: grant.ownerId, sessionId: grant.request.sessionId, checkedAt: 0 };
      this.activeAuthorities.set(key, entry);
    }
    if (entry.pending) return entry.pending;
    if (entry.authority && Date.now() - entry.checkedAt < 1000)
      return Promise.resolve(entry.authority);
    const current = entry;
    current.pending = this.deps
      .resolveAuthority(grant.request.sessionId, grant.ownerId)
      .then((authority) => {
        current.authority = authority;
        current.checkedAt = Date.now();
        return authority;
      })
      .catch((error) => {
        if (this.activeAuthorities.get(key) === current) this.activeAuthorities.delete(key);
        throw error;
      })
      .finally(() => {
        current.pending = undefined;
      });
    return current.pending;
  }

  private async validate(grant: MediaGrant, active = false): Promise<void> {
    if (!this.deps.isOwnerAlive(grant.ownerId)) throw new Error("Media owner closed");
    const authority = await (active
      ? this.activeAuthority(grant)
      : this.deps.resolveAuthority(grant.request.sessionId, grant.ownerId));
    if (grant.mainRootId !== authority.mainRootId) throw new Error("Media task root changed");
    const root = authority.roots.find((candidate) => candidate.id === grant.rootId);
    if (!root || (await realpath(root.path)) !== grant.rootPath)
      throw new Error("Media root revoked");
    const rootInfo = await stat(grant.rootPath);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.dev !== grant.rootIdentity.dev ||
      rootInfo.ino !== grant.rootIdentity.ino
    )
      throw new Error("Media root replaced");
    if (!sameIdentity(grant.identity, identity(await inspectPath(grant.rootPath, grant.path))))
      throw new Error("Media file changed");
    if (!this.deps.isOwnerAlive(grant.ownerId)) throw new Error("Media owner closed");
  }

  async respond(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const token = tokenFor(request.url);
    const grant = token ? this.grants.get(token) : undefined;
    if (!token || !grant) return new Response(null, { status: 404 });
    let handle: FileHandle | undefined;
    try {
      await this.validate(grant);
      if (this.grants.get(token) !== grant || request.signal.aborted)
        throw new Error("Media revoked");
      const range = request.headers.get("range");
      const part =
        range !== null
          ? bounds(range, grant.identity.size)
          : { start: 0, end: grant.identity.size - 1 };
      const headers: Record<string, string> = {
        "Content-Type": grant.preview.mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      };
      if (!part)
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${grant.identity.size}` },
        });
      headers["Content-Length"] = String(part.end - part.start + 1);
      if (range !== null)
        headers["Content-Range"] = `bytes ${part.start}-${part.end}/${grant.identity.size}`;
      const status = range !== null ? 206 : 200;
      if (request.method === "HEAD") return new Response(null, { status, headers });
      handle = await open(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!sameIdentity(grant.identity, identity(await handle.stat())))
        throw new Error("Media file replaced");
      await this.validate(grant);
      if (this.grants.get(token) !== grant || request.signal.aborted)
        throw new Error("Media revoked");
      const file = handle;
      const service = this;
      let stopped = false;
      let position = part.start;
      let validatedAt = Date.now();
      let closePromise: Promise<void> | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const cleanup = () => {
        stopped = true;
        grant.reads.delete(cancel);
        request.signal.removeEventListener("abort", cancel);
        return (closePromise ??= file.close().catch(() => {}));
      };
      const cancel = () => {
        if (stopped) return;
        streamController.error(new DOMException("Media read aborted", "AbortError"));
        void cleanup();
      };
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller;
          },
          async pull(controller) {
            if (stopped) return;
            try {
              // Worktree authority can require Git queries. Refresh at most once
              // a second per active Session, independent of media size/bitrate.
              // Explicit release/owner destruction still stops every pending read.
              if (Date.now() - validatedAt >= 1000) {
                await service.validate(grant, true);
                validatedAt = Date.now();
              }
              if (stopped || service.grants.get(token) !== grant) return;
              if (!service.deps.isOwnerAlive(grant.ownerId)) throw new Error("Media owner closed");
              const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, part.end - position + 1));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
              if (stopped || service.grants.get(token) !== grant) return;
              if (bytesRead === 0 || !sameIdentity(grant.identity, identity(await file.stat())))
                throw new Error("Media file changed during playback");
              if (stopped || service.grants.get(token) !== grant) return;
              position += bytesRead;
              controller.enqueue(buffer.subarray(0, bytesRead));
              if (position > part.end) {
                controller.close();
                await cleanup();
              }
            } catch (error) {
              // File/authority failures revoke the capability. A consumer abort
              // (seeking or unmounting a <video>) only stops this particular read.
              if (stopped) return;
              controller.error(error);
              void cleanup();
              service.revoke(token, grant);
            }
          },
          // Mark cancellation synchronously, before any pending filesystem await
          // resumes. This preserves the token for Chromium's subsequent seek.
          cancel() {
            return cleanup();
          },
        },
        { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
      );
      grant.reads.add(cancel);
      request.signal.addEventListener("abort", cancel, { once: true });
      handle = undefined;
      return new Response(body, { status, headers });
    } catch {
      await handle?.close().catch(() => {});
      if (!request.signal.aborted) this.revoke(token, grant);
      return new Response(null, { status: 404 });
    }
  }
}

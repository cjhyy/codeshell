import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import {
  openResourceDirectory,
  resourceRelativePath,
  sameResourceIdentity,
} from "./directories.js";
import { mediaSourceIdentity, rangeBounds, resourceMimeType, resourceName } from "./library.js";
import type { MediaReadResult, MediaSourceIdentity } from "./library.js";
import { mediaDirectory, mediaScopeKey, readMediaJson, writeMediaJson } from "./storage.js";
import type { ExternalResourceReference, ResourceScope } from "./types.js";

const REFERENCE_ID = /^external-[a-f0-9]{64}$/;
const MAX_REFERENCES = 4096;
type DirectoryIdentity = { dev: number; ino: number };
interface StoredReference {
  schemaVersion: 1;
  id: string;
  name: string;
  mimeType: string;
  createdAt: number;
  root: string;
  path: string;
  ancestors: DirectoryIdentity[];
  source: MediaSourceIdentity;
}
export interface ExternalReferenceOptions {
  name?: string;
  mimeType?: string;
  expectedBytes?: number;
  expectedLastModified?: number;
  signal?: AbortSignal;
  assertAuthorized?: () => void | Promise<void>;
}
interface ReferenceOptions {
  rootDirectory: string;
  maxFileBytes?: number;
  isScopeAuthorized(scope: ResourceScope): boolean | Promise<boolean>;
}
class ReferenceUnavailable extends Error {
  constructor(readonly state: "missing" | "changed") {
    super(
      state === "missing"
        ? "Referenced file is unavailable; reconnect it"
        : "Referenced file changed; select it as a new reference",
    );
  }
}
function referenceId(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE_ID.test(value))
    throw new Error("Invalid external reference ID");
  return value;
}
function validIdentity(value: any): value is DirectoryIdentity {
  return value && Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino);
}
function sameSource(a: MediaSourceIdentity, b: MediaSourceIdentity, relocating = false) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (relocating || a.ctimeMs === b.ctimeMs)
  );
}
function view(
  record: StoredReference,
  state: ExternalResourceReference["state"] = "available",
): ExternalResourceReference {
  return {
    id: record.id,
    kind: "external",
    name: record.name,
    mimeType: record.mimeType,
    bytes: record.source.size,
    lastModified: Math.trunc(record.source.mtimeMs),
    createdAt: record.createdAt,
    state,
  };
}

/** Host-only source locations; public records contain no path and claim no content hash. */
export class ExternalResourceReferences {
  private closed = false;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly streams = new Set<{
    scopeKey: string;
    appId: string;
    id: string;
    stream: Readable;
    closed: Promise<void>;
  }>();
  constructor(private readonly options: ReferenceOptions) {}

  private async authorize(scope: ResourceScope, options: ExternalReferenceOptions = {}) {
    mediaScopeKey(scope);
    options.signal?.throwIfAborted();
    if (this.closed || !(await this.options.isScopeAuthorized(scope)))
      throw new Error("External resource access is no longer authorized");
    await options.assertAuthorized?.();
    options.signal?.throwIfAborted();
  }
  private locked<T>(scope: ResourceScope, work: () => Promise<T>): Promise<T> {
    const key = mediaScopeKey(scope);
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }
  private directory(scope: ResourceScope, create = false) {
    return mediaDirectory(
      this.options.rootDirectory,
      ["scopes", mediaScopeKey(scope), "references"],
      create,
    );
  }
  private async record(scope: ResourceScope, id: string): Promise<StoredReference> {
    referenceId(id);
    await this.authorize(scope);
    const raw: any = await readMediaJson(join(await this.directory(scope), `${id}.json`));
    if (
      !raw ||
      raw.schemaVersion !== 1 ||
      raw.id !== id ||
      Object.keys(raw).some(
        (key) =>
          ![
            "schemaVersion",
            "id",
            "name",
            "mimeType",
            "createdAt",
            "root",
            "path",
            "ancestors",
            "source",
          ].includes(key),
      ) ||
      typeof raw.name !== "string" ||
      raw.name !== resourceName(raw.name) ||
      typeof raw.mimeType !== "string" ||
      resourceMimeType(raw.name, raw.mimeType) !== raw.mimeType ||
      !Number.isSafeInteger(raw.createdAt) ||
      raw.createdAt < 0 ||
      typeof raw.root !== "string" ||
      !isAbsolute(raw.root) ||
      raw.root.length > 4096 ||
      raw.root.includes("\0") ||
      !Array.isArray(raw.ancestors) ||
      raw.ancestors.length < 1 ||
      raw.ancestors.length > 16 ||
      raw.ancestors.some((identity: unknown) => !validIdentity(identity)) ||
      !validIdentity(raw.source) ||
      !Number.isSafeInteger(raw.source.size) ||
      raw.source.size < 1 ||
      raw.source.size > (this.options.maxFileBytes ?? 20 * 1024 ** 3) ||
      !Number.isFinite(raw.source.mtimeMs) ||
      !Number.isFinite(raw.source.ctimeMs)
    )
      throw new Error("Invalid stored external reference");
    resourceRelativePath(raw.path);
    if (raw.ancestors.length !== raw.path.split("/").length)
      throw new Error("Invalid external reference ancestry");
    await this.authorize(scope);
    return raw;
  }
  private async selected(
    scope: ResourceScope,
    root: string,
    path: string,
    options: ExternalReferenceOptions = {},
  ) {
    await this.authorize(scope, options);
    const directory = await openResourceDirectory(root, path, false, () =>
      this.authorize(scope, options),
    );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        directory.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = await file.stat();
      const initial = mediaSourceIdentity(info);
      if (
        !info.isFile() ||
        !validIdentity(initial) ||
        !Number.isSafeInteger(initial.size) ||
        initial.size < 1 ||
        initial.size > (this.options.maxFileBytes ?? 20 * 1024 ** 3)
      )
        throw new Error(
          "External source must be a nonempty regular file within the resource limit",
        );
      if (
        options.expectedBytes !== undefined &&
        (!Number.isSafeInteger(options.expectedBytes) || initial.size !== options.expectedBytes)
      )
        throw new Error("External source size changed after selection");
      if (
        options.expectedLastModified !== undefined &&
        (!Number.isSafeInteger(options.expectedLastModified) ||
          Math.trunc(initial.mtimeMs) !== options.expectedLastModified)
      )
        throw new Error("External source changed after selection");
      const verify = async () => {
        await directory.verify();
        const named = await lstat(directory.path),
          held = await file!.stat();
        if (
          !named.isFile() ||
          named.isSymbolicLink() ||
          !sameSource(initial, mediaSourceIdentity(named)) ||
          !sameSource(initial, mediaSourceIdentity(held))
        )
          throw new ReferenceUnavailable("changed");
      };
      await verify();
      let closing: Promise<void> | undefined;
      return {
        directory,
        file,
        initial,
        verify,
        close: () => (closing ??= Promise.all([file!.close(), directory.close()]).then(() => {})),
      };
    } catch (error) {
      await file?.close().catch(() => {});
      await directory.close();
      throw error;
    }
  }
  private async checked(
    scope: ResourceScope,
    record: StoredReference,
    options: ExternalReferenceOptions = {},
  ) {
    await this.authorize(scope, options);
    try {
      if ((await realpath(record.root)) !== record.root) throw new ReferenceUnavailable("changed");
      const selected = await this.selected(scope, record.root, record.path, options);
      if (
        !sameSource(record.source, selected.initial) ||
        record.ancestors.length !== selected.directory.identities.length ||
        record.ancestors.some(
          (identity, index) =>
            !sameResourceIdentity(identity, selected.directory.identities[index]!),
        )
      ) {
        await selected.close();
        throw new ReferenceUnavailable("changed");
      }
      const verify = selected.verify;
      selected.verify = async () => {
        if ((await realpath(record.root)) !== record.root)
          throw new ReferenceUnavailable("changed");
        await verify();
      };
      return selected;
    } catch (error) {
      await this.authorize(scope, options);
      if (error instanceof ReferenceUnavailable) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new ReferenceUnavailable(
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "") ? "missing" : "changed",
      );
    }
  }
  /** Only call with a directory selected and authorized by the trusted Host. */
  createFromDirectory(
    scope: ResourceScope,
    root: string,
    path: string,
    options: ExternalReferenceOptions = {},
  ) {
    return this.locked(scope, async () => {
      const selected = await this.selected(scope, root, resourceRelativePath(path), options);
      try {
        root = selected.directory.rootPath;
        const id = `external-${createHash("sha256")
          .update(
            JSON.stringify([
              "external-reference-v1",
              mediaScopeKey(scope),
              root,
              path,
              selected.initial,
            ]),
          )
          .digest("hex")}`;
        const directory = await this.directory(scope, true),
          location = join(directory, `${id}.json`);
        try {
          const previous = await this.record(scope, id);
          if (
            previous.root !== root ||
            previous.path !== path ||
            !sameSource(previous.source, selected.initial)
          )
            throw new Error("External reference identity mismatch");
          await selected.verify();
          return view(previous);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (
          (await readdir(directory)).filter((name) =>
            REFERENCE_ID.test(name.replace(/\.json$/, "")),
          ).length >= MAX_REFERENCES
        )
          throw new Error("External reference count limit exceeded");
        const record: StoredReference = {
          schemaVersion: 1,
          id,
          name: resourceName(options.name ?? basename(path)),
          mimeType: resourceMimeType(options.name ?? basename(path), options.mimeType),
          createdAt: Date.now(),
          root: selected.directory.rootPath,
          path,
          ancestors: selected.directory.identities,
          source: selected.initial,
        };
        await selected.verify();
        await writeMediaJson(location, record);
        try {
          await selected.verify();
        } catch (error) {
          await rm(location, { force: true });
          throw error;
        }
        return view(record);
      } finally {
        await selected.close();
      }
    });
  }
  createFromSelectedPath(
    scope: ResourceScope,
    path: string,
    options: ExternalReferenceOptions = {},
  ) {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Invalid Host-selected external file");
    return this.createFromDirectory(scope, dirname(path), basename(path), options);
  }
  get(scope: ResourceScope, id: string): Promise<ExternalResourceReference> {
    return this.locked(scope, async () => {
      const record = await this.record(scope, id);
      try {
        const source = await this.checked(scope, record);
        await source.close();
        return view(record);
      } catch (error) {
        if (error instanceof ReferenceUnavailable) return view(record, error.state);
        throw error;
      }
    });
  }
  relinkFromDirectory(
    scope: ResourceScope,
    id: string,
    root: string,
    path: string,
    options: ExternalReferenceOptions = {},
  ) {
    return this.locked(scope, async () => {
      const previous = await this.record(scope, id);
      const selected = await this.selected(scope, root, resourceRelativePath(path), options);
      try {
        // Metadata alone cannot establish that an unrelated replacement is the original file.
        if (!sameSource(previous.source, selected.initial, true))
          throw new Error("This is a different file; create a new external reference instead");
        const record: StoredReference = {
          ...previous,
          root: selected.directory.rootPath,
          path,
          source: selected.initial,
          ancestors: selected.directory.identities,
        };
        await selected.verify();
        await this.stopStreams(
          (stream) => stream.scopeKey === mediaScopeKey(scope) && stream.id === id,
        );
        const location = join(await this.directory(scope), `${id}.json`);
        await writeMediaJson(location, record);
        try {
          await selected.verify();
        } catch (error) {
          await writeMediaJson(location, previous);
          throw error;
        }
        return view(record);
      } finally {
        await selected.close();
      }
    });
  }
  relinkFromSelectedPath(
    scope: ResourceScope,
    id: string,
    path: string,
    options: ExternalReferenceOptions = {},
  ) {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Invalid Host-selected external file");
    return this.relinkFromDirectory(scope, id, dirname(path), basename(path), options);
  }
  forget(scope: ResourceScope, id: string) {
    return this.locked(scope, async () => {
      await this.record(scope, id);
      await this.stopStreams(
        (stream) => stream.scopeKey === mediaScopeKey(scope) && stream.id === id,
      );
      await this.authorize(scope);
      await rm(join(await this.directory(scope), `${id}.json`));
      return { forgotten: true as const };
    });
  }
  openRead(
    scope: ResourceScope,
    id: string,
    options: { range?: string; method?: string; signal?: AbortSignal } = {},
  ): Promise<MediaReadResult> {
    return this.locked(scope, async (): Promise<MediaReadResult> => {
      const record = await this.record(scope, id);
      const source = await this.checked(scope, record, options);
      const method = options.method ?? "GET";
      if (!["GET", "HEAD"].includes(method)) {
        await source.close();
        return { status: 405, headers: { Allow: "GET, HEAD" }, body: null };
      }
      const headers: Record<string, string> = {
        "Content-Type": record.mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ETag: `"${record.id}"`,
      };
      if (!/^(?:audio|video|image)\//.test(record.mimeType))
        headers["Content-Disposition"] =
          `attachment; filename*=UTF-8''${encodeURIComponent(record.name).replace(/['()*!]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`;
      const bounds = options.range
        ? rangeBounds(options.range, record.source.size)
        : { start: 0, end: record.source.size - 1 };
      if (!bounds) {
        await source.close();
        return {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${record.source.size}` },
          body: null,
        };
      }
      headers["Content-Length"] = String(bounds.end - bounds.start + 1);
      if (options.range)
        headers["Content-Range"] = `bytes ${bounds.start}-${bounds.end}/${record.source.size}`;
      const status = options.range ? 206 : 200;
      if (method === "HEAD") {
        await source.close();
        return { status, headers, body: null };
      }
      const stream = Readable.from(
        (async function* () {
          try {
            for (let offset = bounds.start; offset <= bounds.end; ) {
              await source.verify();
              const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, bounds.end - offset + 1));
              const { bytesRead } = await source.file.read(buffer, 0, buffer.length, offset);
              if (bytesRead !== buffer.length) throw new ReferenceUnavailable("changed");
              await source.verify();
              offset += bytesRead;
              yield buffer;
            }
          } finally {
            await source.close();
          }
        })(),
        { objectMode: false },
      );
      let closed!: () => void;
      const entry = {
        scopeKey: mediaScopeKey(scope),
        appId: scope.appId,
        id,
        stream,
        closed: new Promise<void>((resolve) => {
          closed = resolve;
        }),
      };
      const abort = () => stream.destroy(new Error("External resource read was cancelled"));
      stream.on("error", () => {});
      stream.once("close", () => {
        options.signal?.removeEventListener("abort", abort);
        void source
          .close()
          .catch(() => {})
          .finally(() => {
            this.streams.delete(entry);
            closed();
          });
      });
      this.streams.add(entry);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      return { status, headers, body: stream };
    });
  }
  private async stopStreams(
    match: (stream: { scopeKey: string; appId: string; id: string }) => boolean,
  ) {
    const streams = [...this.streams].filter(match);
    for (const entry of streams)
      entry.stream.destroy(new Error("External resource access was revoked"));
    await Promise.all(streams.map((entry) => entry.closed));
  }
  cancelScope(scope: ResourceScope) {
    return this.stopStreams((stream) => stream.scopeKey === mediaScopeKey(scope));
  }
  cancelApp(appId: string) {
    return this.stopStreams((stream) => stream.appId === appId);
  }
  async shutdown() {
    this.closed = true;
    await this.stopStreams(() => true);
    await Promise.allSettled([...this.queues.values()]);
  }
}

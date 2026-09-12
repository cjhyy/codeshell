import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import { ResourceLibrary, mediaSourceIdentity } from "./library.js";
import { mediaScopeKey, normalizeMediaScope } from "./storage.js";
import {
  openResourceDirectory,
  resourceRelativePath,
  sameResourceIdentity,
} from "./directories.js";
import { ResourceUploadIngest } from "./uploads.js";
import type { ResourceScope } from "./types.js";

const CHUNK_BYTES = 32768;
export interface PanelResourceServiceOptions {
  rootDirectory: string;
  isScopeAuthorized(scope: ResourceScope): boolean | Promise<boolean>;
  maxFileBytes?: number;
}
export interface PanelResourceCallContext {
  /** Resolve a live, owner-authorized process directory grant; never accept a guest path. */
  resolveDirectory?: (handle: string) => string | Promise<string>;
  signal?: AbortSignal;
}
export class PanelResourceError extends Error {
  constructor(
    readonly code: "INVALID_RESOURCE_REQUEST" | "RESOURCE_ACCESS_DENIED" | "RESOURCE_IO_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PanelResourceError";
  }
}
function object(value: unknown, keys: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new PanelResourceError("INVALID_RESOURCE_REQUEST", "Invalid resource request fields");
  return value as Record<string, any>;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new PanelResourceError(
      "INVALID_RESOURCE_REQUEST",
      "Invalid resource byte range or limit",
    );
  return Number(value);
}
function assetId(value: unknown): string {
  if (typeof value !== "string" || !/^asset-[a-f0-9]{64}$/.test(value))
    throw new PanelResourceError("INVALID_RESOURCE_REQUEST", "Invalid resource ID");
  return value;
}

/** Generic resource custody and byte transport; it never interprets a project or invokes a model. */
export class PanelResourceService {
  readonly library: ResourceLibrary;
  private readonly uploads: ResourceUploadIngest;
  private readonly directoryIdentities = new Map<string, { dev: number; ino: number }>();
  private closed = false;
  constructor(private readonly options: PanelResourceServiceOptions) {
    this.library = new ResourceLibrary(options);
    this.uploads = new ResourceUploadIngest({ ...options, library: this.library });
  }
  capabilities() {
    return {
      available: true,
      maxChunkBytes: CHUNK_BYTES,
      maxFileBytes: this.options.maxFileBytes ?? 20 * 1024 ** 3,
      materialize: true,
      capture: true,
      resumableUploads: true,
    };
  }
  initialize(): Promise<void> {
    return this.uploads.initialize();
  }
  private async authorize(scope: ResourceScope, context: PanelResourceCallContext = {}) {
    normalizeMediaScope(scope);
    context.signal?.throwIfAborted();
    if (this.closed || !(await this.options.isScopeAuthorized(scope)))
      throw new PanelResourceError(
        "RESOURCE_ACCESS_DENIED",
        "Resource access is no longer authorized",
      );
    context.signal?.throwIfAborted();
  }
  private async directory(
    scope: ResourceScope,
    input: Record<string, any>,
    context: PanelResourceCallContext,
    create: boolean,
  ) {
    if (
      typeof input.directoryHandle !== "string" ||
      !input.directoryHandle ||
      input.directoryHandle.length > 256 ||
      !context.resolveDirectory
    )
      throw new PanelResourceError(
        "INVALID_RESOURCE_REQUEST",
        "An authorized tool directory is required",
      );
    const path = resourceRelativePath(input.path);
    const root = await context.resolveDirectory(input.directoryHandle);
    const verify = async () => {
      await this.authorize(scope, context);
      if ((await context.resolveDirectory!(input.directoryHandle)) !== root)
        throw new PanelResourceError(
          "RESOURCE_ACCESS_DENIED",
          "Tool directory authorization changed",
        );
    };
    const held = await openResourceDirectory(root, path, create, verify);
    const key = `${mediaScopeKey(scope)}:${input.directoryHandle}`;
    const previous = this.directoryIdentities.get(key);
    if (previous && !sameResourceIdentity(previous, held.rootIdentity)) {
      await held.close();
      throw new PanelResourceError("RESOURCE_ACCESS_DENIED", "Tool directory has been replaced");
    }
    // Grants are bounded by the Host; retain a bounded extra identity cache as defence in depth.
    if (this.directoryIdentities.size >= 1024 && !previous) {
      await held.close();
      throw new Error("Too many resource directory grants; reopen the panel");
    }
    this.directoryIdentities.set(key, { dev: held.rootIdentity.dev, ino: held.rootIdentity.ino });
    return held;
  }
  private async materialize(scope: ResourceScope, raw: unknown, context: PanelResourceCallContext) {
    const input = object(raw, ["assetId", "directoryHandle", "path"]);
    const asset = await this.library.get(scope, assetId(input.assetId));
    const directory = await this.directory(scope, input, context, true);
    const temporary = directory.location(`.${randomUUID()}.resource-partial`);
    let destination: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    let identity: { dev: number; ino: number } | undefined;
    try {
      await directory.verify();
      destination = await open(
        temporary,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      identity = await destination.stat();
      const source = await this.library.openRead(scope, asset.id);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of source.body!) {
          await directory.verify();
          if (bytes + chunk.length > asset.bytes) throw new Error("Resource content changed");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await destination.write(
              chunk,
              offset,
              chunk.length - offset,
              bytes + offset,
            );
            if (!written.bytesWritten) throw new Error("Resource copy stopped making progress");
            offset += written.bytesWritten;
          }
          bytes += chunk.length;
        }
      } finally {
        source.body?.destroy();
      }
      if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256)
        throw new Error("Resource content failed integrity validation");
      await destination.sync();
      // A tool may share the granted directory. Verify the actual destination,
      // not only the source stream, before publishing the materialized file.
      const completed = await destination.stat();
      const copiedHash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      for (let offset = 0; offset < asset.bytes; ) {
        await directory.verify();
        const read = await destination.read(
          buffer,
          0,
          Math.min(buffer.length, asset.bytes - offset),
          offset,
        );
        if (!read.bytesRead) throw new Error("Resource copy was truncated");
        copiedHash.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
      }
      const verified = await destination.stat();
      if (
        verified.size !== asset.bytes ||
        verified.mtimeMs !== completed.mtimeMs ||
        verified.ctimeMs !== completed.ctimeMs ||
        copiedHash.digest("hex") !== asset.sha256
      )
        throw new Error("Materialized resource failed integrity verification");
      await destination.close();
      destination = undefined;
      await directory.verify();
      // Hard-link publication is atomic and refuses to overwrite any existing tool file.
      await link(temporary, directory.path);
      published = true;
      await directory.verify();
      const current = await lstat(directory.path);
      if (!current.isFile() || current.isSymbolicLink() || !sameResourceIdentity(current, identity))
        throw new Error("Resource output changed during publication");
      return { assetId: asset.id, path: input.path, bytes: asset.bytes, sha256: asset.sha256 };
    } catch (error) {
      if (published && identity) {
        const current = await lstat(directory.path).catch(() => undefined);
        if (current && sameResourceIdentity(current, identity))
          await rm(directory.path, { force: true }).catch(() => {});
      }
      throw error;
    } finally {
      await destination?.close().catch(() => {});
      const current = await lstat(temporary).catch(() => undefined);
      if (current && identity && sameResourceIdentity(current, identity))
        await rm(temporary, { force: true }).catch(() => {});
      await directory.close();
    }
  }
  private async capture(scope: ResourceScope, raw: unknown, context: PanelResourceCallContext) {
    const input = object(raw, [
      "directoryHandle",
      "path",
      "name",
      "mimeType",
      "expectedBytes",
      "expectedSha256",
    ]);
    if (
      input.name !== undefined &&
      (typeof input.name !== "string" || !input.name || input.name.length > 240)
    )
      throw new Error("Invalid resource name");
    if (
      input.mimeType !== undefined &&
      (typeof input.mimeType !== "string" || input.mimeType.length > 200)
    )
      throw new Error("Invalid resource MIME type");
    const directory = await this.directory(scope, input, context, false);
    let source: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await directory.verify();
      source = await open(
        directory.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const initial = await source.stat();
      if (!initial.isFile()) throw new Error("Tool output must be a regular file");
      const verify = async () => {
        await directory.verify();
        const current = await lstat(directory.path);
        if (current.isSymbolicLink() || !sameResourceIdentity(initial, current))
          throw new Error("Tool output was replaced");
      };
      return {
        asset: await this.library.importFile(scope, directory.path, {
          name: input.name ?? directory.name,
          mimeType: input.mimeType,
          expectedBytes: input.expectedBytes,
          expectedSha256: input.expectedSha256,
          expectedSource: mediaSourceIdentity(initial),
          signal: context.signal,
          assertAuthorized: verify,
        }),
      };
    } finally {
      await source?.close().catch(() => {});
      await directory.close();
    }
  }
  private async read(scope: ResourceScope, raw: unknown, context: PanelResourceCallContext) {
    const input = object(raw, ["assetId", "offset", "length"]);
    const asset = await this.library.get(scope, assetId(input.assetId));
    const offset = integer(input.offset, 0, asset.bytes),
      length = integer(input.length, 1, CHUNK_BYTES);
    const expected = Math.min(length, asset.bytes - offset);
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (expected) {
      const result = await this.library.openRead(scope, asset.id, {
        range: `bytes=${offset}-${offset + expected - 1}`,
      });
      try {
        for await (const chunk of result.body!) {
          await this.authorize(scope, context);
          bytes += chunk.length;
          if (bytes > expected) throw new Error("Resource range exceeded its limit");
          chunks.push(Buffer.from(chunk));
        }
        if (bytes !== expected) throw new Error("Resource range was incomplete");
      } finally {
        result.body?.destroy();
      }
    } else await this.library.resolvePath(scope, asset.id);
    await this.authorize(scope, context);
    return {
      assetId: asset.id,
      offset,
      totalBytes: asset.bytes,
      mimeType: asset.mimeType,
      dataBase64: Buffer.concat(chunks).toString("base64"),
      eof: offset + bytes === asset.bytes,
    };
  }
  async dispatch(
    scope: ResourceScope,
    method: string,
    raw: unknown = {},
    context: PanelResourceCallContext = {},
  ): Promise<any> {
    try {
      await this.authorize(scope, context);
      switch (method) {
        case "resources.list": {
          const input = object(raw, ["offset", "limit"]);
          const offset = integer(input.offset ?? 0, 0, 100000),
            limit = integer(input.limit ?? 50, 1, 100);
          const assets = await this.library.list(scope);
          return { assets: assets.slice(offset, offset + limit), total: assets.length };
        }
        case "resources.get":
          return { asset: await this.library.get(scope, assetId(object(raw, ["id"]).id)) };
        case "resources.read":
          return await this.read(scope, raw, context);
        case "resources.materialize":
          return await this.materialize(scope, raw, context);
        case "resources.capture":
          return await this.capture(scope, raw, context);
        case "resources.upload.begin":
          return await this.uploads.begin(scope, raw);
        case "resources.upload.write":
          return await this.uploads.write(scope, raw);
        case "resources.upload.get":
          return await this.uploads.get(scope, raw);
        case "resources.upload.finish":
          return await this.uploads.finish(scope, raw, context.signal);
        case "resources.upload.cancel":
          return await this.uploads.cancel(scope, raw);
        default:
          throw new PanelResourceError("INVALID_RESOURCE_REQUEST", "Unsupported resource method");
      }
    } catch (error) {
      if (
        error instanceof PanelResourceError ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw error;
      throw new PanelResourceError(
        "RESOURCE_IO_FAILED",
        "Resource operation failed; check the file and its authorization, then retry",
        { cause: error },
      );
    }
  }
  /** Trusted lifecycle hook; call after a tool owner releases its directory grant. */
  releaseDirectory(scope: ResourceScope, handle: string): void {
    this.directoryIdentities.delete(`${mediaScopeKey(scope)}:${handle}`);
  }
  cancelScope(scope: ResourceScope): Promise<void> {
    return this.uploads.cancelScope(scope);
  }
  cancelApp(appId: string): Promise<void> {
    return this.uploads.cancelApp(appId);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.uploads.shutdown();
    this.directoryIdentities.clear();
  }
}

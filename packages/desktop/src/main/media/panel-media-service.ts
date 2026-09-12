import { copyFile, lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { PanelResourceService } from "@cjhyy/code-shell-server/panels";
import { MediaLibrary, mediaSourceIdentity, type MediaSourceIdentity } from "./media-library.js";
import { MediaJobService } from "./media-jobs.js";
import { MediaDocumentStore } from "./media-documents.js";
import { mediaDirectory, mediaScopeKey, readMediaJson } from "./media-storage.js";
import { MediaRecordingIngest } from "./media-recording-ingest.js";
import { legacyJobRecipe } from "./media-job-recipe.js";
import type { MediaAsset, MediaJob, MediaScope } from "./media-types.js";

export interface PanelMediaOptions {
  rootDirectory: string;
  isScopeAuthorized(scope: MediaScope): boolean;
  onChanged?(scope: MediaScope, job: MediaJob): void;
}
interface SelectedMediaFile {
  path: string;
  identity: MediaSourceIdentity;
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Media request must be an object");
  return value as Record<string, any>;
}
function assetId(value: unknown): string {
  if (typeof value !== "string" || !/^asset-[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid managed media ID");
  return value;
}
function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error("Invalid media pagination");
  return value;
}

function pageResult(
  base: Record<string, unknown>,
  field: string,
  raw: unknown,
  input: Record<string, any>,
  fallback: number,
): unknown {
  if (!Array.isArray(raw)) throw new Error("Invalid stored media analysis");
  const offset = boundedInteger(input.offset, 0, 100000);
  const limit = boundedInteger(input.limit, fallback, 100);
  const values: unknown[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(base)) + 1024;
  for (const value of raw.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes + size > 192 * 1024) {
      if (!values.length) throw new Error("A media analysis item exceeds the response budget");
      break;
    }
    values.push(value);
    bytes += size;
  }
  return {
    ...base,
    total: raw.length,
    offset,
    nextOffset: offset + values.length,
    [field]: values,
  };
}

/** Compatibility custody API. Processing and dependency management belong to Panel tools. */
export class PanelMediaService {
  readonly library: MediaLibrary;
  readonly jobs: MediaJobService;
  readonly documents: MediaDocumentStore;
  private readonly resources: PanelResourceService;
  private readonly recording: MediaRecordingIngest;
  private ready?: Promise<void>;
  private closing = false;
  constructor(private readonly options: PanelMediaOptions) {
    this.resources = new PanelResourceService(options);
    this.library = this.resources.library;
    this.jobs = new MediaJobService({
      rootDirectory: options.rootDirectory,
      concurrency: 2,
      onChanged: options.onChanged,
    });
    this.documents = new MediaDocumentStore(options.rootDirectory);
    this.recording = new MediaRecordingIngest({ ...options, library: this.library });
  }
  private authorize(scope: MediaScope): void {
    if (!this.options.isScopeAuthorized(scope))
      throw new Error("Media app or workspace authorization was revoked");
  }
  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Media service is closed"));
    this.ready ??= this.setup();
    return this.ready;
  }
  private async setup(): Promise<void> {
    this.jobs.registerProcessor("import", {
      recovery: "restart",
      run: async (raw, context) => {
        this.authorize(context.scope);
        const input = object(raw);
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100)
          throw new Error(
            "This import has no saved selection identity; select the media files again",
          );
        const assets: MediaAsset[] = [];
        for (const [index, { path, identity }] of (input.files as SelectedMediaFile[]).entries()) {
          this.authorize(context.scope);
          if (
            !identity ||
            Object.values(mediaSourceIdentity(identity)).some((value) => !Number.isFinite(value))
          )
            throw new Error(
              "This import has no valid saved selection identity; select the media files again",
            );
          let lastProgress = 0;
          const asset = await this.library.importFile(context.scope, path, {
            signal: context.signal,
            expectedSource: identity,
            onProgress: (copiedBytes, totalBytes) => {
              if (Date.now() - lastProgress < 500 && copiedBytes !== totalBytes) return;
              lastProgress = Date.now();
              void context
                .reportProgress({
                  stage: "import",
                  message: basename(path),
                  fraction: (index + copiedBytes / Math.max(1, totalBytes)) / input.files.length,
                })
                .catch(() => {});
            },
          });
          assets.push(asset);
        }
        return { assets };
      },
    });

    await Promise.all([this.recording.initialize(), this.jobs.initialize()]);
  }
  private analysisDirectory(scope: MediaScope): Promise<string> {
    return mediaDirectory(this.options.rootDirectory, ["scopes", mediaScopeKey(scope), "analysis"]);
  }
  async importFiles(scope: MediaScope, paths: string[]): Promise<MediaJob> {
    this.authorize(scope);
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 100 ||
      paths.some((path) => typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    )
      throw new Error("Select between 1 and 100 media files");
    const files: SelectedMediaFile[] = [];
    for (const path of paths) {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error("Select a regular media file");
      files.push({ path, identity: mediaSourceIdentity(info) });
    }
    return this.enqueueImports(scope, files);
  }

  private async enqueueImports(scope: MediaScope, files: SelectedMediaFile[]): Promise<MediaJob> {
    await this.initialize();
    this.authorize(scope);
    return this.jobs.start(scope, { type: "import", input: { files } });
  }

  async importWorkspaceFiles(scope: MediaScope, cwd: string, paths: unknown): Promise<MediaJob> {
    this.authorize(scope);
    if (!Array.isArray(paths) || !paths.length || paths.length > 100)
      throw new Error("Provide 1–100 workspace-relative paths");
    const root = await realpath(cwd);
    const files: SelectedMediaFile[] = [];
    for (const path of paths) {
      if (
        typeof path !== "string" ||
        isAbsolute(path) ||
        path.includes("\0") ||
        path.split(/[\\/]/).some((part) => part === ".." || part.startsWith("."))
      )
        throw new Error("Media import requires workspace-relative paths");
      const target = await realpath(join(root, path));
      const relation = relative(root, target);
      if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation))
        throw new Error("Media source escapes the authorized workspace");
      const info = await lstat(target);
      if (!info.isFile() || (await realpath(target)) !== target)
        throw new Error("Media source changed during selection");
      files.push({ path: target, identity: mediaSourceIdentity(info) });
    }
    return this.enqueueImports(scope, files);
  }

  async dispatch(scope: MediaScope, method: string, raw: unknown): Promise<unknown> {
    this.authorize(scope);
    await this.initialize();
    this.authorize(scope);
    const input = raw === undefined ? {} : object(raw);
    switch (method) {
      case "media.status":
        return {
          apiVersion: 1,
          persistent: true,
          assetRead: { available: true, maxChunkBytes: 32768 },
          resources: this.resources.capabilities(),
          processors: ["import", "recording"],
          processing: "panel-native",
          historicalJobRecipes: true,
        };
      case "media.recording.begin":
        return this.recording.begin(scope, input);
      case "media.recording.write":
        return this.recording.write(scope, input);
      case "media.recording.finish":
        return this.recording.finish(scope, input);
      case "media.recording.cancel":
        return this.recording.cancel(scope, input);
      case "media.recording.get":
        return this.recording.get(scope, input);
      case "media.assets.list": {
        const assets = await this.library.list(scope);
        const offset = boundedInteger(input.offset, 0, 100000),
          limit = boundedInteger(input.limit, 50, 100);
        return { total: assets.length, assets: assets.slice(offset, offset + limit) };
      }
      case "media.assets.get": {
        const id = assetId(input.id);
        const asset = await this.library.get(scope, id);
        const preparation = await readMediaJson(
          join(await this.analysisDirectory(scope), `${id}.json`),
        ).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        return { asset, preparation };
      }
      case "media.assets.read": {
        if (Object.keys(input).some((key) => !["assetId", "offset", "length"].includes(key)))
          throw new Error("不支持此素材读取参数");
        const id = assetId(input.assetId);
        const offset = input.offset,
          length = input.length;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > 32768
        )
          throw new Error("素材读取需要有效字节位置，每次最多读取 32768 字节");
        try {
          const asset = await this.library.get(scope, id);
          if (offset > asset.bytes) throw new Error("素材读取位置超出文件长度");
          this.authorize(scope);
          const chunks: Buffer[] = [];
          let bytes = 0;
          const expected = Math.min(length, asset.bytes - offset);
          if (expected) {
            const result = await this.library.openRead(scope, id, {
              range: `bytes=${offset}-${offset + expected - 1}`,
            });
            if (result.status !== 206 || !result.body) throw new Error("Invalid managed range");
            try {
              for await (const chunk of result.body) {
                this.authorize(scope);
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                if (bytes > expected) throw new Error("Managed range exceeds its budget");
                chunks.push(buffer);
              }
            } finally {
              result.body.destroy();
            }
            if (bytes !== expected) throw new Error("Incomplete managed range");
          } else {
            await this.library.resolvePath(scope, id);
          }
          this.authorize(scope);
          return {
            assetId: id,
            offset,
            totalBytes: asset.bytes,
            mimeType: asset.mimeType,
            dataBase64: Buffer.concat(chunks, bytes).toString("base64"),
            eof: offset + bytes === asset.bytes,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (
            [
              "素材读取位置超出文件长度",
              "Media app or workspace authorization was revoked",
            ].includes(message)
          )
            throw error;
          throw new Error("无法读取受管素材，请确认素材仍可用后重试", { cause: error });
        }
      }
      case "media.transcript": {
        const transcript = object(
          await readMediaJson(
            join(await this.analysisDirectory(scope), `${assetId(input.assetId)}-transcript.json`),
          ),
        );
        return pageResult(
          {
            assetId: input.assetId,
            engine: transcript.engine,
            language: transcript.language,
          },
          "segments",
          transcript.segments,
          input,
          50,
        );
      }
      case "media.analysis": {
        if (input.kind !== "silence" && input.kind !== "scenes")
          throw new Error("Unsupported media analysis kind");
        const data = object(
          await readMediaJson(
            join(
              await this.analysisDirectory(scope),
              `${assetId(input.assetId)}-${input.kind}.json`,
            ),
          ),
        );
        const field = input.kind === "silence" ? "intervals" : "cuts";
        return pageResult(
          {
            assetId: input.assetId,
            kind: input.kind,
            detector: data.detector,
          },
          field,
          data[field],
          input,
          100,
        );
      }
      case "media.jobs.list": {
        const jobs = await this.jobs.list(scope, { includeResult: false });
        const offset = boundedInteger(input.offset, 0, 100000),
          limit = boundedInteger(input.limit, 20, 50);
        return {
          total: jobs.length,
          jobs: jobs.slice(offset, offset + limit).map(({ result: _result, ...job }) => job),
        };
      }
      case "media.jobs.get":
        return this.jobs.get(scope, input.id);
      case "media.jobs.cancel":
        return this.jobs.cancel(scope, input.id);
      case "media.jobs.retry":
        throw new Error(
          "Rebuild this historical operation through the Panel native tools using media.jobs.recipe",
        );
      case "media.jobs.recipe":
        return legacyJobRecipe(await this.jobs.recipe(scope, input.id));
      case "media.document.get":
        return this.documents.get(scope, input.key, input.revision);
      case "media.document.set":
        return this.documents.set(scope, input.key, {
          baseRevision: input.baseRevision,
          data: input.data,
          label: input.label,
        });
      case "media.document.versions":
        return this.documents.versions(scope, input.key);
      default:
        throw new Error(
          `This operation now runs in the Panel native tools. Update the Panel and retry (${method}).`,
        );
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.ready?.catch(() => {});
    await Promise.all([this.jobs.shutdown(), this.recording.shutdown(), this.resources.shutdown()]);
  }
  async cancelApp(appId: string): Promise<void> {
    await this.initialize();
    await Promise.all([
      this.jobs.cancelApp(appId),
      this.recording.cancelApp(appId),
      this.resources.cancelApp(appId),
    ]);
  }
  async exportFile(scope: MediaScope, id: string, destination: string): Promise<void> {
    this.authorize(scope);
    await this.library.verifyContent(scope, assetId(id));
    const source = await this.library.resolvePath(scope, id);
    this.authorize(scope);
    // The destination is chosen by the native Host save dialog, never by the guest.
    await copyFile(source, destination);
  }
}

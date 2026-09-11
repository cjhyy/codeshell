import { constants } from "node:fs";
import { access, copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, extname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import {
  resolveSpeechConfiguration,
  type SpeechConfiguration,
  type SpeechModelDescription,
} from "@cjhyy/code-shell-core/internal";
import { MediaLibrary, mediaSourceIdentity, type MediaSourceIdentity } from "./media-library.js";
import { MediaJobService } from "./media-jobs.js";
import { MediaDocumentStore } from "./media-documents.js";
import { mediaDirectory, mediaScopeKey, readMediaJson, writeMediaJson } from "./media-storage.js";
import {
  createMediaJobProcessors,
  type MediaInspection,
  type MediaProcessorOptions,
} from "./media-processors.js";
import {
  createHyperframesAdapter,
  detectHyperframesRuntime,
  type HyperframesSceneParams,
} from "./hyperframes-adapter.js";
import type { MediaAsset, MediaJob, MediaScope } from "./media-types.js";
import { detectLocalTts, generateLocalTts, validateLocalTtsInput } from "./media-tts.js";
import {
  generateOpenAiTts,
  type OpenAiTtsInput,
  type OpenAiTtsOptions,
} from "./media-tts-openai.js";
import { runMediaProcess } from "./media-process-runner.js";
import { createAudioEnhanceProcessor, validateAudioEnhanceInput } from "./media-audio-enhance.js";
import { MediaRecordingIngest } from "./media-recording-ingest.js";
import { createManagedTtsProviders, validateManagedTtsInput } from "./media-tts-providers.js";

export interface PanelMediaOptions {
  rootDirectory: string;
  isScopeAuthorized(scope: MediaScope): boolean;
  onChanged?(scope: MediaScope, job: MediaJob): void;
  renderCaptionPng?: MediaProcessorOptions["renderCaptionPng"];
  /** Trusted Host/test seams. Neither credentials nor endpoints are guest arguments. */
  speechConfiguration?(scope: MediaScope): SpeechConfiguration;
  generateOnlineSpeech?: typeof generateOpenAiTts;
  speechAudioToolsAvailable?(): Promise<boolean>;
}
export interface PreparedMedia {
  assetId: string;
  inspection: MediaInspection;
  proxy?: { asset: MediaAsset; mimeType: string };
  thumbnail?: { asset: MediaAsset; mimeType: string };
  waveform?: unknown;
  silence?: unknown;
  scenes?: unknown;
  transcription?: unknown;
  preparedAt: number;
}
interface SelectedMediaFile {
  path: string;
  identity: MediaSourceIdentity;
}
const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
]);
const ARTIFACT_MIME = new Set([
  "video/mp4",
  "audio/mp4",
  "image/png",
  "application/x-subrip",
  "application/json",
]);

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
async function executable(name: string): Promise<string> {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ];
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === "win32" ? `${name}.exe` : name);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return name;
}

/** Narrow, path-free guest API over durable Host media processors. */
export class PanelMediaService {
  readonly library: MediaLibrary;
  readonly jobs: MediaJobService;
  readonly documents: MediaDocumentStore;
  private ready?: Promise<void>;
  private closing = false;
  private recording!: MediaRecordingIngest;
  private managedTts!: ReturnType<typeof createManagedTtsProviders>;
  private dependencies?: { ffmpegPath: string; ffprobePath: string; whisperPath: string };

  constructor(private readonly options: PanelMediaOptions) {
    this.library = new MediaLibrary({ rootDirectory: options.rootDirectory });
    this.jobs = new MediaJobService({
      rootDirectory: options.rootDirectory,
      concurrency: 2,
      onChanged: options.onChanged,
    });
    this.documents = new MediaDocumentStore(options.rootDirectory);
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
    const [ffmpegPath, ffprobePath, whisperPath] = await Promise.all([
      executable("ffmpeg"),
      executable("ffprobe"),
      executable("whisper"),
    ]);
    if (this.closing) throw new Error("Media service is closed");
    this.dependencies = { ffmpegPath, ffprobePath, whisperPath };
    this.recording = new MediaRecordingIngest({
      rootDirectory: this.options.rootDirectory,
      library: this.library,
      ffprobePath,
      isScopeAuthorized: this.options.isScopeAuthorized,
    });
    this.managedTts = createManagedTtsProviders({
      runtimeDir: join(this.options.rootDirectory, "media-runtimes", "tts"),
      reuseKokoroDir: join(homedir(), ".cache", "hyperframes", "tts"),
      ffmpegPath,
      ffprobePath,
    });
    await this.recording.initialize();
    this.jobs.registerProcessor(
      "audio-enhance",
      createAudioEnhanceProcessor({
        ffmpegPath,
        ffprobePath,
        resolveAssetPath: (scope, id) => {
          this.authorize(scope);
          return this.library.resolvePath(scope, id);
        },
        publishArtifact: async (scope, path, mimeType, context) => {
          this.authorize(scope);
          const asset = await this.library.importFile(scope, path, {
            name: "优化后的原声.wav",
            mimeType,
            signal: context.signal,
          });
          this.authorize(scope);
          return asset;
        },
      }),
    );
    this.jobs.registerProcessor("tts-setup", {
      recovery: "restart",
      run: async (raw, context) => {
        this.authorize(context.scope);
        return this.managedTts.setup(managedProviderId(object(raw).providerId), context);
      },
    });
    const processors = createMediaJobProcessors({
      ...this.dependencies,
      resolveAssetPath: (scope, id) => {
        this.authorize(scope);
        return this.library.resolvePath(scope, id);
      },
      publishArtifact: async (scope, path, mimeType) => {
        this.authorize(scope);
        if (!ARTIFACT_MIME.has(mimeType)) throw new Error("Unsupported processor artifact type");
        return this.library.importFile(scope, path, { mimeType });
      },
      renderCaptionPng: this.options.renderCaptionPng,
    });
    for (const [type, processor] of Object.entries(processors)) {
      this.jobs.registerProcessor(type, {
        recovery: processor.recovery,
        run: async (input, context) => {
          this.authorize(context.scope);
          const result = await processor.run(input, context);
          if (type === "transcribe")
            return this.saveTranscript(context.scope, object(input).assetId, result);
          if (type === "silence" || type === "scenes")
            return this.saveAnalysis(context.scope, object(input).assetId, type, result);
          return result;
        },
      });
    }
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
          if (!MEDIA_EXTENSIONS.has(extname(path).toLowerCase()))
            throw new Error("Unsupported source media format");
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
    this.jobs.registerProcessor("prepare", {
      recovery: "restart",
      run: async (raw, context) => {
        const input = object(raw);
        const id = assetId(input.assetId);
        const inspection = (
          (await processors.inspect!.run({ assetId: id }, context)) as {
            inspection: MediaInspection;
          }
        ).inspection;
        const result: PreparedMedia = { assetId: id, inspection, preparedAt: Date.now() };
        const kinds = [
          "thumbnail",
          ...(inspection.kind !== "image" ? ["proxy"] : []),
          ...(inspection.audio ? ["waveform", "silence"] : []),
          ...(inspection.kind === "video" ? ["scenes"] : []),
          ...(input.transcribe && inspection.audio ? ["transcribe"] : []),
        ];
        for (const [index, type] of kinds.entries()) {
          this.authorize(context.scope);
          const value = (await processors[type]!.run(
            { assetId: id },
            {
              ...context,
              reportProgress: (progress) =>
                context.reportProgress({
                  ...progress,
                  stage: type,
                  fraction: (index + (progress.fraction ?? 0)) / kinds.length,
                }),
            },
          )) as Record<string, unknown>;
          if (type === "proxy" || type === "thumbnail")
            Object.assign(result, { [type]: value[type] });
          else if (type === "transcribe") {
            result.transcription = await this.saveTranscript(context.scope, id, value);
          } else
            Object.assign(result, {
              [type]:
                type === "silence" || type === "scenes"
                  ? await this.saveAnalysis(context.scope, id, type, value)
                  : value,
            });
        }
        await writeMediaJson(
          join(await this.analysisDirectory(context.scope), `${id}.json`),
          result,
        );
        return result;
      },
    });
    this.jobs.registerProcessor("scene", {
      recovery: "restart",
      run: async (raw, context) => {
        this.authorize(context.scope);
        const input = object(raw);
        const params = object(input.params) as HyperframesSceneParams;
        const directory = await mediaDirectory(this.options.rootDirectory, [
          "scopes",
          mediaScopeKey(context.scope),
          "scenes",
        ]);
        const adapter = createHyperframesAdapter({
          workspaceRoot: directory,
          cacheRoot: join(directory, "cache"),
          ...this.dependencies,
        });
        const hfContext = {
          signal: context.signal,
          onProgress: (event: { phase: string; message: string; progress?: number }) =>
            context.reportProgress({
              stage: event.phase,
              message: event.message,
              ...(event.progress === undefined ? {} : { fraction: event.progress }),
            }),
        };
        const scene = await adapter.createScene(params, hfContext);
        const result = await adapter.render(scene, { ...hfContext, fps: 30 });
        const asset = await this.library.importFile(context.scope, result.artifactPath, {
          name: `${params.title}.mp4`,
          mimeType: "video/mp4",
          signal: context.signal,
        });
        // Persist editable source metadata privately; no local absolute paths cross IPC.
        await writeMediaJson(
          join(await this.analysisDirectory(context.scope), `${asset.id}-scene.json`),
          { params, source: result },
        );
        return {
          asset,
          scene: {
            params,
            contentHash: result.contentHash,
            cached: result.cached,
            rendererVersion: result.rendererVersion,
          },
          durationSeconds: result.durationSeconds,
          width: result.width,
          height: result.height,
        };
      },
    });
    const publishSpeech = async (
      input: {
        text: string;
        voiceId: string;
        rate: number;
        modelId?: string;
        instructions?: string;
      },
      rendered: { path: string; engine: string },
      context: import("./media-types.js").MediaJobContext,
    ) => {
      this.authorize(context.scope);
      const asset = await this.library.importFile(context.scope, rendered.path, {
        name: `配音-${Array.from(input.text)
          .slice(0, 24)
          .join("")
          .replace(/[\\/:*?"<>|\r\n]/g, " ")}.wav`,
        mimeType: "audio/wav",
        signal: context.signal,
      });
      const inspection = (
        (await processors.inspect!.run({ assetId: asset.id }, context)) as {
          inspection: MediaInspection;
        }
      ).inspection;
      const preparation: PreparedMedia = { assetId: asset.id, inspection, preparedAt: Date.now() };
      await writeMediaJson(
        join(await this.analysisDirectory(context.scope), `${asset.id}.json`),
        preparation,
      );
      return {
        asset,
        inspection,
        speech: {
          text: input.text,
          voiceId: input.voiceId,
          engine: rendered.engine,
          rate: input.rate,
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
        },
      };
    };
    this.jobs.registerProcessor("tts", {
      recovery: "restart",
      run: async (raw, context) => {
        this.authorize(context.scope);
        const input = validateLocalTtsInput(raw);
        const rendered = await generateLocalTts(input, context, this.dependencies);
        return publishSpeech(
          {
            ...input,
            voiceId: rendered.voice.id,
            ...(object(raw).modelId === "macos-say" ? { modelId: "macos-say" } : {}),
          },
          rendered,
          context,
        );
      },
    });
    this.jobs.registerProcessor("tts-online", {
      // A completed remote POST may already have incurred cost when the Host dies.
      // Explicit retry is required; never resubmit this request automatically.
      recovery: "fail",
      run: async (raw, context) => {
        this.authorize(context.scope);
        await this.assertSpeechAudioTools();
        const selected = this.validateOnlineSpeech(context.scope, object(raw));
        const rendered = await (this.options.generateOnlineSpeech ?? generateOpenAiTts)(
          selected.input,
          context,
          { ...this.dependencies, ...selected.options },
        );
        return publishSpeech({ ...selected.input, modelId: selected.modelId }, rendered, context);
      },
    });
    this.jobs.registerProcessor("tts-managed", {
      recovery: "restart",
      run: async (raw, context) => {
        this.authorize(context.scope);
        const input = validateManagedTtsInput(raw);
        const rendered = await this.managedTts.generate(input, context);
        return publishSpeech(
          {
            text: input.text,
            voiceId: rendered.voice.id,
            rate: rendered.rate,
            modelId: rendered.engine,
          },
          rendered,
          context,
        );
      },
    });
    if (this.closing) throw new Error("Media service is closed");
    await this.jobs.initialize();
  }

  private speechConfiguration(scope: MediaScope): SpeechConfiguration {
    try {
      return (
        this.options.speechConfiguration?.(scope) ?? resolveSpeechConfiguration(scope.projectPath)
      );
    } catch {
      throw new Error("无法读取配音连接配置，请在设置中检查文字配音连接");
    }
  }

  private async speechCatalog(scope: MediaScope) {
    const [local, audioToolsAvailable] = await Promise.all([
      detectLocalTts(this.dependencies),
      this.speechAudioToolsAvailable(),
    ]);
    const configured = this.speechConfiguration(scope);
    const models: (SpeechModelDescription & {
      installable?: boolean;
      mode?: string;
      state?: string;
    })[] = [
      {
        id: "macos-say",
        name: "macOS 系统配音",
        provider: "macOS",
        available: local.available,
        ...(local.reason ? { reason: local.reason } : {}),
        voices: local.voices,
        defaultVoiceId: local.defaultVoiceId,
        maxTextLength: 6000,
        supportsInstructions: false,
      },
    ];
    for (const providerId of ["edge-tts", "kokoro"] as const) {
      const runtime = await this.managedTts.status(providerId);
      models.push({
        id: runtime.id,
        name: runtime.name,
        provider: providerId === "edge-tts" ? "Microsoft Edge 在线语音" : "Kokoro 本地模型",
        available: runtime.available && audioToolsAvailable,
        reason: !audioToolsAvailable ? "需要 FFmpeg 和 ffprobe 保存音频" : runtime.reason,
        voices: runtime.voices,
        defaultVoiceId: runtime.defaultVoiceId,
        maxTextLength: 6000,
        supportsInstructions: false,
        installable: true,
        mode: runtime.mode,
        state: runtime.state,
      });
    }
    for (const model of configured.models) {
      const description = {
        ...model.description,
        available: audioToolsAvailable,
        ...(!audioToolsAvailable
          ? { reason: "在线配音需要可用的 FFmpeg 和 ffprobe 以保存音频" }
          : {}),
      };
      if (Buffer.byteLength(JSON.stringify([...models, description])) > 160 * 1024) break;
      models.push(description);
    }
    const defaultModelId = models.some(
      (model) => model.id === configured.defaultModelId && model.available,
    )
      ? configured.defaultModelId!
      : local.available
        ? "macos-say"
        : (models.find((model) => model.available)?.id ?? "macos-say");
    return { ...local, available: models.some((model) => model.available), models, defaultModelId };
  }

  private async speechAudioToolsAvailable(): Promise<boolean> {
    if (this.options.speechAudioToolsAvailable) return this.options.speechAudioToolsAvailable();
    try {
      await Promise.all(
        [
          this.dependencies?.ffmpegPath ?? "ffmpeg",
          this.dependencies?.ffprobePath ?? "ffprobe",
        ].map((path) =>
          runMediaProcess(path, ["-version"], {
            signal: AbortSignal.timeout(5000),
            maxStdoutBytes: 64 * 1024,
          }),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async assertSpeechAudioTools(): Promise<void> {
    if (!(await this.speechAudioToolsAvailable()))
      throw new Error("在线配音需要可用的 FFmpeg 和 ffprobe 以保存音频");
  }

  private validateOnlineSpeech(
    scope: MediaScope,
    raw: Record<string, any>,
  ): {
    input: OpenAiTtsInput;
    options: OpenAiTtsOptions;
    modelId: string;
  } {
    const model = this.speechConfiguration(scope).models.find(
      (model) => model.description.id === raw.modelId,
    );
    if (!model) throw new Error("此配音模型连接已更改或不可用，请重新选择文字配音模型");
    if (typeof raw.text !== "string") throw new Error("请输入配音文字");
    const text = raw.text.replace(/\r\n?/g, "\n").trim();
    if (
      !text ||
      Array.from(text).length > model.description.maxTextLength ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    )
      throw new Error(`配音文稿须为 1 至 ${model.description.maxTextLength} 字`);
    const voiceId = raw.voiceId === undefined ? model.description.defaultVoiceId : raw.voiceId;
    if (
      typeof voiceId !== "string" ||
      !model.description.voices.some((voice) => voice.id === voiceId)
    )
      throw new Error("请选择此模型支持的声音");
    const rate = raw.rate === undefined ? model.defaultRate : raw.rate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0.5 || rate > 2)
      throw new Error("语速须在 0.5 至 2 倍之间");
    const instructions =
      raw.instructions === undefined ? model.defaultInstructions : raw.instructions;
    if (
      instructions !== undefined &&
      (typeof instructions !== "string" ||
        instructions.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions))
    )
      throw new Error("朗读风格指令须为不超过 2000 字的文字");
    if (instructions?.trim() && !model.description.supportsInstructions)
      throw new Error("此配音模型不支持朗读风格指令");
    return {
      modelId: model.description.id,
      input: {
        text,
        model: model.model,
        voiceId,
        rate,
        ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      },
      options: { baseUrl: model.baseUrl, apiKey: model.apiKey },
    };
  }

  private analysisDirectory(scope: MediaScope): Promise<string> {
    return mediaDirectory(this.options.rootDirectory, ["scopes", mediaScopeKey(scope), "analysis"]);
  }

  private async saveTranscript(scope: MediaScope, id: string, value: unknown): Promise<unknown> {
    const result = object(value);
    let data = result;
    if (result.transcript?.asset?.id)
      data = JSON.parse(
        await readFile(await this.library.resolvePath(scope, result.transcript.asset.id), "utf8"),
      );
    else if (result.transcript?.path)
      data = JSON.parse(await readFile(result.transcript.path, "utf8"));
    if (!Array.isArray(data.segments))
      throw new Error("Processor returned no timestamped transcript");
    await writeMediaJson(
      join(await this.analysisDirectory(scope), `${assetId(id)}-transcript.json`),
      data,
    );
    return {
      assetId: id,
      engine: data.engine ?? result.engine,
      language: data.language ?? result.language,
      segmentCount: data.segments.length,
      subtitles: result.subtitles,
    };
  }

  private async saveAnalysis(
    scope: MediaScope,
    id: string,
    kind: "silence" | "scenes",
    value: unknown,
  ): Promise<unknown> {
    const result = object(value);
    const data = result.analysis?.path
      ? JSON.parse(await readFile(result.analysis.path, "utf8"))
      : result;
    await writeMediaJson(
      join(await this.analysisDirectory(scope), `${assetId(id)}-${kind}.json`),
      data,
    );
    const { analysis: _privateArtifact, ...summary } = result;
    return { ...summary, analysis: { available: true, kind } };
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
      case "media.status": {
        const [runtime, speech] = await Promise.all([
          detectHyperframesRuntime(this.dependencies),
          this.speechCatalog(scope),
        ]);
        const localWhisper = await access(join(homedir(), ".cache", "whisper", "base.pt")).then(
          () => true,
          () => false,
        );
        return {
          apiVersion: 1,
          persistent: true,
          processors: [
            "prepare",
            "transcribe",
            "scene",
            "tts",
            "tts-online",
            "tts-managed",
            "tts-setup",
            "audio-enhance",
            "recording",
            "render",
          ],
          tts: {
            available: speech.available,
            engine: speech.engine,
            defaultVoiceId: speech.defaultVoiceId,
            defaultModelId: speech.defaultModelId,
            reason: speech.reason,
          },
          hyperframes: {
            available: runtime.available,
            version: runtime.version,
            checks: runtime.checks,
          },
          transcription: {
            available: localWhisper && isAbsolute(this.dependencies!.whisperPath),
            engine: "local-whisper",
            model: "base",
          },
          ffmpeg: {
            available:
              isAbsolute(this.dependencies!.ffmpegPath) &&
              isAbsolute(this.dependencies!.ffprobePath),
          },
        };
      }
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
      case "media.audio.enhance": {
        const params = validateAudioEnhanceInput(input);
        await this.library.get(scope, params.assetId);
        this.authorize(scope);
        return this.jobs.start(scope, { type: "audio-enhance", input: params });
      }
      case "media.tts.providers":
        return {
          providers: await Promise.all(
            (["edge-tts", "kokoro"] as const).map((id) => this.managedTts.status(id)),
          ),
        };
      case "media.tts.setup": {
        if (Object.keys(input).some((key) => key !== "providerId"))
          throw new Error("不支持此配音安装参数");
        const providerId = managedProviderId(input.providerId);
        return this.jobs.start(scope, {
          type: "tts-setup",
          input: { providerId },
          idempotencyKey: `tts-setup:${providerId}`,
          idempotencyPolicy: "active",
        });
      }
      case "media.tts.voices":
        return this.speechCatalog(scope);
      case "media.tts": {
        for (const key of Object.keys(input))
          if (!["text", "modelId", "voiceId", "rate", "instructions"].includes(key))
            throw new Error("不支持此配音参数");
        if (
          input.modelId !== undefined &&
          (typeof input.modelId !== "string" || !input.modelId.trim() || input.modelId.length > 200)
        )
          throw new Error("请选择有效配音模型");
        // Resolve a default only for new requests. Persisted legacy `tts` jobs
        // always retain their local processor, including after a restart.
        const selectedModelId = input.modelId ?? (await this.speechCatalog(scope)).defaultModelId;
        if (selectedModelId === "edge-tts" || selectedModelId === "kokoro") {
          if (
            input.instructions !== undefined &&
            (typeof input.instructions !== "string" || input.instructions.trim())
          )
            throw new Error("此配音模型不支持朗读风格指令");
          const params = validateManagedTtsInput({
            providerId: selectedModelId,
            text: input.text,
            ...(input.voiceId !== undefined ? { voiceId: input.voiceId } : {}),
            ...(input.rate !== undefined ? { rate: input.rate } : {}),
          });
          const runtime = await this.managedTts.status(selectedModelId);
          if (!runtime.available) throw new Error(runtime.reason ?? "请先安装并验证此配音模型");
          if (params.voiceId && !runtime.voices.some((voice) => voice.id === params.voiceId))
            throw new Error("请选择此模型支持的声音");
          await this.assertSpeechAudioTools();
          this.authorize(scope);
          return this.jobs.start(scope, {
            type: "tts-managed",
            input: { ...params, voiceId: params.voiceId ?? runtime.defaultVoiceId },
          });
        }
        if (selectedModelId !== "macos-say") {
          const selected = this.validateOnlineSpeech(scope, { ...input, modelId: selectedModelId });
          await this.assertSpeechAudioTools();
          this.authorize(scope);
          return this.jobs.start(scope, {
            type: "tts-online",
            input: {
              text: selected.input.text,
              modelId: selected.modelId,
              voiceId: selected.input.voiceId,
              rate: selected.input.rate,
              instructions: selected.input.instructions ?? "",
            },
          });
        }
        if (
          input.instructions !== undefined &&
          (typeof input.instructions !== "string" || input.instructions.trim())
        )
          throw new Error("macOS 系统配音不支持朗读风格指令，请选择支持此功能的在线模型");
        const speech = validateLocalTtsInput(input);
        const available = await detectLocalTts(this.dependencies);
        if (!available.available) throw new Error(available.reason ?? "本机文字配音尚未就绪");
        if (speech.voiceId && !available.voices.some((voice) => voice.id === speech.voiceId))
          throw new Error("请选择本机已安装的配音音色");
        this.authorize(scope);
        return this.jobs.start(scope, {
          type: "tts",
          input: {
            ...speech,
            voiceId: speech.voiceId ?? available.defaultVoiceId,
            ...(input.modelId ? { modelId: "macos-say" } : {}),
          },
        });
      }
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
      case "media.prepare": {
        if (!Array.isArray(input.assetIds) || !input.assetIds.length || input.assetIds.length > 100)
          throw new Error("Provide 1–100 asset IDs");
        const jobs: MediaJob[] = [];
        for (const value of input.assetIds) {
          const id = assetId(value);
          await this.library.get(scope, id);
          jobs.push(
            await this.jobs.start(scope, {
              type: "prepare",
              input: { assetId: id, transcribe: input.transcribe === true },
              idempotencyKey: `prepare-v1:${id}:${input.transcribe === true}`,
              idempotencyPolicy: "active",
            }),
          );
        }
        return { jobs: jobs.map(({ result: _result, ...job }) => job) };
      }
      case "media.transcribe": {
        const id = assetId(input.assetId);
        await this.library.get(scope, id);
        return this.jobs.start(scope, {
          type: "transcribe",
          input: { assetId: id, language: input.language ?? "auto" },
          idempotencyKey: `transcribe-v1:${id}:${input.language ?? "auto"}`,
          idempotencyPolicy: "active",
        });
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
      case "media.scene":
        return this.jobs.start(scope, { type: "scene", input: { params: input.params } });
      case "media.render":
        return this.jobs.start(scope, {
          type: "render",
          input: { project: input.project, sources: input.sources ?? {}, subtitleMode: "burn" },
        });
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
        return this.jobs.retry(scope, input.id);
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
        throw new Error(`Unsupported media method: ${method}`);
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.ready?.catch(() => {});
    await Promise.all([this.jobs.shutdown(), this.recording?.shutdown()]);
  }

  async cancelApp(appId: string): Promise<void> {
    await this.initialize();
    await Promise.all([this.jobs.cancelApp(appId), this.recording?.cancelApp(appId)]);
  }

  async exportFile(scope: MediaScope, id: string, destination: string): Promise<void> {
    this.authorize(scope);
    const source = await this.library.resolvePath(scope, assetId(id));
    // The destination is chosen by the native Host save dialog, never by the guest.
    await copyFile(source, destination);
  }
}

function managedProviderId(value: unknown): "edge-tts" | "kokoro" {
  if (value !== "edge-tts" && value !== "kokoro") throw new Error("请选择受支持的配音引擎");
  return value;
}

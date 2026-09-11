import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import type { MediaJobContext, MediaJobProcessor, MediaScope } from "./media-types.js";
import { mediaAbortError, runMediaProcess } from "./media-process-runner.js";

export const MEDIA_PROCESSOR_CACHE_VERSION = 3;

export interface CaptionImageRequest {
  width: number;
  height: number;
  texts: string[];
  fontSize: number;
  style?: "classic" | "bold" | "minimal";
}

export interface MediaProcessorOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  whisperPath?: string;
  whisperModelPath?: string;
  cacheRoot?(scope: MediaScope): string | Promise<string>;
  resolveAssetPath(scope: MediaScope, assetId: string): Promise<string>;
  publishArtifact?(scope: MediaScope, path: string, mimeType: string): Promise<unknown>;
  renderCaptionPng?(request: CaptionImageRequest, context: MediaJobContext): Promise<string>;
}

export interface MediaInspection {
  kind: "video" | "audio" | "image";
  durationSeconds: number | null;
  bytes: number;
  format: string;
  video?: {
    codec: string;
    width: number;
    height: number;
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    pixelFormat: string;
    frameRate: number | null;
    variableFrameRate: boolean | null;
    sampledSeconds: number;
  };
  audio?: { codec: string; channels: number; sampleRate: number };
}

interface ProjectAsset {
  id: string;
  kind: string;
}
interface ProjectClip {
  id: string;
  assetId: string;
  inFrame: number;
  outFrame: number;
  volume: number;
}
interface Caption {
  id: string;
  startFrame: number;
  endFrame: number;
  text: string;
}
interface AudioClip extends ProjectClip {
  startFrame: number;
}
export interface MediaRenderProject {
  schemaVersion: 1;
  revision: number;
  fps: 30;
  width: number;
  height: number;
  assets: ProjectAsset[];
  clips: ProjectClip[];
  captions: Caption[];
  captionStyle?: "classic" | "bold" | "minimal";
  audioClips?: AudioClip[];
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  const result = bounded(value, min, max, label);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid integer ${label}`);
  return result;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value))
    throw new Error("Invalid asset ID");
  return value;
}
function ratio(value: unknown): number | null {
  const parts = String(value ?? "")
    .split("/")
    .map(Number);
  const result = parts.length === 2 ? parts[0]! / parts[1]! : parts[0];
  return result && Number.isFinite(result) && result > 0 ? result : null;
}
function finiteDuration(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function check(context: MediaJobContext): void {
  if (context.signal.aborted) throw mediaAbortError();
}
async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
  await rename(temporary, path);
}
async function regularFile(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error("Media source must be a regular file");
  return canonical;
}

// Imported assets are opaque files, never playlists. Apply these demuxer options to
// every untrusted input, including ffprobe, before format detection can follow references.
const sourceOptions = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif,j2k_pipe",
];

async function executablePath(command: string): Promise<string> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\"))
    return regularFile(resolve(command));
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const path = join(directory, command);
      await access(path);
      return await regularFile(path);
    } catch {
      /* Continue searching PATH. */
    }
  }
  throw new Error(`Required local executable is unavailable: ${command}`);
}

export async function inspectMediaFile(
  path: string,
  context: MediaJobContext,
  options: Pick<MediaProcessorOptions, "ffprobePath"> = {},
): Promise<MediaInspection> {
  path = await regularFile(path);
  const probe = options.ffprobePath ?? "ffprobe";
  const result = await runMediaProcess(
    probe,
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", ...sourceOptions, path],
    { signal: context.signal },
  );
  const raw = JSON.parse(result.stdout.toString("utf8"));
  const video = raw.streams?.find(
    (stream: any) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audio = raw.streams?.find((stream: any) => stream.codec_type === "audio");
  if (!video && !audio) throw new Error("No supported video, image or audio stream found");
  let durationSeconds =
    finiteDuration(raw.format?.duration) ??
    finiteDuration(video?.duration) ??
    finiteDuration(audio?.duration);
  const image =
    video &&
    !audio &&
    !durationSeconds &&
    /^(png|mjpeg|webp|bmp|tiff|gif|jpeg2000)$/.test(video.codec_name);
  if (!durationSeconds && !image) {
    // MediaRecorder WebM often omits container Duration. Measure the actual
    // packet timeline, streaming the probe output instead of retaining it.
    let pending = "",
      lastEnd = 0;
    const streams = new Map<number, { time: number; delta: number }>();
    const consume = (chunk: Buffer) => {
      const lines = (pending + chunk.toString("utf8")).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const fields = Object.fromEntries(line.split("|").map((part) => part.split("=")));
        const time = Number(fields.pts_time ?? fields.dts_time),
          stream = Number(fields.stream_index);
        if (!Number.isFinite(time) || !Number.isFinite(stream)) continue;
        const previous = streams.get(stream);
        const delta =
          previous && time > previous.time ? time - previous.time : (previous?.delta ?? 0);
        streams.set(stream, { time, delta });
        const duration = finiteDuration(fields.duration_time) ?? delta;
        lastEnd = Math.max(lastEnd, time + duration);
      }
    };
    await context.reportProgress({ stage: "inspect", message: "Measuring media packet duration" });
    await runMediaProcess(
      probe,
      [
        "-v",
        "error",
        "-show_entries",
        "packet=stream_index,pts_time,dts_time,duration_time",
        "-of",
        "compact=p=0:nk=0",
        ...sourceOptions,
        path,
      ],
      { signal: context.signal, onStdout: consume },
    );
    consume(Buffer.from("\n"));
    const origin = Math.max(0, Number(raw.format?.start_time) || 0);
    durationSeconds = finiteDuration(lastEnd - origin);
    if (!durationSeconds) throw new Error("Media duration could not be measured from its packets");
  }
  const inspection: MediaInspection = {
    kind: image ? "image" : video ? "video" : "audio",
    durationSeconds,
    bytes: (await stat(path)).size,
    format: String(raw.format?.format_name ?? "unknown"),
  };
  if (video) {
    const rotation = Number(
      video.side_data_list?.find((item: any) => Number.isFinite(item.rotation))?.rotation ??
        video.tags?.rotate ??
        0,
    );
    const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    inspection.video = {
      codec: String(video.codec_name),
      width: Number(video.width),
      height: Number(video.height),
      displayWidth: Number(rotated ? video.height : video.width),
      displayHeight: Number(rotated ? video.width : video.height),
      rotation,
      pixelFormat: String(video.pix_fmt ?? "unknown"),
      frameRate: ratio(video.avg_frame_rate) ?? ratio(video.r_frame_rate),
      variableFrameRate: image ? false : null,
      sampledSeconds: 0,
    };
    if (!image) {
      const frames = await runMediaProcess(
        probe,
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-read_intervals",
          "%+10",
          "-show_entries",
          "frame=best_effort_timestamp_time",
          "-of",
          "json",
          ...sourceOptions,
          path,
        ],
        { signal: context.signal },
      );
      const times = (JSON.parse(frames.stdout.toString("utf8")).frames ?? [])
        .map((frame: any) => Number(frame.best_effort_timestamp_time))
        .filter(Number.isFinite);
      const deltas = times
        .slice(1)
        .map((time: number, index: number) => time - times[index])
        .filter((delta: number) => delta > 0);
      inspection.video.variableFrameRate =
        deltas.length > 1 ? Math.max(...deltas) - Math.min(...deltas) > 0.002 : null;
      inspection.video.sampledSeconds = times.length > 1 ? times.at(-1) - times[0] : 0;
    }
  }
  if (audio)
    inspection.audio = {
      codec: String(audio.codec_name),
      channels: Number(audio.channels),
      sampleRate: Number(audio.sample_rate),
    };
  return inspection;
}

export function captionsToSrt(captions: readonly Caption[], fps = 30): string {
  const timestamp = (frame: number) => {
    const ms = Math.round((frame / fps) * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return [...captions]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map(
      (caption, index) =>
        `${index + 1}\n${timestamp(caption.startFrame)} --> ${timestamp(caption.endFrame)}\n${caption.text.replace(/\r\n?/g, "\n")}\n`,
    )
    .join("\n");
}

function renderProject(value: unknown): MediaRenderProject {
  const project = object(value, "project");
  if (project.schemaVersion !== 1 || project.fps !== 30)
    throw new Error("Only version 1, 30 fps projects are supported");
  if (
    project.captionStyle !== undefined &&
    !["classic", "bold", "minimal"].includes(project.captionStyle)
  )
    throw new Error("Caption style must be classic, bold or minimal");
  integer(project.width, 16, 8192, "width");
  integer(project.height, 16, 8192, "height");
  if (project.width % 2 || project.height % 2)
    throw new Error("MP4 canvas dimensions must be even");
  integer(project.revision, 0, Number.MAX_SAFE_INTEGER, "revision");
  if (
    !Array.isArray(project.assets) ||
    !Array.isArray(project.clips) ||
    !project.clips.length ||
    project.clips.length > 2000
  )
    throw new Error("Invalid render assets or clips");
  const assets = new Set(project.assets.map((asset: any) => id(asset.id)));
  if (assets.size !== project.assets.length) throw new Error("Duplicate render asset IDs");
  let frames = 0;
  const validateClip = (clip: any) => {
    if (!assets.has(id(clip.assetId))) throw new Error("A render clip references missing media");
    integer(clip.inFrame, 0, 30 * 86400, "clip inFrame");
    integer(clip.outFrame, clip.inFrame + 1, 30 * 86400, "clip outFrame");
    bounded(clip.volume, 0, 2, "clip volume");
    if (clip.crop || clip.zoom || clip.speed)
      throw new Error("This processor does not yet render crop, zoom or speed operations");
  };
  for (const clip of project.clips) {
    validateClip(clip);
    frames += clip.outFrame - clip.inFrame;
  }
  integer(frames, 1, 30 * 86400, "timeline duration");
  if (!Array.isArray(project.captions) || project.captions.length > 10000)
    throw new Error("Invalid captions");
  for (const caption of project.captions) {
    integer(caption.startFrame, 0, frames - 1, "caption start");
    integer(caption.endFrame, caption.startFrame + 1, frames, "caption end");
    if (typeof caption.text !== "string" || !caption.text.trim() || caption.text.length > 4000)
      throw new Error("Invalid caption text");
  }
  if (project.audioClips !== undefined) {
    if (!Array.isArray(project.audioClips) || project.audioClips.length > 64)
      throw new Error("At most 64 independent audio clips are supported");
    for (const clip of project.audioClips) {
      validateClip(clip);
      integer(clip.startFrame, 0, frames - 1, "audio startFrame");
    }
  }
  return project as MediaRenderProject;
}

export function createMediaJobProcessors(
  options: MediaProcessorOptions,
): Record<string, MediaJobProcessor> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  let toolVersions: Promise<string[]> | undefined;
  const source = async (input: Record<string, any>, context: MediaJobContext) =>
    regularFile(await options.resolveAssetPath(context.scope, id(input.assetId)));
  const publish = async (path: string, mimeType: string, context: MediaJobContext) =>
    options.publishArtifact
      ? { asset: await options.publishArtifact(context.scope, path, mimeType), mimeType }
      : { path, mimeType };
  const encode = (
    args: string[],
    context: MediaJobContext,
    duration?: number,
    progress?: (fraction: number) => number,
  ) =>
    runMediaProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args],
      {
        signal: context.signal,
        cwd: context.workDir,
        durationSeconds: duration,
        onProgress: (update) =>
          context.reportProgress({
            fraction:
              progress && update.fraction !== undefined
                ? progress(update.fraction)
                : update.fraction,
          }),
      },
    );
  const cachedArtifactsExist = async (
    value: unknown,
    context: MediaJobContext,
  ): Promise<boolean> => {
    if (!value || typeof value !== "object") return true;
    const record = value as Record<string, any>;
    if (typeof record.path === "string" && typeof record.mimeType === "string") {
      return regularFile(record.path).then(
        () => true,
        () => false,
      );
    }
    if (record.asset && typeof record.mimeType === "string") {
      const assetId = record.asset.id;
      if (typeof assetId !== "string") return false;
      return options
        .resolveAssetPath(context.scope, assetId)
        .then(regularFile)
        .then(
          () => true,
          () => false,
        );
    }
    for (const child of Object.values(record))
      if (!(await cachedArtifactsExist(child, context))) return false;
    return true;
  };
  const withJob = (
    kind: string,
    work: (input: Record<string, any>, context: MediaJobContext) => Promise<unknown>,
  ): MediaJobProcessor => ({
    recovery: "restart",
    async run(input, context) {
      check(context);
      await Promise.all(
        [context.workDir, context.outputDir, context.cacheDir].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      await context.reportProgress({ fraction: 0, stage: kind });
      toolVersions ??= Promise.all(
        [ffmpeg, options.ffprobePath ?? "ffprobe"].map(async (tool) => {
          const result = await runMediaProcess(tool, ["-version"], {
            signal: AbortSignal.timeout(5000),
          });
          return result.stdout.toString("utf8").split("\n")[0] ?? tool;
        }),
      ).catch((error) => {
        toolVersions = undefined;
        throw error;
      });
      let modelIdentity: unknown;
      if (kind === "transcribe") {
        const modelPath =
          options.whisperModelPath ?? join(homedir(), ".cache", "whisper", "base.pt");
        const info = await stat(modelPath);
        const whisperExecutable = await executablePath(options.whisperPath ?? "whisper");
        const executableInfo = await stat(whisperExecutable);
        const shebang = (await readFile(whisperExecutable, "utf8")).split("\n")[0] ?? "";
        const python = /^#!(\/[^\r\n ]*python[\d.]*)\s*$/.exec(shebang)?.[1];
        const version = python
          ? (
              await runMediaProcess(
                python,
                [
                  "-c",
                  "import importlib.metadata; print(importlib.metadata.version('openai-whisper'))",
                ],
                { signal: context.signal },
              )
            ).stdout
              .toString("utf8")
              .trim()
          : "wrapper";
        modelIdentity = {
          path: modelPath,
          bytes: info.size,
          modifiedAt: info.mtimeMs,
          executable: whisperExecutable,
          executableModifiedAt: executableInfo.mtimeMs,
          version,
        };
      }
      const payload = object(input, `${kind} input`);
      if (kind === "render") {
        const project = renderProject(payload.project),
          mappings = payload.sources ?? {};
        for (const assetId of new Set(
          [...project.clips, ...(project.audioClips ?? [])].map((clip) => clip.assetId),
        ))
          await regularFile(
            await options.resolveAssetPath(context.scope, id(mappings[assetId] ?? assetId)),
          );
      } else await source(payload, context);
      const cacheDirectory = options.cacheRoot
        ? await options.cacheRoot(context.scope)
        : context.cacheDir;
      await mkdir(cacheDirectory, { recursive: true });
      const key = hash({
        processorVersion: MEDIA_PROCESSOR_CACHE_VERSION,
        scope: context.scope,
        kind,
        input,
        tools: await toolVersions,
        modelIdentity,
        captions: Boolean(options.renderCaptionPng),
      });
      const cachePath = join(cacheDirectory, `${kind}-${key}.json`);
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8"));
        if (cached.version === 1 && (await cachedArtifactsExist(cached.result, context))) {
          check(context);
          await context.reportProgress({ fraction: 1, stage: "cached" });
          return cached.result;
        }
      } catch {
        /* Invalid or evicted derived media is regenerated. */
      }
      check(context);
      const result = await work(payload, context);
      check(context);
      await writeJson(cachePath, {
        version: 1,
        kind,
        input,
        result,
        completedAt: new Date().toISOString(),
      });
      await context.reportProgress({ fraction: 1, stage: "complete" });
      return result;
    },
  });

  const handlers: Record<string, MediaJobProcessor> = {};
  handlers.inspect = withJob("inspect", async (input, context) => ({
    assetId: id(input.assetId),
    inspection: await inspectMediaFile(await source(input, context), context, options),
  }));
  handlers.proxy = withJob("proxy", async (input, context) => {
    const path = await source(input, context),
      info = await inspectMediaFile(path, context, options);
    const width = integer(input.maxWidth ?? 1280, 160, 3840, "proxy width");
    const output = join(
      context.outputDir,
      `proxy-${randomUUID()}.${info.kind === "audio" ? "m4a" : "mp4"}`,
    );
    if (info.kind === "image") throw new Error("Still images do not require a playback proxy");
    await encode(
      [
        ...sourceOptions,
        "-i",
        path,
        ...(info.video
          ? [
              "-map",
              "0:v:0",
              "-vf",
              `scale=w='trunc(min(${width},iw)/2)*2':h=-2,fps=30:eof_action=pass,tpad=stop_mode=clone:stop=-1,setsar=1`,
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "24",
              "-pix_fmt",
              "yuv420p",
            ]
          : ["-vn"]),
        "-map",
        "0:a:0?",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        ...(info.durationSeconds ? ["-t", String(info.durationSeconds)] : []),
        output,
      ],
      context,
      info.durationSeconds ?? undefined,
    );
    return {
      assetId: id(input.assetId),
      inspection: info,
      proxy: await publish(output, info.kind === "audio" ? "audio/mp4" : "video/mp4", context),
    };
  });
  handlers.thumbnail = withJob("thumbnail", async (input, context) => {
    const path = await source(input, context),
      info = await inspectMediaFile(path, context, options);
    const output = join(context.outputDir, `thumbnail-${randomUUID()}.png`);
    const seconds = bounded(
      input.seconds ?? 0,
      0,
      Math.max(0, (info.durationSeconds ?? 86400) - 0.001),
      "thumbnail position",
    );
    const width = integer(input.width ?? 480, 64, 1920, "thumbnail width");
    if (info.kind === "audio")
      await encode(
        [
          ...sourceOptions,
          "-i",
          path,
          "-filter_complex",
          `showwavespic=s=${width}x160:colors=0x8fd6ad`,
          "-frames:v",
          "1",
          output,
        ],
        context,
        info.durationSeconds ?? undefined,
      );
    else
      await encode(
        [
          "-ss",
          String(seconds),
          ...sourceOptions,
          "-i",
          path,
          "-vf",
          `scale=${width}:-2`,
          "-frames:v",
          "1",
          output,
        ],
        context,
      );
    return {
      assetId: id(input.assetId),
      seconds,
      thumbnail: await publish(output, "image/png", context),
    };
  });
  handlers.waveform = withJob("waveform", async (input, context) => {
    const path = await source(input, context),
      info = await inspectMediaFile(path, context, options);
    if (!info.audio || !info.durationSeconds)
      throw new Error("Waveforms require a finite audio stream");
    const points = integer(input.points ?? 1024, 32, 4096, "waveform points");
    const perBucket = Math.max(1, Math.ceil((info.durationSeconds * 8000) / points));
    const peaks: number[] = [],
      rms: number[] = [];
    let pending = Buffer.alloc(0),
      samples = 0,
      peak = 0,
      sum = 0;
    const flush = () => {
      if (samples) {
        peaks.push(Number(peak.toFixed(5)));
        rms.push(Number(Math.sqrt(sum / samples).toFixed(5)));
      }
      samples = 0;
      peak = 0;
      sum = 0;
    };
    await runMediaProcess(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-progress",
        "pipe:2",
        ...sourceOptions,
        "-i",
        path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      {
        signal: context.signal,
        durationSeconds: info.durationSeconds,
        progressStream: "stderr",
        onProgress: (update) => context.reportProgress(update),
        onStdout(chunk) {
          const data = Buffer.concat([pending, chunk]),
            end = data.length - (data.length % 4);
          for (let offset = 0; offset < end; offset += 4) {
            const value = data.readFloatLE(offset);
            peak = Math.max(peak, Math.abs(value));
            sum += value * value;
            samples++;
            if (samples >= perBucket) flush();
          }
          pending = data.subarray(end);
        },
      },
    );
    flush();
    return {
      assetId: id(input.assetId),
      durationSeconds: info.durationSeconds,
      sampleRate: 8000,
      samplesPerPoint: perBucket,
      peaks,
      rms,
    };
  });
  handlers.silence = withJob("silence", async (input, context) => {
    const path = await source(input, context),
      info = await inspectMediaFile(path, context, options);
    if (!info.audio || !info.durationSeconds)
      throw new Error("Silence detection requires a finite audio stream");
    const thresholdDb = bounded(input.thresholdDb ?? -35, -90, -5, "silence threshold"),
      minSeconds = bounded(input.minSeconds ?? 0.45, 0.05, 30, "silence minimum duration");
    let pending = "",
      start: number | null = null;
    const intervals: Array<{ start: number; end: number }> = [];
    const consume = (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const begin = /silence_start:\s*([\d.]+)/.exec(line),
          end = /silence_end:\s*([\d.]+)/.exec(line);
        if (begin) start = Number(begin[1]);
        if (end && start !== null) {
          intervals.push({ start, end: Math.min(info.durationSeconds!, Number(end[1])) });
          start = null;
        }
      }
    };
    await runMediaProcess(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-progress",
        "pipe:1",
        ...sourceOptions,
        "-i",
        path,
        "-vn",
        "-af",
        `silencedetect=noise=${thresholdDb}dB:d=${minSeconds}`,
        "-f",
        "null",
        "-",
      ],
      {
        signal: context.signal,
        durationSeconds: info.durationSeconds ?? undefined,
        onProgress: (update) => context.reportProgress(update),
        onStderr: consume,
      },
    );
    consume("\n");
    if (start !== null) intervals.push({ start, end: info.durationSeconds });
    const complete = {
      assetId: id(input.assetId),
      detector: "ffmpeg-silencedetect",
      thresholdDb,
      minSeconds,
      intervals,
    };
    const analysisPath = join(context.outputDir, `silence-${randomUUID()}.json`);
    await writeJson(analysisPath, complete);
    return {
      ...complete,
      intervals: intervals.slice(0, 1024),
      totalCount: intervals.length,
      truncated: intervals.length > 1024,
      analysis: { path: analysisPath, mimeType: "application/json" },
    };
  });
  handlers.scenes = withJob("scenes", async (input, context) => {
    const path = await source(input, context),
      info = await inspectMediaFile(path, context, options);
    if (info.kind !== "video") throw new Error("Scene detection requires video");
    const threshold = bounded(input.threshold ?? 0.3, 0.01, 0.99, "scene threshold");
    const cuts: number[] = [];
    let pending = "";
    const consume = (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /pts_time:([\d.]+)/.exec(line);
        if (match) cuts.push(Number(match[1]));
      }
    };
    await runMediaProcess(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-progress",
        "pipe:1",
        ...sourceOptions,
        "-i",
        path,
        "-an",
        "-vf",
        `select='gt(scene,${threshold})',showinfo`,
        "-fps_mode",
        "vfr",
        "-f",
        "null",
        "-",
      ],
      {
        signal: context.signal,
        durationSeconds: info.durationSeconds ?? undefined,
        onProgress: (update) => context.reportProgress(update),
        onStderr: consume,
      },
    );
    consume("\n");
    const complete = {
      assetId: id(input.assetId),
      detector: "ffmpeg-scene-change",
      threshold,
      cuts,
      durationSeconds: info.durationSeconds,
    };
    const analysisPath = join(context.outputDir, `scenes-${randomUUID()}.json`);
    await writeJson(analysisPath, complete);
    return {
      ...complete,
      cuts: cuts.slice(0, 1024),
      totalCount: cuts.length,
      truncated: cuts.length > 1024,
      analysis: { path: analysisPath, mimeType: "application/json" },
    };
  });

  handlers.transcribe = withJob("transcribe", async (input, context) => {
    const path = await source(input, context),
      info = await inspectMediaFile(path, context, options);
    if (!info.audio || !info.durationSeconds)
      throw new Error("Transcription requires a finite audio stream");
    const language =
      input.language === undefined || input.language === "auto"
        ? undefined
        : String(input.language);
    if (language && !/^[a-z]{2,3}$/.test(language))
      throw new Error("Invalid transcription language");
    const modelPath = await regularFile(
      options.whisperModelPath ?? join(homedir(), ".cache", "whisper", "base.pt"),
    ).catch(() => {
      throw new Error(
        "A local Whisper model must be installed and configured before transcription",
      );
    });
    const audioPath = join(context.workDir, "transcribe-source.wav");
    await encode(
      [
        ...sourceOptions,
        "-i",
        path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        audioPath,
      ],
      context,
      info.durationSeconds,
      (fraction) => fraction * 0.1,
    );
    await context.reportProgress({
      fraction: 0.1,
      stage: "transcribing",
      message: `Local Whisper ${basename(modelPath)}`,
    });
    await runMediaProcess(
      options.whisperPath ?? "whisper",
      [
        audioPath,
        "--model",
        modelPath,
        "--device",
        "cpu",
        "--fp16",
        "False",
        "--word_timestamps",
        "True",
        "--output_format",
        "json",
        "--output_dir",
        context.outputDir,
        "--threads",
        "4",
        "--verbose",
        "False",
        ...(language ? ["--language", language] : []),
      ],
      { signal: context.signal, cwd: context.workDir },
    );
    const raw = JSON.parse(
      await readFile(join(context.outputDir, "transcribe-source.json"), "utf8"),
    );
    if (!Array.isArray(raw.segments))
      throw new Error("Whisper did not produce a timestamped transcript");
    const segments = raw.segments.map((segment: any) => ({
      start: bounded(segment.start, 0, info.durationSeconds! + 1, "transcript start"),
      end: bounded(segment.end, segment.start, info.durationSeconds! + 1, "transcript end"),
      text: String(segment.text ?? ""),
      words: Array.isArray(segment.words)
        ? segment.words.map((word: any) => ({
            start: Number(word.start),
            end: Number(word.end),
            text: String(word.word),
            probability: Number(word.probability),
          }))
        : [],
    }));
    const output = join(context.outputDir, "transcript.srt");
    await writeFile(
      output,
      captionsToSrt(
        segments
          .filter((segment: any) => segment.end > segment.start && segment.text.trim())
          .map((segment: any, index: number) => ({
            id: String(index),
            startFrame: Math.round(segment.start * 30),
            endFrame: Math.round(segment.end * 30),
            text: segment.text,
          })),
      ),
    );
    const transcriptPath = join(context.outputDir, "transcript.json");
    const languageDetected = String(raw.language ?? language ?? "unknown");
    await writeJson(transcriptPath, {
      version: 1,
      assetId: id(input.assetId),
      engine: "local-whisper",
      model: basename(modelPath),
      language: languageDetected,
      durationSeconds: info.durationSeconds,
      text: String(raw.text ?? ""),
      segments,
    });
    return {
      assetId: id(input.assetId),
      engine: "local-whisper",
      model: basename(modelPath),
      language: languageDetected,
      durationSeconds: info.durationSeconds,
      segmentCount: segments.length,
      wordCount: segments.reduce((total: number, segment: any) => total + segment.words.length, 0),
      transcript: { path: transcriptPath, mimeType: "application/json" },
      subtitles: (await stat(output)).size
        ? await publish(output, "application/x-subrip", context)
        : null,
    };
  });

  handlers.render = withJob("render", async (input, context) => {
    const project = renderProject(input.project);
    const mappings = input.sources === undefined ? {} : object(input.sources, "source mappings");
    const sources = new Map<string, { path: string; inspection: MediaInspection }>();
    const usedIds = new Set(
      [...project.clips, ...(project.audioClips ?? [])].map((clip) => clip.assetId),
    );
    for (const assetId of usedIds) {
      const path = await regularFile(
        await options.resolveAssetPath(context.scope, id(mappings[assetId] ?? assetId)),
      );
      sources.set(assetId, { path, inspection: await inspectMediaFile(path, context, options) });
    }
    const frames = project.clips.reduce((total, clip) => total + clip.outFrame - clip.inFrame, 0),
      duration = frames / 30;
    const subtitleMode = input.subtitleMode ?? "burn";
    if (!["burn", "soft", "none"].includes(subtitleMode)) throw new Error("Invalid subtitle mode");
    if (project.captions.length && subtitleMode === "burn" && !options.renderCaptionPng)
      throw new Error("Burned captions require the Host caption PNG renderer");
    const paths: string[] = [];
    let finishedFrames = 0;
    for (const [index, clip] of project.clips.entries()) {
      check(context);
      const media = sources.get(clip.assetId)!,
        seconds = (clip.outFrame - clip.inFrame) / 30;
      if (
        media.inspection.kind !== "image" &&
        (!media.inspection.durationSeconds ||
          clip.outFrame / 30 > media.inspection.durationSeconds + 1 / 30)
      )
        throw new Error("Clip range exceeds its source media duration");
      const output = join(context.workDir, `segment-${index}.mkv`);
      const args: string[] = [];
      if (media.inspection.kind === "image")
        args.push("-loop", "1", "-framerate", "30", ...sourceOptions, "-i", media.path);
      else args.push("-ss", String(clip.inFrame / 30), ...sourceOptions, "-i", media.path);
      if (!media.inspection.video)
        args.push(
          "-f",
          "lavfi",
          "-i",
          `color=c=0x0a0e10:s=${project.width}x${project.height}:r=30`,
        );
      if (!media.inspection.audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      const videoInput = media.inspection.video ? 0 : 1,
        audioInput = media.inspection.audio ? 0 : 1;
      const filter = `[${videoInput}:v]scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=0x0a0e10,setsar=1,fps=30:eof_action=pass,tpad=stop_mode=clone:stop=-1,setpts=PTS-STARTPTS[v];[${audioInput}:a]aresample=48000,volume=${clip.volume},apad,atrim=duration=${seconds},asetpts=PTS-STARTPTS[a]`;
      args.push(
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        output,
      );
      const base = finishedFrames;
      await encode(
        args,
        context,
        seconds,
        (fraction) => ((base + fraction * (clip.outFrame - clip.inFrame)) / frames) * 0.7,
      );
      finishedFrames += clip.outFrame - clip.inFrame;
      paths.push(output);
    }
    const listPath = join(context.workDir, "segments.txt");
    await writeFile(
      listPath,
      paths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const joined = join(context.workDir, "joined.mkv");
    await encode(
      ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", joined],
      context,
      duration,
      (fraction) => 0.7 + fraction * 0.05,
    );
    const prefix = `render-r${project.revision}-${randomUUID()}`;
    const output = join(context.outputDir, `${prefix}.mp4`),
      srt = join(context.outputDir, `${prefix}.srt`);
    await writeFile(srt, captionsToSrt(project.captions));
    const args = ["-i", joined],
      filters: string[] = [];
    let videoLabel = "0:v",
      audioLabel = "0:a",
      inputIndex = 1;
    if (project.captions.length && subtitleMode === "burn") {
      const boundaries = [
        ...new Set([
          0,
          frames,
          ...project.captions.flatMap((caption) => [caption.startFrame, caption.endFrame]),
        ]),
      ].sort((a, b) => a - b);
      const imageCache = new Map<string, string>();
      const captionSequence = ["ffconcat version 1.0"];
      let lastImage = "";
      for (let index = 0; index < boundaries.length - 1; index++) {
        const start = boundaries[index]!,
          end = boundaries[index + 1]!;
        const texts = project.captions
          .filter((caption) => caption.startFrame <= start && caption.endFrame > start)
          .map((caption) => caption.text);
        check(context);
        const imageKey = hash(texts);
        let overlay = imageCache.get(imageKey);
        if (!overlay) {
          overlay = await regularFile(
            await options.renderCaptionPng!(
              {
                width: project.width,
                height: project.height,
                texts,
                fontSize: Math.round(Math.min(project.width * 0.035, project.height * 0.05)),
                style: project.captionStyle ?? "classic",
              },
              context,
            ),
          );
          imageCache.set(imageKey, overlay);
        }
        captionSequence.push(
          `file '${overlay.replace(/'/g, "'\\''")}'`,
          "option framerate 30",
          `duration ${((end - start) / 30).toFixed(10)}`,
        );
        lastImage = overlay;
      }
      captionSequence.push(`file '${lastImage.replace(/'/g, "'\\''")}'`, "option framerate 30");
      const captionList = join(context.workDir, "captions.ffconcat");
      await writeFile(captionList, captionSequence.join("\n"));
      args.push("-f", "concat", "-safe", "0", "-i", captionList);
      filters.push(
        `[${inputIndex}:v]fps=30,format=rgba[captiontrack]`,
        "[0:v][captiontrack]overlay=0:0:shortest=1[captioned]",
      );
      videoLabel = "captioned";
      inputIndex++;
    }
    if (project.audioClips?.length) {
      const labels = ["[0:a]"];
      for (const [index, clip] of project.audioClips.entries()) {
        const media = sources.get(clip.assetId)!;
        if (
          !media.inspection.audio ||
          !media.inspection.durationSeconds ||
          clip.outFrame / 30 > media.inspection.durationSeconds + 1 / 30
        )
          throw new Error("Invalid independent audio source range");
        args.push(
          "-ss",
          String(clip.inFrame / 30),
          "-t",
          String((clip.outFrame - clip.inFrame) / 30),
          ...sourceOptions,
          "-i",
          media.path,
        );
        const delay = Math.round((clip.startFrame / 30) * 1000),
          label = `music${index}`;
        filters.push(
          `[${inputIndex}:a]aresample=48000,volume=${clip.volume},adelay=${delay}:all=1,apad,atrim=duration=${duration}[${label}]`,
        );
        labels.push(`[${label}]`);
        inputIndex++;
      }
      filters.push(
        `${labels.join("")}amix=inputs=${labels.length}:duration=first:normalize=0[audio]`,
      );
      audioLabel = "audio";
    }
    let subtitleInput: number | undefined;
    if (project.captions.length && subtitleMode === "soft") {
      subtitleInput = inputIndex;
      args.push("-i", srt);
    }
    if (filters.length) {
      const filterPath = join(context.workDir, "composition.filter");
      await writeFile(filterPath, filters.join(";"));
      args.push("-filter_complex_script", filterPath);
    }
    args.push(
      "-map",
      videoLabel === "0:v" ? videoLabel : `[${videoLabel}]`,
      "-map",
      audioLabel === "0:a" ? audioLabel : `[${audioLabel}]`,
    );
    if (subtitleInput !== undefined) args.push("-map", `${subtitleInput}:s:0`, "-c:s", "mov_text");
    args.push(
      "-c:v",
      videoLabel === "0:v" ? "copy" : "libx264",
      ...(videoLabel === "0:v" ? [] : ["-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      String(duration),
      "-movflags",
      "+faststart",
      output,
    );
    await encode(args, context, duration, (fraction) => 0.75 + fraction * 0.24);
    const inspection = await inspectMediaFile(output, context, options);
    if (
      !inspection.video ||
      !inspection.audio ||
      !inspection.durationSeconds ||
      Math.abs(inspection.durationSeconds - duration) > Math.max(0.15, duration * 0.002)
    )
      throw new Error("Rendered MP4 failed duration or audio/video validation");
    return {
      revision: project.revision,
      frames,
      durationSeconds: inspection.durationSeconds,
      subtitleMode,
      inspection,
      video: await publish(output, "video/mp4", context),
      subtitles: project.captions.length
        ? await publish(srt, "application/x-subrip", context)
        : null,
    };
  });
  return handlers;
}

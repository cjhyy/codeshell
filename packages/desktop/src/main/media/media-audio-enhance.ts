import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectMediaFile, type MediaInspection } from "./media-processors.js";
import { runMediaProcess } from "./media-process-runner.js";
import type { MediaAsset, MediaJobContext, MediaJobProcessor, MediaScope } from "./media-types.js";

export interface AudioEnhanceInput {
  assetId: string;
  preset: "light" | "balanced";
  denoise: boolean;
  normalize: boolean;
}
export interface AudioEnhanceOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  maxOutputBytes?: number;
  resolveAssetPath(scope: MediaScope, assetId: string): Promise<string>;
  /** Host must recheck authorization before publishing an immutable derivative. */
  publishArtifact(
    scope: MediaScope,
    path: string,
    mimeType: "audio/wav",
    context: MediaJobContext,
  ): Promise<MediaAsset>;
}
export interface AudioEnhanceResult {
  asset: MediaAsset;
  inspection: MediaInspection;
  provenance: Omit<AudioEnhanceInput, "assetId"> & {
    sourceAssetId: string;
    processor: "ffmpeg-audio-enhance";
    version: 1;
  };
}

export function validateAudioEnhanceInput(raw: unknown): AudioEnhanceInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Audio enhancement parameters must be an object");
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["assetId", "preset", "denoise", "normalize"].includes(key))
  )
    throw new Error("Unsupported audio enhancement parameter");
  if (typeof input.assetId !== "string" || !/^asset-[a-f0-9]{64}$/.test(input.assetId))
    throw new Error("Select an authorized source asset");
  if (input.preset !== undefined && input.preset !== "light" && input.preset !== "balanced")
    throw new Error("Audio enhancement preset must be light or balanced");
  for (const key of ["denoise", "normalize"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error(`Invalid ${key} option`);
  return {
    assetId: input.assetId,
    preset: input.preset ?? "balanced",
    denoise: input.denoise !== false,
    normalize: input.normalize !== false,
  };
}

// Imported assets are opaque audio/video, never playlists or URLs with dependencies.
const sourceOptions = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac",
];

/** Fixed, measured FFmpeg processing. Every attempt creates a separate WAV; originals are immutable. */
export function createAudioEnhanceProcessor(options: AudioEnhanceOptions): MediaJobProcessor {
  const maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 ** 3;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 4096 ||
    maxOutputBytes > 20 * 1024 ** 3
  )
    throw new Error("Invalid enhanced audio file budget");
  return {
    recovery: "restart",
    async run(raw, context): Promise<AudioEnhanceResult> {
      const input = validateAudioEnhanceInput(raw);
      context.signal.throwIfAborted();
      const source = await options.resolveAssetPath(context.scope, input.assetId);
      const original = await inspectMediaFile(source, context, options);
      const duration = original.durationSeconds;
      if (
        !original.audio ||
        !duration ||
        duration > 24 * 60 * 60 ||
        original.audio.channels < 1 ||
        original.audio.channels > 8
      )
        throw new Error("Audio enhancement requires an audio stream up to 24 hours and 8 channels");
      if (Math.ceil(duration * 48000) * original.audio.channels * 2 + 4096 > maxOutputBytes)
        throw new Error("Enhanced WAV would exceed the media file budget");
      await mkdir(context.outputDir, { recursive: true });
      const temporary = join(context.outputDir, `enhanced-${randomUUID()}.partial.wav`);
      const output = join(context.outputDir, `enhanced-${randomUUID()}.wav`);
      const baseFilters = [
        // Keep the full source timeline, including a video whose audio begins late
        // or ends early. first_pts pads leading audio gaps and apad fills its tail.
        "aresample=48000:async=1:first_pts=0",
        `highpass=f=${input.preset === "light" ? 60 : 80}:p=2`,
        ...(input.denoise ? [`afftdn=nr=${input.preset === "light" ? 6 : 12}:nf=-45:tn=1`] : []),
        "apad",
        `atrim=duration=${duration}`,
      ];
      const target = input.preset === "light" ? -18 : -16;
      const loudness = `loudnorm=I=${target}:TP=-1.5:LRA=11`;
      let normalization: string | undefined;
      try {
        if (input.normalize) {
          await context.reportProgress({
            stage: "measure",
            fraction: 0,
            message: "Measuring source loudness",
          });
          const measured = await runMediaProcess(
            options.ffmpegPath ?? "ffmpeg",
            [
              "-hide_banner",
              "-nostdin",
              ...sourceOptions,
              "-i",
              source,
              "-map",
              "0:a:0",
              "-vn",
              "-sn",
              "-dn",
              "-af",
              [...baseFilters, `${loudness}:print_format=json`].join(","),
              "-f",
              "null",
              "-",
            ],
            { signal: context.signal, maxStdoutBytes: 64 * 1024 },
          );
          const block = measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
          if (!block) throw new Error("FFmpeg did not return measured loudness");
          const levels = JSON.parse(block) as Record<string, string>;
          const fields = {
            measured_I: "input_i",
            measured_LRA: "input_lra",
            measured_TP: "input_tp",
            measured_thresh: "input_thresh",
            offset: "target_offset",
          };
          // Digital silence has -inf integrated loudness. Preserve it exactly
          // instead of fabricating a gain from non-finite measurements.
          if (Object.values(fields).every((key) => Number.isFinite(Number(levels[key]))))
            normalization = `${loudness}:${Object.entries(fields)
              .map(([name, key]) => `${name}=${Number(levels[key])}`)
              .join(":")}:linear=true`;
        }
        await context.reportProgress({
          stage: "enhance",
          fraction: input.normalize ? 0.4 : 0,
          message: "Creating enhanced audio",
        });
        const filters = [
          ...baseFilters,
          ...(normalization ? [normalization] : []),
          "alimiter=limit=0.891251:level=false:latency=true",
          "aresample=48000",
          "apad",
          `atrim=duration=${duration}`,
        ];
        await runMediaProcess(
          options.ffmpegPath ?? "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            ...sourceOptions,
            "-i",
            source,
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-af",
            filters.join(","),
            "-ar",
            "48000",
            "-ac",
            String(original.audio.channels),
            "-c:a",
            "pcm_s16le",
            "-rf64",
            "auto",
            "-map_metadata",
            "-1",
            "-progress",
            "pipe:1",
            "-nostats",
            "-n",
            temporary,
          ],
          {
            signal: context.signal,
            durationSeconds: duration,
            onProgress: (progress) =>
              context.reportProgress({
                stage: "enhance",
                fraction:
                  (input.normalize ? 0.4 : 0) +
                  (progress.fraction ?? 0) * (input.normalize ? 0.55 : 0.95),
              }),
          },
        );
        const inspection = await inspectMediaFile(temporary, context, options);
        if (
          inspection.kind !== "audio" ||
          inspection.audio?.sampleRate !== 48000 ||
          inspection.audio.channels !== original.audio.channels ||
          !inspection.durationSeconds ||
          Math.abs(inspection.durationSeconds - duration) > Math.max(1 / 30, duration * 0.00001)
        )
          throw new Error("Enhanced audio did not preserve its source duration and channels");
        context.signal.throwIfAborted();
        await rename(temporary, output);
        const asset = await options.publishArtifact(context.scope, output, "audio/wav", context);
        context.signal.throwIfAborted();
        await context.reportProgress({
          stage: "complete",
          fraction: 1,
          message: "Enhanced audio is ready",
        });
        return {
          asset,
          inspection,
          provenance: {
            sourceAssetId: input.assetId,
            preset: input.preset,
            denoise: input.denoise,
            normalize: input.normalize,
            processor: "ffmpeg-audio-enhance",
            version: 1,
          },
        };
      } finally {
        await Promise.all(
          [temporary, output].map((path) => rm(path, { force: true }).catch(() => {})),
        );
      }
    },
  };
}

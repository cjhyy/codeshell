import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectMediaFile, type MediaInspection } from "./media-processors.js";
import { mediaAbortError, runMediaProcess } from "./media-process-runner.js";
import type { AudioEnhanceOptions } from "./media-audio-enhance.js";
import type { MediaAsset, MediaJobProcessor } from "./media-types.js";

export interface AudioExtractInput {
  assetId: string;
  inFrame: number;
  outFrame: number;
  fps: 30;
}
export interface AudioExtractResult {
  asset: MediaAsset;
  inspection: MediaInspection;
  provenance: Omit<AudioExtractInput, "assetId"> & {
    sourceAssetId: string;
    processor: "ffmpeg-audio-extract";
    version: 1;
  };
}

export function validateAudioExtractInput(raw: unknown): AudioExtractInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("请选择要提取的本人录音片段");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["assetId", "inFrame", "outFrame", "fps"].includes(key)))
    throw new Error("不支持此参考录音提取参数");
  if (typeof input.assetId !== "string" || !/^asset-[a-f0-9]{64}$/.test(input.assetId))
    throw new Error("请选择当前项目已保存的素材");
  for (const key of ["inFrame", "outFrame"])
    if (
      typeof input[key] !== "number" ||
      !Number.isSafeInteger(input[key]) ||
      input[key] < 0 ||
      input[key] > 24 * 3600 * 30
    )
      throw new Error("参考片段的起止位置无效");
  if (input.fps !== 30) throw new Error("参考片段须使用 30 fps 时间基准");
  const inFrame = input.inFrame as number,
    outFrame = input.outFrame as number;
  if (outFrame - inFrame < 90 || outFrame - inFrame > 900)
    throw new Error("本人声音参考片段需要 3–30 秒");
  return { assetId: input.assetId, inFrame, outFrame, fps: 30 };
}

/** Sample-accurate derivative from an authorized asset; never changes the original. */
export function createAudioExtractProcessor(
  options: Omit<AudioEnhanceOptions, "maxOutputBytes">,
): MediaJobProcessor {
  return {
    recovery: "restart",
    async run(raw, context): Promise<AudioExtractResult> {
      const input = validateAudioExtractInput(raw);
      try {
        context.signal.throwIfAborted();
        const source = await options.resolveAssetPath(context.scope, input.assetId);
        const original = await inspectMediaFile(source, context, options);
        if (
          !original.audio ||
          !original.durationSeconds ||
          original.audio.channels < 1 ||
          original.audio.channels > 8
        )
          throw new Error("这个素材没有可用的声音，请选择本人录音或带原声的视频");
        // A rounded final video frame can exceed the container by at most half a frame.
        if (input.outFrame / 30 > original.durationSeconds + 1 / 60)
          throw new Error("参考片段超出原始素材时长，请重新选择起止位置");
        const duration = (input.outFrame - input.inFrame) / 30;
        await mkdir(context.outputDir, { recursive: true });
        const temporary = join(context.outputDir, `reference-${randomUUID()}.partial.wav`);
        const output = join(context.outputDir, `reference-${randomUUID()}.wav`);
        try {
          await context.reportProgress({
            stage: "extract",
            fraction: 0,
            message: "正在提取选中的本人录音片段",
          });
          await runMediaProcess(
            options.ffmpegPath ?? "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-protocol_whitelist",
              "file,pipe",
              "-format_whitelist",
              "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac",
              "-ss",
              String(input.inFrame / 30),
              "-i",
              source,
              "-map",
              "0:a:0",
              "-vn",
              "-sn",
              "-dn",
              // Accurate input seeking avoids decoding hours before a late selection.
              // FFmpeg shifts source timestamps by the seek position. Keep any remaining
              // leading audio gap, then retain precisely 1600 samples per selected frame.
              "-af",
              [
                "aresample=48000:async=1:first_pts=0",
                "apad",
                `atrim=end_sample=${(input.outFrame - input.inFrame) * 1600}`,
                "asetpts=PTS-STARTPTS",
              ].join(","),
              "-t",
              String(duration),
              "-ar",
              "48000",
              "-ac",
              "1",
              "-c:a",
              "pcm_s16le",
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
                  stage: "extract",
                  fraction: (progress.fraction ?? 0) * 0.95,
                }),
            },
          );
          const inspection = await inspectMediaFile(temporary, context, options);
          if (
            inspection.kind !== "audio" ||
            inspection.audio?.sampleRate !== 48000 ||
            inspection.audio.channels !== 1 ||
            !inspection.durationSeconds ||
            Math.abs(inspection.durationSeconds - duration) > 1 / 48000 + 0.000001
          )
            throw new Error("参考录音提取未保留完整片段，请重试");
          context.signal.throwIfAborted();
          await rename(temporary, output);
          const asset = await options.publishArtifact(context.scope, output, "audio/wav", context);
          context.signal.throwIfAborted();
          await context.reportProgress({
            stage: "complete",
            fraction: 1,
            message: "参考录音片段已保存",
          });
          return {
            asset,
            inspection,
            provenance: {
              sourceAssetId: input.assetId,
              inFrame: input.inFrame,
              outFrame: input.outFrame,
              fps: 30,
              processor: "ffmpeg-audio-extract",
              version: 1,
            },
          };
        } finally {
          await Promise.all(
            [temporary, output].map((path) => rm(path, { force: true }).catch(() => {})),
          );
        }
      } catch (error) {
        if (context.signal.aborted) throw mediaAbortError();
        const message = error instanceof Error ? error.message : "";
        const publicMessages = [
          "这个素材没有可用的声音，请选择本人录音或带原声的视频",
          "参考片段超出原始素材时长，请重新选择起止位置",
          "参考录音提取未保留完整片段，请重试",
        ];
        throw new Error(
          publicMessages.includes(message)
            ? message
            : "参考录音提取失败，请检查素材是否可播放，以及本机音频处理工具是否就绪",
          { cause: error },
        );
      }
    },
  };
}

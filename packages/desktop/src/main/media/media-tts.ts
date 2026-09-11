import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { mediaAbortError, runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

export interface LocalTtsVoice {
  id: string;
  name: string;
  language: string;
}

export interface LocalTtsOptions {
  /** Executable paths are trusted Host configuration, never panel input. */
  sayPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
}

export interface LocalTtsStatus {
  available: boolean;
  engine: "macos-say" | "unavailable";
  version?: string;
  voices: LocalTtsVoice[];
  defaultVoiceId?: string;
  reason?: string;
}

export interface LocalTtsInput {
  text: string;
  voiceId?: string;
  rate: number;
}

export interface LocalTtsResult {
  path: string;
  mimeType: "audio/wav";
  engine: "macos-say";
  voice: LocalTtsVoice;
  rate: number;
  durationSeconds: number;
  sampleRate: 48000;
  channels: 1;
  cached: boolean;
  cacheKey: string;
}

const CACHE_VERSION = 1;
const MAX_AUDIO_SECONDS = 30 * 60;
const MAX_WAV_BYTES = MAX_AUDIO_SECONDS * 48_000 * 2 + 4096;

/** Plain text only: say's embedded control language must not bypass rate/duration bounds. */
export function validateLocalTtsInput(raw: unknown): LocalTtsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("配音参数必须是对象");
  const input = raw as Record<string, unknown>;
  if (typeof input.text !== "string") throw new Error("请输入配音文字");
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (!text || Array.from(text).length > 6000) throw new Error("配音文字须为 1 至 6000 字");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /\[\[|\]\]/.test(text))
    throw new Error("配音仅支持普通文字，不支持语音控制标记或控制字符");
  let voiceId: string | undefined;
  if (input.voiceId !== undefined) {
    if (typeof input.voiceId !== "string" || !input.voiceId.trim() || input.voiceId.length > 200)
      throw new Error("声音标识无效");
    voiceId = input.voiceId.trim();
  }
  const rate = input.rate === undefined ? 1 : input.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0.5 || rate > 2)
    throw new Error("语速须在 0.5 至 2 倍之间");
  return { text, ...(voiceId ? { voiceId } : {}), rate };
}

/** Enumerate already installed system voices. This never installs or downloads a voice. */
export async function detectLocalTts(options: LocalTtsOptions = {}): Promise<LocalTtsStatus> {
  if (options.signal?.aborted) throw mediaAbortError();
  if (process.platform !== "darwin")
    return {
      available: false,
      engine: "unavailable",
      voices: [],
      reason: "当前内置配音使用 macOS 系统声音；此系统暂不支持本地配音",
    };
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  const say = options.sayPath ?? "/usr/bin/say";
  try {
    const [listed, binary, ffmpeg, ffprobe] = await Promise.all([
      runMediaProcess(say, ["-v", "?"], { signal, maxStdoutBytes: 256 * 1024 }),
      stat(say),
      runMediaProcess(options.ffmpegPath ?? "ffmpeg", ["-version"], { signal }),
      runMediaProcess(options.ffprobePath ?? "ffprobe", ["-version"], { signal }),
    ]);
    const voices: LocalTtsVoice[] = [];
    for (const line of listed.stdout.toString("utf8").split(/\r?\n/)) {
      const match = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line);
      if (match) voices.push({ id: match[1].trim(), name: match[1].trim(), language: match[2] });
    }
    if (!voices.length) throw new Error("未发现已安装的系统声音");
    const preferred =
      voices.find((voice) => voice.id === "Tingting") ??
      voices.find((voice) => voice.language === "zh_CN") ??
      voices.find((voice) => voice.id === "Samantha") ??
      voices[0];
    return {
      available: true,
      engine: "macos-say",
      version: [
        `macOS-${release()}`,
        `say-${binary.size}-${binary.mtimeMs}`,
        ffmpeg.stdout.toString("utf8").split("\n")[0],
        ffprobe.stdout.toString("utf8").split("\n")[0],
      ].join("; "),
      voices,
      defaultVoiceId: preferred.id,
    };
  } catch (error) {
    if (options.signal?.aborted) throw mediaAbortError();
    return {
      available: false,
      engine: "unavailable",
      voices: [],
      reason: `本地配音需要已安装的系统声音、FFmpeg 和 ffprobe：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function digestFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectWav(path: string, signal: AbortSignal, options: LocalTtsOptions) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 44 || info.size > MAX_WAV_BYTES)
    throw new Error("系统未生成有效或大小合适的语音文件");
  const probe = await runMediaProcess(
    options.ffprobePath ?? "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "wav",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,sample_rate,channels",
      "-of",
      "json",
      path,
    ],
    { signal },
  );
  const result = JSON.parse(probe.stdout.toString("utf8"));
  const audio = result.streams?.find(
    (stream: { codec_type?: string }) => stream.codec_type === "audio",
  );
  const durationSeconds = Number(result.format?.duration);
  if (
    !audio ||
    audio.codec_name !== "pcm_s16le" ||
    Number(audio.sample_rate) !== 48_000 ||
    audio.channels !== 1 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_AUDIO_SECONDS
  )
    throw new Error("系统配音不是有效的 48kHz 单声道 WAV，或超过 30 分钟");
  return { durationSeconds, bytes: info.size };
}

/** Render cancellable, cacheable speech to a unique job artifact; source text is never a CLI argument. */
export async function generateLocalTts(
  raw: { text: string; voiceId?: string; rate?: number },
  context: MediaJobContext,
  options: LocalTtsOptions = {},
): Promise<LocalTtsResult> {
  const input = validateLocalTtsInput(raw);
  if (context.signal.aborted) throw mediaAbortError();
  const deadline = AbortSignal.timeout(180_000);
  const signal = AbortSignal.any([context.signal, deadline]);
  const runtime = await detectLocalTts({ ...options, signal });
  if (!runtime.available) throw new Error(runtime.reason);
  const voice = runtime.voices.find(
    (item) => item.id === (input.voiceId ?? runtime.defaultVoiceId),
  );
  if (!voice) throw new Error("所选声音未安装，请选择列表中的系统声音");
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        version: CACHE_VERSION,
        runtime: runtime.version,
        voice,
        text: input.text,
        rate: input.rate,
      }),
    )
    .digest("hex");
  const nonce = randomUUID();
  const output = join(context.outputDir, `speech-${nonce}.wav`);
  const textPath = join(context.workDir, `speech-${nonce}.txt`);
  const aiff = join(context.workDir, `speech-${nonce}.aiff`);
  const partial = join(context.outputDir, `speech-${nonce}.partial.wav`);
  const cacheWav = join(context.cacheDir, `tts-${cacheKey}.wav`);
  const cacheJson = join(context.cacheDir, `tts-${cacheKey}.json`);
  const cacheTemp = join(context.cacheDir, `tts-${cacheKey}-${nonce}.tmp.wav`);
  const metadataTemp = join(context.cacheDir, `tts-${cacheKey}-${nonce}.tmp.json`);
  let completed = false;
  try {
    for (const directory of [context.workDir, context.outputDir, context.cacheDir])
      await mkdir(directory, { recursive: true });
    await context.reportProgress({
      fraction: 0.03,
      stage: "speech",
      message: "检查系统声音与配音缓存",
    });
    let cachedMetadata: { durationSeconds: number; bytes: number } | undefined;
    try {
      if ((await stat(cacheJson)).size > 4096) throw new Error("Oversized speech cache metadata");
      const cached = JSON.parse(await readFile(cacheJson, "utf8"));
      const metadata = await inspectWav(cacheWav, signal, options);
      if (
        cached.version !== CACHE_VERSION ||
        cached.cacheKey !== cacheKey ||
        cached.bytes !== metadata.bytes ||
        cached.durationSeconds !== metadata.durationSeconds ||
        cached.sha256 !== (await digestFile(cacheWav, signal))
      )
        throw new Error("Stale speech cache");
      cachedMetadata = metadata;
    } catch (error) {
      if (signal.aborted) throw error;
      // Missing, stale or damaged artifacts are regenerated, never treated as valid speech.
    }
    if (cachedMetadata) {
      await copyFile(cacheWav, partial);
      if (signal.aborted) throw mediaAbortError();
      await rename(partial, output);
      await context.reportProgress({
        fraction: 1,
        stage: "speech",
        message: "已复用相同文字的本地配音",
      });
      if (signal.aborted) throw mediaAbortError();
      completed = true;
      return {
        path: output,
        mimeType: "audio/wav",
        engine: "macos-say",
        voice,
        rate: input.rate,
        durationSeconds: cachedMetadata.durationSeconds,
        sampleRate: 48000,
        channels: 1,
        cached: true,
        cacheKey,
      };
    }
    await writeFile(textPath, input.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await context.reportProgress({
      fraction: 0.12,
      stage: "synthesize",
      message: `正在用 ${voice.name} 生成配音`,
    });
    await runMediaProcess(
      options.sayPath ?? "/usr/bin/say",
      ["-v", voice.id, "-r", String(Math.round(175 * input.rate)), "-f", textPath, "-o", aiff],
      { signal },
    );
    await context.reportProgress({ fraction: 0.7, stage: "encode", message: "正在整理语音音轨" });
    await runMediaProcess(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "aiff",
        "-i",
        aiff,
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        "loudnorm=I=-18:TP=-2:LRA=11",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        partial,
      ],
      { signal },
    );
    const metadata = await inspectWav(partial, signal, options);
    const sha256 = await digestFile(partial, signal);
    await copyFile(partial, cacheTemp);
    await writeFile(
      metadataTemp,
      JSON.stringify({ version: CACHE_VERSION, cacheKey, sha256, ...metadata }),
      { mode: 0o600, flag: "wx" },
    );
    if (signal.aborted) throw mediaAbortError();
    await rename(cacheTemp, cacheWav);
    await rename(metadataTemp, cacheJson);
    await rename(partial, output);
    await context.reportProgress({ fraction: 1, stage: "speech", message: "本地配音已生成" });
    if (signal.aborted) throw mediaAbortError();
    completed = true;
    return {
      path: output,
      mimeType: "audio/wav",
      engine: "macos-say",
      voice,
      rate: input.rate,
      durationSeconds: metadata.durationSeconds,
      sampleRate: 48000,
      channels: 1,
      cached: false,
      cacheKey,
    };
  } catch (error) {
    if (context.signal.aborted) throw mediaAbortError();
    if (deadline.aborted)
      throw new Error("系统配音超过 3 分钟处理时限，请缩短文字后重试", { cause: error });
    throw error;
  } finally {
    await Promise.all(
      [textPath, aiff, partial, cacheTemp, metadataTemp, ...(completed ? [] : [output])].map(
        (path) => rm(path, { force: true }),
      ),
    );
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { mediaAbortError, runMediaProcess } from "./media-process-runner.js";
import type { MediaJobContext } from "./media-types.js";

export interface OpenAiTtsInput {
  text: string;
  model: string;
  voiceId: string;
  rate: number;
  instructions?: string;
}

export interface OpenAiTtsOptions {
  /** Host-resolved configuration only. Credentials never enter panel state or job results. */
  baseUrl: string;
  apiKey: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface OpenAiTtsResult {
  path: string;
  mimeType: "audio/wav";
  engine: "openai-compatible";
  durationSeconds: number;
  sampleRate: 48000;
  channels: 1;
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;
const WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);

/** Only messages constructed locally may cross the Host boundary. */
class SpeechError extends Error {}

function requestUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SpeechError("配音服务地址无效");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new SpeechError(
      "配音服务须使用 HTTPS；本机兼容服务可使用回环 HTTP，地址不可包含凭据或查询参数",
    );
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/audio/speech`;
  return url;
}

function validateInput(input: OpenAiTtsInput): OpenAiTtsInput {
  if (
    !input ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    Array.from(input.text.trim()).length > 4096
  )
    throw new SpeechError("在线配音文稿须为 1 至 4096 字");
  for (const value of [input.model, input.voiceId])
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 256 ||
      /[\r\n\u0000]/.test(value)
    )
      throw new SpeechError("配音模型或声音标识无效");
  if (!Number.isFinite(input.rate) || input.rate < 0.5 || input.rate > 2)
    throw new SpeechError("配音速度须在 0.5 至 2 倍之间");
  if (
    input.instructions !== undefined &&
    (typeof input.instructions !== "string" || Array.from(input.instructions).length > 4096)
  )
    throw new SpeechError("声音风格说明不可超过 4096 字");
  return {
    ...input,
    text: input.text.trim(),
    model: input.model.trim(),
    voiceId: input.voiceId.trim(),
  };
}

async function inspectWav(path: string, signal: AbortSignal, options: OpenAiTtsOptions) {
  const result = await runMediaProcess(
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
  const metadata = JSON.parse(result.stdout.toString("utf8"));
  const audio = metadata.streams?.find(
    (stream: { codec_type?: string }) => stream.codec_type === "audio",
  );
  const durationSeconds = Number(metadata.format?.duration);
  if (
    !audio ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_DURATION_SECONDS
  )
    throw new SpeechError("配音服务未返回有效音频，或音频超过 10 分钟");
  return {
    durationSeconds,
    sampleRate: Number(audio.sample_rate),
    channels: Number(audio.channels),
    codec: audio.codec_name,
  };
}

async function saveResponse(
  response: Response,
  path: string,
  signal: AbortSignal,
  context: MediaJobContext,
) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpeechError(
      `配音服务请求失败（HTTP ${response.status}），请检查模型权限、额度或服务设置`,
    );
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const length = Number(response.headers.get("content-length")) || undefined;
  if (!WAV_TYPES.has(type) || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpeechError("配音服务未返回 WAV 音频");
  }
  if (length && (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES)) {
    await response.body.cancel().catch(() => undefined);
    throw new SpeechError("配音响应超过 64 MiB，已停止接收");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let file: FileHandle | undefined;
  let bytes = 0,
    signature = Buffer.alloc(0),
    lastProgress = 0;
  try {
    file = await open(path, "wx", 0o600);
    while (true) {
      if (signal.aborted) throw mediaAbortError();
      const { value, done } = await reader.read();
      if (signal.aborted) throw mediaAbortError();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SpeechError("配音响应超过 64 MiB，已停止接收");
      if (signature.length < 12) {
        signature = Buffer.concat([
          signature,
          Buffer.from(value.subarray(0, 12 - signature.length)),
        ]);
        if (
          signature.length === 12 &&
          (signature.toString("ascii", 0, 4) !== "RIFF" ||
            signature.toString("ascii", 8, 12) !== "WAVE")
        )
          throw new SpeechError("配音服务返回的数据不是 WAV 音频");
      }
      await file.writeFile(value);
      if (Date.now() - lastProgress >= 200) {
        lastProgress = Date.now();
        await context.reportProgress({
          stage: "speech-download",
          message: "正在接收生成的配音",
          ...(length ? { fraction: Math.min(0.65, 0.1 + (0.55 * bytes) / length) } : {}),
        });
      }
    }
    if (bytes <= 44 || signature.length < 12 || (length !== undefined && bytes !== length))
      throw new SpeechError("配音服务返回的音频为空或不完整");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file?.close();
  }
}

/** One explicit request, without redirects, retries or paid-response caching. */
export async function generateOpenAiTts(
  raw: OpenAiTtsInput,
  context: MediaJobContext,
  options: OpenAiTtsOptions,
): Promise<OpenAiTtsResult> {
  const input = validateInput(raw),
    url = requestUrl(options.baseUrl);
  if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey))
    throw new SpeechError("配音服务尚未配置有效凭据");
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new SpeechError("配音服务超时设置无效");
  if (context.signal.aborted) throw mediaAbortError();
  const deadline = AbortSignal.timeout(timeoutMs),
    signal = AbortSignal.any([context.signal, deadline]);
  const nonce = randomUUID();
  const source = join(context.workDir, `speech-response-${nonce}.wav`);
  const partial = join(context.outputDir, `speech-${nonce}.partial.wav`);
  const output = join(context.outputDir, `speech-${nonce}.wav`);
  let completed = false,
    failureMessage = "连接配音服务失败，请检查服务地址、凭据和网络";
  try {
    await mkdir(context.workDir, { recursive: true });
    await mkdir(context.outputDir, { recursive: true });
    await context.reportProgress({
      fraction: 0.03,
      stage: "synthesize",
      message: "正在请求所选模型生成配音",
    });
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify({
        model: input.model,
        input: input.text,
        voice: input.voiceId,
        speed: input.rate,
        response_format: "wav",
        ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
      }),
    });
    failureMessage = "接收配音失败，服务未返回完整可用的音频";
    await saveResponse(response, source, signal, context);
    failureMessage = "配音音频处理失败，请检查音频格式与本机 FFmpeg";
    await inspectWav(source, signal, options);
    await context.reportProgress({
      fraction: 0.75,
      stage: "speech-encode",
      message: "正在整理配音音轨",
    });
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
        "wav",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        String(MAX_DURATION_SECONDS + 1),
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
    if (
      metadata.sampleRate !== 48_000 ||
      metadata.channels !== 1 ||
      metadata.codec !== "pcm_s16le" ||
      (await stat(partial)).size > MAX_DURATION_SECONDS * 48_000 * 2 + 4096
    )
      throw new SpeechError("配音未能转换为有效的 48kHz 单声道 WAV");
    if (signal.aborted) throw mediaAbortError();
    await rename(partial, output);
    await context.reportProgress({ fraction: 1, stage: "speech", message: "配音已生成" });
    if (signal.aborted) throw mediaAbortError();
    completed = true;
    return {
      path: output,
      mimeType: "audio/wav",
      engine: "openai-compatible",
      durationSeconds: metadata.durationSeconds,
      sampleRate: 48000,
      channels: 1,
    };
  } catch (error) {
    if (context.signal.aborted) throw mediaAbortError();
    if (deadline.aborted)
      throw new SpeechError("配音生成超时，已停止请求；请检查任务后再决定是否重试");
    if (error instanceof SpeechError) throw error;
    // Upstream errors may contain authorization headers, URLs or returned text.
    // Only a local stage description is allowed into guest-visible job errors.
    throw new SpeechError(failureMessage);
  } finally {
    await Promise.all(
      [source, partial, ...(completed ? [] : [output])].map((path) => rm(path, { force: true })),
    );
  }
}

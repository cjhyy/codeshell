import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { mediaAbortError, runMediaProcess } from "./media-process-runner.js";
import { MANAGED_TTS_SCRIPT } from "./media-tts-provider-script.js";
import { releaseManagedTtsSetupResources } from "./media-tts-setup-cleanup.js";
import { validateLocalTtsInput, type LocalTtsVoice } from "./media-tts.js";
import type { MediaJobContext } from "./media-types.js";

export type ManagedTtsProviderId = "edge-tts" | "kokoro";
export interface ManagedTtsProviderStatus {
  id: ManagedTtsProviderId;
  name: string;
  mode: "online" | "offline";
  state: "not-installed" | "needs-setup" | "installing" | "ready" | "unavailable" | "failed";
  available: boolean;
  installed: boolean;
  voices: LocalTtsVoice[];
  defaultVoiceId?: string;
  reason?: string;
  downloadBytes: number;
  requiredDiskBytes: number;
  version?: string;
  verifiedAt?: number;
}
export interface ManagedTtsOptions {
  /** Trusted Host configuration. No filesystem/executable/URL options are accepted from a panel. */
  runtimeDir: string;
  pythonPath?: string;
  uvPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Read-only HyperFrames tts cache or an already prepared managed Kokoro resource directory. */
  reuseKokoroDir?: string;
}
export interface ManagedTtsInput {
  providerId: ManagedTtsProviderId;
  text: string;
  voiceId?: string;
  rate: number;
}
export interface ManagedTtsResult {
  path: string;
  mimeType: "audio/wav";
  engine: ManagedTtsProviderId;
  voice: LocalTtsVoice;
  rate: number;
  durationSeconds: number;
  sampleRate: 48000;
  channels: 1;
  cached: boolean;
}

const VERSION = 1;
const SCRIPT_HASH = createHash("sha256").update(MANAGED_TTS_SCRIPT).digest("hex");
const PACKAGES = {
  "edge-tts": ["edge-tts==7.2.8"],
  kokoro: ["kokoro-onnx==0.6.1", "misaki[zh]==0.9.4", "soundfile==0.14.0", "onnxruntime==1.29.0"],
} as const;
const RESOURCES = [
  {
    name: "kokoro-v1.0.onnx",
    reuse: "models",
    bytes: 325532387,
    sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
  },
  {
    name: "voices-v1.0.bin",
    reuse: "voices",
    bytes: 28214398,
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
  },
] as const;
const setupOwners = new Set<string>();
type Manifest = {
  version: number;
  scriptHash: string;
  packages: readonly string[];
  verifiedAt: number;
  voices: LocalTtsVoice[];
  defaultVoiceId: string;
  state: "ready" | "failed";
  reason?: string;
};

export function validateManagedTtsProviderId(raw: unknown): ManagedTtsProviderId {
  if (raw !== "edge-tts" && raw !== "kokoro")
    throw new Error("仅支持白名单中的 Edge TTS 或 Kokoro");
  return raw;
}

export function validateManagedTtsInput(raw: unknown): ManagedTtsInput {
  const normalized = validateLocalTtsInput(raw);
  const providerId = validateManagedTtsProviderId((raw as Record<string, unknown>).providerId);
  if (!/[\p{L}\p{N}]/u.test(normalized.text)) throw new Error("配音文字至少需要一个可朗读的字词");
  return { providerId, ...normalized };
}

async function digest(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function jsonFile(path: string, maxBytes = 256 * 1024): Promise<any> {
  if ((await stat(path)).size > maxBytes) throw new Error("Runtime metadata exceeds its budget");
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}-${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A fixed, bounded resource transfer. Mirrors and URLs cannot be supplied by a panel. */
async function downloadResource(
  resource: (typeof RESOURCES)[number],
  target: string,
  context: MediaJobContext,
  signal: AbortSignal,
) {
  let url = `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/${resource.name}`;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(parsed.hostname)
    )
      throw new Error("模型下载地址不在受信任的发布源内");
    response = await fetch(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("模型下载重定向无效");
      url = new URL(location, url).href;
    } else break;
  }
  if (!response?.ok || !response.body) throw new Error("模型下载失败，请检查网络后重试");
  const declared = Number(response.headers.get("content-length"));
  if (declared && declared !== resource.bytes) {
    await response.body.cancel();
    throw new Error("模型下载大小与固定版本不一致");
  }
  const partial = `${target}-${randomUUID()}.partial`;
  const handle = await open(partial, "wx", 0o600);
  const reader = response.body.getReader();
  let bytes = 0;
  let last = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > resource.bytes) throw new Error("模型下载超出固定大小预算");
      let written = 0;
      while (written < value.byteLength) {
        const chunk = await handle.write(value.subarray(written));
        if (!chunk.bytesWritten) throw new Error("模型文件写入失败");
        written += chunk.bytesWritten;
      }
      if (Date.now() - last > 250) {
        last = Date.now();
        await context.reportProgress({
          fraction: 0.3 + (0.35 * bytes) / resource.bytes,
          stage: "download",
          message: `正在下载 ${resource.name}：${Math.round(bytes / 1048576)} / ${Math.round(resource.bytes / 1048576)} MB`,
        });
      }
    }
    await handle.close();
    if (bytes !== resource.bytes || (await digest(partial, signal)) !== resource.sha256)
      throw new Error("模型校验失败，未启用该资源");
    if (signal.aborted) throw mediaAbortError();
    await rename(partial, target);
  } finally {
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    await rm(partial, { force: true });
  }
}

export function createManagedTtsProviders(options: ManagedTtsOptions) {
  if (!isAbsolute(options.runtimeDir))
    throw new Error("TTS runtimeDir must be an absolute Host path");
  const root = resolve(options.runtimeDir);
  const directory = (id: ManagedTtsProviderId) => join(root, id);
  const python = (id: ManagedTtsProviderId) =>
    join(directory(id), "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const script = (id: ManagedTtsProviderId) => join(directory(id), "runner.py");
  const manifestPath = (id: ManagedTtsProviderId) => join(directory(id), "runtime.json");
  const isolatedEnvironment = () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(UV_|PIP_|PYTHON|VIRTUAL_ENV|CONDA|PHONEMIZER_ESPEAK_LIBRARY)/i.test(key))
        delete env[key];
    }
    return {
      ...env,
      UV_CACHE_DIR: join(root, "package-cache"),
      UV_NO_CONFIG: "1",
      PYTHONNOUSERSITE: "1",
    };
  };

  function baseStatus(id: ManagedTtsProviderId): ManagedTtsProviderStatus {
    return {
      id,
      name: id === "kokoro" ? "Kokoro 本地声音" : "Edge 在线声音（第三方客户端）",
      mode: id === "kokoro" ? "offline" : "online",
      state: "not-installed",
      available: false,
      installed: false,
      voices: [],
      downloadBytes: id === "kokoro" ? 550 * 1048576 : 25 * 1048576,
      requiredDiskBytes: id === "kokoro" ? 2 * 1024 ** 3 : 256 * 1048576,
    };
  }

  async function loadManifest(id: ManagedTtsProviderId): Promise<Manifest> {
    const value = await jsonFile(manifestPath(id));
    if (
      value.version !== VERSION ||
      value.scriptHash !== SCRIPT_HASH ||
      JSON.stringify(value.packages) !== JSON.stringify(PACKAGES[id]) ||
      !Array.isArray(value.voices) ||
      !value.voices.length ||
      value.voices.length > 2000 ||
      value.voices.some(
        (v: LocalTtsVoice) =>
          typeof v.id !== "string" || typeof v.name !== "string" || typeof v.language !== "string",
      ) ||
      !value.voices.some((v: LocalTtsVoice) => v.id === value.defaultVoiceId)
    )
      throw new Error("Stale runtime manifest");
    return value;
  }

  /** Read-only and offline. Availability reflects the last real validation, not a live SLA check. */
  async function status(
    rawId: ManagedTtsProviderId,
    signal?: AbortSignal,
  ): Promise<ManagedTtsProviderStatus> {
    const id = validateManagedTtsProviderId(rawId);
    if (signal?.aborted) throw mediaAbortError();
    const result = baseStatus(id);
    if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
      return {
        ...result,
        state: "unavailable",
        reason: "当前安装器仅支持 macOS / Linux 的 ARM64 或 x64；请使用其他已配置声音",
      };
    if (id === "kokoro" && totalmem() < 4 * 1024 ** 3)
      return { ...result, state: "unavailable", reason: "Kokoro 本地推理至少需要 4 GB 内存" };
    try {
      result.installed = (await stat(python(id))).isFile();
    } catch {
      /* Not installed. */
    }
    if (setupOwners.has(directory(id)))
      return { ...result, state: "installing", reason: "正在准备并验证声音资源" };
    try {
      const manifest = await loadManifest(id);
      if (!result.installed || (await readFile(script(id), "utf8")) !== MANAGED_TTS_SCRIPT)
        throw new Error("Incomplete runtime");
      if (id === "kokoro")
        for (const resource of RESOURCES)
          if ((await stat(join(directory(id), resource.name))).size !== resource.bytes)
            throw new Error("Incomplete model");
      return {
        ...result,
        state: manifest.state,
        available: manifest.state === "ready",
        voices: manifest.voices,
        defaultVoiceId: manifest.defaultVoiceId,
        reason: manifest.reason,
        verifiedAt: manifest.verifiedAt,
        version: PACKAGES[id].join("; "),
      };
    } catch {
      let reason: string | undefined;
      try {
        reason = (await jsonFile(join(directory(id), "failure.json"), 4096)).reason;
      } catch {
        /* No previous failure. */
      }
      return {
        ...result,
        state: reason ? "failed" : result.installed ? "needs-setup" : "not-installed",
        reason: reason ?? "需要准备客户端与声音资源；完成短句验证后才能使用",
      };
    }
  }

  async function execute(
    id: ManagedTtsProviderId,
    data: Record<string, unknown>,
    context: MediaJobContext,
    signal: AbortSignal,
  ) {
    await mkdir(context.workDir, { recursive: true });
    const requestPath = join(context.workDir, `tts-request-${randomUUID()}.json`);
    await writeFile(
      requestPath,
      JSON.stringify({
        providerId: id,
        modelPath: join(directory(id), RESOURCES[0].name),
        voicesPath: join(directory(id), RESOURCES[1].name),
        ...data,
      }),
      { mode: 0o600 },
    );
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    let result: any;
    let last = 0;
    let progress = Promise.resolve();
    try {
      await runMediaProcess(python(id), ["-I", script(id), requestPath], {
        signal,
        env: isolatedEnvironment(),
        onStdout(chunk) {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer) > 1024 * 1024)
            throw new Error("TTS runtime response exceeds budget");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            let value;
            try {
              value = JSON.parse(line);
            } catch {
              continue;
            }
            if (value.result) result = value.result;
            if (value.progress && Date.now() - last > 250) {
              last = Date.now();
              const update = value.progress;
              progress = progress.then(() =>
                context.reportProgress({
                  fraction: typeof update.fraction === "number" ? update.fraction : undefined,
                  stage: "speech",
                  message: id === "kokoro" ? "正在本地生成配音" : "正在接收在线配音",
                }),
              );
              void progress.catch(() => {});
            }
          }
        },
      });
      await progress;
      if (!result) throw new Error("TTS runtime did not return a complete result");
      return result;
    } finally {
      await progress.catch(() => {});
      await rm(requestPath, { force: true });
    }
  }

  async function checkTools(signal: AbortSignal) {
    await Promise.all([
      runMediaProcess(options.ffmpegPath ?? "ffmpeg", ["-version"], { signal }),
      runMediaProcess(options.ffprobePath ?? "ffprobe", ["-version"], { signal }),
    ]);
  }

  async function inspect(path: string, signal: AbortSignal) {
    const size = (await stat(path)).size;
    if (size < 44 || size > 1800 * 48000 * 2 + 4096)
      throw new Error("配音音频为空或超出 30 分钟预算");
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
        "format=duration:stream=codec_name,sample_rate,channels",
        "-of",
        "json",
        path,
      ],
      { signal },
    );
    const metadata = JSON.parse(probe.stdout.toString("utf8"));
    const audio = metadata.streams?.[0];
    const durationSeconds = Number(metadata.format?.duration);
    if (
      audio?.codec_name !== "pcm_s16le" ||
      Number(audio.sample_rate) !== 48000 ||
      audio.channels !== 1 ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 1800
    )
      throw new Error("未生成合格的 48 kHz WAV 配音");
    const volume = await runMediaProcess(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-nostdin",
        "-v",
        "info",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "wav",
        "-i",
        path,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { signal },
    );
    const peak = /max_volume: ([-\d.]+) dB/.exec(volume.stderr);
    if (!peak || Number(peak[1]) < -70) throw new Error("配音输出没有可听见的声音");
    return { durationSeconds, bytes: size };
  }

  async function render(
    id: ManagedTtsProviderId,
    input: ManagedTtsInput,
    voice: LocalTtsVoice,
    context: MediaJobContext,
    signal: AbortSignal,
  ) {
    await mkdir(context.outputDir, { recursive: true });
    const nonce = randomUUID();
    const raw = join(context.workDir, `tts-${nonce}.${id === "kokoro" ? "wav" : "mp3"}`);
    const partial = join(context.outputDir, `speech-${nonce}.partial.wav`);
    const output = join(context.outputDir, `speech-${nonce}.wav`);
    let complete = false;
    try {
      await execute(
        id,
        { action: "generate", text: input.text, voiceId: voice.id, rate: input.rate, output: raw },
        context,
        signal,
      );
      await context.reportProgress({
        fraction: 0.86,
        stage: "speech",
        message: "正在统一音频格式并验证真实声音",
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
          id === "kokoro" ? "wav" : "mp3",
          "-i",
          raw,
          "-map",
          "0:a:0",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-c:a",
          "pcm_s16le",
          "-fs",
          String(1800 * 48000 * 2 + 1048576),
          partial,
        ],
        { signal },
      );
      const metadata = await inspect(partial, signal);
      if (signal.aborted) throw mediaAbortError();
      await rename(partial, output);
      complete = true;
      return { path: output, ...metadata };
    } finally {
      await Promise.all([
        rm(raw, { force: true }),
        rm(partial, { force: true }),
        ...(!complete ? [rm(output, { force: true })] : []),
      ]);
    }
  }

  async function resources(
    id: ManagedTtsProviderId,
    context: MediaJobContext,
    signal: AbortSignal,
  ) {
    if (id !== "kokoro") return;
    for (const resource of RESOURCES) {
      const target = join(directory(id), resource.name);
      const valid = async (path: string) => {
        try {
          return (
            (await stat(path)).size === resource.bytes &&
            (await digest(path, signal)) === resource.sha256
          );
        } catch (error) {
          if (signal.aborted) throw error;
          return false;
        }
      };
      if (await valid(target)) continue;
      const candidates = options.reuseKokoroDir
        ? [
            join(options.reuseKokoroDir, resource.reuse, resource.name),
            join(options.reuseKokoroDir, resource.name),
          ]
        : [];
      let reuse: string | undefined;
      for (const candidate of candidates)
        if (await valid(candidate)) {
          reuse = candidate;
          break;
        }
      if (reuse) {
        await context.reportProgress({
          fraction: 0.55,
          stage: "resources",
          message: `正在复用已校验的 ${resource.name}`,
        });
        await copyFile(reuse, target);
      } else await downloadResource(resource, target, context, signal);
    }
  }

  async function setup(
    rawId: ManagedTtsProviderId,
    context: MediaJobContext,
  ): Promise<ManagedTtsProviderStatus> {
    const id = validateManagedTtsProviderId(rawId);
    if (context.signal.aborted) throw mediaAbortError();
    const initial = await status(id);
    if (initial.state === "unavailable") throw new Error(initial.reason);
    const dir = directory(id);
    if (setupOwners.has(dir)) throw new Error("这个声音服务正在准备，请等待当前任务或取消它");
    setupOwners.add(dir);
    const deadline = AbortSignal.timeout(20 * 60_000);
    const signal = AbortSignal.any([context.signal, deadline]);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const lockPath = join(dir, "setup.lock");
    let sample: string | undefined;
    let setupFailure: Error | undefined;
    try {
      await mkdir(dir, { recursive: true });
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch {
        const existing = await jsonFile(lockPath, 4096).catch(() => null);
        let alive = false;
        if (Number.isSafeInteger(existing?.pid)) {
          try {
            process.kill(existing.pid, 0);
            alive = true;
          } catch {
            /* Old Host terminated. */
          }
        }
        if (alive) throw new Error("另一个宿主正在准备这个声音服务");
        await rm(lockPath, { force: true });
        lock = await open(lockPath, "wx", 0o600);
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      const disk = await statfs(dir);
      if (disk.bavail * disk.bsize < initial.requiredDiskBytes)
        throw new Error(
          `空间不足，至少需要 ${Math.ceil(initial.requiredDiskBytes / 1024 ** 3)} GB 可用空间`,
        );
      await checkTools(signal);
      await context.reportProgress({
        fraction: 0.02,
        stage: "setup",
        message: `准备独立 Python 环境；预计下载约 ${Math.ceil(initial.downloadBytes / 1048576)} MB，已有模型可复用`,
      });
      await writeFile(script(id), MANAGED_TTS_SCRIPT, { mode: 0o600 });
      let installed = false;
      try {
        const version = await execute(id, { action: "probe" }, context, signal);
        installed =
          version.version === (id === "kokoro" ? "0.6.1" : "7.2.8") &&
          (id !== "kokoro" || version.frontend === "0.9.4");
      } catch (error) {
        if (signal.aborted) throw error;
      }
      if (!installed) {
        const uv = options.uvPath ?? "uv";
        await runMediaProcess(
          uv,
          [
            "venv",
            "--clear",
            "--no-config",
            "--python",
            options.pythonPath ?? "3.12",
            "--no-python-downloads",
            join(dir, "venv"),
          ],
          { signal, env: isolatedEnvironment() },
        );
        await context.reportProgress({
          fraction: 0.1,
          stage: "install",
          message: "正在安装固定版本的声音客户端与依赖",
        });
        await runMediaProcess(
          uv,
          [
            "pip",
            "install",
            "--no-config",
            "--python",
            python(id),
            "--index-url",
            "https://pypi.org/simple",
            ...PACKAGES[id],
          ],
          { signal, env: isolatedEnvironment(), maxStdoutBytes: 2 * 1024 * 1024 },
        );
      }
      await resources(id, context, signal);
      await context.reportProgress({
        fraction: 0.7,
        stage: "verify",
        message: id === "kokoro" ? "验证本地模型和中文声音" : "向在线服务获取实际可用声音",
      });
      const listed = await execute(id, { action: "voices" }, context, signal);
      const voices = listed.voices as LocalTtsVoice[];
      if (!Array.isArray(voices) || !voices.length || voices.length > 2000)
        throw new Error("没有找到可使用的声音");
      const voice =
        voices.find((v) => v.id === (id === "kokoro" ? "zf_xiaobei" : "zh-CN-XiaoxiaoNeural")) ??
        voices.find((v) => v.language === "zh-CN");
      if (!voice) throw new Error("没有找到可验证的中文声音");
      const validation = await render(
        id,
        { providerId: id, text: "你好，这是视频工作台的中文声音测试。", rate: 1 },
        voice,
        context,
        signal,
      );
      sample = validation.path;
      if (signal.aborted) throw mediaAbortError();
      await atomicJson(manifestPath(id), {
        version: VERSION,
        scriptHash: SCRIPT_HASH,
        packages: PACKAGES[id],
        verifiedAt: Date.now(),
        voices,
        defaultVoiceId: voice.id,
        state: "ready",
      } satisfies Manifest);
      await rm(join(dir, "failure.json"), { force: true });
      await context.reportProgress({
        fraction: 1,
        stage: "ready",
        message: "已通过真实中文配音验证，可以使用",
      });
    } catch (error) {
      if (!lock) {
        setupFailure = error instanceof Error ? error : new Error(String(error));
        throw setupFailure;
      }
      const reason = signal.aborted
        ? context.signal.aborted
          ? "声音准备已取消，可以重新准备"
          : "声音准备超时，请检查网络和运行环境后重试"
        : id === "edge-tts"
          ? "Edge 在线声音准备失败；需要 uv、Python 3.12、FFmpeg 及可访问的在线语音服务，可选择系统声音或本地 Kokoro"
          : "Kokoro 准备失败；需要 uv、Python 3.12、FFmpeg、可用依赖与完整模型，请检查网络和空间后重试";
      await atomicJson(join(dir, "failure.json"), { reason, at: Date.now() }).catch(() => {});
      try {
        const manifest = await loadManifest(id);
        await atomicJson(manifestPath(id), { ...manifest, state: "failed", reason });
      } catch {
        /* No validated installation yet. */
      }
      setupFailure = context.signal.aborted
        ? mediaAbortError()
        : new Error(reason, { cause: error });
      throw setupFailure;
    } finally {
      setupOwners.delete(dir);
      await releaseManagedTtsSetupResources(lock, lockPath, sample, setupFailure);
    }
    return status(id);
  }

  async function generate(
    raw: ManagedTtsInput | Record<string, unknown>,
    context: MediaJobContext,
  ): Promise<ManagedTtsResult> {
    const input = validateManagedTtsInput(raw);
    const id = input.providerId;
    if (context.signal.aborted) throw mediaAbortError();
    const runtime = await status(id, context.signal);
    if (!runtime.available) throw new Error(runtime.reason ?? "请先准备并验证所选声音服务");
    const voice = runtime.voices.find((v) => v.id === (input.voiceId ?? runtime.defaultVoiceId));
    if (!voice) throw new Error("所选声音不在已验证的声音列表中，请刷新声音服务");
    const deadline = AbortSignal.timeout(10 * 60_000);
    const signal = AbortSignal.any([context.signal, deadline]);
    await checkTools(signal);
    if (id === "kokoro")
      for (const resource of RESOURCES)
        if ((await digest(join(directory(id), resource.name), signal)) !== resource.sha256) {
          const reason = "本地模型校验失败，请重新准备声音服务";
          const manifest = await loadManifest(id);
          await atomicJson(manifestPath(id), { ...manifest, state: "failed", reason });
          throw new Error(reason);
        }
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({
          version: VERSION,
          scriptHash: SCRIPT_HASH,
          packages: PACKAGES[id],
          resources: id === "kokoro" ? RESOURCES : [],
          input: { ...input, voiceId: voice.id },
        }),
      )
      .digest("hex");
    await mkdir(context.cacheDir, { recursive: true });
    const cacheWav = join(context.cacheDir, `speech-${cacheKey}.wav`);
    const cacheMeta = join(context.cacheDir, `speech-${cacheKey}.json`);
    try {
      const cached = await jsonFile(cacheMeta, 4096);
      if (cached.cacheKey !== cacheKey || (await digest(cacheWav, signal)) !== cached.sha256)
        throw new Error("Invalid speech cache");
      const metadata = await inspect(cacheWav, signal);
      await mkdir(context.outputDir, { recursive: true });
      const output = join(context.outputDir, `speech-${randomUUID()}.wav`);
      await copyFile(cacheWav, output);
      if (signal.aborted) {
        await rm(output, { force: true });
        throw mediaAbortError();
      }
      await context.reportProgress({
        fraction: 1,
        stage: "speech",
        message: "已复用相同文案、声音和语速的配音",
      });
      return {
        path: output,
        mimeType: "audio/wav",
        engine: id,
        voice,
        rate: input.rate,
        durationSeconds: metadata.durationSeconds,
        sampleRate: 48000,
        channels: 1,
        cached: true,
      };
    } catch (error) {
      if (signal.aborted) throw error;
    }
    try {
      const result = await render(id, input, voice, context, signal);
      const temporary = `${cacheWav}-${randomUUID()}.partial`;
      try {
        await copyFile(result.path, temporary);
        await rename(temporary, cacheWav);
        await atomicJson(cacheMeta, { cacheKey, sha256: await digest(cacheWav, signal) });
      } finally {
        await rm(temporary, { force: true });
      }
      await context.reportProgress({
        fraction: 1,
        stage: "speech",
        message: "配音已生成并验证，可以用于导出",
      });
      return {
        path: result.path,
        mimeType: "audio/wav",
        engine: id,
        voice,
        rate: input.rate,
        durationSeconds: result.durationSeconds,
        sampleRate: 48000,
        channels: 1,
        cached: false,
      };
    } catch (error) {
      if (context.signal.aborted) throw mediaAbortError();
      const reason =
        id === "edge-tts"
          ? "Edge 在线配音失败，服务可能不可达；请重新验证或选择本地声音"
          : "Kokoro 本地配音失败，请检查文案语言和模型资源后重试";
      if (id === "edge-tts") {
        try {
          const manifest = await loadManifest(id);
          await atomicJson(manifestPath(id), { ...manifest, state: "failed", reason });
        } catch {
          /* Concurrent setup may have replaced it. */
        }
      }
      throw new Error(reason, { cause: error });
    }
  }

  return { status, setup, generate };
}

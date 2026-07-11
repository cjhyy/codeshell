/**
 * Built-in GenerateVideo tool (TODO 7.1 块3) — text-to-video via a
 * {@link VideoProvider} adapter (submit / poll / download).
 *
 * Video generation is always slow (tens of seconds to minutes), so this tool
 * is fire-and-forget by design: it submits the job, returns a handle
 * immediately, and polls in the BACKGROUND. When the job finishes it writes
 * the file to `<cwd>/.code-shell/generated_videos/` and enqueues a completion
 * notification (same notificationQueue path as background agents / shells), so
 * the main turn is never blocked (consistent with TODO 3.2 / 4.1).
 *
 * Concrete provider adapters (Seedance / Kling) are not wired yet — their
 * private APIs need confirmed docs. Until then the only resolvable provider is
 * the test-injected fake, so in production this tool is dormant (returns a
 * "no video provider configured" message) rather than half-working.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import { notificationQueue } from "./agent-notifications.js";
import { backgroundJobRegistry, type BackgroundJobOutcome } from "./background-jobs.js";
import { logger } from "../../logging/logger.js";
import {
  getVideoProvider,
  DEFAULT_VIDEO_MODEL,
  type VideoProvider,
  type VideoProviderCreds,
} from "./video-providers.js";
import { getImageUploader, isHttpUrl, type ImageUploader, type UploaderCreds } from "./image-uploader.js";
import { effectiveApiKey } from "./generate-image.js";
import { getMergedCatalog, findCatalogEntry } from "../../model-catalog/index.js";
import { genInstancesFromConnections } from "../../model-catalog/gen-connections.js";

/** A configured videoGen instance (subset used here). */
interface VideoInstance {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  catalogId?: string;
  apiKeyRef?: string;
}

const MAX_IMAGES = 9;

export function __resolveLocalImageInputForTests(pathOrUrl: string, cwd: string): string {
  if (isHttpUrl(pathOrUrl)) return pathOrUrl;
  return isAbsolute(pathOrUrl) ? pathOrUrl : resolve(cwd, pathOrUrl);
}

/**
 * Normalize image inputs (URLs or local paths) into public URLs the provider
 * can consume. `images[]` wins over the single `image`. Local paths are
 * uploaded via the injected {@link ImageUploader}; URLs pass through. Caps at
 * {@link MAX_IMAGES} (fal reference-to-video allows up to 9).
 */
export async function __normalizeImagesForTests(
  images: string[] | undefined,
  image: string | undefined,
  uploader: ImageUploader,
  creds: UploaderCreds,
  signal?: AbortSignal,
): Promise<{ ok: true; urls: string[] } | { ok: false; error: string }> {
  const raw = images && images.length ? images : image ? [image] : [];
  if (raw.length > MAX_IMAGES) {
    return { ok: false, error: `too many images: ${raw.length} (max ${MAX_IMAGES})` };
  }
  const urls: string[] = [];
  for (const item of raw) {
    const r = await uploader.toUrl(item, creds, signal);
    if (!r.ok) return { ok: false, error: r.error };
    urls.push(r.url);
  }
  return { ok: true, urls };
}

/** Video provider `kind`s that have an adapter, in resolution preference. */
const VIDEO_PROVIDER_KINDS: string[] = ["fal"];

const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Safety cap so a stuck job's background loop can't poll forever. */
const DEFAULT_MAX_POLL_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
let maxPollMs = DEFAULT_MAX_POLL_MS;
let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;

export function __setVideoPollingLimitsForTests(
  limits: { maxPollMs: number; requestTimeoutMs: number } | null,
): void {
  maxPollMs = limits?.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  requestTimeoutMs = limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

export const generateVideoToolDef: ToolDefinition = {
  name: "GenerateVideo",
  description:
    "Generate a video from a text prompt. The job runs in the background (video generation is " +
    "slow); you are notified automatically when it finishes, and the .mp4 is saved into the " +
    "workspace. Do NOT sleep or poll — continue with other work. Requires a configured video " +
    "provider.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Description of the video to generate" },
      provider: {
        type: "string",
        description: "Video provider kind to use. Defaults to the first configured video provider.",
      },
      model: { type: "string", description: "Video model id. Defaults to the provider's default." },
      image: { type: "string", description: "Image URL (http/https) for image-to-video. When set, an image-to-video model is used." },
      images: {
        type: "array",
        items: { type: "string" },
        description: "Image URLs or local file paths for image/reference-to-video. 1 image → image-to-video; 2+ → reference-to-video (max 9). Local paths are auto-uploaded. Refer to them in prompt as @Image1, @Image2.",
      },
      videos: {
        type: "array",
        items: { type: "string" },
        description: "Reference/continuation video URLs (http/https only — NOT local paths) for video extension. Forces reference-to-video (Seedance model required). Up to 3. Refer to them in prompt as @Video1, @Video2 (e.g. \"continue from @Video1\").",
      },
    },
    required: ["prompt"],
  },
};

// Test seam: inject a VideoProvider so the background poll loop can be tested
// end-to-end without a real adapter or network. Null → normal resolution.
let injectedProvider: VideoProvider | null = null;
export function __setVideoProviderForTests(p: VideoProvider | null): void {
  injectedProvider = p;
  availCache.clear();
}

/**
 * Tool-visibility guard: GenerateVideo is hidden until a video provider is
 * actually configured. With no real adapters wired yet (VIDEO_PROVIDER_KINDS
 * is empty), this returns false in production so the model never sees a tool
 * it can't use — the tool becomes visible automatically once an adapter +
 * matching settings provider exist. Short TTL cache like GenerateImage.
 */
const availCache = new Map<string, { at: number; value: boolean }>();
const AVAIL_TTL_MS = 1000;
export function isGenerateVideoAvailable(
  cwd: string = process.cwd(),
  nowMs: number = Date.now(),
): boolean {
  if (injectedProvider) return true;
  const hit = availCache.get(cwd);
  if (hit && nowMs - hit.at < AVAIL_TTL_MS) return hit.value;
  let value = false;
  try {
    value = resolveVideoProvider(cwd) !== null;
  } catch {
    value = false;
  }
  availCache.set(cwd, { at: nowMs, value });
  return value;
}

/**
 * List configured, usable video providers (TODO 7.1). Returns [] when no
 * adapters are wired (VIDEO_PROVIDER_KINDS empty) or none configured.
 */
export function listConfiguredVideoProviders(
  cwd: string = process.cwd(),
): Array<{ id?: string; kind: string; catalogId?: string }> {
  try {
    const settings = new SettingsManager(cwd, "full").get();
    // Canonical videoGen.providers[] first (TODO 7.1) — but only kinds that
    // have a wired adapter (VIDEO_PROVIDER_KINDS); a configured-but-unadapted
    // entry isn't usable yet.
    const videoGen = (settings as { videoGen?: { providers?: VideoInstance[] } }).videoGen;
    if (videoGen?.providers?.length) {
      const list = videoGen.providers;
      return list
        .filter((p) => !!effectiveApiKey(p, list) && getVideoProvider(p.kind) !== null)
        .map((p) => ({ id: p.id, kind: p.kind, catalogId: p.catalogId }));
    }
    // Legacy LLM providers[] back-compat (field dropped from schema; read via
    // .passthrough() with an inline cast).
    const legacyProviders =
      (settings as { providers?: Array<{ kind: string; apiKey?: string }> }).providers ?? [];
    return legacyProviders
      .filter((p) => p.apiKey && VIDEO_PROVIDER_KINDS.includes(p.kind))
      .map((p) => ({ kind: p.kind }));
  } catch {
    return [];
  }
}

/** Dynamic GenerateVideo description naming configured providers (TODO 7.1). */
export function generateVideoToolDefFor(cwd: string): ToolDefinition {
  const providers = listConfiguredVideoProviders(cwd);
  if (providers.length === 0) return generateVideoToolDef;
  const names = providers.map((p) => p.id ?? p.kind).join(", ");
  const catalog = getMergedCatalog();
  const paramLines = providers
    .map((p) => {
      const entry = findCatalogEntry(catalog, p.catalogId, p.kind);
      return entry?.paramsDoc ? `  - ${p.id ?? p.kind}: ${entry.paramsDoc}` : null;
    })
    .filter((x): x is string => x !== null);
  const paramsBlock = paramLines.length ? `\nParams per provider:\n${paramLines.join("\n")}` : "";
  return {
    ...generateVideoToolDef,
    description:
      generateVideoToolDef.description +
      ` Configured provider(s): ${names}. Pass \`provider\` to pick one.` +
      paramsBlock,
  };
}

interface ResolvedVideoProvider {
  kind: string;
  creds: VideoProviderCreds;
  defaultModel?: string;
}

function resolveVideoProvider(cwd: string, preferKind?: string): ResolvedVideoProvider | null {
  const settings = new SettingsManager(cwd, "full").get();

  // 0. Unified store (统一模型接入方案): modelConnections (tag=video) +
  // credentials, taking precedence over legacy videoGen.providers[].
  const conns = (settings as { modelConnections?: { tag?: string }[] }).modelConnections;
  const creds = (settings as { credentials?: unknown[] }).credentials;
  if (Array.isArray(conns) && conns.some((c) => c.tag === "video")) {
    const list = genInstancesFromConnections(
      conns as never[],
      (Array.isArray(creds) ? creds : []) as never[],
      getMergedCatalog(),
      "video",
    ) as unknown as VideoInstance[];
    const def = (settings as { defaults?: { video?: string } }).defaults?.video;
    const usable = (p: VideoInstance): boolean => !!p.apiKey && getVideoProvider(p.kind) !== null;
    const credsOf = (p: VideoInstance): VideoProviderCreds => ({ baseUrl: p.baseUrl, apiKey: p.apiKey! });
    if (preferKind) {
      const chosen = list.find((p) => (p.id === preferKind || p.kind === preferKind) && usable(p));
      if (chosen) return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
      return null;
    }
    const preferred = def ? list.find((p) => p.id === def) : undefined;
    const chosen = (preferred && usable(preferred) ? preferred : undefined) ?? list.find(usable);
    if (chosen) return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
    if (def || preferKind) return null;
  }

  const videoGen = (settings as { videoGen?: { defaultProvider?: string; providers?: VideoInstance[] } }).videoGen;
  if (videoGen?.providers?.length) {
    const list = videoGen.providers;
    const usable = (p: VideoInstance): boolean =>
      !!effectiveApiKey(p, list) && getVideoProvider(p.kind) !== null;
    const credsOf = (p: VideoInstance): VideoProviderCreds => ({ baseUrl: p.baseUrl, apiKey: effectiveApiKey(p, list)! });
    if (preferKind) {
      const chosen = list.find((p) => (p.id === preferKind || p.kind === preferKind) && usable(p));
      if (chosen) return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
      return null;
    }
    const preferred = videoGen.defaultProvider
      ? list.find((p) => p.id === videoGen.defaultProvider)
      : undefined;
    const chosen = (preferred && usable(preferred) ? preferred : undefined) ?? list.find(usable);
    if (chosen) return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
    return null;
  }
  // Back-compat: scan legacy LLM providers[] for a video-capable kind. The
  // field was dropped from the schema; un-migrated settings.json still carry it
  // via .passthrough(), so read it through an inline cast.
  const legacyProviders =
    (settings as { providers?: Array<{ kind: string; baseUrl: string; apiKey?: string }> }).providers ?? [];
  const kinds = preferKind ? [preferKind] : VIDEO_PROVIDER_KINDS;
  for (const kind of kinds) {
    const provider = legacyProviders.find((p) => p.kind === kind);
    if (provider && provider.apiKey) {
      return { kind, creds: { baseUrl: provider.baseUrl, apiKey: provider.apiKey } };
    }
  }
  return null;
}

export function __resolveVideoProviderForTests(cwd: string, preferKind?: string): ResolvedVideoProvider | null {
  return resolveVideoProvider(cwd, preferKind);
}

export async function generateVideoTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const prompt = args.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return "Error: prompt is required";
  }
  const cwd = ctx?.cwd ?? process.cwd();
  const sessionId = ctx?.sessionId;
  const preferKind = typeof args.provider === "string" && args.provider ? args.provider : undefined;
  const overrideModel = typeof args.model === "string" && args.model ? args.model : undefined;
  const image = typeof args.image === "string" && args.image
    ? __resolveLocalImageInputForTests(args.image, cwd)
    : undefined;
  const imagesArg = Array.isArray(args.images)
    ? (args.images as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((x) => __resolveLocalImageInputForTests(x, cwd))
    : undefined;
  // videos pass through verbatim to fal's video_urls (no upload) — http(s) only.
  const videosArg = Array.isArray(args.videos)
    ? (args.videos as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  const pollIntervalMs =
    typeof args.pollIntervalMs === "number" && args.pollIntervalMs > 0
      ? args.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;

  // Resolve the provider + adapter. The test seam wins so the background loop
  // is exercised without a real adapter.
  let kind: string;
  let creds: VideoProviderCreds;
  let adapter: VideoProvider;
  let defaultModel: string | undefined;
  if (injectedProvider) {
    adapter = injectedProvider;
    kind = injectedProvider.kind;
    creds = { baseUrl: "test", apiKey: "test" };
  } else {
    const resolved = resolveVideoProvider(cwd, preferKind);
    if (!resolved) {
      return preferKind
        ? `Error: no video provider of kind "${preferKind}" available. Configure it (with an apiKey) in settings.`
        : "Error: no video provider available. Video generation requires a configured video provider (none are wired yet).";
    }
    const a = getVideoProvider(resolved.kind);
    if (!a) return `Error: video generation is not supported for provider kind "${resolved.kind}".`;
    adapter = a;
    kind = resolved.kind;
    creds = resolved.creds;
    defaultModel = resolved.defaultModel;
  }

  const model = overrideModel ?? defaultModel ?? DEFAULT_VIDEO_MODEL[kind] ?? kind;

  // Normalize image inputs (local paths → uploaded URLs) before submit. The
  // provider only ever receives URLs and routes t2v/i2v/ref2v by count.
  const uploader = getImageUploader(kind) ?? getImageUploader("fal")!;
  const norm = await __normalizeImagesForTests(imagesArg, image, uploader, { baseUrl: creds.baseUrl, apiKey: creds.apiKey }, ctx?.signal);
  if (!norm.ok) return `Error: ${norm.error}`;

  const submit = await adapter.submit({ prompt, model, image: undefined, images: norm.urls, videos: videosArg, creds, signal: ctx?.signal });
  if (!submit.ok) {
    return `Error submitting video job: ${submit.error}`;
  }
  const jobId = submit.jobId;

  // Background poll → download → write → notify. Fire-and-forget: never await.
  // Register the job so it shows up in the goal judge's background-task list
  // (so the judge can tell "waiting on a finite render" from "nothing left to
  // do" — the s-mqe0ox7n-a8d11c26 busy-loop bug). The video does NOT park the
  // engine anymore; its completion notification wakes the idle session (server
  // maybeWakeIdleSession). The registry is keyed by the fal jobId namespaced so
  // two providers can't collide.
  const jobKey = `video-${jobId}`;
  const promptPreview = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  const controller = new AbortController();
  let abortKind: "cancelled" | "timeout" | undefined;
  const abortTask = (kind: "cancelled" | "timeout"): void => {
    if (controller.signal.aborted) return;
    abortKind = kind;
    controller.abort();
  };
  const onTurnAbort = (): void => abortTask("cancelled");
  if (ctx?.signal?.aborted) onTurnAbort();
  else ctx?.signal?.addEventListener("abort", onTurnAbort, { once: true });
  const totalTimer = setTimeout(() => abortTask("timeout"), maxPollMs);
  const polling = pollToCompletion(
    adapter,
    jobId,
    creds,
    cwd,
    sessionId,
    prompt,
    pollIntervalMs,
    controller.signal,
    () => abortKind,
    maxPollMs,
    requestTimeoutMs,
  );
  backgroundJobRegistry.start(jobKey, sessionId ?? "", `生成视频中:${promptPreview}`, {
    kind: "video",
    abort: async () => {
      abortTask("cancelled");
      return await polling;
    },
  });
  void polling
    .then((outcome) => backgroundJobRegistry.finish(jobKey, outcome))
    .catch((err) =>
      backgroundJobRegistry.finish(jobKey, { status: "failed", finalText: (err as Error).message }),
    )
    .finally(() => {
      clearTimeout(totalTimer);
      ctx?.signal?.removeEventListener("abort", onTurnAbort);
    });

  return [
    `Video generation started in the background.`,
    `job_id: ${jobId} (internal — do not show to user)`,
    `prompt: ${prompt}`,
    ``,
    `It will be saved into .code-shell/generated_videos/ and you'll be notified automatically when it finishes.`,
    `If you have no other work right now, END YOUR TURN — the system wakes you when the video is ready. NEVER run \`sleep\` or poll the provider yourself.`,
  ].join("\n");
}

async function pollToCompletion(
  adapter: VideoProvider,
  jobId: string,
  creds: VideoProviderCreds,
  cwd: string,
  sessionId: string | undefined,
  prompt: string,
  pollIntervalMs: number,
  signal: AbortSignal,
  getAbortKind: () => "cancelled" | "timeout" | undefined,
  totalTimeoutMs: number,
  perRequestTimeoutMs: number,
): Promise<BackgroundJobOutcome> {
  let knownVideoUrl: string | undefined;

  const abortOutcome = (): BackgroundJobOutcome => {
    if (knownVideoUrl) {
      const msg = `Video rendered successfully, but the local download stopped. Download it from ${knownVideoUrl}`;
      notifyVideo(sessionId, "completed", prompt, undefined, undefined, knownVideoUrl);
      return { status: "completed", finalText: msg };
    }
    if (getAbortKind() === "timeout") {
      const msg = `video job ${jobId} timed out after ${Math.round(totalTimeoutMs / 1000)}s`;
      notifyVideo(sessionId, "failed", prompt, undefined, msg);
      return { status: "failed", finalText: msg };
    }
    const msg = "Local waiting stopped; the remote service may still be rendering the video.";
    notifyVideo(sessionId, "cancelled", prompt, undefined, msg);
    return { status: "cancelled", finalText: msg };
  };

  try {
    for (;;) {
      if (signal.aborted) return abortOutcome();
      const res = await runVideoRequest(
        (requestSignal) => adapter.poll({ jobId, creds, signal: requestSignal }),
        signal,
        perRequestTimeoutMs,
      );
      if (signal.aborted) return abortOutcome();
      if (!res.ok) {
        notifyVideo(sessionId, "failed", prompt, undefined, res.error);
        return { status: "failed", finalText: res.error };
      }
      if (res.status === "failed") {
        notifyVideo(sessionId, "failed", prompt, undefined, res.error);
        return { status: "failed", finalText: res.error };
      }
      if (res.status === "succeeded") {
        knownVideoUrl = res.url;
        break;
      }
      await abortableDelay(pollIntervalMs, signal);
    }

    const dl = await runVideoRequest(
      (requestSignal) =>
        adapter.download({
          jobId,
          creds,
          signal: requestSignal,
          onUrl: (url) => {
            knownVideoUrl = url;
          },
        }),
      signal,
      perRequestTimeoutMs,
    );
    if (signal.aborted) return abortOutcome();
    if (!dl.ok) {
      notifyVideo(sessionId, "failed", prompt, undefined, dl.error);
      return { status: "failed", finalText: dl.error };
    }
    knownVideoUrl = dl.url ?? knownVideoUrl;
    const dir = join(cwd, ".code-shell", "generated_videos");
    await mkdir(dir, { recursive: true });
    if (signal.aborted) return abortOutcome();
    const path = join(dir, `${Date.now()}.${dl.ext || "mp4"}`);
    await writeFile(path, dl.bytes, { signal });
    notifyVideo(sessionId, "completed", prompt, path, undefined, knownVideoUrl);
    return { status: "completed", finalText: path };
  } catch (err) {
    if (signal.aborted) return abortOutcome();
    notifyVideo(sessionId, "failed", prompt, undefined, (err as Error).message);
    return { status: "failed", finalText: (err as Error).message };
  }
}

async function runVideoRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  taskSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const requestSignal = AbortSignal.any([taskSignal, AbortSignal.timeout(timeoutMs)]);
  const promise = request(requestSignal);
  if (requestSignal.aborted) throw requestSignal.reason;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(requestSignal.reason);
    const cleanup = (): void => requestSignal.removeEventListener("abort", onAbort);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function notifyVideo(
  sessionId: string | undefined,
  status: "completed" | "failed" | "cancelled",
  prompt: string,
  path?: string,
  error?: string,
  url?: string,
): void {
  if (!sessionId) {
    logger.warn("video_completion_without_session", { status });
    return;
  }
  // Include the fal-hosted URL on success so the model can pass it to a follow-up
  // GenerateVideo `videos:[url]` to extend this clip (no re-upload). Expiring URL.
  const extendHint = url
    ? ` To extend this video, call GenerateVideo again with videos:["${url}"] (Seedance model). URL may expire.`
    : "";
  notificationQueue.enqueue(
    {
      agentId: `video-${Date.now()}`,
      name: "video generation",
      description:
        status === "completed"
          ? path
            ? `Video generated: ${path} (prompt: ${prompt})`
            : `Video rendered: ${url} (local download stopped; prompt: ${prompt})`
          : status === "cancelled"
            ? `Stopped waiting for video generation (prompt: ${prompt})`
            : `Video generation failed (prompt: ${prompt})`,
      status,
      finalText:
        status === "completed"
          ? path
            ? `Video saved to ${path}.${extendHint}`
            : `Video rendered successfully. Download it from ${url}.${extendHint}`
          : undefined,
      error: status === "failed" || status === "cancelled" ? error : undefined,
      enqueuedAt: Date.now(),
    },
    sessionId,
  );
}

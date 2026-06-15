/**
 * VideoProvider — adapter interface for text-to-video generation (TODO 7.1).
 *
 * Unlike images (one request → bytes), video generation is asynchronous and
 * long: SUBMIT a job → POLL its status until it finishes → DOWNLOAD the bytes.
 * The interface captures exactly those three steps so the GenerateVideo tool's
 * background polling loop is provider-agnostic, and concrete adapters
 * (Seedance/Kling — filled in once their private API docs are available) only
 * implement submit/poll/download.
 *
 * Credentials are resolved by the tool layer from settings; adapters are pure
 * "creds + request → job lifecycle". `fetch` is injected for testability.
 */

export interface VideoProviderCreds {
  baseUrl: string;
  apiKey: string;
}

export interface VideoSubmitRequest {
  prompt: string;
  model: string;
  creds: VideoProviderCreds;
  /** Single image URL (http/https) — image-to-video. Back-compat. */
  image?: string;
  /** Multiple image URLs — ≥2 triggers reference-to-video. Takes precedence over `image`. */
  images?: string[];
  /** Reference/continuation video URLs (http/https) — passed through to fal's `video_urls`. Reference them in the prompt as @Video1/@Video2. Forces reference-to-video. */
  videos?: string[];
  signal?: AbortSignal;
}

export type VideoSubmitResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

export type VideoPollResult =
  | { ok: true; status: "running" }
  | { ok: true; status: "succeeded" }
  | { ok: true; status: "failed"; error: string }
  | { ok: false; error: string };

export type VideoDownloadResult =
  | { ok: true; bytes: Uint8Array; ext: string; url?: string }
  | { ok: false; error: string };

export interface VideoProvider {
  readonly kind: string;
  submit(req: VideoSubmitRequest): Promise<VideoSubmitResult>;
  poll(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult>;
  download(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoDownloadResult>;
}

/**
 * Deterministic in-memory adapter for tests and local dev — no network. Models
 * the three-step lifecycle: submit mints a job; poll returns `running` for the
 * first N calls then `succeeded` (or `failed` after M); download returns the
 * configured bytes. Lets the GenerateVideo background loop be tested end-to-end
 * before any real (Seedance/Kling) adapter exists.
 */
export class FakeVideoProvider implements VideoProvider {
  readonly kind = "fake";
  private polls = new Map<string, number>();
  private counter = 0;
  constructor(
    private readonly opts: {
      succeedAfterPolls?: number;
      failAfterPolls?: number;
      failMessage?: string;
      bytes?: string;
    } = {},
  ) {}

  async submit(_req: VideoSubmitRequest): Promise<VideoSubmitResult> {
    this.counter += 1;
    const jobId = `fakejob-${this.counter}`;
    this.polls.set(jobId, 0);
    return { ok: true, jobId };
  }

  async poll(req: { jobId: string; creds?: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult> {
    const n = this.polls.get(req.jobId) ?? 0;
    this.polls.set(req.jobId, n + 1);
    if (this.opts.failAfterPolls !== undefined && n >= this.opts.failAfterPolls) {
      return { ok: true, status: "failed", error: this.opts.failMessage ?? "job failed" };
    }
    if (this.opts.succeedAfterPolls !== undefined && n >= this.opts.succeedAfterPolls) {
      return { ok: true, status: "succeeded" };
    }
    return { ok: true, status: "running" };
  }

  async download(_req: { jobId: string; creds?: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoDownloadResult> {
    return { ok: true, bytes: Buffer.from(this.opts.bytes ?? "FAKE_VIDEO"), ext: "mp4" };
  }
}

/**
 * fal.ai video adapter — submit/poll/download against the fal queue API
 * (https://queue.fal.run). model id selects the underlying model
 * (e.g. fal-ai/kling-video/v3/pro/text-to-video). When `image` is present we
 * switch a `...text-to-video` model to `...image-to-video` and send image_url,
 * so callers only need to pass an image to get i2v.
 *
 * IMPORTANT: fal's status/result URLs use a model-FAMILY prefix
 * (`fal-ai/kling-video/requests/<id>`), NOT the full submit path
 * (`.../v3/pro/text-to-video/requests/<id>` → HTTP 405). So we never
 * reconstruct those URLs; we encode the `status_url` + `response_url` that
 * submit returns into the jobId (`<status_url>|<response_url>`) and use them
 * verbatim in poll/download. Verified against the live API 2026-06-10.
 */
export class FalVideoProvider implements VideoProvider {
  readonly kind = "fal";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Effective image list: images[] wins; else single image; else []. */
  private imageList(req: VideoSubmitRequest): string[] {
    if (req.images && req.images.length) return req.images;
    if (req.image) return [req.image];
    return [];
  }

  /**
   * Does this model family support reference-to-video (multi-image)? Verified
   * 2026-06-10 against the live API: Seedance has it; Kling does NOT (routing a
   * Kling model to `.../reference-to-video` 404s at result fetch). Keep this a
   * conservative allowlist — only families confirmed to expose the endpoint.
   */
  private supportsReference(model: string): boolean {
    return /seedance/i.test(model);
  }

  /** Route model suffix by image count: 0→text, 1→image, ≥2→reference. */
  private resolveModel(model: string, imageCount: number): string {
    const target = imageCount >= 2 ? "reference-to-video" : imageCount === 1 ? "image-to-video" : null;
    if (target && /(text|image|reference)-to-video$/.test(model)) {
      return model.replace(/(text|image|reference)-to-video$/, target);
    }
    return model;
  }

  /** jobId = `${statusUrl}|${responseUrl}` (fal returns both from submit). */
  private split(jobId: string): { statusUrl: string; responseUrl: string } {
    const idx = jobId.indexOf("|");
    if (idx < 0) return { statusUrl: jobId, responseUrl: jobId };
    return { statusUrl: jobId.slice(0, idx), responseUrl: jobId.slice(idx + 1) };
  }

  async submit(req: VideoSubmitRequest): Promise<VideoSubmitResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const imgs = this.imageList(req);
    const vids = req.videos ?? [];
    // Multi-image OR any reference video needs the reference-to-video endpoint,
    // which only some families (Seedance) expose. Routing e.g. Kling there
    // 404s at result fetch — fail fast with a clear message instead.
    const needsReference = imgs.length >= 2 || vids.length > 0;
    if (needsReference && !this.supportsReference(req.model)) {
      return {
        ok: false,
        error: `model "${req.model}" does not support reference-to-video (multiple images or reference videos). Use a Seedance model, or pass a single image / no video.`,
      };
    }
    // imageCount alone can't express "reference needed"; bump to 2 when a video
    // forces the reference endpoint so resolveModel picks reference-to-video.
    const refImageCount = needsReference ? Math.max(imgs.length, 2) : imgs.length;
    const model = this.resolveModel(req.model, refImageCount);
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (imgs.length >= 2) body.image_urls = imgs;
    else if (imgs.length === 1) body.image_url = imgs[0];
    if (vids.length > 0) body.video_urls = vids;
    try {
      const r = await this.fetchImpl(`${base}/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${req.creds.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `fal submit failed: HTTP ${r.status} ${t}`.trim() };
      }
      const j = (await r.json()) as { request_id?: string; status_url?: string; response_url?: string };
      if (!j.request_id) return { ok: false, error: "fal submit: no request_id in response" };
      // Prefer the URLs fal hands back; fall back to family-prefix reconstruction
      // only if they're absent (defensive — live API always returns them).
      const statusUrl = j.status_url ?? "";
      const responseUrl = j.response_url ?? "";
      if (!statusUrl || !responseUrl) {
        return { ok: false, error: "fal submit: missing status_url/response_url" };
      }
      return { ok: true, jobId: `${statusUrl}|${responseUrl}` };
    } catch (err) {
      return { ok: false, error: `fal submit error: ${(err as Error).message}` };
    }
  }

  async poll(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult> {
    const { statusUrl } = this.split(req.jobId);
    try {
      const r = await this.fetchImpl(statusUrl, {
        method: "GET",
        headers: { Authorization: `Key ${req.creds.apiKey}` },
        signal: req.signal,
      });
      // fal returns 200/202 for valid in-progress/queued states; only treat a
      // hard client/server error (4xx except 202, 5xx) as a transport failure.
      if (!r.ok && r.status !== 202) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `fal status failed: HTTP ${r.status} ${t}`.trim() };
      }
      const j = (await r.json()) as { status?: string; error?: unknown };
      switch (j.status) {
        case "IN_QUEUE":
        case "IN_PROGRESS":
          return { ok: true, status: "running" };
        case "COMPLETED":
          return { ok: true, status: "succeeded" };
        default:
          return { ok: true, status: "failed", error: `fal status: ${j.status ?? "unknown"}` };
      }
    } catch (err) {
      return { ok: false, error: `fal poll error: ${(err as Error).message}` };
    }
  }

  async download(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoDownloadResult> {
    const { responseUrl } = this.split(req.jobId);
    try {
      // hop 1: result JSON
      const r = await this.fetchImpl(responseUrl, {
        method: "GET",
        headers: { Authorization: `Key ${req.creds.apiKey}` },
        signal: req.signal,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return { ok: false, error: `fal result failed: HTTP ${r.status} ${t}`.trim() };
      }
      const j = (await r.json()) as { video?: { url?: string } };
      const videoUrl = j.video?.url;
      if (!videoUrl) return { ok: false, error: "fal result: no video.url" };

      // hop 2: video bytes
      const vr = await this.fetchImpl(videoUrl, { method: "GET", signal: req.signal });
      if (!vr.ok) {
        return { ok: false, error: `fal video download failed: HTTP ${vr.status}` };
      }
      const buf = new Uint8Array(await vr.arrayBuffer());
      const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(videoUrl);
      const ext = m ? m[1].toLowerCase() : "mp4";
      // Surface the fal-hosted URL so the model can reuse it for video extension
      // (videos[] → video_urls) without re-uploading. Note: signed/expiring.
      return { ok: true, bytes: buf, ext, url: videoUrl };
    } catch (err) {
      return { ok: false, error: `fal download error: ${(err as Error).message}` };
    }
  }
}

/** Default model per video provider kind (filled in with real adapters). */
export const DEFAULT_VIDEO_MODEL: Record<string, string> = {
  fal: "fal-ai/kling-video/v3/pro/text-to-video",
};

/**
 * Registry of video-provider adapters, keyed by `kind`. Only `fake` exists
 * today (test/dev). Real adapters (seedance, kling) are intentionally absent
 * until their private API contracts are confirmed — see TODO 7.1 块3.
 */
export function getVideoProvider(kind: string, fetchImpl: typeof fetch = fetch): VideoProvider | null {
  switch (kind) {
    case "fake":
      return new FakeVideoProvider({ succeedAfterPolls: 0 });
    case "fal":
      return new FalVideoProvider(fetchImpl);
    default:
      return null;
  }
}

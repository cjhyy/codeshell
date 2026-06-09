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
  /** Optional image URL (http/https). When present, triggers image-to-video. */
  image?: string;
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
  | { ok: true; bytes: Uint8Array; ext: string }
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
 * so callers only need to pass an image to get i2v. jobId encodes
 * `${model}::${request_id}` since poll/download need the model to build URLs.
 */
export class FalVideoProvider implements VideoProvider {
  readonly kind = "fal";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private resolveModel(model: string, image?: string): string {
    if (image && /text-to-video$/.test(model)) {
      return model.replace(/text-to-video$/, "image-to-video");
    }
    return model;
  }

  private split(jobId: string): { model: string; requestId: string } {
    const idx = jobId.indexOf("::");
    if (idx < 0) return { model: jobId, requestId: "" };
    return { model: jobId.slice(0, idx), requestId: jobId.slice(idx + 2) };
  }

  async submit(req: VideoSubmitRequest): Promise<VideoSubmitResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const model = this.resolveModel(req.model, req.image);
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (req.image) body.image_url = req.image;
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
      const j = (await r.json()) as { request_id?: string };
      if (!j.request_id) return { ok: false, error: "fal submit: no request_id in response" };
      return { ok: true, jobId: `${model}::${j.request_id}` };
    } catch (err) {
      return { ok: false, error: `fal submit error: ${(err as Error).message}` };
    }
  }

  async poll(req: { jobId: string; creds: VideoProviderCreds; signal?: AbortSignal }): Promise<VideoPollResult> {
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const { model, requestId } = this.split(req.jobId);
    try {
      const r = await this.fetchImpl(`${base}/${model}/requests/${requestId}/status`, {
        method: "GET",
        headers: { Authorization: `Key ${req.creds.apiKey}` },
        signal: req.signal,
      });
      if (!r.ok) {
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
    const base = req.creds.baseUrl.replace(/\/+$/, "");
    const { model, requestId } = this.split(req.jobId);
    try {
      // hop 1: result JSON
      const r = await this.fetchImpl(`${base}/${model}/requests/${requestId}/`, {
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
      return { ok: true, bytes: buf, ext };
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

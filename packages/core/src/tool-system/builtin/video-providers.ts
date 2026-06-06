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

/** Default model per video provider kind (filled in with real adapters). */
export const DEFAULT_VIDEO_MODEL: Record<string, string> = {
  // seedance / kling defaults go here once their adapters land.
};

/**
 * Registry of video-provider adapters, keyed by `kind`. Only `fake` exists
 * today (test/dev). Real adapters (seedance, kling) are intentionally absent
 * until their private API contracts are confirmed — see TODO 7.1 块3.
 */
export function getVideoProvider(kind: string, _fetchImpl: typeof fetch = fetch): VideoProvider | null {
  switch (kind) {
    case "fake":
      return new FakeVideoProvider({ succeedAfterPolls: 0 });
    default:
      return null;
  }
}

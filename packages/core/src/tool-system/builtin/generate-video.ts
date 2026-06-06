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
import { join } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import { notificationQueue } from "./agent-notifications.js";
import { logger } from "../../logging/logger.js";
import {
  getVideoProvider,
  DEFAULT_VIDEO_MODEL,
  type VideoProvider,
  type VideoProviderCreds,
} from "./video-providers.js";

/** Video provider `kind`s that have an adapter, in resolution preference.
 *  Empty until Seedance/Kling adapters land — see video-providers.ts. */
const VIDEO_PROVIDER_KINDS: string[] = [];

const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Safety cap so a stuck job's background loop can't poll forever. */
const MAX_POLL_MS = 15 * 60 * 1000;

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
    },
    required: ["prompt"],
  },
};

// Test seam: inject a VideoProvider so the background poll loop can be tested
// end-to-end without a real adapter or network. Null → normal resolution.
let injectedProvider: VideoProvider | null = null;
export function __setVideoProviderForTests(p: VideoProvider | null): void {
  injectedProvider = p;
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

interface ResolvedVideoProvider {
  kind: string;
  creds: VideoProviderCreds;
}

function resolveVideoProvider(cwd: string, preferKind?: string): ResolvedVideoProvider | null {
  const settings = new SettingsManager(cwd, "full").get();
  const kinds = preferKind ? [preferKind] : VIDEO_PROVIDER_KINDS;
  for (const kind of kinds) {
    const provider = settings.providers.find((p) => p.kind === kind);
    if (provider && provider.apiKey) {
      return { kind, creds: { baseUrl: provider.baseUrl, apiKey: provider.apiKey } };
    }
  }
  return null;
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
  const pollIntervalMs =
    typeof args.pollIntervalMs === "number" && args.pollIntervalMs > 0
      ? args.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;

  // Resolve the provider + adapter. The test seam wins so the background loop
  // is exercised without a real adapter.
  let kind: string;
  let creds: VideoProviderCreds;
  let adapter: VideoProvider;
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
  }

  const model = overrideModel ?? DEFAULT_VIDEO_MODEL[kind] ?? kind;

  const submit = await adapter.submit({ prompt, model, creds, signal: ctx?.signal });
  if (!submit.ok) {
    return `Error submitting video job: ${submit.error}`;
  }
  const jobId = submit.jobId;

  // Background poll → download → write → notify. Fire-and-forget: never await.
  void pollToCompletion(adapter, jobId, creds, cwd, sessionId, prompt, pollIntervalMs);

  return [
    `Video generation started in the background.`,
    `job_id: ${jobId} (internal — do not show to user)`,
    `prompt: ${prompt}`,
    ``,
    `It will be saved into .code-shell/generated_videos/ and you'll be notified automatically when it finishes. Do not sleep or poll.`,
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
): Promise<void> {
  const started = Date.now();
  try {
    for (;;) {
      if (Date.now() - started > MAX_POLL_MS) {
        notifyVideo(sessionId, "failed", prompt, undefined, `video job ${jobId} timed out after ${Math.round(MAX_POLL_MS / 1000)}s`);
        return;
      }
      const res = await adapter.poll({ jobId, creds });
      if (!res.ok) {
        notifyVideo(sessionId, "failed", prompt, undefined, res.error);
        return;
      }
      if (res.status === "failed") {
        notifyVideo(sessionId, "failed", prompt, undefined, res.error);
        return;
      }
      if (res.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const dl = await adapter.download({ jobId, creds });
    if (!dl.ok) {
      notifyVideo(sessionId, "failed", prompt, undefined, dl.error);
      return;
    }
    const dir = join(cwd, ".code-shell", "generated_videos");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}.${dl.ext || "mp4"}`);
    await writeFile(path, dl.bytes);
    notifyVideo(sessionId, "completed", prompt, path);
  } catch (err) {
    notifyVideo(sessionId, "failed", prompt, undefined, (err as Error).message);
  }
}

function notifyVideo(
  sessionId: string | undefined,
  status: "completed" | "failed",
  prompt: string,
  path?: string,
  error?: string,
): void {
  if (!sessionId) {
    logger.warn("video_completion_without_session", { status });
    return;
  }
  notificationQueue.enqueue(
    {
      agentId: `video-${Date.now()}`,
      name: "video generation",
      description:
        status === "completed"
          ? `Video generated: ${path} (prompt: ${prompt})`
          : `Video generation failed (prompt: ${prompt})`,
      status,
      finalText: status === "completed" ? `Video saved to ${path}` : undefined,
      error: status === "failed" ? error : undefined,
      enqueuedAt: Date.now(),
    },
    sessionId,
  );
}

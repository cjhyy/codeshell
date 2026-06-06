/**
 * Image-gen provider probe — verifies that an image provider's
 * key/baseUrl/model actually generate an image, so the desktop 连接 UI can say
 * more than "saved". Mirrors search-probe-service.ts. Reuses the core
 * ImageProvider adapters (the SAME code path GenerateImage uses) via a real
 * generation call with a tiny prompt + short timeout.
 *
 * Returns a small base64 preview on success so the UI can show the generated
 * thumbnail — proof the whole pipeline works, not just "no error".
 */

import { getImageProvider, DEFAULT_IMAGE_MODEL } from "@cjhyy/code-shell-core";

export interface ImageProbeInput {
  /** Adapter selector — "openai" | "google" | … */
  kind: string;
  apiKey?: string;
  baseUrl?: string;
  /** Model id; falls back to the kind default. */
  model?: string;
}

export interface ImageProbeResult {
  status: "ok" | "error" | "unconfigured";
  /** Data URL (image/png;base64,…) of the generated probe image when ok. */
  previewDataUrl?: string;
  errorMessage?: string;
  errorDetail?: string;
  lastProbedAt: string;
}

const PROBE_TIMEOUT_MS = 60_000; // image gen is slower than search
const PROBE_PROMPT = "a small solid blue circle on a white background, minimal";

function humanize(raw: string): string {
  if (/401|403|unauthorized|invalid.*key|api key/i.test(raw))
    return "鉴权失败（API key 无效或额度耗尽）";
  if (/404|not found/i.test(raw)) return "端点不存在（确认 Base URL / 模型名）";
  if (/429|rate limit|quota/i.test(raw)) return "额度不足或被限流";
  if (/ETIMEDOUT|timed out/i.test(raw)) return "请求超时";
  if (/ENOTFOUND/.test(raw)) return "域名解析失败";
  if (/ECONNREFUSED/.test(raw)) return "拒绝连接（确认 Base URL）";
  if (/Invalid URL/i.test(raw)) return "Base URL 格式无效";
  return raw.split("\n")[0].slice(0, 200);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function probeImage(input: ImageProbeInput): Promise<ImageProbeResult> {
  const lastProbedAt = new Date().toISOString();

  if (!input.apiKey || !input.baseUrl) {
    return { status: "unconfigured", lastProbedAt };
  }
  const adapter = getImageProvider(input.kind);
  if (!adapter) {
    return {
      status: "error",
      errorMessage: `不支持的图片 provider 类型 "${input.kind}"`,
      lastProbedAt,
    };
  }

  const model = input.model || DEFAULT_IMAGE_MODEL[input.kind] || "gpt-image-2";

  try {
    const res = await withTimeout(
      adapter.generate({
        prompt: PROBE_PROMPT,
        size: "1024x1024",
        quality: "low",
        model,
        creds: { baseUrl: input.baseUrl, apiKey: input.apiKey },
      }),
      PROBE_TIMEOUT_MS,
      "Image probe",
    );
    if (!res.ok) {
      return {
        status: "error",
        errorMessage: humanize(res.error),
        errorDetail: res.error,
        lastProbedAt: new Date().toISOString(),
      };
    }
    return {
      status: "ok",
      previewDataUrl: `data:image/png;base64,${res.b64}`,
      lastProbedAt: new Date().toISOString(),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      errorMessage: humanize(raw),
      errorDetail: err instanceof Error ? err.stack ?? raw : raw,
      lastProbedAt: new Date().toISOString(),
    };
  }
}

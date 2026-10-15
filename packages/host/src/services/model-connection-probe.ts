/** A bounded, tool-free connectivity check through the same Core clients as real tasks. */
import {
  createLLMClient,
  resolveLLMConfigForTag,
  type SettingsManager,
} from "@cjhyy/code-shell-core";
import { getMergedCatalog } from "@cjhyy/code-shell-core/internal";

type Settings = ReturnType<SettingsManager["get"]>;
export type ModelProbeCode =
  | "connected"
  | "missing_key"
  | "invalid_configuration"
  | "unauthorized"
  | "model_unavailable"
  | "rate_limited"
  | "provider_error"
  | "network_error"
  | "invalid_response"
  | "timeout"
  | "cancelled";
export interface ModelProbeResult {
  ok: boolean;
  connectionId: string;
  model: string;
  latencyMs: number;
  checkedAt: string;
  code: ModelProbeCode;
  message: string;
  status?: number;
}
const messages: Record<ModelProbeCode, string> = {
  connected: "连接成功，模型已正常返回响应。",
  missing_key: "缺少有效的 API Key，请编辑连接并填写密钥。",
  invalid_configuration: "连接配置不完整或不支持，请检查服务商、模型和服务地址。",
  unauthorized: "服务商拒绝了凭据，请检查 API Key 与账号的模型访问权限。",
  model_unavailable: "模型或接口不可用，请检查模型名称与服务地址。",
  rate_limited: "服务商限制了请求，请检查账户额度或稍后重试。",
  provider_error: "服务商暂时无法处理请求，请稍后重试。",
  network_error: "无法连接服务，请检查服务器网络、服务地址与本地模型是否启动。",
  invalid_response: "服务有响应，但没有返回有效的模型内容，请检查接口类型和模型。",
  timeout: "连接测试超时，请检查服务地址与网络，或稍后重试。",
  cancelled: "已取消连接测试。",
};

export async function probeConfiguredModel(
  settings: Settings,
  id: string,
  options: { signal?: AbortSignal; timeoutMs?: number; transport?: typeof fetch } = {},
): Promise<ModelProbeResult> {
  const started = Date.now();
  const connection = settings.modelConnections.find(
    (item) => item.id === id && item.tag === "text",
  );
  const result = (code: ModelProbeCode, status?: number): ModelProbeResult => ({
    ok: code === "connected",
    connectionId: id,
    model: connection?.model ?? "",
    latencyMs: Math.max(0, Date.now() - started),
    checkedAt: new Date().toISOString(),
    code,
    message: messages[code],
    ...(status ? { status } : {}),
  });
  if (!connection) return result("invalid_configuration");
  const template = getMergedCatalog().find((entry) => entry.id === connection.catalogId);
  // Core treats an omitted text protocol as OpenAI-compatible.
  if (!template) return result("invalid_configuration");
  const credential = settings.credentials.find((item) => item.id === connection.credentialId);
  if (template.needsKey !== false && !credential?.apiKey) return result("missing_key");
  // Narrowing prevents the resolver's fallback from testing a different connection.
  const resolved = resolveLLMConfigForTag(
    { ...settings, modelConnections: [connection] },
    "text",
    id,
  );
  if (!resolved) return result("invalid_configuration");
  try {
    const endpoint = new URL(resolved.baseUrl ?? "");
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      return result("invalid_configuration");
  } catch {
    return result("invalid_configuration");
  }
  const controller = new AbortController();
  const timeoutMs = Math.min(18_000, Math.max(1, options.timeoutMs ?? 18_000));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let status: number | undefined;
  let transportFailed = false;
  let invalidResponse = false;
  let requests = 0;
  const transport = options.transport ?? globalThis.fetch;
  const safeFetch = (async (input, init) => {
    // SDK retries must never turn a connectivity check into multiple paid requests.
    if (++requests > 1) return failureResponse(503);
    try {
      const response = await transport(input, {
        ...init,
        redirect: "error",
        signal: init?.signal
          ? AbortSignal.any([controller.signal, init.signal])
          : controller.signal,
      });
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        // Provider error bodies can echo credentials. Never let them reach SDK logs.
        return failureResponse(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        invalidResponse = true;
        return failureResponse(502);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 1024 * 1024) {
            invalidResponse = true;
            await reader.cancel();
            return failureResponse(502);
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = Buffer.concat(chunks);
      // Invalid JSON must not cause an SDK exception containing the response body.
      let safeBody: string;
      try {
        const payload: unknown = JSON.parse(data.toString("utf8"));
        safeBody = JSON.stringify(payload, (_key, value: unknown) =>
          typeof value === "string" && resolved.apiKey
            ? value.replaceAll(resolved.apiKey, "[redacted]")
            : value,
        );
      } catch {
        invalidResponse = true;
        return failureResponse(502);
      }
      return new Response(safeBody, {
        status: response.status,
        headers: { "content-type": "application/json", "x-should-retry": "false" },
      });
    } catch {
      transportFailed = true;
      return failureResponse(503);
    }
  }) as typeof fetch;
  let rejectAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error("model probe aborted"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    const request = async () => {
      const client = await createLLMClient(
        { ...resolved, apiKey: resolved.apiKey ?? "codeshell-no-key", maxTokens: 32 },
        { timeout: timeoutMs, retryMaxAttempts: 1, fetch: safeFetch },
      );
      return client.createMessage({
        systemPrompt: "This is a connection test. Reply with OK.",
        messages: [{ role: "user", content: "Reply OK." }],
        tools: [],
        reasoning: { mode: "off" },
        maxTokens: 32,
        requestVisible: false,
        billingEnabled: false,
        signal: controller.signal,
      });
    };
    const response = await Promise.race([request(), aborted]);
    return response.text?.trim() ? result("connected") : result("invalid_response");
  } catch {
    if (timedOut) return result("timeout");
    if (controller.signal.aborted) return result("cancelled");
    if (invalidResponse) return result("invalid_response");
    if (transportFailed) return result("network_error");
    if (status === 401 || status === 403) return result("unauthorized", status);
    if (status === 400 || status === 404 || status === 422)
      return result("model_unavailable", status);
    if (status === 429) return result("rate_limited", status);
    if (status && status >= 500) return result("provider_error", status);
    return result("invalid_response", status);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}

function failureResponse(status: number): Response {
  return Response.json(
    { error: { message: "Model connection check failed", type: "model_probe_error" } },
    {
      status,
      headers: { "x-should-retry": "false" },
    },
  );
}

/**
 * resolveLLMConfigForTag — 单一入口:settings + tag + 可选偏好实例 id → LLMConfig。
 * 所有非-engine 的 seed 场景(agent-server bootstrap / automation / dream / TUI
 * 命令)都调它,避免各自手搓 { provider: settings.model.provider, ... }。
 *
 * 复用 modelEntriesFromConnections + 临时 ModelPool.toLLMConfig,与 engine 内部
 * 长生命周期 pool 共享同一批零件,不逻辑分叉。
 *
 * 选择优先级:preferredId(命中才用)→ defaults[tag] → 首个可用连接。
 * 返回 null = 该 tag 下没有任何可用连接,调用方据此抛明确错误。
 *
 * 本次只处理 text;image/video 已有独立 resolver(resolveImageProvider 等)。
 */
import type { LLMConfig } from "../types.js";
import type { ValidatedSettings } from "../settings/schema.js";
import { getMergedCatalog } from "../model-catalog/index.js";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import { ModelPool } from "../llm/model-pool.js";

export function resolveLLMConfigForTag(
  settings: ValidatedSettings,
  tag: "text",
  preferredInstanceId?: string,
): LLMConfig | null {
  const connections = (settings as { modelConnections?: unknown[] }).modelConnections;
  if (!Array.isArray(connections) || connections.length === 0) return null;
  const credentials = (settings as { credentials?: unknown[] }).credentials;
  const catalog = getMergedCatalog();

  const entries = modelEntriesFromConnections(
    connections as never[],
    (Array.isArray(credentials) ? credentials : []) as never[],
    catalog,
  );
  if (entries.length === 0) return null;

  // entry.key === connection.id(见 modelEntriesFromConnections)。
  const defaultId = (settings as { defaults?: { text?: string } }).defaults?.text;
  const pick =
    (preferredInstanceId && entries.find((e) => e.key === preferredInstanceId)) ||
    (defaultId && entries.find((e) => e.key === defaultId)) ||
    entries[0];
  if (!pick) return null;
  // 用户显式选了 default/preferred 但它解析不到(连接的 catalogId 被删 →
  // modelEntriesFromConnections 静默过滤掉)→ 这里 find 落空、悄悄回退到 entries[0]
  // 是「换了个模型还不告诉你」。不改回退行为(有可用连接就用),但出一条 warn 让
  // 静默替换可见(否则用户以为还在用选的那个)。
  const wanted = preferredInstanceId ?? defaultId;
  if (wanted && pick.key !== wanted) {
    console.warn(
      `[resolveLLMConfigForTag] 偏好/默认连接 "${wanted}" 解析不到(catalogId 可能已删)— 回退到 "${pick.key}"。`,
    );
  }

  // The picked connection's catalog template needs a key but none resolved
  // (credentialId missing/points at a deleted credential). Returning null here
  // routes to the caller's existing clean "没有可用的文本模型连接 … 请在「连接」
  // 页添加并填写凭证" message + exit, instead of silently building a config with
  // apiKey:undefined that only fails later as a cryptic provider 401. In
  // CONTRACT: this fn's null already means "no USABLE connection for this tag".
  // resolveInstance's no-crash (apiKey:undefined) behavior is untouched — this
  // gate is one layer up where usability is decided.
  if (pick.needsKey !== false && !pick.apiKey) {
    console.warn(
      `[resolveLLMConfigForTag] 连接 "${pick.key}" 需要密钥但未解析到凭证(credentialId 缺失或指向已删凭证)— 视为该 tag 无可用连接。`,
    );
    return null;
  }

  // 临时 pool 复用 toLLMConfig 的全部映射逻辑(reasoning/headers/providerKind 等)。
  const pool = new ModelPool([]);
  pool.register(pick);
  return pool.toLLMConfig(pick);
}

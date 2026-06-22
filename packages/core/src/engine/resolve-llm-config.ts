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

  // 临时 pool 复用 toLLMConfig 的全部映射逻辑(reasoning/headers/providerKind 等)。
  const pool = new ModelPool([]);
  pool.register(pick);
  return pool.toLLMConfig(pick);
}

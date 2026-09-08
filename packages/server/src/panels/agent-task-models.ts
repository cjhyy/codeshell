export interface PanelAgentTaskModelOption {
  id: string;
  providerId: string;
  provider: string;
  model: string;
  label: string;
}

export interface PanelAgentTaskModelCatalog {
  defaultModel?: string;
  models: PanelAgentTaskModelOption[];
}

interface ModelConnectionLike {
  id?: unknown;
  catalogId?: unknown;
  tag?: unknown;
  model?: unknown;
}

interface CatalogEntryLike {
  id?: unknown;
  displayName?: unknown;
  modelPresets?: Array<{ value?: unknown; label?: unknown }>;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) return undefined;
  return text;
}

/**
 * Build the secret-free model catalog exposed to a Panel App.
 *
 * Connections are the engine's real pool keys. Credentials, base URLs, and
 * parameter values deliberately never cross the guest boundary.
 */
export function buildPanelAgentTaskModelCatalog(
  settings: unknown,
  catalog: readonly CatalogEntryLike[],
): PanelAgentTaskModelCatalog {
  const source =
    settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const entries = new Map(
    catalog.flatMap((entry) => {
      const id = boundedText(entry.id, 256);
      return id ? [[id, entry] as const] : [];
    }),
  );
  const connections = Array.isArray(source.modelConnections)
    ? (source.modelConnections as ModelConnectionLike[])
    : [];
  const models: PanelAgentTaskModelOption[] = [];
  const seen = new Set<string>();

  for (const connection of connections) {
    if (connection?.tag !== "text") continue;
    const id = boundedText(connection.id, 256);
    const providerId = boundedText(connection.catalogId, 256);
    const model = boundedText(connection.model, 512);
    if (!id || !providerId || !model || seen.has(id)) continue;
    const entry = entries.get(providerId);
    if (!entry) continue;
    const provider = boundedText(entry.displayName, 256) ?? providerId;
    const preset = Array.isArray(entry.modelPresets)
      ? entry.modelPresets.find((candidate) => candidate?.value === model)
      : undefined;
    const label = boundedText(preset?.label, 512) ?? model;
    seen.add(id);
    models.push({ id, providerId, provider, model, label });
  }

  const defaults =
    source.defaults && typeof source.defaults === "object"
      ? (source.defaults as Record<string, unknown>)
      : {};
  const requestedDefault = boundedText(defaults.text, 256);
  const defaultModel =
    requestedDefault && seen.has(requestedDefault) ? requestedDefault : undefined;
  return { ...(defaultModel ? { defaultModel } : {}), models };
}

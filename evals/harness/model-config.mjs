import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Only the selected text connection crosses this boundary. Never copy the user's
// settings (hooks, MCP, permissions, other credentials) into an eval workspace.
export function selectConnection(settings, catalog, connectionId) {
  const id = connectionId ?? settings.defaults?.text;
  const connection = settings.modelConnections?.find((item) => item.id === id);
  if (!connection || connection.tag !== "text") throw new Error("Text connection not found");
  const entry = catalog.find((item) => item.id === connection.catalogId);
  if (!entry || entry.protocol !== "openai-compat") {
    throw new Error("This first live adapter requires an OpenAI-compatible text connection");
  }
  const credential = settings.credentials?.find((item) => item.id === connection.credentialId);
  if (credential && credential.catalogId !== entry.id) {
    throw new Error("Cross-catalog credentials are not supported by this eval loader");
  }
  if (entry.needsKey !== false && !credential?.apiKey)
    throw new Error("Selected credential missing");
  const baseUrl = connection.baseUrl ?? credential?.baseUrl ?? entry.defaultBaseUrl;
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Endpoint must not contain embedded credentials, query, or fragment");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("Remote model endpoints require HTTPS");
  }
  return {
    connectionId: id,
    model: connection.model,
    adapterKind: entry.adapterKind,
    protocol: entry.protocol,
    baseUrl: url.href.replace(/\/$/, ""),
    apiKey: credential?.apiKey ?? "",
    paramValues: { ...connection.paramValues },
    preset: entry.modelPresets?.find((item) => item.value === connection.model),
  };
}

export async function loadModelConnection({
  connectionId,
  settingsHome = join(homedir(), ".code-shell"),
} = {}) {
  let settings;
  try {
    settings = JSON.parse(await readFile(join(settingsHome, "settings.json"), "utf8"));
  } catch {
    // V8 JSON syntax errors can quote the source, including a malformed key.
    throw new Error("Could not read or parse model settings");
  }
  const { BUILTIN_CATALOG } = await import("../../packages/core/dist/model-catalog/builtin.js");
  let user = [];
  try {
    user = JSON.parse(await readFile(join(settingsHome, "model-catalog.user.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read user model catalog");
  }
  if (!Array.isArray(user)) throw new Error("User model catalog must be an array");
  const entries = new Map(BUILTIN_CATALOG.map((entry) => [entry.id, entry]));
  for (const entry of user) {
    const base = entries.get(entry.id);
    const presets = new Map((base?.modelPresets ?? []).map((preset) => [preset.value, preset]));
    for (const preset of entry.modelPresets ?? []) presets.set(preset.value, preset);
    entries.set(
      entry.id,
      entry.modelPresetsMode === "merge" && base
        ? { ...base, ...entry, modelPresets: [...presets.values()] }
        : entry,
    );
  }
  return selectConnection(settings, [...entries.values()], connectionId);
}

export function publicModel(model) {
  return {
    connectionId: model.connectionId,
    provider: model.adapterKind,
    requested: model.model,
    endpointOrigin: new URL(model.baseUrl).origin,
    paramValues: model.paramValues,
  };
}

import { createHash } from "node:crypto";
import { SettingsManager } from "@cjhyy/code-shell-core";
import {
  getMergedCatalog,
  resolveInstance,
  type CatalogEntry,
} from "@cjhyy/code-shell-core/internal";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Resolve existing credentials only; provider workflows and request formats stay in tools. */
export function panelConnections(cwd: string, selectedIds?: string[]) {
  const settings = new SettingsManager(cwd, "full").get();
  return resolvePanelConnections(settings, getMergedCatalog(), selectedIds);
}
export function resolvePanelConnections(
  settings: Pick<
    ReturnType<SettingsManager["get"]>,
    "modelConnections" | "credentials" | "defaults"
  >,
  catalog: CatalogEntry[],
  selectedIds?: string[],
) {
  const connections: Array<Record<string, any>> = (settings.modelConnections ?? []).flatMap<
    Record<string, any>
  >((connection) => {
    if (selectedIds && !selectedIds.includes(connection.id)) return [];
    const value = resolveInstance(connection, settings.credentials ?? [], catalog);
    if (!value) return [];
    const identity = {
      id: connection.id,
      catalogId: connection.catalogId,
      tag: connection.tag,
      adapterKind: value.adapterKind,
      model: value.model,
      hasCredentials: !!value.apiKey || !value.needsKey,
    };
    if (selectedIds)
      return [
        {
          ...identity,
          baseUrl: value.baseUrl,
          apiKey: value.apiKey ?? "",
          entry: value.entry,
          preset: value.preset,
          paramValues: value.paramValues,
        },
      ];
    const secretName = /(?:authorization|api.?key|token|secret|password|credential|header|cookie)/i;
    const parameters = (value.preset?.params ?? [])
      .filter((param) => !secretName.test(param.name))
      .map((param) => ({
        name: param.name,
        control: param.control,
        ...(param.control === "enum"
          ? {
              options: param.options ?? [],
              ...(typeof param.default === "string" && param.options?.includes(param.default)
                ? { default: param.default }
                : {}),
            }
          : {}),
        ...(param.control === "number"
          ? {
              min: param.min,
              max: param.max,
              ...(typeof param.default === "number" ? { default: param.default } : {}),
            }
          : {}),
        ...(param.control === "toggle" && typeof param.default === "boolean"
          ? { default: param.default }
          : {}),
      }));
    const paramValues = Object.fromEntries(
      parameters.flatMap((param) => {
        const current = value.paramValues[param.name];
        return (param.control === "enum" &&
          typeof current === "string" &&
          param.options?.includes(current)) ||
          (param.control === "number" && typeof current === "number" && Number.isFinite(current)) ||
          (param.control === "toggle" && typeof current === "boolean")
          ? [[param.name, current]]
          : [];
      }),
    );
    return [
      {
        ...identity,
        fingerprint: createHash("sha256")
          .update(JSON.stringify([connection.id, connection.catalogId, value.model, value.baseUrl]))
          .digest("hex")
          .slice(0, 32),
        providerName: value.entry.displayName,
        entry: { displayName: value.entry.displayName, tag: value.entry.tag },
        preset: value.preset
          ? { value: value.preset.value, label: value.preset.label, params: parameters }
          : undefined,
        paramValues,
      },
    ];
  });
  if (selectedIds?.some((id) => !connections.some((connection) => connection.id === id)))
    throw new Error("Selected connection is unavailable");
  return { connections, defaults: settings.defaults ?? {} };
}
export function panelConnectionIds(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 8 ||
    input.some((id) => typeof id !== "string" || !id || id.length > 200) ||
    new Set(input).size !== input.length
  )
    throw new Error("Select between one and eight configured connections");
  return input;
}
/** Sealed launch argument, never sent to a Guest or persisted in job input. */
export async function materializePanelConnections(
  root: string,
  cwd: string,
  selectedIds: string[],
) {
  const value = panelConnections(cwd, panelConnectionIds(selectedIds));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "connections-"));
  const path = join(directory, "connections.json");
  const cleanup = () => {
    void rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  } catch (error) {
    cleanup();
    throw error;
  }
  return { path, cleanup };
}

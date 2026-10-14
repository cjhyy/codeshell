import { createHash } from "node:crypto";
import {
  SettingsManager,
  WorkspaceSourceBindingSchema,
  type SourceDefinition,
} from "@cjhyy/code-shell-core";
import {
  insertSourceDefinitionsIfAbsent,
  listSourceDefinitions,
} from "@cjhyy/code-shell-core/internal";
import {
  getLinkProviderManifest,
  resolveLinkFileSelection,
  type LinkSnapshot,
  type MaskedLinkConnection,
} from "@cjhyy/code-shell-link";
import type {
  AddLinkedFileSourcesInput,
  LinkedFileSourceApi,
  LinkedFileSourceSnapshot,
} from "../shared/linked-file-sources.js";

export interface LinkedFileProject {
  projectId: string;
  rootId: string;
  cwd: string;
  canonicalIdentity: string;
}

interface LinkedFileServiceDeps {
  assertCurrent(): void;
  resolveProject(projectId: string): Promise<LinkedFileProject>;
  assertProjectCurrent(project: LinkedFileProject): void;
  snapshot(cwd: string): LinkSnapshot;
  /** Test seam around the real cross-process project settings transaction. */
  settings?: (cwd: string) => Pick<SettingsManager, "mutateSettingsForScope">;
}

function readyFileConnection(connection: MaskedLinkConnection): boolean {
  const capability = getLinkProviderManifest(connection.providerId)?.fileSelection;
  return Boolean(
    capability &&
    connection.status === "connected" &&
    (connection.capabilityIds.includes(`${connection.providerId}.${capability.action}`) ||
      (connection.authSource !== "remote-link" && connection.capabilityIds.length === 0)),
  );
}

function projectId(input: unknown): asserts input is string {
  if (typeof input !== "string" || !input || input.length > 128 || /[\x00-\x20\x7f]/.test(input))
    throw new Error("Invalid project identity");
}

function parseInput(input: AddLinkedFileSourcesInput): AddLinkedFileSourcesInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["connectionId", "expectedRevision", "files", "priority"].includes(key),
    ) ||
    typeof input.connectionId !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.connectionId) ||
    typeof input.expectedRevision !== "string" ||
    !input.expectedRevision ||
    input.expectedRevision.length > 512 ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > 100 ||
    !["normal", "high"].includes(input.priority)
  )
    throw new Error("Invalid linked file selection");
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)
    throw new Error("Linked file selection is too large");
  return structuredClone(input);
}

function reviewRevision(connection: MaskedLinkConnection, project: LinkedFileProject): string {
  return createHash("sha256")
    .update(JSON.stringify({ connectionId: connection.id, revision: connection.revision, project }))
    .digest("hex");
}

function connectionFor(
  snapshot: LinkSnapshot,
  input: AddLinkedFileSourcesInput,
  project: LinkedFileProject,
) {
  const connection = snapshot.connections.find((candidate) => candidate.id === input.connectionId);
  if (!connection || !readyFileConnection(connection))
    throw new Error("连接已不可用，请刷新后重新选择。");
  if (reviewRevision(connection, project) !== input.expectedRevision)
    throw new Error("连接授权或项目主目录已改变，请刷新后重新选择。");
  return connection;
}

function selectedFiles(connection: MaskedLinkConnection, input: AddLinkedFileSourcesInput) {
  const capability = getLinkProviderManifest(connection.providerId)!.fileSelection!;
  const resources =
    connection.account?.resourceGroups?.find((group) => group.id === capability.resourceGroup)
      ?.items ?? [];
  return input.files.map((file) => {
    const selected = resolveLinkFileSelection(connection.providerId, file);
    if (
      connection.authSource === "remote-link" &&
      !resources.some((resource) => resource.id === selected.resourceId)
    )
      throw new Error("文件不在这个连接的授权范围内，请先在连接中授权。");
    return selected;
  });
}

function sourceFor(
  connectionId: string,
  file: ReturnType<typeof resolveLinkFileSelection>,
): SourceDefinition {
  const adapterConfig = { providerId: file.providerId, action: file.action, params: file.params };
  const identity = JSON.stringify({ credentialRef: connectionId, ...adapterConfig });
  return {
    id: `linked_${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`,
    kind: "link",
    label: file.label,
    credentialRef: connectionId,
    adapterConfig,
    enabled: true,
  };
}

function assertDefinitions(definitions: SourceDefinition[]) {
  const current = new Map(listSourceDefinitions().map((source) => [source.id, source]));
  for (const expected of definitions) {
    const source = current.get(expected.id);
    if (
      !source ||
      source.kind !== "link" ||
      source.credentialRef !== expected.credentialRef ||
      JSON.stringify(source.adapterConfig) !== JSON.stringify(expected.adapterConfig)
    )
      throw new Error("已有文件引用已改变，请在数据源中检查后重试。");
    if (!source.enabled) throw new Error("这个文件引用已停用，请先在数据源中启用。");
  }
}

/** Selection stores exact references only. No provider requests or content reads occur here. */
export function createLinkedFileSourceService(deps: LinkedFileServiceDeps): LinkedFileSourceApi {
  async function resolve(id: string) {
    projectId(id);
    deps.assertCurrent();
    const project = await deps.resolveProject(id);
    deps.assertCurrent();
    deps.assertProjectCurrent(project);
    return project;
  }
  return {
    async snapshot(id): Promise<LinkedFileSourceSnapshot> {
      const project = await resolve(id);
      const snapshot = deps.snapshot(project.cwd);
      deps.assertCurrent();
      deps.assertProjectCurrent(project);
      return {
        connections: snapshot.connections.filter(readyFileConnection).map((connection) => {
          const capability = getLinkProviderManifest(connection.providerId)!.fileSelection!;
          const restricted = connection.authSource === "remote-link";
          return {
            id: connection.id,
            providerId: connection.providerId,
            label: connection.label,
            accountLabel: connection.account?.label,
            revision: reviewRevision(connection, project),
            selection: capability.kind,
            resources: restricted
              ? (connection.account?.resourceGroups
                  ?.find((group) => group.id === capability.resourceGroup)
                  ?.items.map((item) => ({ id: item.id, label: item.label })) ?? [])
              : [],
            resourceRestricted: restricted,
          };
        }),
        limitations: snapshot.connections
          .flatMap((connection) => {
            const manifest = getLinkProviderManifest(connection.providerId);
            return connection.status === "connected" && !readyFileConnection(connection)
              ? [
                  {
                    providerId: connection.providerId,
                    label: manifest?.displayName ?? connection.label,
                    reason:
                      manifest?.fileSelectionLimitation ?? ("file-selection-unavailable" as const),
                  },
                ]
              : [];
          })
          .filter(
            (item, index, all) =>
              all.findIndex((other) => other.providerId === item.providerId) === index,
          ),
      };
    },
    async add(id, rawInput) {
      const input = parseInput(rawInput);
      const project = await resolve(id);
      const connection = connectionFor(deps.snapshot(project.cwd), input, project);
      const files = selectedFiles(connection, input);
      const definitions = [
        ...new Map(
          files.map((file) => {
            const source = sourceFor(connection.id, file);
            return [source.id, source] as const;
          }),
        ).values(),
      ];
      const freshProject = await resolve(id);
      if (JSON.stringify(freshProject) !== JSON.stringify(project))
        throw new Error("项目主目录已改变，请重新打开项目配置。");
      const assertCurrent = () => {
        deps.assertCurrent();
        deps.assertProjectCurrent(project);
        selectedFiles(connectionFor(deps.snapshot(project.cwd), input, project), input);
      };
      assertCurrent();
      const inserted = insertSourceDefinitionsIfAbsent(definitions);
      try {
        assertCurrent();
        assertDefinitions(definitions);
        const settings = deps.settings?.(project.cwd) ?? new SettingsManager(project.cwd, "full");
        settings.mutateSettingsForScope("project", project.cwd, (current) => {
          assertCurrent();
          assertDefinitions(definitions);
          if (current.sources !== undefined && !Array.isArray(current.sources))
            throw new Error("项目数据源配置已损坏，请先修复。");
          const bindings = ((current.sources as unknown[] | undefined) ?? []).map((binding) =>
            WorkspaceSourceBindingSchema.parse(binding),
          );
          if (new Set(bindings.map((binding) => binding.sourceId)).size !== bindings.length)
            throw new Error("项目数据源引用存在重复，请先修复。");
          for (const source of definitions) {
            const index = bindings.findIndex((binding) => binding.sourceId === source.id);
            const existing = bindings[index];
            const binding = WorkspaceSourceBindingSchema.parse({
              sourceId: source.id,
              scopes: [`${connection.providerId}:get_file`],
              readPolicy: existing?.readPolicy ?? "ask",
              priority: input.priority,
            });
            if (index < 0) bindings.push(binding);
            else bindings[index] = binding;
          }
          current.sources = bindings;
          assertCurrent();
        });
      } catch (cause) {
        // Stable references can already be reused by another project while we
        // wait for its settings lock. Never delete shared references on failure.
        if (inserted.length)
          throw new Error(
            `项目引用未保存；文件引用已保留，重新添加即可重试。${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        throw cause;
      }
      return { sourceIds: definitions.map((source) => source.id) };
    },
  };
}

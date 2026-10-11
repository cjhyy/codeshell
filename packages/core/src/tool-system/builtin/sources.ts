/**
 * 数据源只读读取面（ADR §5）。ListSources 只出 metadata（自动允许）；
 * ReadSource 读内容（permissionDefault: ask，在 index.ts 注册处声明），
 * 执行时对 source/scope/resource 二次校验（防审批后换参），结果带
 * provenance + maxBytes 截断 + secret redaction + untrusted input 包裹。
 */
import { SettingsManager } from "../../settings/manager.js";
import { randomUUID } from "node:crypto";
import { connectorAdapterFor, registerConnectorAdapter } from "../../sources/adapter.js";
import {
  LOCAL_FILES_SOURCE_ID,
  listLocalFiles,
  localFilesAdapter,
  readUploadedDocument,
  uploadedDocumentDirectoryIdentity,
  type UploadedDocumentRead,
} from "../../sources/adapters/local-files.js";
import { searchDocumentIndexes } from "../../sources/documents/index-store.js";
import { MAX_DOCUMENT_BYTES } from "../../sources/documents/types.js";
import { defaultMcpResourceAdapter } from "../../sources/adapters/mcp-resource.js";
import { linkSourceAdapter } from "../../sources/adapters/link.js";
import { mockAdapter } from "../../sources/adapters/mock.js";
import {
  collectionAdapter,
  readCollectionDocument,
  type CollectionDocumentRead,
} from "../../sources/adapters/collection.js";
import { collectionConfig } from "../../sources/collection.js";
import { collectionLocalDirectoryIdentity } from "../../sources/collection-local.js";
import { defaultCredentialStatus } from "../../sources/credential-status.js";
import { resolveEffectiveSourceAccess, type EffectiveSourceAccess } from "../../sources/resolve.js";
import { truncateUtf8Text } from "../../sources/truncate-utf8.js";
import type { SourceResourceMeta } from "../../sources/types.js";
import type { ToolDefinition } from "../../types.js";
import { scrubSecrets, scrubSecretValue } from "../../utils/secret-scrubber.js";
import { wrapUntrustedInput } from "../../automation/write-policy.js";
import type { ToolContext } from "../context.js";
import { boundToolResult } from "../bound-tool-result.js";

const DEFAULT_MAX_BYTES = 262_144;
const MAX_COLLECTION_FILES = 8;
const MAX_COLLECTION_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_COLLECTION_INDEX_BYTES = 4 * 1024 * 1024;
const COLLECTION_TIMEOUT_MS = 30_000;
// Symbol identity stays in this module. No model JSON, hook args or result
// prose can create a receipt sink; the executor passes it only to this call.
const documentQueryService = Symbol("authorized-document-query");
type DocumentQueryRead = UploadedDocumentRead | CollectionDocumentRead;
interface SelectedDocument {
  scope: string;
  resource: string;
}
interface DocumentQueryService {
  source: string;
  scope: string;
  resource: string;
  query: string;
  reserveInputBytes(bytes: number): void;
  capture(receipt: DocumentQueryRead): void;
}
const mcpResourceAdapter = defaultMcpResourceAdapter();

/** Registering the same adapter objects is safe to repeat across test/host imports. */
export function registerBuiltinSourceAdapters(): void {
  registerConnectorAdapter(mockAdapter);
  registerConnectorAdapter(localFilesAdapter);
  registerConnectorAdapter(mcpResourceAdapter);
  registerConnectorAdapter(linkSourceAdapter);
  registerConnectorAdapter(collectionAdapter);
}

registerBuiltinSourceAdapters();

function accessFor(cwd: string, ctx?: ToolContext): EffectiveSourceAccess[] {
  if (ctx?.isSourceProfileCurrent && !ctx.isSourceProfileCurrent()) return [];
  const settingsScope = ctx?.settingsScope ?? "project";
  const settings = new SettingsManager(cwd, settingsScope);
  return resolveEffectiveSourceAccess({
    cwd,
    settings,
    credentialStatus: defaultCredentialStatus,
    settingsScope,
    workspaceProfileName: ctx?.workspaceProfileName,
  });
}

function authorityIsCurrent(
  access: EffectiveSourceAccess,
  cwd: string,
  ctx?: ToolContext,
): boolean {
  return (
    JSON.stringify(accessFor(cwd, ctx).find((item) => item.sourceId === access.sourceId)) ===
    JSON.stringify(access)
  );
}

async function resourcesFor(
  access: EffectiveSourceAccess,
  scope: string,
  cwd: string,
  ctx?: ToolContext,
): Promise<SourceResourceMeta[]> {
  if (access.sourceId === LOCAL_FILES_SOURCE_ID) return listLocalFiles(cwd);
  if (!access.definition) return [];
  return (
    (await connectorAdapterFor(access.kind)?.listResources(access.definition, scope, {
      cwd,
      settingsScope: ctx?.settingsScope ?? "project",
      signal: ctx?.signal,
      ...(access.kind === "mcp-resource" ? { mcpContext: ctx } : {}),
    })) ?? []
  );
}

export const listSourcesToolDef: ToolDefinition = {
  name: "ListSources",
  description:
    "List the data sources bound to this workspace: names, scopes, availability status and resource names/sizes. Metadata only — use ReadSource to read content (requires approval).",
  inputSchema: { type: "object", properties: {} },
};

export async function listSourcesTool(
  _args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const access = accessFor(cwd, ctx);
  if (access.length === 0) return "No data sources are bound to this workspace.";

  const lines: string[] = [];
  for (const item of access) {
    if (!authorityIsCurrent(item, cwd, ctx))
      return "Error: source authorization changed during listing.";
    lines.push(
      `## ${item.label} (id: ${item.sourceId}, kind: ${item.kind}, status: ${item.status}, readPolicy: ${item.readPolicy})`,
    );
    if (item.status !== "ok") continue;

    if (item.kind === "collection" && item.definition) {
      // One synchronous metadata projection. No per-file await, parsing of
      // originals, DNS or repeated whole-manifest parsing for 1,000 scopes.
      const entries = new Map(
        collectionConfig(item.definition).entries.map((entry) => [entry.id, entry]),
      );
      for (const scope of item.scopes) {
        lines.push(`### scope: ${scope}`);
        const entry = entries.get(scope);
        if (entry)
          lines.push(
            `- ${entry.relativePath ?? entry.name} (resource: ${entry.id}, ${entry.sizeBytes}B)`,
          );
      }
      if (!authorityIsCurrent(item, cwd, ctx))
        return "Error: source authorization changed during listing.";
      continue;
    }

    for (const scope of item.scopes) {
      let resources: SourceResourceMeta[] = [];
      try {
        resources = await resourcesFor(item, scope, cwd, ctx);
      } catch {
        // Listing is metadata-only and best effort. A temporarily failing scope
        // must not expose content or make the other bound sources disappear.
      }

      if (!authorityIsCurrent(item, cwd, ctx))
        return "Error: source authorization changed during listing.";

      lines.push(`### scope: ${scope}`);
      for (const resource of resources.filter((candidate) => candidate.scopeId === scope)) {
        lines.push(
          `- ${resource.name} (resource: ${resource.id}${
            resource.sizeBytes === undefined ? "" : `, ${resource.sizeBytes}B`
          })`,
        );
      }
    }
  }

  if (access.some((item) => !authorityIsCurrent(item, cwd, ctx)))
    return "Error: source authorization changed during listing.";
  return lines.join("\n");
}

export const readSourceToolDef: ToolDefinition = {
  name: "ReadSource",
  description:
    "Read one exact resource from a bound data source (requires approval). Uploaded files and shared document collections support UTF-8 text, DOCX/PPTX/XLSX and PDF extraction; PDF requires Node.js 22.13+. Optional query performs local lexical search (limit 1–20); optional chunk reads a returned chunk id. For cross-file search, supply query and select 1–8 resources: uploads use string ids plus their common scope; a shared collection uses [{scope, resource}] and omits outer scope. Every collection file has its own explicitly bound scope. Each file retains its own approval; any failure returns no corpus results. URL files are downloaded again before return for sequential version checks, not an atomic remote snapshot. Changed files require an explicit collection update. No implicit whole-project scan or automatic synchronization. Query and chunk cannot be combined.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Bound source id (from ListSources)" },
      scope: { type: "string", description: "Bound scope id" },
      resource: { type: "string", description: "Resource id within that scope" },
      resources: {
        type: "array",
        minItems: 1,
        maxItems: MAX_COLLECTION_FILES,
        uniqueItems: true,
        items: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: 512 },
            {
              type: "object",
              properties: {
                scope: { type: "string", minLength: 1, maxLength: 512 },
                resource: { type: "string", minLength: 1, maxLength: 512 },
              },
              required: ["scope", "resource"],
              additionalProperties: false,
            },
          ],
        },
        description:
          "Cross-file query: uploads use string ids plus outer scope; shared collections use exact {scope, resource} pairs without outer scope. Select one source only; excludes resource and chunk",
      },
      query: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        description:
          "Uploaded documents or shared collections: local lexical search terms within the exact selected resources",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum query matches, default 5",
      },
      chunk: {
        type: "string",
        pattern: "^c_[a-f0-9]{24}$",
        description: "Exact chunk id from a prior query of the current document version",
      },
    },
    required: ["source"],
    oneOf: [
      { required: ["scope", "resource"], not: { required: ["resources"] } },
      {
        required: ["scope", "resources", "query"],
        properties: { resources: { items: { type: "string" } } },
        not: { anyOf: [{ required: ["resource"] }, { required: ["chunk"] }] },
      },
      {
        required: ["resources", "query"],
        properties: { resources: { items: { type: "object" } } },
        not: {
          anyOf: [{ required: ["scope"] }, { required: ["resource"] }, { required: ["chunk"] }],
        },
      },
    ],
  },
};

async function querySourceCollection(
  args: Record<string, unknown>,
  access: EffectiveSourceAccess,
  scope: string,
  query: string,
  limit: number,
  cwd: string,
  ctx: ToolContext | undefined,
  signal?: AbortSignal,
): Promise<string> {
  // Monotonic checks cover synchronous metadata/ranking/hash work too; a
  // delayed timer callback alone cannot enforce a computation deadline.
  let remainingMs = COLLECTION_TIMEOUT_MS;
  let activeSince = performance.now();
  let budgetActive = true;
  const sharedCollection = access.kind === "collection";
  const validId = (value: unknown): value is string =>
    typeof value === "string" && Boolean(value) && value.length <= 512 && !value.includes("\0");
  if (
    args.resource !== undefined ||
    args.chunk !== undefined ||
    !Array.isArray(args.resources) ||
    args.resources.length < 1 ||
    args.resources.length > MAX_COLLECTION_FILES ||
    (sharedCollection && args.scope !== undefined) ||
    args.resources.some((item) =>
      sharedCollection
        ? !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          !validId(item.scope) ||
          !validId(item.resource) ||
          Object.keys(item).some((key) => key !== "scope" && key !== "resource")
        : !validId(item),
    )
  )
    return "Error: collection query requires 1–8 exact selections: uploaded string ids with scope, or shared {scope, resource} pairs without outer scope; excludes resource/chunk.";
  const selected: SelectedDocument[] = args.resources.map((item) =>
    sharedCollection ? { scope: item.scope, resource: item.resource } : { scope, resource: item },
  );
  if (new Set(selected.map((item) => JSON.stringify(item))).size !== selected.length)
    return "Error: collection query requires unique resource selections.";
  selected.sort((left, right) =>
    left.scope < right.scope
      ? -1
      : left.scope > right.scope
        ? 1
        : left.resource < right.resource
          ? -1
          : left.resource > right.resource
            ? 1
            : 0,
  );
  if (!ctx?.executeBoundTool || !ctx.previewToolPermission)
    return "Error: collection queries require the owning tool authorization pipeline.";
  const receipts: DocumentQueryRead[] = [];
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () =>
    deadline.abort(new Error("Collection query exceeded its 30 second computation deadline"));
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, Math.max(0, remainingMs));
  };
  const pauseAuthorization = () => {
    if (!budgetActive) return;
    remainingMs -= performance.now() - activeSince;
    budgetActive = false;
    clearTimeout(timer);
  };
  const resumeComputation = () => {
    if (budgetActive) return;
    budgetActive = true;
    activeSince = performance.now();
    armTimer();
  };
  let directoryIdentity: string | undefined;
  const localDirectories = new Map<string, string>();
  const entries = sharedCollection
    ? collectionConfig(access.definition!).entries.filter((entry) =>
        selected.some((item) => item.resource === entry.id),
      )
    : [];
  const callArgs = (item: SelectedDocument) => ({
    source: access.sourceId,
    scope: item.scope,
    resource: item.resource,
    query,
    limit: 1,
  });
  const assertAuthorized = () => {
    if (budgetActive && performance.now() - activeSince >= remainingMs) expire();
    combined.throwIfAborted();
    if (
      !authorityIsCurrent(access, cwd, ctx) ||
      ctx.disabledBuiltins?.has("ReadSource") ||
      (ctx.allowedToolNames && !ctx.allowedToolNames.has("ReadSource")) ||
      selected.some(
        (item) =>
          !access.scopes.includes(item.scope) ||
          ctx.previewToolPermission!("ReadSource", callArgs(item)) === "deny",
      )
    )
      throw new Error("Source authorization changed or a selected resource is denied");
    if (
      directoryIdentity !== undefined &&
      uploadedDocumentDirectoryIdentity(cwd, selected[0].resource) !== directoryIdentity
    )
      throw new Error("Uploaded document workspace or directory changed during collection query");
    for (const entry of entries) {
      const identity = localDirectories.get(entry.id);
      if (
        identity !== undefined &&
        entry.kind === "local" &&
        collectionLocalDirectoryIdentity(entry) !== identity
      )
        throw new Error("Collection file directory changed during collection query");
    }
  };
  try {
    armTimer();
    // All known deny/metadata/size checks precede the first content read. A
    // forecast never grants a read: each child still runs real approval/hooks.
    assertAuthorized();
    const metadata = new Map<string, SourceResourceMeta[]>();
    for (const item of selected) {
      if (metadata.has(item.scope)) continue;
      metadata.set(item.scope, await resourcesFor(access, item.scope, cwd, ctx));
      assertAuthorized();
    }
    let advertisedBytes = 0;
    for (const selection of selected) {
      const item = metadata
        .get(selection.scope)!
        .find(
          (candidate) =>
            candidate.id === selection.resource && candidate.scopeId === selection.scope,
        );
      if (!item)
        throw new Error(
          `Selected resource "${selection.resource}" is not listed in scope "${selection.scope}"`,
        );
      if (
        !Number.isSafeInteger(item.sizeBytes) ||
        item.sizeBytes! < 0 ||
        item.sizeBytes! > MAX_DOCUMENT_BYTES
      )
        throw new Error(
          "Selected document exceeds the 20 MiB parsing limit or has no bounded size",
        );
      advertisedBytes += item.sizeBytes!;
    }
    if (advertisedBytes > MAX_COLLECTION_INPUT_BYTES)
      throw new Error("Collection query exceeds the 40 MiB total input limit; select fewer files");
    if (sharedCollection) {
      for (const item of selected) {
        const entry = entries.find((candidate) => candidate.id === item.resource);
        if (entry?.kind === "local")
          localDirectories.set(entry.id, collectionLocalDirectoryIdentity(entry));
      }
    } else directoryIdentity = uploadedDocumentDirectoryIdentity(cwd, selected[0].resource);
    let inputBytes = 0;
    let indexBytes = 0;
    for (const selection of selected) {
      assertAuthorized();
      let receipt: DocumentQueryRead | undefined;
      const service: DocumentQueryService = Object.freeze({
        source: access.sourceId,
        scope: selection.scope,
        resource: selection.resource,
        query,
        reserveInputBytes(bytes: number) {
          // Child permission / pre-start Hook waiting is not parser compute.
          // The existing outer registry timeout still bounds the whole call.
          resumeComputation();
          assertAuthorized();
          if (inputBytes + bytes > MAX_COLLECTION_INPUT_BYTES)
            throw new Error("Collection query exceeds the 40 MiB actual input limit");
          inputBytes += bytes;
        },
        capture(value: DocumentQueryRead) {
          assertAuthorized();
          if (
            receipt ||
            value.index.resourceId !== selection.resource ||
            !Object.isFrozen(value.index)
          )
            throw new Error("Invalid authorized document query receipt");
          const bytes = Buffer.byteLength(JSON.stringify(value.index));
          if (indexBytes + bytes > MAX_COLLECTION_INDEX_BYTES)
            throw new Error("Collection query exceeds the 4 MiB index limit; select fewer files");
          indexBytes += bytes;
          receipt = value;
        },
      });
      pauseAuthorization();
      const result = boundToolResult(
        await ctx.executeBoundTool(
          {
            id: `source-query-${randomUUID()}`,
            toolName: "ReadSource",
            args: callArgs(selection),
          },
          {
            signal: combined,
            assertAuthorized,
            privateServices: new Map([[documentQueryService, service]]),
          },
        ),
      );
      resumeComputation();
      assertAuthorized();
      if (result.isError || !receipt)
        throw new Error(
          "A selected document read was denied, failed or produced no trusted receipt",
        );
      receipts.push(receipt);
      // Includes earlier files while a later approval/parse was awaiting.
      for (const original of receipts) original.assertCurrent();
    }
    const corpus = searchDocumentIndexes(
      receipts.map((item) => item.index),
      query,
      limit,
    );
    const scopeFor = (resourceId: string) =>
      selected.find((item) => item.resource === resourceId)!.scope;
    const result = {
      source: access.sourceId,
      ...(sharedCollection ? {} : { scope }),
      ...corpus,
      ...(sharedCollection
        ? {
            resources: corpus.resources.map((item) => ({
              ...item,
              scopeId: scopeFor(item.resourceId),
            })),
            matches: corpus.matches.map((item) => ({
              ...item,
              scopeId: scopeFor(item.resourceId),
            })),
            ...(receipts.some((item) => "revalidateRemote" in item && item.revalidateRemote)
              ? { remoteConsistency: "sequential_revalidation" as const }
              : {}),
          }
        : {}),
    };
    let output = JSON.stringify(scrubSecretValue(result));
    while (Buffer.byteLength(output) > DEFAULT_MAX_BYTES && result.matches.length) {
      result.matches.pop();
      result.hasMore = true;
      result.outputTruncated = true;
      output = JSON.stringify(scrubSecretValue(result));
    }
    if (Buffer.byteLength(output) > DEFAULT_MAX_BYTES)
      throw new Error("Collection metadata exceeds the output limit");
    // URL observations are sequential redownloads, never an atomic snapshot.
    // Afterwards the local originals and all authority are checked synchronously.
    for (const original of receipts) {
      if ("revalidateRemote" in original && original.revalidateRemote) {
        assertAuthorized();
        await original.revalidateRemote();
        assertAuthorized();
      }
    }
    // No await between all local identity/hash checks and the final result.
    assertAuthorized();
    for (const original of receipts) original.assertCurrent();
    assertAuthorized();
    const wrapped = wrapUntrustedInput(
      output,
      `source=${access.sourceId}${sharedCollection ? "" : ` scope=${scope}`} resources=${JSON.stringify(sharedCollection ? selected : selected.map((item) => item.resource))}`,
    );
    assertAuthorized();
    return wrapped;
  } catch (error) {
    return `Error: collection query failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function readSourceTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const source = String(args.source ?? "");
  const scope = String(args.scope ?? "");
  const resource = String(args.resource ?? "");
  const signal = ctx?.signal ?? (args.__signal as AbortSignal | undefined);

  // Second authorization gate after approval: the source must still be bound
  // and healthy, and the requested scope must still be explicitly selected.
  const access = accessFor(cwd, ctx).find((item) => item.sourceId === source);
  if (!access) return `Error: source "${source}" is not bound to this workspace.`;
  if (access.status !== "ok") return `Error: source "${source}" is ${access.status}.`;
  if (access.readPolicy === "deny") {
    return `Error: source "${source}" is metadata-only in this workspace (readPolicy: deny).`;
  }
  if (
    !(access.kind === "collection" && args.resources !== undefined) &&
    !access.scopes.includes(scope)
  ) {
    return `Error: scope "${scope}" is not bound for source "${source}".`;
  }
  if (!access.definition) return `Error: source "${source}" is dangling.`;

  const adapter = connectorAdapterFor(access.kind);
  if (!adapter) return `Error: no adapter for kind "${access.kind}".`;

  const query = args.query;
  const chunk = args.chunk;
  const limit = args.limit;
  if (query !== undefined || chunk !== undefined || limit !== undefined) {
    if (access.kind !== "local-files" && access.kind !== "collection")
      return "Error: document queries and chunks are available only for uploaded files or document collections.";
    if (
      query !== undefined &&
      (typeof query !== "string" || !query.trim() || query.length > 512 || query.includes("\0"))
    )
      return "Error: document query must contain 1–512 characters.";
    if (chunk !== undefined && (typeof chunk !== "string" || !/^c_[a-f0-9]{24}$/.test(chunk)))
      return "Error: invalid document chunk id.";
    if (query !== undefined && chunk !== undefined)
      return "Error: choose either a document query or an exact chunk.";
    if (
      limit !== undefined &&
      (query === undefined ||
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20)
    )
      return "Error: document query limit must be an integer from 1 to 20.";
  }

  if (args.resources !== undefined) {
    if (
      (access.kind !== "collection" &&
        (access.kind !== "local-files" || source !== LOCAL_FILES_SOURCE_ID)) ||
      typeof query !== "string"
    )
      return "Error: collection queries require query and an uploaded files or shared collection source.";
    return querySourceCollection(
      args,
      access,
      scope,
      query,
      typeof limit === "number" ? limit : 5,
      cwd,
      ctx,
      signal,
    );
  }
  if (typeof args.resource !== "string" || !resource)
    return "Error: choose one exact resource or an explicit document resources query.";

  try {
    // Validate resource ownership from the selected scope's metadata before
    // any content read. This prevents a valid id from another scope being used
    // after approval with otherwise unchanged source/scope arguments.
    signal?.throwIfAborted();
    const resources = await resourcesFor(access, scope, cwd, ctx);
    if (!authorityIsCurrent(access, cwd, ctx))
      return "Error: source authorization changed during the read.";
    const listed = resources.some(
      (candidate) => candidate.id === resource && candidate.scopeId === scope,
    );
    if (!listed) {
      return `Error: resource "${resource}" is not listed in scope "${scope}" for source "${source}".`;
    }

    const service = ctx?.boundToolServices?.get(documentQueryService) as
      | DocumentQueryService
      | undefined;
    if (
      service &&
      (service.source !== source ||
        service.scope !== scope ||
        service.resource !== resource ||
        service.query !== query)
    )
      throw new Error("Uploaded document query service does not match this exact read");
    const options = {
      maxBytes: DEFAULT_MAX_BYTES,
      signal,
      cwd,
      settingsScope: ctx?.settingsScope ?? "project",
      executeBoundTool: ctx?.executeBoundTool,
      ...(access.kind === "mcp-resource" ? { mcpContext: ctx } : {}),
      documentParserExecutable: ctx?.documentParserExecutable,
      ...(typeof query === "string" ? { query, limit: typeof limit === "number" ? limit : 5 } : {}),
      ...(typeof chunk === "string" ? { chunk } : {}),
      assertAuthorized: () => {
        if (!authorityIsCurrent(access, cwd, ctx)) throw new Error("Source authorization changed");
      },
    };
    const receipt =
      service && adapter === localFilesAdapter
        ? await readUploadedDocument(resource, {
            ...options,
            reserveInputBytes: service.reserveInputBytes,
          })
        : service && adapter === collectionAdapter
          ? await readCollectionDocument(access.definition, resource, {
              ...options,
              reserveInputBytes: service.reserveInputBytes,
            })
          : undefined;
    const content = receipt?.content ?? (await adapter.read(access.definition, resource, options));
    signal?.throwIfAborted();
    if (!authorityIsCurrent(access, cwd, ctx))
      return "Error: source authorization changed during the read.";
    if (content.resourceId !== resource) {
      return `Error: source "${source}" returned a different resource id.`;
    }
    if (receipt) service!.capture(receipt);

    // Adapters enforce maxBytes too; keep this boundary-level cap so a future
    // or injected adapter cannot bypass the 256 KiB context limit.
    const capped = truncateUtf8Text(content.text, DEFAULT_MAX_BYTES);
    const truncated = content.truncated || capped.truncated;
    const provenance = `source=${source} scope=${scope} resource=${resource}${
      truncated ? " (truncated)" : ""
    }`;
    return wrapUntrustedInput(scrubSecrets(capped.text), provenance);
  } catch (error) {
    return `Error: read failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

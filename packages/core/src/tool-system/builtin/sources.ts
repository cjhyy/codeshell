/**
 * 数据源只读读取面（ADR §5）。ListSources 只出 metadata（自动允许）；
 * ReadSource 读内容（permissionDefault: ask，在 index.ts 注册处声明），
 * 执行时对 source/scope/resource 二次校验（防审批后换参），结果带
 * provenance + maxBytes 截断 + secret redaction + untrusted input 包裹。
 */
import { SettingsManager } from "../../settings/manager.js";
import { connectorAdapterFor, registerConnectorAdapter } from "../../sources/adapter.js";
import {
  LOCAL_FILES_SOURCE_ID,
  listLocalFiles,
  localFilesAdapter,
} from "../../sources/adapters/local-files.js";
import { defaultMcpResourceAdapter } from "../../sources/adapters/mcp-resource.js";
import { mockAdapter } from "../../sources/adapters/mock.js";
import { defaultCredentialStatus } from "../../sources/credential-status.js";
import { resolveEffectiveSourceAccess, type EffectiveSourceAccess } from "../../sources/resolve.js";
import { truncateUtf8Text } from "../../sources/truncate-utf8.js";
import type { SourceResourceMeta } from "../../sources/types.js";
import type { ToolDefinition } from "../../types.js";
import { scrubSecrets } from "../../utils/secret-scrubber.js";
import { wrapUntrustedInput } from "../../automation/write-policy.js";
import type { ToolContext } from "../context.js";

const DEFAULT_MAX_BYTES = 262_144;
const mcpResourceAdapter = defaultMcpResourceAdapter();

/** Registering the same adapter objects is safe to repeat across test/host imports. */
export function registerBuiltinSourceAdapters(): void {
  registerConnectorAdapter(mockAdapter);
  registerConnectorAdapter(localFilesAdapter);
  registerConnectorAdapter(mcpResourceAdapter);
}

registerBuiltinSourceAdapters();

function accessFor(cwd: string): EffectiveSourceAccess[] {
  const settings = new SettingsManager(cwd, "full");
  return resolveEffectiveSourceAccess({
    cwd,
    settings,
    credentialStatus: defaultCredentialStatus,
  });
}

async function resourcesFor(
  access: EffectiveSourceAccess,
  scope: string,
  cwd: string,
): Promise<SourceResourceMeta[]> {
  if (access.sourceId === LOCAL_FILES_SOURCE_ID) return listLocalFiles(cwd);
  if (!access.definition) return [];
  return (await connectorAdapterFor(access.kind)?.listResources(access.definition, scope)) ?? [];
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
  const access = accessFor(cwd);
  if (access.length === 0) return "No data sources are bound to this workspace.";

  const lines: string[] = [];
  for (const item of access) {
    lines.push(
      `## ${item.label} (id: ${item.sourceId}, kind: ${item.kind}, status: ${item.status}, readPolicy: ${item.readPolicy})`,
    );
    if (item.status !== "ok") continue;

    for (const scope of item.scopes) {
      let resources: SourceResourceMeta[] = [];
      try {
        resources = await resourcesFor(item, scope, cwd);
      } catch {
        // Listing is metadata-only and best effort. A temporarily failing scope
        // must not expose content or make the other bound sources disappear.
      }

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

  return lines.join("\n");
}

export const readSourceToolDef: ToolDefinition = {
  name: "ReadSource",
  description:
    "Read the content of one resource from a bound data source. Requires approval. Args must exactly match a bound source/scope and a listed resource id.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Bound source id (from ListSources)" },
      scope: { type: "string", description: "Bound scope id" },
      resource: { type: "string", description: "Resource id within that scope" },
    },
    required: ["source", "scope", "resource"],
  },
};

export async function readSourceTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const cwd = ctx?.cwd ?? process.cwd();
  const source = String(args.source ?? "");
  const scope = String(args.scope ?? "");
  const resource = String(args.resource ?? "");
  const signal = args.__signal as AbortSignal | undefined;

  // Second authorization gate after approval: the source must still be bound
  // and healthy, and the requested scope must still be explicitly selected.
  const access = accessFor(cwd).find((item) => item.sourceId === source);
  if (!access) return `Error: source "${source}" is not bound to this workspace.`;
  if (access.status !== "ok") return `Error: source "${source}" is ${access.status}.`;
  if (access.readPolicy === "deny") {
    return `Error: source "${source}" is metadata-only in this workspace (readPolicy: deny).`;
  }
  if (!access.scopes.includes(scope)) {
    return `Error: scope "${scope}" is not bound for source "${source}".`;
  }
  if (!access.definition) return `Error: source "${source}" is dangling.`;

  const adapter = connectorAdapterFor(access.kind);
  if (!adapter) return `Error: no adapter for kind "${access.kind}".`;

  try {
    // Validate resource ownership from the selected scope's metadata before
    // any content read. This prevents a valid id from another scope being used
    // after approval with otherwise unchanged source/scope arguments.
    const resources = await resourcesFor(access, scope, cwd);
    const listed = resources.some(
      (candidate) => candidate.id === resource && candidate.scopeId === scope,
    );
    if (!listed) {
      return `Error: resource "${resource}" is not listed in scope "${scope}" for source "${source}".`;
    }

    const content = await adapter.read(access.definition, resource, {
      maxBytes: DEFAULT_MAX_BYTES,
      signal,
      cwd,
    });
    if (content.resourceId !== resource) {
      return `Error: source "${source}" returned a different resource id.`;
    }

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

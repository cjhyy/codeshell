import { FIGMA_MCP_SERVER_URL, isFigmaMcpAction } from "@cjhyy/code-shell-link";
import type { Credential, OAuthCredentialSecret } from "../credentials/types.js";
import type { CredentialAccess, CredentialMetadata } from "../credentials/access.js";
import { CredentialStore } from "../credentials/store.js";
import {
  parseOAuthCredentialSecret,
  summarizeOAuthCredentialSecret,
} from "../credentials/oauth.js";
import { assertMcpOAuthCredentialBinding } from "../credentials/mcp-binding.js";
import { MCPManager, spillMcpImage } from "../tool-system/mcp-manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { canonicalOperationValue } from "../operations/ledger.js";
import { linkAuthoritySnapshot } from "./authority.js";
import { FIGMA_RESPONSE_BYTES } from "./figma.js";
import { assertFigmaMakeResourceUri, figmaMcpParameters } from "./figma-mcp-params.js";
import type { MCPServerConfig } from "../types.js";
import { isDeepStrictEqual } from "node:util";

export interface McpLinkActionRequest {
  cwd?: string;
  id: string;
  scope: "full" | "project";
  accountId: string;
  verifiedAt: string;
  action: string;
  params: Record<string, unknown>;
}

export class McpLinkActionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "changed"
      | "forbidden"
      | "reconnect"
      | "unsupported"
      | "response_too_large"
      | "resource_not_discovered"
      | "provider_error",
  ) {
    super(
      {
        invalid_request: "Invalid Figma MCP request.",
        changed: "Figma MCP connection changed; select the connection again.",
        forbidden: "This Figma connection does not grant the requested MCP action.",
        reconnect: "Figma MCP authorization requires reconnection in Figma Link.",
        unsupported: "This Figma MCP connection does not provide the requested capability.",
        response_too_large:
          "Figma MCP response exceeded 8 MiB. Read selected nodes or individual source resources instead.",
        resource_not_discovered:
          "Discover this Make file with get_design_context or list_resources on the same connection before reading a returned resource URI.",
        provider_error:
          "Figma MCP could not complete this request. Check the connection, file access, and available capabilities.",
      }[code],
    );
    this.name = "McpLinkActionError";
  }
}

export function isFigmaMcpCredential(
  credential: Pick<CredentialMetadata, "type" | "meta">,
): boolean {
  return (
    credential.type === "oauth" &&
    credential.meta?.linkProvider === "figma" &&
    String(credential.meta.linkExecutionBackend) === "mcp" &&
    String(credential.meta.linkAuthSource) === "mcp-oauth" &&
    credential.meta.linkExecutionRuntime === "local" &&
    credential.meta.mcpServerUrl === FIGMA_MCP_SERVER_URL
  );
}

interface McpLinkManager {
  connect(
    name: string,
    config: MCPServerConfig,
    workspace?: undefined,
    managedSelection?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  callToolEnvelope(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  listResourcesPage(
    server: string,
    params?: { cursor?: string },
    signal?: AbortSignal,
  ): Promise<{ resources: Array<{ uri: string; [key: string]: unknown }>; nextCursor?: string }>;
  readResourceResult(
    server: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<{
    contents: Array<{
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
      [key: string]: unknown;
    }>;
  }>;
  disconnectAll(): Promise<void>;
}

export interface McpLinkActionOptions {
  store?: CredentialStore;
  userStore?: CredentialStore;
  signal?: AbortSignal;
  assertAuthorized?: () => void;
  resolveOAuthAccess: NonNullable<CredentialAccess["resolveOAuthAccess"]>;
  /** Owned Host/test adapter; never accepted from LinkAction arguments. */
  createManager?: (access: CredentialAccess) => McpLinkManager;
  now?: () => number;
}

const resourceRefs = new Map<
  string,
  { authority: string; fileKey: string; expiresAt: number; uris: Set<string> }
>();
const RESOURCE_REF_TTL = 30 * 60_000;

function refsKey(id: string, fileKey: string): string {
  return JSON.stringify([id, fileKey]);
}
function admitResources(
  value: Record<string, unknown>,
  fileKey: string,
  action: string,
): Set<string> {
  const result = new Set<string>();
  const admit = (record: Record<string, unknown>) => {
    if (typeof record.uri === "string") {
      try {
        result.add(assertFigmaMakeResourceUri(record.uri, fileKey));
      } catch {
        /* unrelated references are data, not authority */
      }
    }
  };
  if (action === "list_resources" && Array.isArray(value.resources)) {
    for (const item of value.resources) if (item && typeof item === "object") admit(item);
  } else if (action === "get_design_context" && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "resource_link") admit(item);
      else if (item.type === "resource" && item.resource && typeof item.resource === "object")
        admit(item.resource);
    }
  }
  if (result.size > 2048) throw new McpLinkActionError("response_too_large");
  return result;
}

function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > FIGMA_RESPONSE_BYTES)
    throw new McpLinkActionError("response_too_large");
}

/** Host-owned execution: only read actions, one fixed official endpoint, no tokens returned to workers. */
export async function executeFigmaMcpLinkAction(
  input: McpLinkActionRequest,
  options: McpLinkActionOptions,
): Promise<unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.id !== "string" ||
    !input.id ||
    input.id.length > 512 ||
    !["full", "project"].includes(input.scope) ||
    (input.cwd !== undefined && typeof input.cwd !== "string") ||
    typeof input.accountId !== "string" ||
    !input.accountId ||
    typeof input.verifiedAt !== "string" ||
    !input.verifiedAt ||
    typeof input.action !== "string" ||
    !isFigmaMcpAction(input.action) ||
    !input.params ||
    typeof input.params !== "object" ||
    Array.isArray(input.params)
  )
    throw new McpLinkActionError("invalid_request");
  const params = JSON.parse(canonicalOperationValue(input.params, 64 * 1024));
  // Figma's unified connection is saved in the user store. Project overrides
  // must never select one account while the Host token resolver reads another.
  if (input.scope !== "full") throw new McpLinkActionError("forbidden");
  const request = figmaMcpParameters(input.action, params);
  const store = options.store ?? new CredentialStore(input.cwd);
  const userStore = options.userStore ?? new CredentialStore();
  const now = options.now ?? Date.now;
  const checkSignal = () => {
    options.signal?.throwIfAborted();
    options.assertAuthorized?.();
  };
  const read = (): Credential => {
    checkSignal();
    const value = store.resolve(input.id, input.scope);
    const userValue = userStore.resolve(input.id, "full");
    if (
      !value ||
      !userValue ||
      !isDeepStrictEqual(value, userValue) ||
      !isFigmaMcpCredential({ type: value.type, meta: value.meta }) ||
      value.meta?.linkAccountId !== input.accountId ||
      value.meta.linkLastVerifiedAt !== input.verifiedAt
    )
      throw new McpLinkActionError("changed");
    if (!value.meta.linkCapabilityIds?.includes(`figma.${input.action}`))
      throw new McpLinkActionError("forbidden");
    let secret: OAuthCredentialSecret;
    try {
      secret = parseOAuthCredentialSecret(value.secret ?? "");
      assertMcpOAuthCredentialBinding(value, FIGMA_MCP_SERVER_URL, secret);
    } catch {
      throw new McpLinkActionError("reconnect");
    }
    if (value.meta.linkOAuthState === "reconnect") throw new McpLinkActionError("reconnect");
    return value;
  };
  const metadata = (value: Credential): CredentialMetadata => ({
    id: value.id,
    type: value.type,
    label: value.label,
    hasSecret: Boolean(value.secret),
    meta: structuredClone(value.meta),
    oauthStatus: summarizeOAuthCredentialSecret(value.secret),
  });
  const original = read();
  const authority = linkAuthoritySnapshot(metadata(original));
  const assertConnected = () => {
    if (linkAuthoritySnapshot(metadata(read())) !== authority)
      throw new McpLinkActionError("changed");
  };
  const access: CredentialAccess = {
    listMasked: () => [metadata(read())],
    resolveMeta: (_cwd, id) => (id === input.id ? metadata(read()) : undefined),
    envExposures: () => ({}),
    resolveOAuthAccess: async (req) => {
      assertConnected();
      if (req.id !== input.id || req.serverUrl !== FIGMA_MCP_SERVER_URL)
        throw new McpLinkActionError("forbidden");
      const token = await options.resolveOAuthAccess(req);
      assertConnected();
      return token;
    },
  };
  const manager =
    options.createManager?.(access) ??
    new MCPManager(new ToolRegistry({ builtinTools: [] }), {
      defaultInstance: false,
      credentialAccess: access,
    });
  const serverName = "figma-link";
  const key = refsKey(input.id, request.target.fileKey);
  for (const [savedKey, refs] of resourceRefs)
    if (refs.expiresAt <= now()) resourceRefs.delete(savedKey);
  const discover = (value: Record<string, unknown>) => {
    if (request.target.fileType !== "make") return;
    const uris = admitResources(value, request.target.fileKey, input.action);
    if (!uris.size) return;
    const prior = resourceRefs.get(key);
    const combined = new Set([...(prior?.authority === authority ? prior.uris : []), ...uris]);
    if (combined.size > 2048 || (!prior && resourceRefs.size >= 128))
      throw new McpLinkActionError("response_too_large");
    resourceRefs.set(key, {
      authority,
      fileKey: request.target.fileKey,
      uris: combined,
      expiresAt: now() + RESOURCE_REF_TTL,
    });
  };
  try {
    assertConnected();
    if (input.action === "read_resource") {
      const ref = resourceRefs.get(key);
      if (
        !ref ||
        ref.authority !== authority ||
        !ref.uris.has(request.uri!) ||
        ref.expiresAt <= now()
      )
        throw new McpLinkActionError("resource_not_discovered");
    }
    await manager.connect(
      serverName,
      {
        name: "Figma",
        transport: "streamable-http",
        url: FIGMA_MCP_SERVER_URL,
        credentialRef: input.id,
        connectRetries: 0,
      },
      undefined,
      false,
      options.signal,
    );
    assertConnected();
    let data: Record<string, unknown>;
    if (input.action === "list_resources") {
      const page = await manager.listResourcesPage(
        serverName,
        { cursor: request.cursor },
        options.signal,
      );
      data = {
        ...page,
        resources: page.resources.filter((resource) => {
          try {
            assertFigmaMakeResourceUri(resource.uri, request.target.fileKey);
            return true;
          } catch {
            return false;
          }
        }),
      };
    } else if (input.action === "read_resource") {
      const value = await manager.readResourceResult(serverName, request.uri!, options.signal);
      if (value.contents.some((item) => item.uri !== request.uri))
        throw new McpLinkActionError("forbidden");
      data = value;
    } else {
      data = await manager.callToolEnvelope(serverName, input.action, request.args, options.signal);
    }
    assertConnected();
    bounded(data);
    if (data.isError === true)
      return {
        backend: "mcp",
        fileKey: request.target.fileKey,
        nodeId: request.target.nodeId,
        ...data,
      };
    // LinkAction's textual result refers to saved images, rather than emitting megabytes of base64.
    if (Array.isArray(data.content)) {
      const content: unknown[] = [];
      for (const block of data.content) {
        if (
          block &&
          typeof block === "object" &&
          block.type === "image" &&
          typeof block.data === "string"
        ) {
          assertConnected();
          const reference = await spillMcpImage(
            serverName,
            input.action,
            block.data,
            typeof block.mimeType === "string" ? block.mimeType : "image/png",
          );
          content.push({ type: "image", mimeType: block.mimeType, reference });
        } else content.push(block);
      }
      data = { ...data, content };
    }
    assertConnected();
    discover(data);
    return {
      backend: "mcp",
      fileKey: request.target.fileKey,
      fileType: request.target.fileType,
      ...(request.args.nodeId ? { nodeId: request.args.nodeId } : {}),
      ...data,
    };
  } catch (error) {
    if (
      error instanceof McpLinkActionError ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    if (error instanceof Error && /exceeded.*8 MiB|response.*too large/i.test(error.message))
      throw new McpLinkActionError("response_too_large");
    throw new McpLinkActionError("provider_error");
  } finally {
    await manager.disconnectAll();
  }
}

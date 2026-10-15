import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpAuthenticatedFetch,
  parseOAuthCredentialSecret,
  type Credential,
  type CredentialAccess,
  VERSION,
} from "@cjhyy/code-shell-core";
import { assertMcpOAuthCredentialBinding } from "@cjhyy/code-shell-core/internal";
import { FIGMA_MCP_SERVER_URL, FIGMA_MCP_TOOL_IDS } from "@cjhyy/code-shell-link";
import { HostLinkOAuthError, type HostLinkOAuthAdapter } from "@cjhyy/code-shell-server/links";
import {
  McpOAuthVerificationError,
  McpOAuthServiceError,
  type McpOAuthVerificationStage,
  type McpOAuthService,
} from "./mcp-oauth-service.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function authorizationUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    url.origin !== "https://www.figma.com" ||
    url.pathname !== "/oauth/mcp" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Unexpected Figma authorization endpoint");
  return url;
}

function accountResult(value: unknown): { id: string; label: string } {
  const result = record(value);
  if (!result || result.isError)
    throw new McpOAuthVerificationError("account_verification", "account_tool_error");
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536)
    throw new McpOAuthVerificationError("account_verification", "response_too_large");
  const candidates: unknown[] = [result.structuredContent];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const item = record(block);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    const text = item.text.trim();
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    try {
      candidates.push(JSON.parse(fenced?.[1] ?? text));
    } catch {
      /* Other text blocks carry no identity. */
    }
  }
  for (const candidate of candidates) {
    const account = record(record(candidate)?.user) ?? record(candidate);
    const email = typeof account?.email === "string" ? account.email.trim() : "";
    const id = typeof account?.id === "string" ? account.id.trim() : email.toLowerCase();
    const displayName =
      typeof account?.handle === "string" && account.handle.trim()
        ? account.handle.trim()
        : typeof account?.name === "string"
          ? account.name.trim()
          : "";
    const label =
      displayName && email && displayName !== email
        ? `${displayName} (${email})`
        : displayName || email;
    if (
      id &&
      id.length <= 512 &&
      label &&
      label.length <= 512 &&
      !/[\x00-\x1f\x7f]/.test(id + label)
    )
      return { id, label };
  }
  throw new McpOAuthVerificationError("account_verification", "account_identity_unavailable");
}

/** Figma policy stays in its adapter; OAuth custody and transport remain generic Host mechanisms. */
export function createFigmaMcpLinkAdapter(options: {
  oauth: Pick<McpOAuthService, "authorizeCredential" | "revokeDetachedCredential">;
  openExternal(url: string): Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
}): HostLinkOAuthAdapter {
  return {
    providerId: "figma",
    methodId: "mcp",
    authModeId: "mcp-oauth",
    label: "连接官方 MCP",
    async openAuthorizationUrl(rawUrl) {
      const url = authorizationUrl(rawUrl);
      await options.openExternal(url.href);
    },
    async authorize(input) {
      try {
        return await options.oauth.authorizeCredential(
          {
            source: "catalog",
            profileId: "figma-mcp",
            credentialId: input.id,
          },
          {
            signal: input.signal,
            callbackTimeoutMs: 10 * 60_000,
            onAuthorizationUrl: (url, expiresAt) =>
              input.onAuthorizationUrl(authorizationUrl(url).href, expiresAt),
            validateCredential: async (candidate, signal) => {
              let stage: McpOAuthVerificationStage = "credential_binding";
              let status: number | undefined;
              const client = new Client(
                { name: "CodeShell", version: VERSION },
                { capabilities: {} },
              );
              try {
                const secret = parseOAuthCredentialSecret(candidate.secret!);
                assertMcpOAuthCredentialBinding(candidate, FIGMA_MCP_SERVER_URL, secret);
                const access: CredentialAccess = {
                  listMasked: () => [],
                  resolveMeta: () => ({ ...candidate, secret: undefined, hasSecret: true }),
                  envExposures: () => ({}),
                  resolveOAuthAccess: async (request) => {
                    signal?.throwIfAborted();
                    assertMcpOAuthCredentialBinding(candidate, request.serverUrl, secret);
                    return { accessToken: secret.accessToken, expiresAt: secret.expiresAt };
                  },
                };
                const authenticatedFetch = createMcpAuthenticatedFetch(
                  "figma",
                  {
                    name: "figma",
                    transport: "streamable-http",
                    url: FIGMA_MCP_SERVER_URL,
                    credentialRef: candidate.id,
                  },
                  access,
                  (async (url, init) => {
                    const method = init?.method ?? (url instanceof Request ? url.method : "GET");
                    const response = await (options.fetch ?? fetch)(url, init);
                    if (method === "POST")
                      status = response.status >= 400 ? response.status : undefined;
                    return response;
                  }) as typeof fetch,
                );
                signal?.throwIfAborted();
                const transport = new StreamableHTTPClientTransport(new URL(FIGMA_MCP_SERVER_URL), {
                  fetch: ((url, init) =>
                    authenticatedFetch(url, {
                      ...init,
                      ...(signal
                        ? { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }
                        : {}),
                    })) as never,
                });
                stage = "mcp_initialize";
                await client.connect(transport);
                stage = "tool_discovery";
                status = undefined;
                const toolIds = new Set<string>();
                const cursors = new Set<string>();
                let cursor: string | undefined;
                let catalogBytes = 0;
                for (let page = 0; page < 100; page++) {
                  const discovered = await client.listTools(
                    cursor ? { cursor } : undefined,
                    signal ? { signal } : undefined,
                  );
                  catalogBytes += Buffer.byteLength(JSON.stringify(discovered));
                  if (catalogBytes > 8 * 1024 * 1024)
                    throw new McpOAuthVerificationError(stage, "response_too_large");
                  for (const tool of discovered.tools) toolIds.add(tool.name);
                  cursor = discovered.nextCursor;
                  if (!cursor) break;
                  if (cursors.has(cursor) || page === 99)
                    throw new McpOAuthVerificationError(stage, "invalid_pagination");
                  cursors.add(cursor);
                }
                if (!toolIds.has("whoami"))
                  throw new McpOAuthVerificationError(stage, "tool_unavailable");
                stage = "account_verification";
                status = undefined;
                const account = accountResult(
                  await client.callTool(
                    { name: "whoami", arguments: {} },
                    undefined,
                    signal ? { signal } : undefined,
                  ),
                );
                stage = "capability_verification";
                status = undefined;
                const capabilities: string[] = FIGMA_MCP_TOOL_IDS.filter((name) =>
                  toolIds.has(name),
                );
                if (client.getServerCapabilities()?.resources)
                  capabilities.push("list_resources", "read_resource");
                if (!capabilities.length)
                  throw new McpOAuthVerificationError(stage, "no_read_capabilities");
                signal?.throwIfAborted();
                return {
                  ...candidate,
                  label: input.label,
                  autoUseByAI: false,
                  meta: {
                    ...candidate.meta,
                    linkProvider: "figma",
                    linkConnectionMethod: "mcp",
                    linkExecutionRuntime: "local",
                    linkExecutionBackend: "mcp",
                    linkAuthSource: "mcp-oauth",
                    linkOAuthState: "connected",
                    agentExposable: false,
                    mcpServerName: "figma",
                    mcpServerUrl: FIGMA_MCP_SERVER_URL,
                    linkAccountId: account.id,
                    linkAccountLabel: account.label,
                    linkCapabilityIds: capabilities.map((name) => `figma.${name}`),
                    linkLastVerifiedAt: new Date((options.now ?? Date.now)()).toISOString(),
                  },
                } satisfies Credential;
              } catch (error) {
                if (error instanceof McpOAuthVerificationError) throw error;
                const reason = signal?.aborted
                  ? "cancelled"
                  : status
                    ? "http_error"
                    : stage === "credential_binding"
                      ? "binding_mismatch"
                      : /fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
                            error instanceof Error ? error.message : "",
                          )
                        ? "network_error"
                        : "protocol_error";
                throw new McpOAuthVerificationError(stage, reason, status);
              } finally {
                await client.close().catch(() => {});
              }
            },
          },
        );
      } catch (error) {
        if (error instanceof McpOAuthServiceError)
          throw new HostLinkOAuthError({
            code: error.code,
            stage: error.stage,
            ...(error.verificationStage ? { verificationStage: error.verificationStage } : {}),
            ...(error.reason ? { reason: error.reason } : {}),
            ...(error.status !== undefined ? { httpStatus: error.status } : {}),
          });
        throw error;
      }
    },
    async disconnect(credential) {
      await options.oauth.revokeDetachedCredential(credential);
    },
  };
}

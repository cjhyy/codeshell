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
import type { HostLinkOAuthAdapter } from "@cjhyy/code-shell-server/links";
import type { McpOAuthService } from "./mcp-oauth-service.js";

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
  if (!result || result.isError) throw new Error("Figma MCP account verification failed");
  let account = record(result.structuredContent);
  if (!account) {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .flatMap((block) => {
        const item = record(block);
        return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n");
    if (Buffer.byteLength(text) > 65_536)
      throw new Error("Figma MCP account response is too large");
    try {
      account = record(JSON.parse(text));
    } catch {
      /* Fixed error below. */
    }
  }
  account = record(account?.user) ?? account;
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  const id = typeof account?.id === "string" ? account.id : email.toLowerCase();
  const label =
    typeof account?.name === "string" && account.name.trim() ? account.name.trim() : email;
  if (!id || id.length > 512 || !label || label.length > 512 || /[\x00-\x1f\x7f]/.test(id + label))
    throw new Error("Figma MCP account identity is unavailable");
  return { id, label: email && label !== email ? `${label} (${email})` : label };
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
      return options.oauth.authorizeCredential(
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
              options.fetch ?? fetch,
            );
            const client = new Client(
              { name: "CodeShell", version: VERSION },
              { capabilities: {} },
            );
            try {
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
              await client.connect(transport);
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
                  throw new Error("Figma MCP tool catalog is too large");
                for (const tool of discovered.tools) toolIds.add(tool.name);
                cursor = discovered.nextCursor;
                if (!cursor) break;
                if (cursors.has(cursor) || page === 99)
                  throw new Error("Figma MCP tool catalog pagination is invalid");
                cursors.add(cursor);
              }
              if (!toolIds.has("whoami"))
                throw new Error("Figma MCP does not provide account verification");
              const account = accountResult(
                await client.callTool(
                  { name: "whoami", arguments: {} },
                  undefined,
                  signal ? { signal } : undefined,
                ),
              );
              const capabilities: string[] = FIGMA_MCP_TOOL_IDS.filter((name) => toolIds.has(name));
              if (client.getServerCapabilities()?.resources)
                capabilities.push("list_resources", "read_resource");
              if (!capabilities.length)
                throw new Error("Figma MCP has no supported read capabilities");
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
            } finally {
              await client.close().catch(() => {});
            }
          },
        },
      );
    },
    async disconnect(credential) {
      await options.oauth.revokeDetachedCredential(credential);
    },
  };
}

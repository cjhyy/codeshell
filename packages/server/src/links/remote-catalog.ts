import { beginRemoteLinkAuthorization, type RemoteLinkConfiguration } from "@cjhyy/code-shell-core";

import { REMOTE_LINK_PROVIDER_ADAPTERS, type RemoteLinkProviderId } from "@cjhyy/code-shell-core";

export type RemoteLinkCatalogFailureReason =
  | "network"
  | "timeout"
  | "http_status"
  | "invalid_json"
  | "invalid_schema"
  | "unreviewed_capability"
  | "unsupported_auth"
  | "response_limit";

/** Fixed diagnostics distinguish unavailable discovery from a valid empty catalog. */
export class RemoteLinkCatalogError extends Error {
  readonly code: "network_error" | "http_error" | "invalid_response" | "response_too_large";
  constructor(
    readonly reason: RemoteLinkCatalogFailureReason,
    readonly httpStatus?: number,
  ) {
    super(
      {
        network: "Could not reach the Link provider catalog. Retry the request.",
        timeout: "The Link provider catalog request timed out. Retry the request.",
        http_status: "The Link provider catalog returned an unsuccessful HTTP status.",
        invalid_json: "The Link provider catalog response is not valid JSON.",
        invalid_schema: "The Link provider catalog response does not match the supported protocol.",
        unreviewed_capability: "The Link provider catalog advertised an unreviewed capability.",
        unsupported_auth: "The Link provider catalog uses an unsupported authorization mechanism.",
        response_limit: "The Link provider catalog exceeded the 32 KiB response limit.",
      }[reason],
    );
    this.name = "RemoteLinkCatalogError";
    this.code =
      reason === "network" || reason === "timeout"
        ? "network_error"
        : reason === "http_status"
          ? "http_error"
          : reason === "response_limit"
            ? "response_too_large"
            : "invalid_response";
  }
}

/** The Host's compiled executors own authority, never remotely supplied presentation metadata. */
export const REMOTE_LINK_ADAPTERS = REMOTE_LINK_PROVIDER_ADAPTERS.map((adapter) => ({
  ...adapter,
  methodId: "remote-link",
  authModeId: "remote-link",
  scopes: adapter.actions.map((action) => `${adapter.id}:${action}`),
}));
export type RemoteProviderId = RemoteLinkProviderId;
export interface RemoteProviderCapabilities {
  id: RemoteProviderId;
  actions: string[];
  scopes: string[];
}

export async function readRemoteProviderCatalog(
  configuration: RemoteLinkConfiguration,
): Promise<RemoteProviderId[]> {
  return (await readRemoteProviderCapabilities(configuration)).map((provider) => provider.id);
}

/** Discovery never grants authority or turns a failed response into an empty catalog. */
export async function readRemoteProviderCapabilities(
  configuration: RemoteLinkConfiguration,
): Promise<RemoteProviderCapabilities[]> {
  const issuer = beginRemoteLinkAuthorization(configuration).configuration.issuer;
  const scopes = REMOTE_LINK_ADAPTERS.flatMap((adapter) => adapter.scopes);
  const capabilities = JSON.stringify({ version: 1, scopes });
  if (scopes.length > 128 || Buffer.byteLength(capabilities) > 4_096)
    throw new Error("Host Link capabilities exceed catalog negotiation limits");
  const signal = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await fetch(new URL("/api/v1/links/providers", issuer), {
      redirect: "error",
      signal,
      headers: { Accept: "application/json", "X-CodeShell-Link-Capabilities": capabilities },
    });
  } catch (error) {
    throw new RemoteLinkCatalogError(
      signal.aborted || (error instanceof Error && error.name === "TimeoutError")
        ? "timeout"
        : "network",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new RemoteLinkCatalogError("http_status", response.status);
  }
  if (!response.body) throw new RemoteLinkCatalogError("invalid_schema");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) {
        throw new RemoteLinkCatalogError("response_limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof RemoteLinkCatalogError) throw error;
    throw new RemoteLinkCatalogError(signal.aborted ? "timeout" : "network");
  } finally {
    reader.releaseLock();
  }
  let catalog: any;
  try {
    catalog = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RemoteLinkCatalogError("invalid_json");
  }
  if (catalog?.version !== 1 || !Array.isArray(catalog.providers) || catalog.providers.length > 32)
    throw new RemoteLinkCatalogError("invalid_schema");
  if (
    catalog.providers.some(
      (item: unknown) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as { id?: unknown }).id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test((item as { id: string }).id),
    )
  )
    throw new RemoteLinkCatalogError("invalid_schema");
  const ids = catalog.providers.map((item: { id: string }) => item.id);
  if (new Set(ids).size !== ids.length) throw new RemoteLinkCatalogError("invalid_schema");
  return REMOTE_LINK_ADAPTERS.flatMap((adapter): RemoteProviderCapabilities[] => {
    const matches = catalog.providers.filter((item: any) => item?.id === adapter.id);
    if (!matches.length) return [];
    const provider = matches[0];
    const actions = provider.actions;
    const scopes = provider.scopes;
    if (
      !Array.isArray(actions) ||
      !actions.length ||
      actions.length > adapter.actions.length ||
      new Set(actions).size !== actions.length ||
      actions.some((action) => !(adapter.actions as readonly string[]).includes(action)) ||
      !Array.isArray(scopes) ||
      scopes.length !== actions.length ||
      new Set(scopes).size !== scopes.length ||
      actions.some((action) => !scopes.includes(`${adapter.id}:${action}`))
    )
      throw new RemoteLinkCatalogError("unreviewed_capability");
    const methods = Array.isArray(provider.methods)
      ? provider.methods.filter((method: any) => method?.id === adapter.methodId)
      : [];
    if (
      methods.length !== 1 ||
      !methods.some(
        (method: any) =>
          method?.id === adapter.methodId &&
          method.authKind === "oauth" &&
          method.defaultAuthModeId === "browser" &&
          Array.isArray(method.authModes) &&
          method.authModes.filter((mode: any) => mode?.id === "browser").length === 1 &&
          method.authModes.some((mode: any) => mode?.id === "browser" && mode.kind === "redirect"),
      )
    )
      throw new RemoteLinkCatalogError("unsupported_auth");
    return [{ id: adapter.id, actions: [...actions], scopes: [...scopes] }];
  });
}

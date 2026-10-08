import { beginRemoteLinkAuthorization, type RemoteLinkConfiguration } from "@cjhyy/code-shell-core";

/** Reviewed Host adapters: remote presentation data cannot add executors or navigation authority. */
export const REMOTE_LINK_ADAPTERS = [
  {
    id: "github",
    name: "GitHub",
    methodId: "remote-link",
    authModeId: "remote-link",
    actions: ["list_repositories", "list_issues", "get_issue"],
    scopes: ["github:list_repositories", "github:list_issues", "github:get_issue"],
  },
] as const;

export type RemoteProviderId = (typeof REMOTE_LINK_ADAPTERS)[number]["id"];

/** A legacy v1 service has no catalog. Its one already-reviewed adapter remains compatible. */
export async function readRemoteProviderCatalog(
  configuration: RemoteLinkConfiguration,
): Promise<RemoteProviderId[]> {
  const issuer = beginRemoteLinkAuthorization(configuration).configuration.issuer;
  const response = await fetch(new URL("/api/v1/links/providers", issuer), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { Accept: "application/json" },
  });
  if ([404, 501].includes(response.status)) {
    await response.body?.cancel();
    return ["github"];
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Link catalog unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) {
        await reader.cancel();
        return [];
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let catalog: any;
  try {
    catalog = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return [];
  }
  if (catalog?.version !== 1 || !Array.isArray(catalog.providers) || catalog.providers.length > 32)
    return [];
  return REMOTE_LINK_ADAPTERS.filter((adapter) => {
    const matches = catalog.providers.filter((item: any) => item?.id === adapter.id);
    if (matches.length !== 1) return false;
    const provider = matches[0];
    return (
      Array.isArray(provider.scopes) &&
      provider.scopes.length === adapter.scopes.length &&
      adapter.scopes.every((scope) => provider.scopes.includes(scope)) &&
      Array.isArray(provider.actions) &&
      provider.actions.length === adapter.actions.length &&
      adapter.actions.every((action) => provider.actions.includes(action)) &&
      Array.isArray(provider.methods) &&
      provider.methods.some(
        (method: any) =>
          method?.id === adapter.methodId &&
          method.authKind === "oauth" &&
          method.defaultAuthModeId === "browser" &&
          Array.isArray(method.authModes) &&
          method.authModes.some((mode: any) => mode?.id === "browser" && mode.kind === "redirect"),
      )
    );
  }).map((adapter) => adapter.id);
}

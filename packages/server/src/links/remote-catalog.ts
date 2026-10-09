import { beginRemoteLinkAuthorization, type RemoteLinkConfiguration } from "@cjhyy/code-shell-core";

import {
  REMOTE_LINK_PROVIDER_ADAPTERS,
  LEGACY_GITHUB_ACTIONS,
  type RemoteLinkProviderId,
} from "@cjhyy/code-shell-core";

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
export const LEGACY_REMOTE_PROVIDERS: RemoteProviderCapabilities[] = [
  {
    id: "github",
    actions: [...LEGACY_GITHUB_ACTIONS],
    scopes: LEGACY_GITHUB_ACTIONS.map((action) => `github:${action}`),
  },
];

export async function readRemoteProviderCatalog(
  configuration: RemoteLinkConfiguration,
): Promise<RemoteProviderId[]> {
  return (await readRemoteProviderCapabilities(configuration)).map((provider) => provider.id);
}

/** A legacy v1 service has no catalog. Its one already-reviewed adapter remains compatible. */
export async function readRemoteProviderCapabilities(
  configuration: RemoteLinkConfiguration,
): Promise<RemoteProviderCapabilities[]> {
  const issuer = beginRemoteLinkAuthorization(configuration).configuration.issuer;
  const scopes = REMOTE_LINK_ADAPTERS.flatMap((adapter) => adapter.scopes);
  const capabilities = JSON.stringify({ version: 1, scopes });
  if (scopes.length > 128 || Buffer.byteLength(capabilities) > 4_096)
    throw new Error("Host Link capabilities exceed catalog negotiation limits");
  const response = await fetch(new URL("/api/v1/links/providers", issuer), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { Accept: "application/json", "X-CodeShell-Link-Capabilities": capabilities },
  });
  if ([404, 501].includes(response.status)) {
    await response.body?.cancel();
    return structuredClone(LEGACY_REMOTE_PROVIDERS);
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
  return REMOTE_LINK_ADAPTERS.flatMap((adapter): RemoteProviderCapabilities[] => {
    const matches = catalog.providers.filter((item: any) => item?.id === adapter.id);
    if (matches.length !== 1) return [];
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
      return [];
    if (
      !Array.isArray(provider.methods) ||
      !provider.methods.some(
        (method: any) =>
          method?.id === adapter.methodId &&
          method.authKind === "oauth" &&
          method.defaultAuthModeId === "browser" &&
          Array.isArray(method.authModes) &&
          method.authModes.some((mode: any) => mode?.id === "browser" && mode.kind === "redirect"),
      )
    )
      return [];
    return [{ id: adapter.id, actions: [...actions], scopes: [...scopes] }];
  });
}

import type { MaskedLinkConnection } from "@cjhyy/code-shell-link";
import type { LocalLinkProviderView } from "../../preload/types";
import type { MaskedCredentialView } from "./types";

export function linkCredentialProvider(credential: MaskedCredentialView): string | undefined {
  if (credential.meta?.linkProvider) return credential.meta.linkProvider;
  if (credential.meta?.oauthProvider) return credential.meta.oauthProvider;
  return credential.id.endsWith("-oauth") ? credential.id.slice(0, -6) || undefined : undefined;
}

/** A partial catalog never removes saved accounts or replaces their authority. */
export function mergeLinkDirectoryProviders(
  local: LocalLinkProviderView[],
  remote: LocalLinkProviderView[] | undefined,
  credentials: MaskedCredentialView[],
  connections: MaskedLinkConnection[] = [],
): LocalLinkProviderView[] {
  const providers = new Map(local.map((provider) => [provider.id, provider]));
  for (const provider of remote ?? []) {
    const previous = providers.get(provider.id);
    providers.set(provider.id, {
      ...previous,
      ...provider,
      connectionMethods: [
        ...(previous?.connectionMethods ?? []).filter(
          (method) => !provider.connectionMethods.some((next) => next.id === method.id),
        ),
        ...provider.connectionMethods,
      ],
    });
  }
  const ensure = (id: string) => {
    let provider = providers.get(id);
    if (!provider) {
      provider = {
        id,
        displayName: id === "figma" ? "Figma" : id === "github" ? "GitHub" : id,
        category: "work",
        description: { zh: "管理已保存的连接。", en: "Manage saved connections." },
        brandText: id.slice(0, 2).toUpperCase(),
        icon: "conversation",
        accent: "neutral",
        connectionMethods: [],
        actionIds: [],
        tokenLabel: "Token",
        tokenPlaceholder: "",
        actions: [],
      };
      providers.set(id, provider);
    }
    return provider;
  };
  for (const connection of connections) ensure(connection.providerId);
  for (const credential of credentials) {
    const id = linkCredentialProvider(credential);
    if (!id) continue;
    const provider = ensure(id);
    // Provider-managed connections stay in their exact Host channel. Catalog
    // fallback describes display state only and never synthesizes an auth mode.
    if (["remote", "mcp"].includes(credential.meta?.linkExecutionBackend ?? "")) continue;
    const runtime =
      credential.meta?.linkExecutionRuntime ?? (credential.type === "oauth" ? "server" : "local");
    const explicitMethod = credential.meta?.linkConnectionMethod;
    if (
      !explicitMethod &&
      provider.connectionMethods.some(
        (method) => method.executionRuntime === runtime && method.id !== "mcp",
      )
    )
      continue;
    const methodId = explicitMethod ?? `saved-${runtime}`;
    if (provider.connectionMethods.some((method) => method.id === methodId)) continue;
    providers.set(id, {
      ...provider,
      connectionMethods: [
        ...provider.connectionMethods,
        {
          id: methodId,
          displayName: { zh: "已保存的连接", en: "Saved connection" },
          executionRuntime: runtime,
          secretLocation: runtime === "server" ? "server" : "device",
          authKind: credential.type === "oauth" ? "oauth" : "token",
          availability: "coming-soon",
        },
      ],
    });
  }
  return [...providers.values()];
}

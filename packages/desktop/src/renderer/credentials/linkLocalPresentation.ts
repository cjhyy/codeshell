import type { LinkProviderView, LinkSnapshot } from "@cjhyy/code-shell-link";

/** Display projection only. Saved cloud connections and credentials remain with their Host. */
export function localLinkProvider(provider: LinkProviderView): LinkProviderView {
  const connectionMethods = provider.connectionMethods.filter(
    (method) => method.executionRuntime === "local",
  );
  const localMethods = new Set(connectionMethods.map((method) => method.id));
  return {
    ...provider,
    connectionMethods,
    authModes: provider.authModes?.filter(
      (mode) => mode.id !== "remote-link" && localMethods.has(mode.methodId),
    ),
  };
}

export function localLinkSnapshot(snapshot?: LinkSnapshot): LinkSnapshot | undefined {
  if (!snapshot) return undefined;
  const {
    remoteServer: _server,
    remoteCatalog: _catalog,
    remoteCleanupPending: _cleanup,
    ...local
  } = snapshot;
  return {
    ...local,
    providers: snapshot.providers.map(localLinkProvider),
    connections: snapshot.connections.filter(
      (connection) => connection.runtime === "local" && connection.authSource !== "remote-link",
    ),
    capabilities: { ...snapshot.capabilities, remoteAuth: false },
  };
}

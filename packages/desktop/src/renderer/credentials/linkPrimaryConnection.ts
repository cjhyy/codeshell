import type { LinkAuthMode, LinkProviderView, MaskedLinkConnection } from "@cjhyy/code-shell-link";

export interface PrimaryLinkOption {
  id: string;
  methodId: string;
  credentialId?: string;
  usable?: boolean;
  available?: boolean;
}

/** Select presentation only; connection identities, grants and runtime defaults stay unchanged. */
export function selectPrimaryLinkOption({
  provider,
  connections,
  options,
}: {
  provider?: LinkProviderView;
  connections: readonly MaskedLinkConnection[];
  options: readonly PrimaryLinkOption[];
}): string | undefined {
  const accounts = provider
    ? connections.filter((connection) => connection.providerId === provider.id)
    : connections;
  const matchesConnection = (
    option: PrimaryLinkOption,
    connection: MaskedLinkConnection,
  ): boolean =>
    connection.authSource === "remote-link" || connection.authSource === "mcp-oauth"
      ? option.id === connection.authSource
      : option.credentialId === connection.id;
  const connected = options.find((option) =>
    accounts.some(
      (connection) => connection.status === "connected" && matchesConnection(option, connection),
    ),
  );
  if (connected) return connected.id;
  const usable = options.find((option) => option.usable);
  if (usable) return usable.id;
  const savedConnection = options.find((option) =>
    accounts.some((connection) => matchesConnection(option, connection)),
  );
  if (savedConnection) return savedConnection.id;
  const savedCredential = options.find((option) => option.credentialId !== undefined);
  if (savedCredential) return savedCredential.id;

  const matchesMode = (option: PrimaryLinkOption, mode: LinkAuthMode): boolean =>
    option.available === true &&
    option.methodId === mode.methodId &&
    (option.id === mode.id || option.id.startsWith(`method:${mode.methodId}:`));
  const modes = provider?.authModes?.filter((mode) => mode.available) ?? [];
  for (const preferred of [true, false]) {
    for (const mode of modes) {
      if (Boolean(mode.preferred) !== preferred) continue;
      const option = options.find((candidate) => matchesMode(candidate, mode));
      if (option) return option.id;
    }
  }
  return options.find((option) => option.available === true)?.id;
}

import type { LocalLinkProviderSpec, LocalLinkProviderSummary } from "./types.js";

const registeredProviders: LocalLinkProviderSpec[] = [];
/** Live read-only view; Core deliberately ships no implicit provider implementations. */
export const LOCAL_LINK_PROVIDERS: readonly LocalLinkProviderSpec[] = registeredProviders;

/** Trusted composition seam. Register once before constructing an Engine/Host. */
export function registerLocalLinkProviders(providers: readonly LocalLinkProviderSpec[]): void {
  const known = new Set(registeredProviders.map((provider) => provider.id));
  const reviewed = providers.map((provider) => {
    if (!provider.id || known.has(provider.id) || typeof provider.validate !== "function")
      throw new Error("Invalid or duplicate Link provider registration");
    known.add(provider.id);
    const actionIds = new Set<string>();
    const actions = provider.actions.map((action) => {
      if (!action.id || actionIds.has(action.id) || typeof action.execute !== "function")
        throw new Error("Invalid or duplicate Link action registration");
      actionIds.add(action.id);
      return Object.freeze({ ...action });
    });
    if (provider.credentialActionIds?.some((id) => !actionIds.has(id)))
      throw new Error("Credential validation cannot enable an unregistered Link action");
    return Object.freeze({
      ...provider,
      actions: Object.freeze(actions),
      ...(provider.credentialActionIds
        ? { credentialActionIds: Object.freeze([...provider.credentialActionIds]) }
        : {}),
    });
  });
  registeredProviders.push(...reviewed);
}

export function getLocalLinkProvider(providerId: string): LocalLinkProviderSpec | undefined {
  return LOCAL_LINK_PROVIDERS.find((provider) => provider.id === providerId);
}

export function listLocalLinkProviders(): LocalLinkProviderSummary[] {
  return LOCAL_LINK_PROVIDERS.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    tokenLabel: provider.tokenLabel,
    tokenPlaceholder: provider.tokenPlaceholder,
    actions: provider.actions.map(({ id, title, description, risk }) => ({
      id,
      title,
      description,
      risk,
    })),
  }));
}

export async function validateLocalLinkToken(
  providerId: string,
  token: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; authKind?: "token" | "oauth" } = {},
): Promise<import("./types.js").LocalLinkValidationResult> {
  const provider = getLocalLinkProvider(providerId);
  if (!provider) throw new Error(`Unknown local Link provider: ${providerId}`);
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Token is required");
  const identity = await provider.validate({ token: trimmed, ...options });
  return {
    providerId,
    identity,
    capabilityIds: provider.actions
      .filter(
        (actionSpec) =>
          !provider.credentialActionIds || provider.credentialActionIds.includes(actionSpec.id),
      )
      .map((actionSpec) => `${providerId}.${actionSpec.id}`),
    verifiedAt: new Date().toISOString(),
  };
}

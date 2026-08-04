import { LINK_PROVIDER_MANIFESTS, type LinkProviderManifest } from "@cjhyy/code-shell-link";
import { listLocalLinkProviders, type LocalLinkProviderSummary } from "@cjhyy/code-shell-core";

export type DesktopLinkProviderView = LinkProviderManifest &
  Pick<LocalLinkProviderSummary, "tokenLabel" | "tokenPlaceholder" | "actions">;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * The independent Link package owns portable provider/auth metadata; Core owns
 * trusted executors. Desktop is the host boundary that validates and combines
 * them before any manifest reaches the renderer.
 */
export function composeLinkProviderCatalog(
  manifests: readonly LinkProviderManifest[],
  executors: readonly LocalLinkProviderSummary[],
): DesktopLinkProviderView[] {
  const manifestIds = manifests.map((provider) => provider.id);
  const executorIds = executors.map((provider) => provider.id);
  if (!unique(manifestIds) || !unique(executorIds)) {
    throw new Error("Link provider ids must be unique");
  }
  if (
    manifestIds.length !== executorIds.length ||
    manifestIds.some((providerId) => !executorIds.includes(providerId))
  ) {
    throw new Error("Link provider manifests and local executors are out of sync");
  }

  return manifests.map((manifest) => {
    const executor = executors.find((candidate) => candidate.id === manifest.id)!;
    const declared = manifest.actionIds;
    const implemented = executor.actions.map((action) => action.id);
    if (
      !unique(declared) ||
      !unique(implemented) ||
      declared.length !== implemented.length ||
      declared.some((actionId) => !implemented.includes(actionId))
    ) {
      throw new Error(`Link provider manifest Actions are out of sync: ${manifest.id}`);
    }
    return {
      ...manifest,
      tokenLabel: executor.tokenLabel,
      tokenPlaceholder: executor.tokenPlaceholder,
      actions: executor.actions,
    };
  });
}

export function listDesktopLinkProviders(): DesktopLinkProviderView[] {
  return composeLinkProviderCatalog(LINK_PROVIDER_MANIFESTS, listLocalLinkProviders());
}

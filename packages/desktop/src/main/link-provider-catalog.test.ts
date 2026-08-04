import { describe, expect, test } from "bun:test";
import { LINK_PROVIDER_MANIFESTS } from "@cjhyy/code-shell-link";
import { listLocalLinkProviders } from "@cjhyy/code-shell-core";
import { composeLinkProviderCatalog, listDesktopLinkProviders } from "./link-provider-catalog.js";

describe("desktop Link provider catalog", () => {
  test("combines all independent manifests with matching trusted executors", () => {
    const providers = listDesktopLinkProviders();
    expect(providers).toHaveLength(10);
    expect(providers.map((provider) => provider.id)).toEqual(
      LINK_PROVIDER_MANIFESTS.map((provider) => provider.id),
    );
    expect(
      providers.every((provider) => provider.actions.length === provider.actionIds.length),
    ).toBe(true);
  });

  test("fails closed when a separately versioned manifest changes its Action contract", () => {
    const manifests = structuredClone(LINK_PROVIDER_MANIFESTS);
    manifests[0]!.actionIds = ["unexpected_action"];
    expect(() => composeLinkProviderCatalog(manifests, listLocalLinkProviders())).toThrow(
      "Actions are out of sync: github",
    );
  });
});

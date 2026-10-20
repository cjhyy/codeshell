let installed: Promise<void> | undefined;

/** Test-owned composition; call only after the suite installed its network guard. */
export function installTestLinkProviders(): Promise<void> {
  return (installed ??= Promise.all([
    import("../../packages/core/src/links/providers.js"),
    import("../../packages/server/src/links/providers/defaults.js"),
    import("../../packages/core/src/links/http.js"),
    import("../../packages/core/src/links/figma.js"),
    import("../../packages/core/src/links/source-reads.js"),
    import("../../packages/core/src/links/github-star.js"),
    import("../../packages/core/src/links/github-issue-state.js"),
  ]).then(([registry, product, http, figma, source, star, issue]) => {
    registry.registerLocalLinkProviders(
      product.createDefaultLinkProviders({
        ...http,
        ...figma,
        ...source,
        ...star,
        ...issue,
      }),
    );
  }));
}

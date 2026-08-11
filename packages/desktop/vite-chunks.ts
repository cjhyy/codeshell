/** Stable vendor boundaries shared by the desktop and mobile renderer builds. */
export function rendererManualChunks(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/");
  if (normalized.includes("/packages/web/src/")) return "codeshell-web";
  if (!normalized.includes("/node_modules/")) return undefined;

  if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(normalized)) {
    return "react-vendor";
  }
  if (normalized.includes("/node_modules/lucide-react/")) return "icons-vendor";
  if (
    normalized.includes("/node_modules/@radix-ui/") ||
    normalized.includes("/node_modules/cmdk/")
  ) {
    return "ui-vendor";
  }
  if (
    /\/node_modules\/(?:react-markdown|remark-|rehype-|unified|mdast-|micromark|hast-|unist-)/.test(
      normalized,
    )
  ) {
    return "markdown-vendor";
  }
  if (normalized.includes("/node_modules/highlight.js/")) return "syntax-vendor";
  if (normalized.includes("/node_modules/@xterm/")) return "terminal-vendor";
  return undefined;
}

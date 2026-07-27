import { assertSafeThemeName, THEME_ASSET_DIR } from "@cjhyy/code-shell-core";

/**
 * Pure cstheme:// url helpers, kept free of any electron import so they are
 * unit-testable. The protocol handler (theme-asset-protocol.ts) builds on these.
 */
export const THEME_ASSET_SCHEME = "cstheme";

export interface ParsedThemeUrl {
  id: string;
  relativePath: string;
}

/**
 * Parse a cstheme:// asset url into { id, relativePath }, or null when it is not
 * a safe canonical-asset request. Only `<THEME_ASSET_DIR>/<file>` (exactly two
 * segments) under a safe theme id is reachable.
 */
export function parseThemeUrl(source: string): ParsedThemeUrl | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${THEME_ASSET_SCHEME}:` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    return null;
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    segments[0] !== THEME_ASSET_DIR ||
    segments.length !== 2 ||
    !segments[1] ||
    segments[1] === "." ||
    segments[1] === ".."
  ) {
    return null;
  }
  try {
    assertSafeThemeName(url.hostname);
  } catch {
    return null;
  }
  return { id: url.hostname, relativePath };
}

/** Build the cstheme:// url for an installed asset's canonical relative path. */
export function themeAssetUrl(id: string, relativePath: string): string {
  const pathname = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${THEME_ASSET_SCHEME}://${id}/${pathname}`;
}

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DESKTOP_LINK_PROVIDER_BUNDLE = "out/worker/link-providers.mjs";

/** Packaged workers load an owned bundle; development keeps workspace resolution. */
export function desktopLinkProviderModuleUrl(
  host: { isPackaged: boolean; getAppPath(): string },
  resolveDevelopment: () => string,
): string {
  return host.isPackaged
    ? pathToFileURL(join(host.getAppPath(), DESKTOP_LINK_PROVIDER_BUNDLE)).href
    : resolveDevelopment();
}

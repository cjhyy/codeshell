import * as os from "node:os";
import * as path from "node:path";

export function safeBrowserRuntimeProfileId(profileId: string): string {
  return profileId.replace(/[^a-zA-Z0-9_:.@-]/g, "_").slice(0, 160) || "anonymous";
}

/** Electron storage partition for the fallback backend only. */
export function browserRuntimePartition(profileId: string): string {
  return `persist:browser-runtime:${safeBrowserRuntimeProfileId(profileId)}`;
}

/** Playwright profiles are separate filesystem profiles, never BrowserPanel data. */
export function defaultBrowserRuntimeProfilesRoot(): string {
  return path.join(os.homedir(), ".code-shell", "browser-runtime", "profiles");
}

export function browserRuntimeProfilePath(root: string, profileId: string): string {
  return path.join(root, safeBrowserRuntimeProfileId(profileId));
}

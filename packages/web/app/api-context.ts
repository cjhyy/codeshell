// A browser window shows one workspace at a time. Controllers update this
// before mounting its keyed management views. Each request captures its scope.
let workspace: string | undefined;

export function setApiWorkspace(cwd?: string): void {
  workspace = cwd || undefined;
}

export function getApiWorkspace(): string | undefined {
  return workspace;
}

export function apiWorkspaceHeaders(cwd = workspace): Record<string, string> {
  return cwd ? { "X-CodeShell-Workspace": encodeURIComponent(cwd) } : {};
}

/** Cookie-authenticated image/download links cannot send a custom header. */
export function apiUrl(path: string, cwd = workspace): string {
  if (!cwd) return path;
  if (!path.startsWith("/api/v1/")) throw new Error("Workspace URLs must use the local API");
  const url = new URL(path, "http://codeshell.invalid");
  url.searchParams.set("workspace", cwd);
  return `${url.pathname}${url.search}${url.hash}`;
}

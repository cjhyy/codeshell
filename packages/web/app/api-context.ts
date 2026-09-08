// Delayed operations capture scope before starting; keyed workbenches discard
// the previous project's drafts and connections when selection changes.
let workspace: string | undefined;
let project: string | null = null;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_PATH = /^\/p\/([0-9a-f-]{36})(\/.*)$/;

export interface ApiScope {
  workspace: string;
  projectId: string | null;
}

export function validProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID.test(value);
}

export function setApiProject(id: string | null): void {
  if (id !== null && !validProjectId(id)) throw new Error("项目标识无效。");
  project = id;
}

export function getApiProject(): string | null {
  return project;
}

export function captureApiScope(): ApiScope {
  return { workspace: workspace ?? "", projectId: project };
}

export function setApiWorkspace(cwd?: string): void {
  workspace = cwd || undefined;
}

export function getApiWorkspace(): string | undefined {
  return workspace;
}

export function apiWorkspaceHeaders(cwd = workspace): Record<string, string> {
  return cwd ? { "X-CodeShell-Workspace": encodeURIComponent(cwd) } : {};
}

export function isControlPlaneUrl(path: string): boolean {
  return (
    /^\/api\/v1\/(?:auth|projects)(?:\/|\?|$)/.test(path) ||
    /^\/api\/v1\/desktop\/session(?:\?|$)/.test(path)
  );
}

export function isProjectUrl(path: string): boolean {
  const match = PROJECT_PATH.exec(path);
  return !!match && validProjectId(match[1]);
}

/** Cookie-authenticated assets/downloads and HTTP/WS share the same project. */
export function apiUrl(path: string, cwd = workspace, projectId = project): string {
  const match = PROJECT_PATH.exec(path);
  const localPath = match ? match[2] : path;
  if (
    (match && !validProjectId(match[1])) ||
    (!localPath.startsWith("/api/v1/") && localPath !== "/ws") ||
    /[\\\r\n]/.test(path)
  )
    throw new Error("Workspace URLs must use the local API");
  const url = new URL(localPath, "http://codeshell.invalid");
  if (url.pathname !== localPath.split(/[?#]/, 1)[0])
    throw new Error("Workspace URLs must use the local API");
  if (isControlPlaneUrl(localPath)) return localPath;
  // A fully scoped URL is immutable, including its original workspace query.
  if (match) return path;
  if (projectId !== null && !validProjectId(projectId)) throw new Error("项目标识无效。");
  if (cwd && localPath.startsWith("/api/v1/")) url.searchParams.set("workspace", cwd);
  return `${projectId ? `/p/${projectId}` : ""}${url.pathname}${url.search}${url.hash}`;
}

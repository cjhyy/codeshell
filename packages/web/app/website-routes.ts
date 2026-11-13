import { validProjectId } from "./api-context.js";

export type AccountSection = "profile" | "security" | "sessions" | "connections";
export type AdminSection = "users" | "summary" | "audit";
export type WorkbenchView =
  | "chat"
  | "activity"
  | "history"
  | "files"
  | "links"
  | "panels"
  | "settings";
export type WorkspaceSettingsSection = "overview" | "models" | "skills" | "mcp";
export type WebsiteRoute =
  | { kind: "workbench" }
  | { kind: "account"; section: AccountSection }
  | { kind: "admin"; section: AdminSection };

const accounts: AccountSection[] = ["profile", "security", "sessions", "connections"];
const administrators: AdminSection[] = ["users", "summary", "audit"];

/** This bundle also serves local/private Hosts. Only the official public
 * deployment replaces the root with a product website. No network discovery. */
export function isPublicWebsiteOrigin(url: URL): boolean {
  return ["https://codeshell.site", "https://www.codeshell.site"].includes(url.origin);
}

export function websiteCloudSelected(url: URL): boolean {
  if (url.searchParams.get("target") === "choose") return false;
  if (url.searchParams.get("target") === "cloud" || validProjectId(url.searchParams.get("project")))
    return true;
  // Preserve existing private Host/root entry. Public /app starts with a choice.
  return !isPublicWebsiteOrigin(url) && !["/app", "/app/"].includes(url.pathname);
}

/** Registration accepts no callback, redirect, token or mode from the URL. */
export function isRegistrationRoute(url: URL): boolean {
  return url.pathname === "/register" || url.pathname === "/register/";
}

export function parseWebsiteRoute(url: URL): WebsiteRoute {
  if (url.pathname === "/api/v1/account/manage" || url.pathname === "/settings/account")
    return { kind: "account", section: "profile" };
  const account = /^\/settings\/account\/([^/]+)\/?$/.exec(url.pathname);
  if (account && accounts.includes(account[1] as AccountSection))
    return { kind: "account", section: account[1] as AccountSection };
  const admin = /^\/admin\/([^/]+)\/?$/.exec(url.pathname);
  if (admin && administrators.includes(admin[1] as AdminSection))
    return { kind: "admin", section: admin[1] as AdminSection };
  return { kind: "workbench" };
}

/** Only public project/session selections survive a settings round trip. */
export function websiteRouteUrl(route: WebsiteRoute, current: URL): string {
  const query = new URLSearchParams();
  const target = current.searchParams.get("target");
  if (target === "cloud" || target === "choose") query.set("target", target);
  const project = current.searchParams.get("project");
  const session = current.searchParams.get("session");
  if (validProjectId(project)) {
    query.set("project", project);
    if (session && /^[A-Za-z0-9_-]{1,128}$/.test(session)) query.set("session", session);
  }
  const workbench = parseWorkbenchLocation(current);
  if (workbench.view !== "chat") query.set("view", workbench.view);
  if (workbench.view === "settings" && workbench.section !== "overview")
    query.set("section", workbench.section);
  const path =
    route.kind === "workbench"
      ? isPublicWebsiteOrigin(current)
        ? "/app"
        : "/"
      : route.kind === "account"
        ? `/settings/account/${route.section}`
        : `/admin/${route.section}`;
  return path + (query.size ? `?${query}` : "");
}

/** Only known same-origin workspace/settings routes may follow website login.
 * Rebuild their query so tokens, redirect chains and unknown parameters never survive. */
export function safeWebsiteReturn(value: string | null, origin: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value))
    return "/app";
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.hash) return "/app";
    const route = parseWebsiteRoute(url);
    if (route.kind === "workbench" && !["/app", "/app/"].includes(url.pathname)) return "/app";
    return websiteRouteUrl(route, url);
  } catch {
    return "/app";
  }
}

export function websiteAuthUrl(mode: "login" | "signup", destination = "/app"): string {
  return `/${mode}${destination === "/app" ? "" : `?returnTo=${encodeURIComponent(destination)}`}`;
}

export function parseWorkbenchLocation(url: URL): {
  view: WorkbenchView;
  section: WorkspaceSettingsSection;
} {
  const view = url.searchParams.get("view"),
    section = url.searchParams.get("section");
  return {
    view: ["activity", "history", "files", "links", "panels", "settings"].includes(view ?? "")
      ? (view as WorkbenchView)
      : "chat",
    section: ["models", "skills", "mcp"].includes(section ?? "")
      ? (section as WorkspaceSettingsSection)
      : "overview",
  };
}

export function sameWebsiteRoute(a: WebsiteRoute, b: WebsiteRoute): boolean {
  return (
    a.kind === b.kind && (a.kind === "workbench" || ("section" in b && a.section === b.section))
  );
}

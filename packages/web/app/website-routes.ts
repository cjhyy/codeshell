import { validProjectId } from "./api-context.js";

export type AccountSection = "profile" | "security" | "sessions" | "connections";
export type AdminSection = "users" | "summary" | "audit";
export type WorkbenchView = "chat" | "history" | "files" | "links" | "panels" | "settings";
export type WorkspaceSettingsSection = "overview" | "models" | "skills" | "mcp";
export type WebsiteRoute =
  | { kind: "workbench" }
  | { kind: "account"; section: AccountSection }
  | { kind: "admin"; section: AdminSection };

const accounts: AccountSection[] = ["profile", "security", "sessions", "connections"];
const administrators: AdminSection[] = ["users", "summary", "audit"];

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
      ? "/"
      : route.kind === "account"
        ? `/settings/account/${route.section}`
        : `/admin/${route.section}`;
  return path + (query.size ? `?${query}` : "");
}

export function parseWorkbenchLocation(url: URL): {
  view: WorkbenchView;
  section: WorkspaceSettingsSection;
} {
  const view = url.searchParams.get("view"),
    section = url.searchParams.get("section");
  return {
    view: ["history", "files", "links", "panels", "settings"].includes(view ?? "")
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

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  isPanelAppBound,
  listInstalledPanelApps,
  resolvePanelAppBindingPolicy,
  resolvePanelAppBindingProjectPath,
  SettingsManager,
  type InstalledPanelApp,
} from "@cjhyy/code-shell-core";
import type { PanelAppDescriptor, PanelAppExtensionSummary } from "../shared/panel-apps.js";
import { dlog } from "./desktop-logger.js";
import { replacePanelAppResources, type PanelAppProtocolResource } from "./panel-app-protocol.js";
import { isPanelAppAvailable, summarizePanelApp, type PanelAppPolicy } from "./panel-app-policy.js";

function localizedTitle(app: InstalledPanelApp, locale: string): string {
  return locale.toLowerCase().startsWith("zh")
    ? (app.title["zh-CN"] ?? app.title.default)
    : (app.title.en ?? app.title.default);
}

function installedPanelAppRevision(app: InstalledPanelApp): string {
  const hash = createHash("sha256");
  for (const relative of [".codeshell-panel/panel.json", ".cs-panel-app-meta.json", app.entry]) {
    const file = path.join(app.installPath, relative);
    try {
      const info = statSync(file);
      hash.update(relative).update("\0").update(String(info.size)).update("\0");
      if (relative.endsWith(".json")) hash.update(readFileSync(file));
      else hash.update(String(info.mtimeMs));
    } catch {
      hash.update(relative).update("\0missing\0");
    }
  }
  return hash.digest("hex");
}

async function discoverPanelApps(locale: string): Promise<{
  descriptors: PanelAppDescriptor[];
  resources: PanelAppProtocolResource[];
  sources: Map<string, InstalledPanelApp>;
}> {
  let apps: InstalledPanelApp[];
  try {
    apps = await listInstalledPanelApps();
  } catch {
    return { descriptors: [], resources: [], sources: new Map() };
  }

  const descriptors: PanelAppDescriptor[] = [];
  const resources: PanelAppProtocolResource[] = [];
  for (const app of apps) {
    const revision = installedPanelAppRevision(app);
    const hostId = createHash("sha256")
      .update("codeshell-panel-app-v1")
      .update("\0")
      .update(app.id)
      .update("\0")
      .update(app.installPath)
      .update("\0")
      .update(revision)
      .digest("hex")
      .slice(0, 32);
    const descriptor: PanelAppDescriptor = {
      id: `panel-app:${app.id}`,
      appId: app.id,
      title: localizedTitle(app, locale),
      version: app.version,
      ...(app.description ? { description: app.description } : {}),
      icon: app.icon,
      singleton: app.singleton,
      permissions: [...app.permissions],
      ...(app.agent
        ? {
            agent: {
              tools: app.agent.tools.map((tool) => ({
                ...tool,
                inputSchema: { ...tool.inputSchema },
              })),
              skills: [...app.agent.skills],
            },
          }
        : {}),
      hostId,
      revision,
    };
    descriptors.push(descriptor);
    resources.push({ descriptor, root: app.installPath, entry: app.entry });
  }
  return { descriptors, resources, sources: new Map(apps.map((app) => [app.id, app])) };
}

function updateSource(app: InstalledPanelApp): PanelAppExtensionSummary["updateSource"] {
  if (typeof app.source !== "string") {
    const repository = new URL(app.source.url).pathname.replace(/^\/|\.git$/g, "");
    return {
      kind: "git",
      label: `${repository}${app.source.subdir ? `/${app.source.subdir}` : ""}`,
      available: true,
    };
  }
  let kind: "dir" | "zip" = path.extname(app.source).toLowerCase() === ".zip" ? "zip" : "dir";
  let available = false;
  try {
    const info = statSync(app.source);
    if (info.isDirectory()) {
      kind = "dir";
      available = true;
    } else if (info.isFile() && path.extname(app.source).toLowerCase() === ".zip") {
      kind = "zip";
      available = true;
    }
  } catch {
    // The installed snapshot stays runnable when its original source moves.
  }
  return { kind, label: path.basename(app.source), available };
}

function panelAppPolicy(cwd: string): PanelAppPolicy {
  try {
    const projectPath = cwd ? resolvePanelAppBindingProjectPath(cwd) : "";
    const settings = new SettingsManager(projectPath || process.cwd(), "full");
    const global = settings.getForScope("user") as Record<string, unknown>;
    const scoped = projectPath
      ? (settings.getForScope("project", projectPath) as Record<string, unknown>)
      : undefined;
    const binding = resolvePanelAppBindingPolicy(global, scoped, Boolean(projectPath));
    const projectOverrides: Record<string, "on" | "off"> = {};
    const rawOverrides =
      scoped?.panelAppOverrides &&
      typeof scoped.panelAppOverrides === "object" &&
      !Array.isArray(scoped.panelAppOverrides)
        ? (scoped.panelAppOverrides as Record<string, unknown>)
        : {};
    for (const [id, value] of Object.entries(rawOverrides)) {
      if (value !== "on" && value !== "off") continue;
      projectOverrides[id] = value;
    }
    return {
      boundApps: binding.boundApps,
      globalDisabledApps: binding.globalDisabledApps,
      projectOverrides,
    };
  } catch (error) {
    // Fail closed: a settings read error must not expose every installed app.
    // But log it — a single invalid key (e.g. a persisted null in
    // panelAppOverrides) rejects the whole file here and silently unbinds every
    // Panel App in the project, which is indistinguishable from "not bound".
    dlog("main", "panel_app.policy_read_failed", {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      boundApps: new Set(),
      globalDisabledApps: new Set(),
      projectOverrides: {},
    };
  }
}

/** Synchronous runtime guard used by the WebView bridge on every bind/call. */
export function isPanelAppBoundToProject(cwd: string, appId: string): boolean {
  if (!cwd || !appId) return false;
  const policy = panelAppPolicy(cwd);
  return isPanelAppBound(appId, {
    hasProject: true,
    boundApps: policy.boundApps,
    globalDisabledApps: policy.globalDisabledApps,
  });
}

export async function listPanelAppExtensions(
  cwd: string,
  locale: string,
): Promise<PanelAppExtensionSummary[]> {
  const policy = panelAppPolicy(cwd);
  const discovered = await discoverPanelApps(locale);
  return discovered.descriptors.map((app) =>
    summarizePanelApp(
      app,
      policy,
      discovered.sources.get(app.appId)
        ? updateSource(discovered.sources.get(app.appId)!)
        : { kind: "dir", label: "", available: false },
    ),
  );
}

/**
 * Runtime descriptors for the session-owned dock across several projects.
 *
 * Panel buckets are per project and the Extensions screen can bind an app to a
 * project that is not the active one, so the renderer needs the union of every
 * project's bound apps plus which projects bind each one. Filtering to a single
 * cwd (as `listPanelApps` does) would leave a session in another project with
 * an empty dock. The catalog is discovered once and the policy is evaluated per
 * project, so this costs one scan regardless of project count.
 */
export async function listPanelAppsForProjects(
  projectPaths: readonly string[],
  locale: string,
): Promise<{
  descriptors: PanelAppDescriptor[];
  boundProjectPathsByAppId: Record<string, string[]>;
}> {
  const discovered = await discoverPanelApps(locale);
  replacePanelAppResources(discovered.resources);
  const boundProjectPathsByAppId: Record<string, string[]> = {};
  for (const projectPath of new Set(projectPaths.filter(Boolean))) {
    const policy = panelAppPolicy(projectPath);
    // Report BOTH the requested path and the path bindings actually resolve to
    // (a worktree or subdirectory resolves up to its project root). The
    // renderer compares the dock's projectPath against this list, and those two
    // are not always the same string.
    const canonical = resolvePanelAppBindingProjectPath(projectPath);
    for (const app of discovered.descriptors) {
      if (!isPanelAppAvailable(app, policy)) continue;
      const paths = (boundProjectPathsByAppId[app.appId] ??= []);
      if (!paths.includes(projectPath)) paths.push(projectPath);
      if (canonical && !paths.includes(canonical)) paths.push(canonical);
    }
  }
  return {
    descriptors: discovered.descriptors.filter((app) => boundProjectPathsByAppId[app.appId]),
    boundProjectPathsByAppId,
  };
}

/** Runtime descriptors for the session-owned dock. */
export async function listPanelApps(cwd: string, locale: string): Promise<PanelAppDescriptor[]> {
  const discovered = await discoverPanelApps(locale);
  // Resources cover every installed app. Project policy filters only the
  // window's descriptors so one window cannot revoke another's app protocol.
  replacePanelAppResources(discovered.resources);
  const policy = panelAppPolicy(cwd);
  return discovered.descriptors.filter((app) => isPanelAppAvailable(app, policy));
}

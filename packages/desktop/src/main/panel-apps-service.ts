import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  isPanelAppBound,
  listInstalledPanelApps,
  listProjectPanelApps,
  migrateProjectPanelAppPackagePins,
  projectPanelAppPackagePins,
  resolvePanelAppBindingPolicy,
  resolvePanelAppBindingProjectPath,
  SettingsManager,
  type InstalledPanelApp,
} from "@cjhyy/code-shell-core";
import type { PanelAppDescriptor, PanelAppExtensionSummary } from "../shared/panel-apps.js";
import { dlog } from "./desktop-logger.js";
import { replacePanelAppResources, type PanelAppProtocolResource } from "./panel-app-protocol.js";
import { isPanelAppAvailable, summarizePanelApp, type PanelAppPolicy } from "./panel-app-policy.js";

import { createDesktopPanelManagement } from "./panel-app-management.js";

function localizedTitle(app: InstalledPanelApp, locale: string): string {
  return locale.toLowerCase().startsWith("zh")
    ? (app.title["zh-CN"] ?? app.title.default)
    : (app.title.en ?? app.title.default);
}

export function installedPanelAppRevision(app: InstalledPanelApp): string {
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

async function discoverPanelApps(
  locale: string,
  projectPath = "",
): Promise<{
  descriptors: PanelAppDescriptor[];
  resources: PanelAppProtocolResource[];
  sources: Map<string, InstalledPanelApp>;
}> {
  let apps: InstalledPanelApp[];
  let pins: ReturnType<typeof projectPanelAppPackagePins>;
  try {
    if (projectPath) await migrateProjectPanelAppPackagePins(projectPath);
    pins = projectPath ? projectPanelAppPackagePins(projectPath) : {};
    apps = projectPath ? await listProjectPanelApps(projectPath) : await listInstalledPanelApps();
    if (
      projectPath &&
      JSON.stringify(pins) !== JSON.stringify(projectPanelAppPackagePins(projectPath))
    )
      throw new Error("Project package changed during discovery");
    if (
      apps.some(
        (app) =>
          pins[app.id] &&
          (pins[app.id]!.version !== app.version ||
            pins[app.id]!.packageDigest !== app.packageDigest),
      )
    )
      throw new Error("Project package changed during discovery");
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
      packageDigest: app.packageDigest,
      packagePinned: !!pins[app.id],
      ...(projectPath ? { projectPaths: [projectPath] } : {}),
      ...(app.description ? { description: app.description } : {}),
      icon: app.icon,
      singleton: app.singleton,
      permissions: [...app.permissions],
      ...(app.nativeEntries ? { nativeEntries: structuredClone(app.nativeEntries) } : {}),
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
  const discovered = await discoverPanelApps(
    locale,
    cwd ? resolvePanelAppBindingProjectPath(cwd) : "",
  );
  const bindings = cwd ? await createDesktopPanelManagement(cwd).snapshot() : [];
  return discovered.descriptors.map((app) => {
    const binding = bindings.find((item) => item.appId === app.appId);
    if (
      cwd &&
      (!binding || binding.version !== app.version || binding.packageDigest !== app.packageDigest)
    )
      throw new Error("项目面板版本已改变，请刷新后重试。");
    return {
      ...summarizePanelApp(
        app,
        policy,
        discovered.sources.get(app.appId)
          ? updateSource(discovered.sources.get(app.appId)!)
          : { kind: "dir", label: "", available: false },
      ),
      ...(binding
        ? {
            bindingRevision: binding.revision,
            projectBound: binding.bound,
            enabled: binding.bound && !binding.globalDisabled,
          }
        : {}),
    };
  });
}

const projectDiscoveries = new Map<string, object>();

/** Runtime variants keep the stable dock ID but select package bytes per project. */
export async function listPanelAppsForProjects(
  projectPaths: readonly string[],
  locale: string,
): Promise<{
  descriptors: PanelAppDescriptor[];
  boundProjectPathsByAppId: Record<string, string[]>;
}> {
  const variants = new Map<string, PanelAppDescriptor>();
  const boundProjectPathsByAppId: Record<string, string[]> = {};
  const byCanonical = new Map<string, Set<string>>();
  for (const requested of new Set(projectPaths.filter(Boolean))) {
    const canonical = resolvePanelAppBindingProjectPath(requested);
    if (!canonical) continue;
    const paths = byCanonical.get(canonical) ?? new Set([canonical]);
    paths.add(requested);
    byCanonical.set(canonical, paths);
  }
  for (const [canonical, paths] of byCanonical) {
    const discovery = {};
    projectDiscoveries.set(canonical, discovery);
    const discovered = await discoverPanelApps(locale, canonical);
    if (projectDiscoveries.get(canonical) !== discovery) continue;
    projectDiscoveries.delete(canonical);
    const policy = panelAppPolicy(canonical);
    const enabled = discovered.descriptors.filter((app) => isPanelAppAvailable(app, policy));
    const enabledHosts = new Set(enabled.map((app) => app.hostId));
    replacePanelAppResources(
      discovered.resources.filter((resource) => enabledHosts.has(resource.descriptor.hostId)),
      canonical,
    );
    for (const app of enabled) {
      const bound = (boundProjectPathsByAppId[app.appId] ??= []);
      for (const projectPath of paths) if (!bound.includes(projectPath)) bound.push(projectPath);
      const existing = variants.get(app.hostId);
      const projectPaths = new Set([...(existing?.projectPaths ?? []), ...paths]);
      variants.set(app.hostId, { ...app, projectPaths: [...projectPaths] });
    }
  }
  return { descriptors: [...variants.values()], boundProjectPathsByAppId };
}

/** Runtime descriptors for one project; other windows keep their own resources. */
export async function listPanelApps(cwd: string, locale: string): Promise<PanelAppDescriptor[]> {
  return (await listPanelAppsForProjects(cwd ? [cwd] : [], locale)).descriptors;
}

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  listInstalledPanelApps,
  SettingsManager,
  type InstalledPanelApp,
} from "@cjhyy/code-shell-core";
import type { PanelAppDescriptor, PanelAppExtensionSummary } from "../shared/panel-apps.js";
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
    const settings = new SettingsManager(cwd || process.cwd(), "full");
    const global = settings.get() as { disabledPanelApps?: unknown };
    const scoped = cwd
      ? (settings.getForScope("project", cwd) as {
          panelAppOverrides?: Record<string, unknown>;
        })
      : undefined;
    const globalDisabledApps = new Set(
      Array.isArray(global.disabledPanelApps)
        ? global.disabledPanelApps.filter((id): id is string => typeof id === "string")
        : [],
    );
    const disabledApps = new Set(globalDisabledApps);
    const projectOverrides: Record<string, "on" | "off"> = {};
    for (const [id, value] of Object.entries(scoped?.panelAppOverrides ?? {})) {
      if (value !== "on" && value !== "off") continue;
      projectOverrides[id] = value;
      if (value === "on") disabledApps.delete(id);
      else disabledApps.add(id);
    }
    return { disabledApps, globalDisabledApps, projectOverrides };
  } catch {
    return {
      disabledApps: new Set(),
      globalDisabledApps: new Set(),
      projectOverrides: {},
    };
  }
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

/** Runtime descriptors for the session-owned dock. */
export async function listPanelApps(cwd: string, locale: string): Promise<PanelAppDescriptor[]> {
  const discovered = await discoverPanelApps(locale);
  // Resources cover every installed app. Project policy filters only the
  // window's descriptors so one window cannot revoke another's app protocol.
  replacePanelAppResources(discovered.resources);
  const policy = panelAppPolicy(cwd);
  return discovered.descriptors.filter((app) => isPanelAppAvailable(app, policy));
}

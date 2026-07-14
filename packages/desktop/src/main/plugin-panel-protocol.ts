import { protocol, session } from "electron";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, posix, resolve, sep } from "node:path";
import type { PluginPanelDescriptor, PreparedPluginPanel } from "../shared/plugin-panels.js";

export const PLUGIN_PANEL_SCHEME = "csplugin";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; " +
  "frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface PluginPanelProtocolResource {
  descriptor: PluginPanelDescriptor;
  root: string;
  entry: string;
}

let resources = new Map<string, PluginPanelProtocolResource>();
const installedPartitions = new Set<string>();

export function registerPluginPanelSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_PANEL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

export function replacePluginPanelResources(next: PluginPanelProtocolResource[]): void {
  resources = new Map(next.map((resource) => [resource.descriptor.hostId, resource]));
}

function encodePanelUrl(hostId: string, entry: string): string {
  const pathname = entry
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${PLUGIN_PANEL_SCHEME}://${hostId}/${pathname}`;
}

function safePartition(hostId: string): string {
  return `${PLUGIN_PANEL_SCHEME}:${hostId}`;
}

export async function preparePluginPanel(id: string): Promise<PreparedPluginPanel> {
  const resource = [...resources.values()].find((candidate) => candidate.descriptor.id === id);
  if (!resource) throw new Error(`plugin panel is not installed or enabled: ${id}`);
  const partition = safePartition(resource.descriptor.hostId);
  await installProtocolForPartition(partition);
  return {
    id,
    src: encodePanelUrl(resource.descriptor.hostId, resource.entry),
    partition,
  };
}

export function validatePluginPanelEntryUrl(source: string): PluginPanelProtocolResource | null {
  const parsed = parsePluginPanelUrl(source);
  if (!parsed) return null;
  const resource = resources.get(parsed.hostId);
  return resource && parsed.relativePath === resource.entry ? resource : null;
}

export function expectedPluginPanelPartition(hostId: string): string {
  return safePartition(hostId);
}

function parsePluginPanelUrl(source: string): { hostId: string; relativePath: string } | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${PLUGIN_PANEL_SCHEME}:` ||
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
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    return null;
  }
  return { hostId: url.hostname, relativePath };
}

function isPathUnder(relativePath: string, root: string, entry: string): boolean {
  // A root-level entry has no safe asset subtree. Serve only that HTML file;
  // authors who need JS/CSS/images put the entry in a dedicated directory.
  if (root === ".") return relativePath === entry;
  const relation = posix.relative(root, relativePath);
  return relation !== ".." && !relation.startsWith("../") && !posix.isAbsolute(relation);
}

function strictlyContained(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function response(status: number, body?: BodyInit, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

async function handlePluginPanelRequest(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return response(405, "Method Not Allowed");
  const parsed = parsePluginPanelUrl(request.url);
  if (!parsed) return response(400, "Bad Request");
  const resource = resources.get(parsed.hostId);
  if (!resource) return response(404, "Not Found");

  const assetRoot = posix.dirname(resource.entry);
  if (!isPathUnder(parsed.relativePath, assetRoot, resource.entry)) {
    return response(403, "Forbidden");
  }
  const mime = MIME_TYPES[extname(parsed.relativePath).toLowerCase()];
  if (!mime) return response(415, "Unsupported Media Type");

  try {
    const root = await realpath(resource.root);
    const target = await realpath(resolve(resource.root, ...parsed.relativePath.split("/")));
    if (!strictlyContained(root, target) || !(await stat(target)).isFile()) {
      return response(403, "Forbidden");
    }
    if (request.method === "HEAD") return response(200, undefined, mime);
    return response(200, await readFile(target), mime);
  } catch {
    return response(404, "Not Found");
  }
}

async function installProtocolForPartition(partition: string): Promise<void> {
  if (installedPartitions.has(partition)) return;
  const targetSession = session.fromPartition(partition, { cache: false });
  await targetSession.protocol.handle(PLUGIN_PANEL_SCHEME, handlePluginPanelRequest);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  targetSession.setPermissionCheckHandler(() => false);
  installedPartitions.add(partition);
}

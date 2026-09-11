import { protocol, session, desktopCapturer, dialog } from "electron";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { MediaScope } from "./media/media-types.js";
import type { PanelAppDescriptor, PreparedPanelApp } from "../shared/panel-apps.js";
import { THEME_ASSET_SCHEME } from "./theme-asset-url.js";

export const PANEL_APP_SCHEME = "cspanel";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  // Local files explicitly selected in the guest can be previewed via object
  // URLs without granting filesystem URLs, network access, or blob scripts.
  "img-src 'self' data: blob:; media-src 'self' blob:; " +
  "font-src 'self' data:; connect-src 'none'; object-src 'none'; " +
  "frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MEDIA_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";
const MEDIA_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
  "audio/webm",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/tiff",
]);

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface PanelAppProtocolResource {
  descriptor: PanelAppDescriptor;
  root: string;
  entry: string;
}

let resources = new Map<string, PanelAppProtocolResource>();
const installedPartitions = new Set<string>();
const preparedPartitionScopes = new Map<string, { hostId: string; projectPath: string }>();

type ManagedMediaReader = (
  scope: MediaScope,
  id: string,
  request: { range?: string; method: string },
) => Promise<{ status: number; headers: Record<string, string>; body: Readable | null }>;
let managedMediaReader: ManagedMediaReader | undefined;
let captureAuthorizer: ((scope: MediaScope) => boolean) | undefined;
export function setPanelAppCaptureAuthorizer(
  authorize: ((scope: MediaScope) => boolean) | undefined,
): void {
  captureAuthorizer = authorize;
}
function partitionMayCapture(partition: string, url: string): boolean {
  const scope = preparedPartitionScopes.get(partition),
    resource = validatePanelAppEntryUrl(url);
  if (!scope || !resource || scope.hostId !== resource.descriptor.hostId) return false;
  try {
    return (
      captureAuthorizer?.({ appId: resource.descriptor.appId, projectPath: scope.projectPath }) ===
      true
    );
  } catch {
    return false;
  }
}

/** The Host installs an authorization-aware reader; guests never supply disk paths. */
export function setPanelAppMediaReader(reader: ManagedMediaReader): void {
  managedMediaReader = reader;
}

export function registerPanelAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PANEL_APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true,
      },
    },
    {
      scheme: THEME_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
      },
    },
  ]);
}

export function replacePanelAppResources(next: PanelAppProtocolResource[]): void {
  resources = new Map(next.map((resource) => [resource.descriptor.hostId, resource]));
}

function encodePanelUrl(hostId: string, entry: string): string {
  const pathname = entry
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${PANEL_APP_SCHEME}://${hostId}/${pathname}`;
}

function safePartition(hostId: string, projectPath: string): string {
  const projectScope = createHash("sha256")
    .update("codeshell-panel-app-project-v1")
    .update("\0")
    .update(projectPath)
    .digest("hex")
    .slice(0, 32);
  return `${PANEL_APP_SCHEME}:${hostId}:${projectScope}`;
}

export async function preparePanelApp(id: string, projectPath: string): Promise<PreparedPanelApp> {
  const resource = [...resources.values()].find((candidate) => candidate.descriptor.id === id);
  if (!resource) throw new Error(`Panel App is not installed or enabled: ${id}`);
  if (typeof projectPath !== "string" || !projectPath) {
    throw new Error("Panel App requires a project binding");
  }
  const partition = safePartition(resource.descriptor.hostId, projectPath);
  preparedPartitionScopes.set(partition, {
    hostId: resource.descriptor.hostId,
    projectPath,
  });
  await installProtocolForPartition(partition);
  return {
    id,
    src: encodePanelUrl(resource.descriptor.hostId, resource.entry),
    partition,
    revision: resource.descriptor.revision,
  };
}

export function validatePanelAppEntryUrl(source: string): PanelAppProtocolResource | null {
  const parsed = parsePanelAppUrl(source);
  if (!parsed) return null;
  const resource = resources.get(parsed.hostId);
  return resource && parsed.relativePath === resource.entry ? resource : null;
}

/**
 * Resolve the project scope recorded by a successful prepare call. Unprepared
 * or cross-app partitions fail closed during Electron's attach hook.
 */
export function preparedPanelAppPartitionProjectPath(
  hostId: string,
  partition: string,
): string | null {
  const scope = preparedPartitionScopes.get(partition);
  return scope?.hostId === hostId ? scope.projectPath : null;
}

function parsePanelAppUrl(source: string): { hostId: string; relativePath: string } | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${PANEL_APP_SCHEME}:` ||
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

async function handlePanelAppRequest(request: Request, partition: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return response(405, "Method Not Allowed");
  const parsed = parsePanelAppUrl(request.url);
  if (!parsed) return response(400, "Bad Request");
  const resource = resources.get(parsed.hostId);
  if (!resource) return response(404, "Not Found");

  if (parsed.relativePath.startsWith("media/")) {
    const scope = preparedPartitionScopes.get(partition);
    const id = parsed.relativePath.slice("media/".length);
    if (
      !scope ||
      scope.hostId !== parsed.hostId ||
      !/^asset-[a-f0-9]{64}$/.test(id) ||
      !resource.descriptor.permissions.includes("media") ||
      !managedMediaReader
    )
      return response(403, "Forbidden");
    try {
      const media = await managedMediaReader(
        { appId: resource.descriptor.appId, projectPath: scope.projectPath },
        id,
        { method: request.method, range: request.headers.get("range") ?? undefined },
      );
      try {
        const headers = new Headers(media.headers);
        const mime = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (!mime || !MEDIA_MIME_TYPES.has(mime)) {
          media.body?.destroy();
          return response(415, "Unsupported Media Type");
        }
        headers.set("Content-Security-Policy", MEDIA_CSP);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Cache-Control", "private, no-store");
        return new Response(
          media.body ? (Readable.toWeb(media.body) as unknown as BodyInit) : null,
          {
            status: media.status,
            headers,
          },
        );
      } catch (error) {
        media.body?.destroy();
        throw error;
      }
    } catch {
      return response(404, "Not Found");
    }
  }

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
  await targetSession.protocol.handle(PANEL_APP_SCHEME, (request) =>
    handlePanelAppRequest(request, partition),
  );
  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(
      partitionMayCapture(partition, webContents.getURL()) &&
        panelAppMayCapture(
          webContents.getURL(),
          details.requestingUrl,
          details.isMainFrame,
          String(permission) === "display-capture"
            ? ["screen"]
            : permission === "media" && Array.isArray(mediaTypes)
              ? mediaTypes
              : [],
        ),
    );
  });
  targetSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      partitionMayCapture(partition, webContents?.getURL() ?? "") &&
      panelAppMayCapture(
        webContents?.getURL() ?? "",
        details.requestingUrl,
        details.isMainFrame,
        String(permission) === "display-capture"
          ? ["screen"]
          : permission === "media" && details.mediaType
            ? [details.mediaType]
            : [],
      ),
  );
  targetSession.setDisplayMediaRequestHandler?.(
    (request, callback) => {
      const frame = request.frame;
      const sourceUrl = frame?.url;
      if (
        !frame ||
        !partitionMayCapture(partition, frame.url) ||
        frame.parent ||
        !request.userGesture ||
        !request.videoRequested ||
        !panelAppMayCapture(frame.url, frame.url, true, ["screen"])
      ) {
        callback({});
        return;
      }
      // Keep authorization in this handler on every platform. The system picker
      // bypasses it on newer macOS; require an explicitly selected source here.
      void (async () => {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });
        for (let offset = 0; offset < sources.length; offset += 12) {
          const page = sources.slice(offset, offset + 12);
          const more = offset + page.length < sources.length;
          const result = await dialog.showMessageBox({
            type: "question",
            title: "选择要录制的画面",
            message: "只录制你选择的屏幕或窗口",
            buttons: [
              "取消",
              ...page.map((source) => source.name),
              ...(more ? ["查看更多窗口"] : []),
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (!result.response) {
            callback({});
            return;
          }
          if (more && result.response === page.length + 1) continue;
          const source = page[result.response - 1];
          if (
            !source ||
            !request.frame ||
            request.frame.url !== sourceUrl ||
            !partitionMayCapture(partition, frame.url) ||
            !panelAppMayCapture(frame.url, frame.url, true, ["screen"])
          ) {
            callback({});
            return;
          }
          callback({
            video: source,
            ...(request.audioRequested && process.platform === "win32"
              ? { audio: "loopback" }
              : {}),
          });
          return;
        }
        callback({});
      })().catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  installedPartitions.add(partition);
}

/**
 * Grant Chromium microphone access only to the reviewed main entry of a Panel
 * App that explicitly declares `audio.transcribe`. Camera requests, subframes,
 * stale/unregistered hosts, and ordinary browser guests remain denied.
 */
export function panelAppMayCaptureAudio(
  webContentsUrl: string,
  requestingUrl: string | undefined,
  isMainFrame: boolean,
  mediaTypes: readonly string[],
): boolean {
  if (!isMainFrame || !mediaTypes.length || mediaTypes.some((type) => type !== "audio")) {
    return false;
  }
  const requested = requestingUrl || webContentsUrl;
  const resource = validatePanelAppEntryUrl(requested);
  if (!resource || validatePanelAppEntryUrl(webContentsUrl) !== resource) return false;
  return resource.descriptor.permissions.includes("audio.transcribe");
}

/** Capture is an explicit install permission, separate from microphone dictation. */
export function panelAppMayCapture(
  webContentsUrl: string,
  requestingUrl: string | undefined,
  isMainFrame: boolean,
  mediaTypes: readonly string[],
): boolean {
  if (
    !isMainFrame ||
    !mediaTypes.length ||
    mediaTypes.some((kind) => !["audio", "video", "screen"].includes(kind))
  )
    return false;
  const resource = validatePanelAppEntryUrl(requestingUrl || webContentsUrl);
  if (!resource || validatePanelAppEntryUrl(webContentsUrl) !== resource) return false;
  return (
    resource.descriptor.permissions.includes("media.capture") ||
    panelAppMayCaptureAudio(webContentsUrl, requestingUrl, isMainFrame, mediaTypes)
  );
}

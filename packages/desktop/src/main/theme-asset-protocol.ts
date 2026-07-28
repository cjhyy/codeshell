import { protocol, session } from "electron";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { themeInstallDir } from "@cjhyy/code-shell-core";
import { THEME_ASSET_SCHEME, parseThemeUrl, themeAssetUrl } from "./theme-asset-url.js";

/**
 * `cstheme://` serves an installed theme pack's image assets to the renderer.
 * URL shape: cstheme://<id>/.cs-theme-assets/<file>. Only image MIME types are
 * allowed; the theme id is validated as a safe segment and the resolved file
 * must stay strictly under that theme's install dir (defense against traversal
 * and symlink escape, mirroring the Panel App protocol). Pure url parsing
 * lives in theme-asset-url.ts so it stays electron-free and testable.
 */
export { THEME_ASSET_SCHEME, themeAssetUrl } from "./theme-asset-url.js";

const CSP = "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'";

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

let schemeRegistered = false;
const handledSessions = new WeakSet<Electron.Session>();

/** Must run before app `ready` (privileged scheme registration requirement). */
export function registerThemeAssetSchemePrivileges(): void {
  if (schemeRegistered) return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THEME_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
  schemeRegistered = true;
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

function strictlyContained(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

async function handleThemeAssetRequest(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return response(405, "Method Not Allowed");
  const parsed = parseThemeUrl(request.url);
  if (!parsed) return response(400, "Bad Request");
  const mime = IMAGE_MIME[extname(parsed.relativePath).toLowerCase()];
  if (!mime) return response(415, "Unsupported Media Type");
  try {
    const root = await realpath(themeInstallDir(parsed.id));
    const target = await realpath(
      resolve(themeInstallDir(parsed.id), ...parsed.relativePath.split("/")),
    );
    if (!strictlyContained(root, target) || !(await stat(target)).isFile()) {
      return response(403, "Forbidden");
    }
    if (request.method === "HEAD") return response(200, undefined, mime);
    return response(200, await readFile(target), mime);
  } catch {
    return response(404, "Not Found");
  }
}

/** Install the handler on a session (default renderer + pet popout share it). */
export function installThemeAssetProtocol(target: Electron.Session = session.defaultSession): void {
  if (handledSessions.has(target)) return;
  target.protocol.handle(THEME_ASSET_SCHEME, handleThemeAssetRequest);
  handledSessions.add(target);
}

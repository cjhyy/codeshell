import { session } from "electron";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { detectThemeWav, MAX_THEME_MUSIC_BYTES, themeInstallDir } from "@cjhyy/code-shell-core";
import { THEME_ASSET_SCHEME, parseThemeUrl } from "./theme-asset-url.js";

/**
 * `cstheme://` serves an installed theme pack's media assets to the renderer.
 * URL shape: cstheme://<id>/.cs-theme-assets/<file>. Only image and WAV MIME types are
 * allowed; the theme id is validated as a safe segment and the resolved file
 * must stay strictly under that theme's install dir (defense against traversal
 * and symlink escape, mirroring the Panel App protocol). Pure url parsing
 * lives in theme-asset-url.ts so it stays electron-free and testable.
 */
export { THEME_ASSET_SCHEME, themeAssetUrl } from "./theme-asset-url.js";

const CSP = "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'";

const ASSET_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wav": "audio/wav",
};

const handledSessions = new WeakSet<Electron.Session>();

function response(
  status: number,
  body?: BodyInit,
  contentType = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function strictlyContained(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/** Resolve a single byte range; multipart requests are intentionally rejected. */
function byteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(size - 1, end) };
}

export async function handleThemeAssetRequest(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return response(405, "Method Not Allowed");
  const parsed = parseThemeUrl(request.url);
  if (!parsed) return response(400, "Bad Request");
  const mime = ASSET_MIME[extname(parsed.relativePath).toLowerCase()];
  if (!mime) return response(415, "Unsupported Media Type");
  try {
    const root = await realpath(themeInstallDir(parsed.id));
    const target = await realpath(
      resolve(themeInstallDir(parsed.id), ...parsed.relativePath.split("/")),
    );
    if (!strictlyContained(root, target)) {
      return response(403, "Forbidden");
    }
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      const audio = mime === "audio/wav";
      if (!info.isFile()) return response(403, "Forbidden");
      if (info.size > (audio ? MAX_THEME_MUSIC_BYTES : 8 * 1024 * 1024)) {
        return response(413, "Content Too Large");
      }
      const buffer = Buffer.alloc(info.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total !== info.size) return response(409, "Asset Changed");
      const bytes = buffer.subarray(0, total);
      if (audio) {
        const wav = detectThemeWav(bytes);
        if (!wav || wav.durationSeconds > 600) return response(415, "Unsupported Media Type");
      }
      const headers: Record<string, string> = {
        "Content-Length": String(total),
        ...(audio ? { "Accept-Ranges": "bytes" } : {}),
      };
      if (request.method === "HEAD") return response(200, undefined, mime, headers);
      const rangeHeader = request.headers.get("range");
      if (audio && rangeHeader) {
        const range = byteRange(rangeHeader, total);
        if (!range) {
          return response(416, undefined, mime, { "Content-Range": `bytes */${total}` });
        }
        return response(206, bytes.subarray(range.start, range.end + 1), mime, {
          ...headers,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        });
      }
      return response(200, bytes, mime, headers);
    } finally {
      await handle.close();
    }
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

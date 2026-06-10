import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep, extname } from "node:path";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Serves the built mobile web app (out/mobile) as static assets for the
 * `/mobile` route family, replacing the old inline `mobileRemoteHtml()` string.
 *
 * Two modes:
 *  - prod: read files from `out/mobile` (resolved relative to the bundled main).
 *  - dev:  proxy to the mobile vite dev server (MOBILE_DEV_URL) for HMR.
 *
 * Security (design §5): only files INSIDE out/mobile are served. The request
 * path is normalized and re-resolved; anything that escapes the root → 404.
 * This closes the path-traversal hole the beta1 sweep fixed elsewhere.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/** Strip `/mobile` (and an optional trailing slash) off the request URL, drop
 *  any query/hash, and return the asset sub-path. `/mobile` → "", `/mobile/` →
 *  "", `/mobile/assets/x.js` → "assets/x.js". */
export function mobileAssetPath(reqUrl: string): string {
  const noQuery = reqUrl.split("?")[0].split("#")[0];
  let rest = noQuery.slice("/mobile".length); // reqUrl always starts with /mobile here
  if (rest.startsWith("/")) rest = rest.slice(1);
  return rest;
}

/** Resolve an asset sub-path to an absolute file inside `root`, or null if it
 *  would escape the root (traversal) or does not resolve to a regular file. An
 *  empty sub-path resolves to index.html (SPA entry). */
export function resolveSafe(root: string, subPath: string): string | null {
  const rootResolved = resolve(root);
  const rel = normalize(subPath || "index.html");
  // Reject absolute paths and any normalized path still containing `..`.
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || rel.startsWith(sep)) {
    return null;
  }
  const full = resolve(join(rootResolved, rel));
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

export interface MobileStaticOptions {
  /** Absolute path to the built mobile app (out/mobile). */
  rootDir: string;
  /** When set, dev mode: proxy /mobile/* to this base URL instead of disk. */
  devUrl?: string;
}

/**
 * Handle a `/mobile`-prefixed request. Returns true if it handled the response
 * (wrote a status), false if the caller should fall through (it never does for
 * /mobile — callers check the prefix first, so this always handles).
 */
export function serveMobile(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MobileStaticOptions,
): void {
  if (opts.devUrl) {
    proxyToDev(req, res, opts.devUrl);
    return;
  }
  const sub = mobileAssetPath(req.url ?? "/mobile");
  let file = resolveSafe(opts.rootDir, sub);
  // SPA fallback: unknown non-asset path (no extension) → index.html.
  if (!file && sub && !extname(sub)) {
    file = resolveSafe(opts.rootDir, "index.html");
  }
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(file).pipe(res);
}

/**
 * Serve a ROOT-level static asset (no /mobile prefix) from the built app.
 * Needed because the built index.html uses base "./" and is served at /mobile
 * (no trailing slash), so the browser resolves "./assets/x" → "/assets/x".
 * Only known static buckets are served (assets/, *.ico/.png/.svg/.webmanifest)
 * — never arbitrary root paths. Returns true if it wrote a response.
 */
export function serveMobileRootAsset(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
): boolean {
  const url = (req.url ?? "").split("?")[0].split("#")[0];
  // Only handle asset-shaped root requests; everything else falls through.
  const isAsset =
    url.startsWith("/assets/") ||
    /\.(ico|png|jpg|jpeg|svg|webp|woff2?|ttf|webmanifest|map)$/.test(url);
  if (!isAsset) return false;
  const file = resolveSafe(rootDir, url.replace(/^\/+/, ""));
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return true;
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(file).pipe(res);
  return true;
}

/** Dev-only: forward the request to the mobile vite dev server. Vite injects
 *  ABSOLUTE-path assets (/@vite/client, /@react-refresh, /main.tsx,
 *  /node_modules/.vite/*) that the phone requests at the HOST ROOT, plus the
 *  page itself at /mobile. We rewrite only the /mobile prefix → vite's root and
 *  forward every other path verbatim, so all of vite's root assets resolve. */
export function devProxyPath(reqUrl: string): string {
  // Split off the query so we can rewrite just the path.
  const qIdx = reqUrl.indexOf("?");
  const path = qIdx === -1 ? reqUrl : reqUrl.slice(0, qIdx);
  const query = qIdx === -1 ? "" : reqUrl.slice(qIdx);
  if (path === "/mobile" || path === "/mobile/") return "/" + query;
  if (path.startsWith("/mobile/")) return path.slice("/mobile".length) + query;
  // Root-level asset (vite client/refresh/modules) — forward as-is.
  return path + query;
}

function proxyToDev(req: IncomingMessage, res: ServerResponse, devUrl: string): void {
  const target = new URL(devUrl);
  const proxyReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: devProxyPath(req.url ?? "/mobile"),
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      // Never let a phone cache the DEV page/assets. Otherwise a stale static
      // build's HTML (hash-named assets) survives in the browser cache and its
      // asset requests hit the vite dev server, which has no hash files → 404.
      // no-store on every dev response keeps the phone in lockstep with vite.
      const headers = { ...proxyRes.headers, "cache-control": "no-store" };
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("mobile dev server unavailable");
  });
  req.pipe(proxyReq);
}

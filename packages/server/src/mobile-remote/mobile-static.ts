import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep, extname } from "node:path";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { contentTypeFor } from "../static-files.js";

/**
 * Serves the built mobile web app (out/mobile) as static assets for the
 * `/mobile` route family, replacing the old inline `mobileRemoteHtml()` string.
 *
 * Two modes:
 *  - prod: read files from `out/mobile` (resolved relative to the bundled main).
 *  - dev:  proxy to the mobile vite dev server (MOBILE_DEV_URL) for HMR.
 *
 * The app is built/served with vite base "/mobile/" (vite.mobile.config.ts), so
 * BOTH the built bundle's asset URLs and vite's dev HMR/module URLs live under
 * the `/mobile` prefix — a single prefix route serves prod and dev, with no
 * root-level asset shim or whole-server dev proxy.
 *
 * Security (design §5): only files INSIDE out/mobile are served. The request
 * path is normalized and re-resolved; anything that escapes the root → 404.
 * This closes the path-traversal hole the beta1 sweep fixed elsewhere.
 */

/** Strip `/mobile` (and an optional trailing slash) off the request URL, drop
 *  any query/hash, and return the asset sub-path. `/mobile` → "", `/mobile/` →
 *  "", `/mobile/assets/x.js` → "assets/x.js". */
export function mobileAssetPath(reqUrl: string): string {
  const noQuery = reqUrl.split("?")[0].split("#")[0];
  let rest = noQuery.slice("/mobile".length); // reqUrl always starts with /mobile here
  if (rest.startsWith("/")) rest = rest.slice(1);
  return rest;
}

/** If `reqUrl` is the bare `/mobile` entry (optionally with a query/hash but no
 *  trailing slash), return the canonical `/mobile/`-prefixed target (query/hash
 *  preserved) for a redirect. Returns null for `/mobile/` and any sub-path,
 *  which need no redirect. */
export function mobileEntryRedirect(reqUrl: string): string | null {
  const qIdx = reqUrl.search(/[?#]/);
  const path = qIdx === -1 ? reqUrl : reqUrl.slice(0, qIdx);
  const suffix = qIdx === -1 ? "" : reqUrl.slice(qIdx);
  if (path === "/mobile") return "/mobile/" + suffix;
  return null;
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

/** True when the request is a browser navigation (accepts text/html), used to
 *  decide whether a path that doesn't resolve to a file should fall back to the
 *  SPA shell. Asset/module fetches send `*\/*` or a specific type and must NOT
 *  fall back (so a missing asset 404s instead of returning HTML). */
function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
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
  // Canonicalize the entry URL to a trailing slash. The pairing URL is
  // `/mobile?pairing=...` (no slash); without the slash the served HTML's base
  // is `/`, so a relative ref would escape the routed prefix. Redirect the bare
  // entry → `/mobile/` (preserving the query) so the app always loads under
  // `/mobile/`. Sub-paths (/mobile/assets/*) are left untouched.
  const redirect = mobileEntryRedirect(req.url ?? "/mobile");
  if (redirect) {
    res.writeHead(308, { location: redirect });
    res.end();
    return;
  }
  if (opts.devUrl) {
    proxyToDev(req, res, opts.devUrl);
    return;
  }
  const sub = mobileAssetPath(req.url ?? "/mobile");
  let file = resolveSafe(opts.rootDir, sub);
  // SPA fallback: a navigation to an unknown client route → index.html so the
  // React router can take over. Gate on the request ACCEPTing html (the browser
  // sends `Accept: text/html` for navigations, `*/*` or a specific type for
  // asset/module fetches), NOT on the absence of a file extension — a route
  // segment containing a dot (e.g. a version or dotted id) must still fall back,
  // and a genuinely-missing .js/.css must still 404 (returning HTML for a module
  // request would break module loading).
  if (!file && sub && acceptsHtml(req)) {
    file = resolveSafe(opts.rootDir, "index.html");
  }
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const type = contentTypeFor(extname(file));
  // Hashed bundles under /assets are content-addressed → cache forever. The
  // entry HTML (index.html, served for "" or the SPA fallback) must NOT be
  // cached: after an app upgrade ships a new bundle with new hashed filenames, a
  // stale index.html would reference deleted assets → 404 → blank page until a
  // hard refresh.
  const isHtml = type.startsWith("text/html");
  res.writeHead(200, {
    "content-type": type,
    "cache-control": isHtml
      ? "no-store"
      : sub.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
  });
  createReadStream(file).pipe(res);
}

/** Dev-only: forward the request to the mobile vite dev server. The mobile vite
 *  config sets base "/mobile/", so vite serves its HMR client, module graph, and
 *  asset URLs UNDER that prefix (/mobile/@vite/client, /mobile/src/main.tsx). We
 *  therefore forward the request path UNCHANGED — stripping /mobile would ask
 *  vite for /@vite/client, which a base-"/mobile/" server 404s, breaking HMR so
 *  the phone never live-updates. The /mobile prefix belongs to vite here (its
 *  base), not to us — only prod static serving strips it (files live flat under
 *  out/mobile). */
function proxyToDev(req: IncomingMessage, res: ServerResponse, devUrl: string): void {
  const target = new URL(devUrl);
  const proxyReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url ?? "/mobile/",
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

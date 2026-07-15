// packages/server/src/static-files.ts
//
// Shared static-file primitives for the two HTTP hosts (pairing host's
// /mobile static root and the headless serve SPA root). Keep this file free
// of host wiring — MIME map + helpers only.
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
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function contentTypeFor(extname: string): string {
  return CONTENT_TYPES[extname.toLowerCase()] ?? "application/octet-stream";
}

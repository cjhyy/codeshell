import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_EXAMINED = 4096;
const DOWNLOAD_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".mov",
  ".webm",
  ".avi",
  ".mpeg",
  ".mpg",
  ".ts",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".aiff",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".txt",
  ".md",
  ".csv",
  ".tsv",
  ".json",
  ".html",
  ".srt",
  ".vtt",
  ".ass",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
]);

export interface PanelProcessDirectoryOptions {
  /** Host-resolved directory from an opaque process directory grant, never a URL path. */
  root: string;
  /** The exact authenticated route for that opaque grant. */
  baseUrl: string;
  /** Trusted gateway prefix, used in rendered links only. */
  linkPrefix?: string;
  /** Trusted host workspace retained in browser links for Desktop Web routing. */
  workspace?: string;
  isAuthorized(): Promise<boolean>;
}

class DirectoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new DirectoryError(status, message);
}
function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino;
}
function escaped(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
function safeBasename(name: string): boolean {
  return (
    Boolean(name) &&
    name.length <= 240 &&
    !name.startsWith(".") &&
    !/[\\/\u0000-\u001f\u007f:]/u.test(name) &&
    !/[. ]$/u.test(name) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name)
  );
}
function downloadable(name: string): boolean {
  return (
    safeBasename(name) &&
    DOWNLOAD_EXTENSIONS.has(extname(name).toLowerCase()) &&
    !/(?:^|[\s._-])(?:credentials?|cookies?|tokens?|secrets?|auth|oauth|accounts?|passwords?|sessions?|id_rsa|id_ed25519|id_ecdsa)(?:[\s._-]|$)/iu.test(
      name,
    )
  );
}
function disposition(name: string): string {
  const suffix = extname(name).replace(/[^.A-Za-z0-9]/g, "");
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download${suffix}"; filename*=UTF-8''${encoded}`;
}

/** Authenticated read-only exports from one granted directory; no recursive paths. */
export async function handlePanelProcessDirectory(
  request: IncomingMessage,
  response: ServerResponse,
  options: PanelProcessDirectoryOptions,
): Promise<void> {
  let directory: FileHandle | undefined;
  let file: FileHandle | undefined;
  const authorize = async () => {
    let allowed = false;
    try {
      allowed = await options.isAuthorized();
    } catch {
      /* fail closed */
    }
    if (!allowed) fail(403, "下载授权已失效，请重新打开面板目录。");
    if (response.destroyed || request.aborted) throw new Error("Download connection closed");
  };
  try {
    await authorize();
    if (!["GET", "HEAD"].includes(request.method ?? "")) fail(405, "此目录只支持浏览和下载。");
    if (
      !isAbsolute(options.root) ||
      (options.linkPrefix !== undefined &&
        options.linkPrefix !== "" &&
        !/^\/p\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          options.linkPrefix,
        )) ||
      (options.workspace !== undefined && !isAbsolute(options.workspace)) ||
      !/^\/api\/v1\/panels\/runtime\/[A-Za-z0-9_-]+\/directory\/[A-Za-z0-9_-]+$/.test(
        options.baseUrl,
      )
    )
      fail(400, "下载目录配置无效。");
    const url = new URL(request.url ?? "", "http://localhost");
    if (
      url.pathname !== options.baseUrl ||
      [...url.searchParams.keys()].some((key) => key !== "file" && key !== "workspace") ||
      url.searchParams.getAll("file").length > 1 ||
      url.searchParams.getAll("workspace").length > 1 ||
      (url.searchParams.has("workspace") && url.searchParams.get("workspace") !== options.workspace)
    )
      fail(400, "下载参数无效。");
    const name = url.searchParams.get("file");
    if (name !== null && !safeBasename(name)) fail(400, "下载文件名无效。");
    if (name !== null && !downloadable(name)) fail(404, "找不到可下载的文件。");
    const root = resolve(options.root);
    const before = await lstat(root);
    await authorize();
    if (!before.isDirectory() || before.isSymbolicLink()) fail(404, "下载目录不可用。");
    const canonical = await realpath(root);
    await authorize();
    if (canonical !== root) fail(404, "下载目录已经改变。");
    directory = await open(
      root,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    await authorize();
    const opened = await directory.stat();
    await authorize();
    if (!opened.isDirectory() || !sameFile(before, opened)) fail(404, "下载目录已经改变。");
    const verifyDirectory = async () => {
      const current = await lstat(root);
      await authorize();
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(opened, current))
        fail(404, "下载目录已经改变。");
    };
    if (name === null) {
      const entries: Array<{ name: string; size: number }> = [];
      let examined = 0;
      let truncated = false;
      const listing = await opendir(root);
      try {
        await authorize();
        for await (const entry of listing) {
          await authorize();
          if (++examined > MAX_EXAMINED) {
            truncated = true;
            break;
          }
          if (!entry.isFile() || !downloadable(entry.name)) continue;
          const metadata = await lstat(join(root, entry.name)).catch(() => null);
          await authorize();
          if (
            !metadata ||
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            metadata.nlink !== 1 ||
            metadata.size > MAX_DOWNLOAD_BYTES
          )
            continue;
          if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          entries.push({ name: entry.name, size: metadata.size });
        }
      } finally {
        try {
          await listing.close();
        } catch {
          /* Iteration already closed the directory. */
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      await verifyDirectory();
      await authorize();
      const rows = entries
        .map(
          (entry) =>
            `<li><a href="${escaped((options.linkPrefix ?? "") + options.baseUrl + "?file=" + encodeURIComponent(entry.name) + (options.workspace === undefined ? "" : "&workspace=" + encodeURIComponent(options.workspace)))}">${escaped(entry.name)}</a><span>${entry.size.toLocaleString("en-US")} bytes</span></li>`,
        )
        .join("");
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>面板下载文件</title><style>body{font:16px system-ui,sans-serif;max-width:880px;margin:48px auto;padding:0 24px;color:#1f2937;background:#f8fafc}h1{font-size:26px}p,span{color:#64748b}ul{list-style:none;padding:0}li{display:flex;gap:24px;justify-content:space-between;padding:16px 0;border-bottom:1px solid #e2e8f0}a{color:#1d4ed8;overflow-wrap:anywhere}span{font-size:13px;white-space:nowrap}</style><h1>面板下载文件</h1><p>点击文件保存到这台设备。这里只显示当前目录中的媒体与导出文件。</p>${rows ? `<ul>${rows}</ul>` : "<p>暂无可下载的文件。</p>"}${truncated ? "<p>文件较多，当前最多显示 200 项。</p>" : ""}</html>`;
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    const path = join(root, name);
    const entry = await lstat(path);
    await authorize();
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
      fail(404, "找不到可下载的文件。");
    const location = process.platform === "linux" ? `/proc/self/fd/${directory.fd}/${name}` : path;
    file = await open(
      location,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    await authorize();
    const metadata = await file.stat();
    await authorize();
    if (!metadata.isFile() || metadata.nlink !== 1 || !sameFile(entry, metadata))
      fail(404, "下载文件已经改变。");
    if (metadata.size > MAX_DOWNLOAD_BYTES) fail(413, "下载文件超过 2 GiB。");
    const current = await lstat(path);
    await authorize();
    if (current.isSymbolicLink() || !sameFile(metadata, current)) fail(404, "下载文件已经改变。");
    await verifyDirectory();
    await authorize();
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": disposition(name),
      "Content-Length": metadata.size,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (request.method === "HEAD" || metadata.size === 0) {
      response.end();
      return;
    }
    const input = file.createReadStream({ autoClose: false, start: 0, end: metadata.size - 1 });
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void authorize()
        .catch((cause) => {
          input.destroy(cause);
          response.destroy(cause);
        })
        .finally(() => {
          checking = false;
        });
    }, 250);
    timer.unref();
    try {
      await pipeline(
        Readable.from(
          (async function* () {
            for await (const chunk of input) {
              await authorize();
              yield chunk;
            }
          })(),
          { objectMode: false },
        ),
        response,
      );
    } finally {
      clearInterval(timer);
      input.destroy();
    }
  } catch (cause) {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    const code = (cause as NodeJS.ErrnoException)?.code;
    const status =
      cause instanceof DirectoryError
        ? cause.status
        : ["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes(code ?? "")
          ? 404
          : 500;
    const message =
      cause instanceof DirectoryError
        ? cause.message
        : status === 404
          ? "找不到可下载的文件。"
          : "无法读取下载目录。";
    response.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : message);
  } finally {
    await file?.close().catch(() => {});
    await directory?.close().catch(() => {});
  }
}

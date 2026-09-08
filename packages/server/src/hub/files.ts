import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { hubJson } from "./uploads.js";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

class FileRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Authenticated, read-only workspace files. Downloads never execute as Hub pages. */
export function createHubFiles(options: {
  cwd: string;
  isAuthorized: (request: IncomingMessage) => Promise<boolean>;
}) {
  const lexicalRoot = resolve(options.cwd);
  let canonicalRoot: string | undefined;
  let rootIdentity: { dev: number; ino: number } | undefined;
  const active = new Set<ServerResponse>();
  let closed = false;

  function allowedPath(parts: string[]): boolean {
    return (
      !parts.some(
        (part) =>
          [".git", "node_modules", ".ssh", ".aws", ".npmrc", ".netrc"].includes(
            part.toLowerCase(),
          ) || /^\.env(?:\.|$)/i.test(part),
      ) &&
      (!parts.some((part) => part.toLowerCase() === ".code-shell") ||
        (parts[0] === ".code-shell" &&
          parts[1] === "attachments" &&
          !parts.slice(2).some((part) => part.toLowerCase() === ".code-shell")))
    );
  }

  async function locate(input: string) {
    if (input.length > 4096 || input.includes("\0") || input.includes("\\"))
      throw new FileRequestError(400, "文件路径无效。");
    const root = canonicalRoot ?? (canonicalRoot = await realpath(lexicalRoot));
    const target = resolve(isAbsolute(input) ? input : join(root, input || "."));
    // The configured workspace may itself be an alias (for example /var on macOS).
    let rel = relative(root, target);
    if (isAbsolute(input) && (rel === ".." || rel.startsWith(`..${sep}`))) {
      const lexical = relative(lexicalRoot, target);
      if (lexical !== ".." && !lexical.startsWith(`..${sep}`) && !isAbsolute(lexical))
        rel = lexical;
    }
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new FileRequestError(403, "只能访问当前服务器工作区内的文件。");
    const parts = rel.split(sep).filter(Boolean);
    if (parts.length > 128) throw new FileRequestError(400, "文件路径层级过深。");
    if (!allowedPath(parts))
      throw new FileRequestError(403, "这个位置包含服务配置或内部数据，不能从文件页面读取。");
    const path = join(root, ...parts);
    await checkSegments(root, parts);
    return { root, path, relativePath: parts.join("/"), parts };
  }

  async function openLocation(location: Awaited<ReturnType<typeof locate>>, directory: boolean) {
    const held: Array<{ handle: FileHandle; path: string; dev: number; ino: number }> = [];
    const close = async () => {
      await Promise.all(held.map((entry) => entry.handle.close().catch(() => undefined)));
    };
    try {
      let path = location.root;
      for (let index = -1; index < location.parts.length; index++) {
        if (index >= 0) path = join(path, location.parts[index]!);
        const parent = held.at(-1);
        // Linux exposes stable directory descriptors; each child is opened relative
        // to its held parent. Other Node hosts keep all ancestor descriptors and
        // reject replaced paths before returning bytes or directory metadata.
        const openPath =
          process.platform === "linux" && parent
            ? `/proc/self/fd/${parent.handle.fd}/${location.parts[index]}`
            : path;
        const isDirectory = index < location.parts.length - 1 || directory;
        const handle = await open(
          openPath,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0) |
            (isDirectory ? (constants.O_DIRECTORY ?? 0) : 0),
        );
        const info = await handle.stat().catch(async (error) => {
          await handle.close().catch(() => undefined);
          throw error;
        });
        held.push({ handle, path, dev: info.dev, ino: info.ino });
        if (isDirectory ? !info.isDirectory() : !info.isFile())
          throw new FileRequestError(
            400,
            isDirectory ? "这个路径不是文件夹。" : "只能读取普通文件。",
          );
        if (index === -1) {
          rootIdentity ??= { dev: info.dev, ino: info.ino };
          if (info.dev !== rootIdentity.dev || info.ino !== rootIdentity.ino)
            throw new FileRequestError(409, "服务器工作目录已经改变，请重新启动服务。");
        }
      }
      const handle = held.at(-1)!.handle;
      const verify = async () => {
        for (const entry of held) {
          const info = await lstat(entry.path);
          if (info.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino)
            throw new FileRequestError(409, "文件或所在目录正在变化，请刷新后重试。");
        }
      };
      await verify();
      return {
        handle,
        close,
        verify,
        readPath: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : location.path,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!["/api/v1/files", "/api/v1/files/content"].includes(url.pathname)) return false;
    let handle: FileHandle | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      if (closed) throw new FileRequestError(503, "服务正在关闭。");
      if (req.method !== "GET") throw new FileRequestError(405, "文件页面只支持读取。");
      if (!(await options.isAuthorized(req))) throw new FileRequestError(401, "请重新登录。");
      if (active.size >= 16) throw new FileRequestError(429, "正在读取的文件过多，请稍后重试。");
      active.add(res);
      const location = await locate(url.searchParams.get("path") ?? "");
      const directory = url.pathname === "/api/v1/files";
      if (!directory && !location.parts.length) throw new FileRequestError(400, "请选择一个文件。");
      const opened = await openLocation(location, directory);
      handle = opened.handle;
      release = opened.close;
      const info = await handle.stat();
      if (directory) {
        const files: Array<{
          name: string;
          path: string;
          kind: "directory" | "file";
          size: number;
          modifiedAt: number;
        }> = [];
        let examined = 0;
        let truncated = false;
        const listing = await opendir(opened.readPath, { bufferSize: 64 });
        try {
          for await (const entry of listing) {
            if (++examined > 4096) {
              truncated = true;
              break;
            }
            if (
              !(entry.isFile() || entry.isDirectory()) ||
              !allowedPath([...location.parts, entry.name])
            )
              continue;
            if (files.length >= 500) {
              truncated = true;
              break;
            }
            try {
              const child = await lstat(join(opened.readPath, entry.name));
              if (!child.isFile() && !child.isDirectory()) continue;
              files.push({
                name: entry.name,
                path: [...location.parts, entry.name].join("/"),
                kind: child.isDirectory() ? "directory" : "file",
                size: child.size,
                modifiedAt: child.mtimeMs,
              });
            } catch {
              /* A concurrent rename must not hide the remaining directory. */
            }
          }
        } finally {
          try {
            await listing.close();
          } catch {
            /* The async iterator also closes on completion or early return. */
          }
        }
        files.sort(
          (a, b) =>
            Number(b.kind === "directory") - Number(a.kind === "directory") ||
            a.name.localeCompare(b.name),
        );
        if (!(await options.isAuthorized(req))) throw new FileRequestError(401, "请重新登录。");
        await opened.verify();
        hubJson(res, 200, { path: location.relativePath, files, truncated });
      } else {
        if (info.size > MAX_DOWNLOAD_BYTES)
          throw new FileRequestError(413, "文件超过 100 MB，请从服务器工作目录获取。");
        if (!(await options.isAuthorized(req))) throw new FileRequestError(401, "请重新登录。");
        await opened.verify();
        const imageType = IMAGE_TYPES[extname(location.path).toLowerCase()];
        const preview = url.searchParams.get("preview") === "true";
        if (preview) {
          const buffer = Buffer.alloc(Math.min(info.size, MAX_PREVIEW_BYTES));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const bytes = buffer.subarray(0, bytesRead);
          const binary = bytes.includes(0) || !!imageType;
          hubJson(res, 200, {
            path: location.relativePath,
            name: basename(location.path),
            size: info.size,
            kind: imageType ? "image" : binary ? "binary" : "text",
            ...(imageType ? { mime: imageType } : {}),
            ...(!binary
              ? { content: bytes.toString("utf8"), truncated: info.size > MAX_PREVIEW_BYTES }
              : {}),
          });
        } else {
          const inline = url.searchParams.get("inline") === "true" && !!imageType;
          const filename = basename(location.path);
          const encoded = encodeURIComponent(filename).replace(
            /[!'()*]/g,
            (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
          );
          res.writeHead(200, {
            "content-type": inline ? imageType : "application/octet-stream",
            "content-length": info.size,
            "content-disposition": `${inline ? "inline" : "attachment"}; filename="download${extname(filename).replace(/[^.A-Za-z0-9]/g, "")}"; filename*=UTF-8''${encoded}`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          });
          if (info.size === 0) res.end();
          else
            await pipeline(
              handle.createReadStream({ autoClose: false, end: Math.max(0, info.size - 1) }),
              res,
            );
        }
      }
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const failure =
        cause instanceof FileRequestError
          ? cause
          : code === "ENOENT"
            ? new FileRequestError(404, "文件不存在或已移动。")
            : ["ELOOP", "ENOTDIR"].includes(code ?? "")
              ? new FileRequestError(409, "文件或所在目录正在变化，请刷新后重试。")
              : code === "EACCES" || code === "EPERM"
                ? new FileRequestError(403, "服务器没有读取这个文件的权限。")
                : new FileRequestError(500, "无法读取这个文件，请刷新后重试。");
      if (res.headersSent) res.destroy();
      else hubJson(res, failure.status, { error: failure.message });
    } finally {
      if (release) await release();
      else await handle?.close().catch(() => undefined);
      active.delete(res);
    }
    return true;
  }
  return {
    handle,
    close() {
      closed = true;
      for (const response of active) response.destroy();
      active.clear();
    },
  };
}

async function checkSegments(root: string, parts: readonly string[]): Promise<void> {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new FileRequestError(403, "工作目录已经改变，请重新连接。");
  let path = root;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]!);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()))
      throw new FileRequestError(403, "不能从文件页面访问符号链接。");
  }
}

/**
 * 上传文件源（ADR §4.3）：每个 workspace 隐式自带，不进全局 catalog。
 * 文件在 ${cwd}/.code-shell/uploads/ 内；读取前规范化 resourceId，
 * 并校验消解 symlink 后的真实路径仍在 uploads 目录内。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ConnectorAdapter } from "../adapter.js";
import { truncateUtf8Bytes } from "../truncate-utf8.js";
import type { SourceDefinition, SourceResourceMeta } from "../types.js";

export const LOCAL_FILES_SOURCE_ID = "project-uploads";

export function uploadsDir(cwd: string): string {
  return join(cwd, ".code-shell", "uploads");
}

export function localFilesSourceFor(cwd: string): SourceDefinition {
  return {
    id: LOCAL_FILES_SOURCE_ID,
    kind: "local-files",
    label: "项目文件",
    description: `本 workspace 上传的文件（${uploadsDir(cwd)}）`,
    adapterConfig: {},
    enabled: true,
  };
}

function canonicalResourceId(resourceId: string): string {
  let decoded = resourceId;

  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error(`invalid local-files resource path: ${resourceId}`);
  }

  if (
    decoded.length === 0 ||
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    isAbsolute(decoded) ||
    /^[a-zA-Z]:[\\/]/.test(decoded)
  ) {
    throw new Error(`invalid local-files resource path: ${resourceId}`);
  }

  const canonical = normalize(decoded);
  if (canonical === "." || canonical === ".." || canonical.startsWith(`..${sep}`)) {
    throw new Error(`resource escapes uploads dir: ${resourceId}`);
  }

  return canonical.split(sep).join("/");
}

function resolveInsideUploads(
  cwd: string,
  resourceId: string,
): {
  path: string;
  resourceId: string;
} {
  const root = realpathSync(uploadsDir(cwd));
  const canonicalId = canonicalResourceId(resourceId);
  const candidate = resolve(root, ...canonicalId.split("/"));
  const real = realpathSync(candidate);

  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Error(`resource escapes uploads dir: ${resourceId}`);
  }

  const finalId = relative(root, real).split(sep).join("/");
  if (!finalId || finalId === ".." || finalId.startsWith("../")) {
    throw new Error(`invalid local-files resource path: ${resourceId}`);
  }

  return { path: real, resourceId: finalId };
}

export const localFilesAdapter: ConnectorAdapter = {
  kind: "local-files",

  async listScopes() {
    return [{ id: "uploads", label: "上传文件" }];
  },

  async listResources() {
    throw new Error("use listLocalFiles(cwd) — local-files listing is cwd-scoped");
  },

  async read(_definition, resourceId, options) {
    if (!options.cwd) {
      throw new Error("local-files read requires cwd");
    }

    const resolved = resolveInsideUploads(options.cwd, resourceId);
    const buffer = readFileSync(resolved.path);
    const truncated = truncateUtf8Bytes(buffer, options.maxBytes);

    return {
      resourceId: resolved.resourceId,
      ...truncated,
    };
  },
};

/** cwd 维度的文件列举；隐式源不在 definition 里携带路径。 */
export function listLocalFiles(cwd: string): SourceResourceMeta[] {
  const directory = uploadsDir(cwd);
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      id: entry.name,
      scopeId: "uploads",
      name: entry.name,
      sizeBytes: statSync(join(directory, entry.name)).size,
    }));
}

/**
 * 上传文件源（ADR §4.3）：每个 workspace 隐式自带，不进全局 catalog。
 * 文件在 ${cwd}/.code-shell/uploads/ 内；读取前规范化 resourceId，
 * 并校验消解 symlink 后的真实路径仍在 uploads 目录内。
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ConnectorAdapter } from "../adapter.js";
import { truncateUtf8Text } from "../truncate-utf8.js";
import {
  documentIndexText,
  loadUploadedDocumentIndex,
  searchDocumentIndex,
  uploadedDocumentHash,
} from "../documents/index-store.js";
import { MAX_DOCUMENT_BYTES } from "../documents/types.js";
import type { SourceDefinition, SourceResourceMeta } from "../types.js";

export const LOCAL_FILES_SOURCE_ID = "project-uploads";

export function uploadsDir(cwd: string): string {
  return join(cwd, ".code-shell", "uploads");
}

/** Validate a write/delete basename and resolve it inside the workspace uploads directory. */
export function resolveUploadTarget(cwd: string, name: string): string {
  let decoded = name;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error(`invalid upload name: ${name}`);
  }

  if (
    !name ||
    name !== decoded ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    basename(name) !== name
  ) {
    throw new Error(`invalid upload name: ${name}`);
  }

  const root = resolve(uploadsDir(cwd));
  const target = resolve(root, name);
  if (dirname(target) !== root) throw new Error(`invalid upload name: ${name}`);
  return target;
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
  directoryIdentity: string;
} {
  const workspace = realpathSync(resolve(cwd));
  const stateDir = join(workspace, ".code-shell");
  const stateInfo = lstatSync(stateDir);
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
    throw new Error("project state directory must be a regular directory");
  }
  const stateReal = realpathSync(stateDir);
  if (
    relative(workspace, stateReal).startsWith(`..${sep}`) ||
    relative(workspace, stateReal) === ".."
  ) {
    throw new Error("project state directory escapes cwd");
  }
  const uploadPath = join(stateReal, "uploads");
  const uploadInfo = lstatSync(uploadPath);
  if (uploadInfo.isSymbolicLink() || !uploadInfo.isDirectory()) {
    throw new Error("uploads directory must be a regular directory");
  }
  const root = realpathSync(uploadPath);
  const uploadRel = relative(stateReal, root);
  if (uploadRel === ".." || uploadRel.startsWith(`..${sep}`) || isAbsolute(uploadRel)) {
    throw new Error("uploads directory escapes cwd");
  }
  const canonicalId = canonicalResourceId(resourceId);
  const candidate = resolve(root, ...canonicalId.split("/"));
  const candidateInfo = lstatSync(candidate);
  if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
    throw new Error(`resource escapes uploads or is not a regular file: ${resourceId}`);
  }
  const real = realpathSync(candidate);

  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Error(`resource escapes uploads dir: ${resourceId}`);
  }

  const finalId = relative(root, real).split(sep).join("/");
  if (!finalId || finalId === ".." || finalId.startsWith("../")) {
    throw new Error(`invalid local-files resource path: ${resourceId}`);
  }

  const workspaceInfo = lstatSync(workspace);
  return {
    path: real,
    resourceId: finalId,
    directoryIdentity: JSON.stringify([
      workspace,
      workspaceInfo.dev,
      workspaceInfo.ino,
      stateReal,
      stateInfo.dev,
      stateInfo.ino,
      root,
      uploadInfo.dev,
      uploadInfo.ino,
    ]),
  };
}

function readSnapshot(cwd: string, resourceId: string) {
  const resolved = resolveInsideUploads(cwd, resourceId);
  const before = lstatSync(resolved.path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Uploaded document is no longer a regular file");
  const fd = openSync(
    resolved.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev)
      throw new Error("Uploaded document changed before reading");
    if (info.size > MAX_DOCUMENT_BYTES)
      throw new Error(
        "Uploaded document exceeds the 20 MiB parsing limit; split it or export a smaller UTF-8 text file",
      );
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const current = resolveInsideUploads(cwd, resourceId);
    const currentInfo = lstatSync(current.path);
    if (
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      currentInfo.ino !== info.ino ||
      currentInfo.dev !== info.dev ||
      current.directoryIdentity !== resolved.directoryIdentity
    )
      throw new Error("Uploaded document changed during reading");
    return {
      resourceId: resolved.resourceId,
      bytes: bytes.subarray(0, length),
      identity: JSON.stringify([resolved.directoryIdentity, resolved.path, info.dev, info.ino]),
    };
  } finally {
    closeSync(fd);
  }
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

    options.signal?.throwIfAborted();
    options.assertAuthorized?.();
    const snapshot = readSnapshot(options.cwd, resourceId);
    const sourceHash = uploadedDocumentHash(snapshot.bytes);
    const assertCurrent = () => {
      options.signal?.throwIfAborted();
      options.assertAuthorized?.();
      const current = readSnapshot(options.cwd!, resourceId);
      if (
        current.identity !== snapshot.identity ||
        uploadedDocumentHash(current.bytes) !== sourceHash
      )
        throw new Error("Uploaded document changed during parsing; read its current version again");
    };
    const index = await loadUploadedDocumentIndex(
      options.cwd,
      snapshot.resourceId,
      snapshot.bytes,
      {
        signal: options.signal,
        assertCurrent,
        resolveExecutable: options.documentParserExecutable,
      },
    );
    let text: string;
    if (options.query !== undefined) {
      text = JSON.stringify(searchDocumentIndex(index, options.query, options.limit ?? 5));
    } else if (options.chunk !== undefined) {
      const chunk = index.chunks.find((candidate) => candidate.id === options.chunk);
      if (!chunk)
        throw new Error(
          "Document chunk does not exist in the current file version; query the current document again",
        );
      text = JSON.stringify({ resourceId, sourceHash, ...chunk });
    } else {
      text =
        documentIndexText(index) ||
        "This document contains no extractable text; scanned images require OCR or a UTF-8 text export.";
    }
    assertCurrent();
    const truncated = truncateUtf8Text(text, options.maxBytes);

    return {
      resourceId: snapshot.resourceId,
      ...truncated,
      truncated: truncated.truncated || index.truncated,
    };
  },
};

/** cwd 维度的文件列举；隐式源不在 definition 里携带路径。 */
export function listLocalFiles(cwd: string): SourceResourceMeta[] {
  const directory = uploadsDir(cwd);
  if (!existsSync(directory)) return [];

  let workspace: string;
  let directoryReal: string;
  try {
    workspace = realpathSync(resolve(cwd));
    const stateDir = join(workspace, ".code-shell");
    const stateInfo = lstatSync(stateDir);
    const directoryInfo = lstatSync(directory);
    if (
      stateInfo.isSymbolicLink() ||
      !stateInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      !directoryInfo.isDirectory()
    ) {
      return [];
    }
    directoryReal = realpathSync(directory);
    const rel = relative(workspace, directoryReal);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [];
  } catch {
    return [];
  }

  return readdirSync(directoryReal, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .slice(0, 10_000)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      id: entry.name,
      scopeId: "uploads",
      name: entry.name,
      sizeBytes: statSync(join(directoryReal, entry.name)).size,
    }));
}

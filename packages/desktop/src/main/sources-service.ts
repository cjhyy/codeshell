/** 数据源的 desktop main 门面（组合 core host API，样板 = profiles-service.ts）。 */
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import {
  bindSource as bindWorkspaceSource,
  connectorAdapterFor,
  defaultCredentialStatus,
  deleteSourceDefinition,
  listBindings,
  listLocalFiles,
  listSourceDefinitions,
  readSourceDefinition,
  resolveEffectiveSourceAccess,
  resolveUploadTarget,
  saveSourceDefinition,
  unbindSource as unbindWorkspaceSource,
} from "@cjhyy/code-shell-core/internal";

const MAX_UPLOAD_FILES = 100;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkedUploadsDir(cwd: string, create: boolean): string | undefined {
  const workspace = realpathSync(resolve(cwd));
  const stateDir = join(workspace, ".code-shell");
  if (existsSync(stateDir)) {
    const info = lstatSync(stateDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("project state directory must be a regular directory");
    }
  } else if (create) {
    mkdirSync(stateDir, { mode: 0o700 });
  } else {
    return undefined;
  }
  const stateReal = realpathSync(stateDir);
  if (!isContained(workspace, stateReal)) throw new Error("project state directory escapes cwd");
  const root = join(stateReal, "uploads");
  if (existsSync(root)) {
    const info = lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("uploads directory must be a regular directory");
    }
  } else if (create) {
    mkdirSync(root, { mode: 0o700 });
  } else {
    return undefined;
  }
  const rootReal = realpathSync(root);
  if (!isContained(stateReal, rootReal)) throw new Error("uploads directory escapes cwd");
  if (process.platform !== "win32") chmodSync(rootReal, 0o700);
  return rootReal;
}

export function catalogList() {
  return listSourceDefinitions();
}

export function catalogSave(definition: Parameters<typeof saveSourceDefinition>[0]): void {
  saveSourceDefinition(definition);
}

export function catalogDelete(id: string): void {
  deleteSourceDefinition(id);
}

export function workspaceAccess(cwd: string) {
  const settings = new SettingsManager(cwd, "full");
  let uploads: ReturnType<typeof listLocalFiles> = [];
  try {
    if (checkedUploadsDir(cwd, false)) uploads = listLocalFiles(cwd);
  } catch {
    // An invalid/symlinked project upload root is unavailable, not a source.
  }
  return {
    bindings: listBindings(settings, cwd),
    access: resolveEffectiveSourceAccess({
      cwd,
      settings,
      credentialStatus: defaultCredentialStatus,
    }),
    uploads,
  };
}

export function bind(cwd: string, binding: Parameters<typeof bindWorkspaceSource>[2]): void {
  bindWorkspaceSource(new SettingsManager(cwd, "full"), cwd, binding);
}

export function unbind(cwd: string, sourceId: string): void {
  unbindWorkspaceSource(new SettingsManager(cwd, "full"), cwd, sourceId);
}

export async function listScopes(sourceId: string) {
  const definition = readSourceDefinition(sourceId);
  if (!definition) throw new Error(`source not found: ${sourceId}`);

  const adapter = connectorAdapterFor(definition.kind);
  if (!adapter) throw new Error(`no adapter registered for source kind: ${definition.kind}`);
  return adapter.listScopes(definition);
}

/** 上传 = 把用户选中的文件按 basename 拷进 uploads 目录（同名覆盖）。 */
export function uploadFiles(cwd: string, absolutePaths: string[]): string[] {
  if (!Array.isArray(absolutePaths) || absolutePaths.length > MAX_UPLOAD_FILES) {
    throw new Error(`too many upload files (max ${MAX_UPLOAD_FILES})`);
  }
  const root = checkedUploadsDir(cwd, true)!;
  const files = absolutePaths.map((path) => {
    if (typeof path !== "string" || !path || path.length > 32_768 || path.includes("\0")) {
      throw new Error("invalid upload source path");
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("upload source must be a regular file");
    }
    if (info.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error("upload source exceeds the 100 MB size limit");
    }
    const name = basename(path);
    resolveUploadTarget(cwd, name); // validates the untrusted basename
    const target = join(root, name);
    if (existsSync(target)) {
      const targetInfo = lstatSync(target);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        throw new Error("upload target must be a regular file");
      }
    }
    return { path: realpathSync(path), name, target };
  });

  for (const file of files) {
    const temporary = join(root, `.${file.name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      copyFileSync(file.path, temporary, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, file.target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return files.map((file) => file.name);
}

/** 只允许删除 uploads 根目录下一层、未编码且非隐藏的 basename。 */
export function deleteUpload(cwd: string, name: string): void {
  const root = checkedUploadsDir(cwd, false);
  if (!root) return;
  resolveUploadTarget(cwd, name); // validates the untrusted basename
  const target = join(root, name);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("upload target must be a regular file");
    }
  }
  rmSync(target, { force: true });
}

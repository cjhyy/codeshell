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
import { copyFile, chmod } from "node:fs/promises";
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
  LOCAL_FILES_SOURCE_ID,
  invalidateUploadedDocumentIndex,
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
  return listSourceDefinitions().filter((definition) => definition.kind !== "mock");
}

export function catalogSave(
  definition: Parameters<typeof saveSourceDefinition>[0],
  beforeCommit?: () => void,
): void {
  if (
    definition.kind === "collection" ||
    readSourceDefinition(definition.id)?.kind === "collection"
  )
    throw new Error("资料集请通过文件选择和资料集编辑界面修改。");
  if (definition.kind === "mock") throw new Error("演示数据仅用于测试，不能保存为项目资料。");
  saveSourceDefinition(definition, { preserveCollections: true, beforeCommit });
}

export function catalogDelete(id: string, beforeCommit?: () => void): void {
  if (readSourceDefinition(id)?.kind === "collection")
    throw new Error("请先查看资料集引用影响，再删除资料集。");
  deleteSourceDefinition(id, { preserveCollections: true, beforeCommit });
}

export function workspaceAccess(cwd: string) {
  const settings = new SettingsManager(cwd, "full");
  const mockIds = new Set(
    listSourceDefinitions()
      .filter((definition) => definition.kind === "mock")
      .map((definition) => definition.id),
  );
  let uploads: ReturnType<typeof listLocalFiles> = [];
  try {
    if (checkedUploadsDir(cwd, false)) uploads = listLocalFiles(cwd);
  } catch {
    // An invalid/symlinked project upload root is unavailable, not a source.
  }
  const bindings = listBindings(settings, cwd).filter((binding) => !mockIds.has(binding.sourceId));
  return {
    bindings,
    access: resolveEffectiveSourceAccess({
      cwd,
      settings,
      credentialStatus: defaultCredentialStatus,
    }).filter(
      (access) =>
        access.kind !== "mock" &&
        (access.sourceId !== LOCAL_FILES_SOURCE_ID || bindings.length > 0 || uploads.length > 0),
    ),
    uploads,
  };
}

export function bind(
  cwd: string,
  binding: Parameters<typeof bindWorkspaceSource>[2],
  beforeCommit?: () => void,
): void {
  if (readSourceDefinition(binding.sourceId)?.kind === "mock")
    throw new Error("演示数据仅用于测试，不能绑定到项目。");
  bindWorkspaceSource(new SettingsManager(cwd, "full"), cwd, binding, beforeCommit);
}

export function unbind(cwd: string, sourceId: string, beforeCommit?: () => void): void {
  unbindWorkspaceSource(new SettingsManager(cwd, "full"), cwd, sourceId, beforeCommit);
}

export async function listScopes(sourceId: string) {
  const definition = readSourceDefinition(sourceId);
  if (!definition) throw new Error(`source not found: ${sourceId}`);
  if (definition.kind === "mock") throw new Error("演示数据仅用于测试，不能读取。");

  const adapter = connectorAdapterFor(definition.kind);
  if (!adapter) throw new Error(`no adapter registered for source kind: ${definition.kind}`);
  return adapter.listScopes(definition);
}

function uploadInputs(cwd: string, absolutePaths: string[]) {
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
  return { root, files };
}

export interface StagedSourceUploads {
  directory: string;
  files: { name: string; temporary: string; dev: number; ino: number; size: number }[];
}

function isStagedFile(path: string, expected: StagedSourceUploads["files"][number]) {
  try {
    const current = lstatSync(path);
    return (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.size === expected.size
    );
  } catch {
    return false;
  }
}

export function discardStagedUploads(staged: StagedSourceUploads) {
  for (const file of staged.files) {
    const path = join(staged.directory, file.temporary);
    if (isStagedFile(path, file)) rmSync(path, { force: true });
  }
}

/** Stage bounded native selections asynchronously before claiming the writer.
 * Only the final rename runs on the shared storage thread. */
export async function stageSourceUploads(
  cwd: string,
  paths: string[],
  assertCurrent: () => void,
): Promise<StagedSourceUploads> {
  assertCurrent();
  const { root, files } = uploadInputs(cwd, paths);
  const staged: StagedSourceUploads = { directory: root, files: [] };
  try {
    for (const file of files) {
      assertCurrent();
      const temporary = `.codeshell-upload-${randomUUID()}.tmp`;
      const destination = join(root, temporary);
      await copyFile(file.path, destination, constants.COPYFILE_EXCL);
      const stat = lstatSync(destination);
      staged.files.push({
        name: file.name,
        temporary,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
      });
      if (!stat.isFile() || stat.size > MAX_UPLOAD_FILE_BYTES)
        throw new Error("upload source exceeds the size limit");
      if (process.platform !== "win32") await chmod(destination, 0o600);
    }
    assertCurrent();
    return staged;
  } catch (error) {
    discardStagedUploads(staged);
    throw error;
  }
}

export function commitStagedUploads(
  cwd: string,
  staged: StagedSourceUploads,
  commit: () => void,
): string[] {
  const root = checkedUploadsDir(cwd, false);
  if (!root || root !== staged.directory) throw new Error("Project uploads directory changed");
  const files = staged.files.map((file) => {
    resolveUploadTarget(cwd, file.name);
    if (!/^\.codeshell-upload-[a-f0-9-]+\.tmp$/.test(file.temporary))
      throw new Error("Invalid staged upload");
    const temporary = join(root, file.temporary);
    const target = join(root, file.name);
    if (!isStagedFile(temporary, file)) throw new Error("Staged upload changed");
    if (existsSync(target) && !lstatSync(target).isFile())
      throw new Error("upload target must be a regular file");
    return { name: file.name, temporary, target };
  });
  commit();
  for (const file of files) {
    renameSync(file.temporary, file.target);
    invalidateUploadedDocumentIndex(cwd, file.name);
  }
  return files.map((file) => file.name);
}

/** Synchronous local adapter for callers already running on their own file owner. */
export function uploadFiles(cwd: string, absolutePaths: string[]): string[] {
  const { root, files } = uploadInputs(cwd, absolutePaths);
  for (const file of files) {
    const temporary = join(root, `.${file.name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      copyFileSync(file.path, temporary, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, file.target);
      invalidateUploadedDocumentIndex(cwd, file.name);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return files.map((file) => file.name);
}

/** 只允许删除 uploads 根目录下一层、未编码且非隐藏的 basename。 */
export function deleteUpload(cwd: string, name: string, beforeCommit?: () => void): void {
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
  beforeCommit?.();
  rmSync(target, { force: true });
  invalidateUploadedDocumentIndex(cwd, name);
}

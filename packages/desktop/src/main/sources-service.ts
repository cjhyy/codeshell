/** 数据源的 desktop main 门面（组合 core host API，样板 = profiles-service.ts）。 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
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
  uploadsDir,
} from "@cjhyy/code-shell-core/internal";

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
  return {
    bindings: listBindings(settings, cwd),
    access: resolveEffectiveSourceAccess({
      cwd,
      settings,
      credentialStatus: defaultCredentialStatus,
    }),
    uploads: listLocalFiles(cwd),
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
  const files = absolutePaths.map((path) => {
    const name = basename(path);
    return { path, name, target: resolveUploadTarget(cwd, name) };
  });

  mkdirSync(uploadsDir(cwd), { recursive: true });
  for (const file of files) copyFileSync(file.path, file.target);
  return files.map((file) => file.name);
}

/** 只允许删除 uploads 根目录下一层、未编码且非隐藏的 basename。 */
export function deleteUpload(cwd: string, name: string): void {
  rmSync(resolveUploadTarget(cwd, name), { force: true });
}

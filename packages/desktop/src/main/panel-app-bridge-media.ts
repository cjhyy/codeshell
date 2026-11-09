/**
 * Native file selection for Panel media and resource references: the
 * `resources.references.pick` dialog (re-authorized before and after the user
 * answers) and the `media.*` import/export/reveal paths that need a Host
 * dialog or shell. Everything else is forwarded to PanelMediaService.
 */
import { BrowserWindow, dialog, shell } from "electron";
import { basename } from "node:path";
import { PanelBridgeError } from "@cjhyy/code-shell-server/panels";
import type { GuestBinding, PanelAppBridgeInternals } from "./panel-app-bridge-types.js";

export async function panelPickResourceReferences(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const input = (params ?? {}) as {
    multiple?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
    id?: string;
  };
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["multiple", "filters", "id"].includes(key)) ||
    (input.multiple !== undefined && typeof input.multiple !== "boolean") ||
    (input.id !== undefined &&
      (typeof input.id !== "string" || !/^external-[a-f0-9]{64}$/.test(input.id))) ||
    (input.filters !== undefined &&
      (!Array.isArray(input.filters) ||
        input.filters.length > 16 ||
        input.filters.some(
          (filter) =>
            !filter ||
            typeof filter !== "object" ||
            Object.keys(filter).some((key) => !["name", "extensions"].includes(key)) ||
            typeof filter.name !== "string" ||
            !filter.name.trim() ||
            filter.name.length > 80 ||
            !Array.isArray(filter.extensions) ||
            !filter.extensions.length ||
            filter.extensions.length > 32 ||
            filter.extensions.some(
              (extension) =>
                typeof extension !== "string" || !/^(?:[a-zA-Z0-9]{1,16}|\*)$/.test(extension),
            ),
        )))
  )
    throw new PanelBridgeError("INVALID_ARGUMENT", "Invalid reference file selection");
  const owner = BrowserWindow.fromId(binding.ownerWindowId);
  const assertAuthorized = () => {
    if (
      signal?.aborted ||
      bridge.isResourceTransfersStopping() ||
      bridge.guests.get(binding.guest.id) !== binding ||
      binding.guest.isDestroyed() ||
      !owner ||
      owner.isDestroyed()
    )
      throw new PanelBridgeError("REVOKED", "Panel App file selection was revoked");
    bridge.requirePermission(binding, "resources");
    bridge.assertProjectBinding(binding);
    if (
      !bridge.options.isWorkspaceTrusted(binding.projectPath) ||
      !bridge.options.isWorkspaceTrusted(binding.cwd ?? binding.projectPath)
    )
      throw new PanelBridgeError("REVOKED", "Panel App workspace trust was revoked");
  };
  assertAuthorized();
  const multiple = !input.id && input.multiple === true;
  // A closed guest must not hold Host shutdown open while a native dialog is
  // still waiting for user input. Ignore its eventual answer after revocation.
  const selected = await new Promise<Electron.OpenDialogReturnValue>((resolveSelection, reject) => {
    const abort = () =>
      reject(new PanelBridgeError("REVOKED", "Panel App file selection was revoked"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
      return;
    }
    void dialog
      .showOpenDialog(owner!, {
        title: input.id ? "Reconnect original file" : "Choose files to reference",
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        ...(input.filters ? { filters: input.filters } : {}),
      })
      .then(resolveSelection, () =>
        reject(new PanelBridgeError("OPERATION_FAILED", "Unable to open file selection")),
      )
      .finally(() => signal?.removeEventListener("abort", abort));
  });
  assertAuthorized();
  if (selected.canceled || !selected.filePaths.length) return { references: [] };
  if (selected.filePaths.length > (multiple ? 128 : 1))
    throw new PanelBridgeError("INVALID_ARGUMENT", "Select at most 128 files");
  const scope = { appId: binding.resource.descriptor.appId, projectPath: binding.projectPath };
  const service = bridge.getResourceService().references;
  const references: Awaited<ReturnType<typeof service.createFromSelectedPath>>[] = [];
  for (const path of selected.filePaths) {
    assertAuthorized();
    try {
      references.push(
        input.id
          ? await service.relinkFromSelectedPath(scope, input.id, path, {
              signal,
              assertAuthorized,
            })
          : await service.createFromSelectedPath(scope, path, { signal, assertAuthorized }),
      );
    } catch (error) {
      assertAuthorized();
      if (error instanceof PanelBridgeError) throw error;
      // Filesystem errors can contain the selected absolute source path.
      throw new PanelBridgeError(
        "OPERATION_FAILED",
        "Unable to reference selected file; reconnecting requires the unchanged original file",
      );
    }
  }
  assertAuthorized();
  return { references };
}

export async function panelDispatchMedia(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  method: string,
  params: unknown,
): Promise<unknown> {
  const scope = { appId: binding.resource.descriptor.appId, projectPath: binding.projectPath };
  if (!bridge.options.isWorkspaceTrusted(binding.projectPath))
    throw new Error("Media requires a trusted workspace");
  const service = bridge.getMediaService();
  const input = (params ?? {}) as Record<string, unknown>;
  if (method === "media.import") {
    if (input.paths !== undefined) {
      bridge.requirePermission(binding, "workspace.read");
      return service.importWorkspaceFiles(
        scope,
        await bridge.trustedWorkspaceRoot(binding),
        input.paths,
      );
    }
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("Media picker requires an owner window");
    const selection = await dialog.showOpenDialog(owner, {
      title: "导入视频、图片与音频",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Media",
          extensions: [
            "mp4",
            "m4v",
            "mov",
            "webm",
            "mkv",
            "avi",
            "mp3",
            "m4a",
            "aac",
            "wav",
            "flac",
            "ogg",
            "opus",
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
            "bmp",
            "tiff",
          ],
        },
      ],
    });
    bridge.assertProjectBinding(binding);
    if (selection.canceled || !selection.filePaths.length) return { cancelled: true };
    return service.importFiles(scope, selection.filePaths);
  }
  if (method === "media.export") {
    const asset = await service.library.get(scope, input.assetId as string);
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("Media export requires an owner window");
    const destination = await dialog.showSaveDialog(owner, {
      title: "保存制作结果",
      defaultPath: asset.name,
    });
    bridge.assertProjectBinding(binding);
    if (destination.canceled || !destination.filePath) return { cancelled: true };
    await service.exportFile(scope, asset.id, destination.filePath);
    return { saved: true, name: basename(destination.filePath) };
  }
  if (method === "media.reveal") {
    const path = await service.library.resolvePath(scope, input.assetId as string);
    shell.showItemInFolder(path);
    return { revealed: true };
  }
  return service.dispatch(scope, method, params);
}

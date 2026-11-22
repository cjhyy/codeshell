import type { IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { requireRendererOrSessionPath } from "./renderer-session-path.js";
import type { NativeMediaProtocol } from "./hosted-media-protocol.js";
import type { AgentDefinition } from "@cjhyy/code-shell-core";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";
import { rejectUnexpectedRendererKeys } from "./renderer-configuration-helpers.js";

type AgentOptions = { scope?: "user" | "project"; target?: RendererConfigurationTarget };
function agentTarget(opts?: AgentOptions) {
  if (opts) rejectUnexpectedRendererKeys(opts, ["scope", "target"], "Agent definition");
  if (opts?.scope !== undefined && opts.scope !== "user" && opts.scope !== "project")
    throw Error("Invalid agent scope");
  if (opts?.scope === "project") {
    if (!opts.target) throw Error("Project agent change requires stable authority");
    return opts.target;
  }
  if (opts?.target) throw Error("User agent change does not accept project authority");
  return null;
}

export interface AgentsMediaIpcDeps {
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal };
  mainWindows: Set<BrowserWindow>;
  mediaPreviewService: NativeMediaProtocol;
}

/** Agent definition routes plus media preview and image read/save routes. */
export function registerAgentsMediaIpc(deps: AgentsMediaIpcDeps) {
  const { mainWindows, mediaPreviewService } = deps;
  ipcMain.handle("media:getPreview", async (event, input: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      ![...mainWindows].some(
        (window) => !window.isDestroyed() && window.webContents === event.sender,
      )
    )
      return null;
    return mediaPreviewService.create(event.sender.id, input, deps.host.documentSignal(event));
  });
  ipcMain.handle("media:releasePreview", (event, url: unknown) => {
    if (event.senderFrame === event.sender.mainFrame && typeof url === "string")
      mediaPreviewService.release(event.sender.id, url);
  });

  ipcMain.handle(
    "images:readDataUrl",
    async (
      event,
      payload: { absPath?: unknown; cwd?: unknown; sessionId?: unknown },
    ): Promise<string | null> => {
      const signal = deps.host.documentSignal(event);
      const cwd =
        typeof payload?.cwd === "string" && payload.cwd
          ? await requireRendererOrSessionPath(payload.cwd, payload.sessionId)
          : undefined;
      return deps.host.callBusiness(
        "images/read",
        {
          path: typeof payload?.absPath === "string" ? payload.absPath : "",
          cwd,
          sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : undefined,
        },
        signal,
      );
    },
  );

  // Save an image to a user-chosen location (Lightbox / attachment "download").
  // Accepts the data URL the renderer already holds (works for generated images,
  // pasted/dragged attachments, and file-backed thumbnails alike). Returns the
  // saved path, or null if the user cancelled the dialog.
  ipcMain.handle(
    "images:save",
    async (e, src: string, opts?: { name?: string; mime?: string }): Promise<string | null> => {
      if (typeof src !== "string" || !src) throw new Error("images:save requires src");
      if (src.length > Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1_024) {
        throw new Error("images:save exceeds the encoded size limit");
      }
      const signal = deps.host.documentSignal(e);
      const suggested = await deps.host.callBusiness(
        "images/exportName",
        { src, name: opts?.name, mime: opts?.mime },
        signal,
      );
      signal.throwIfAborted();
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: suggested })
        : await dialog.showSaveDialog({ defaultPath: suggested });
      if (result.canceled || !result.filePath) return null;
      await deps.host.callBusiness(
        "images/writePicked",
        { src, filePath: result.filePath },
        signal,
      );
      return result.filePath;
    },
  );
  ipcMain.handle("agents:save", (event, definition: AgentDefinition, opts?: AgentOptions) =>
    deps.host.callBusiness(
      "agents/save",
      { target: agentTarget(opts), definition },
      deps.host.documentSignal(event),
    ),
  );
  ipcMain.handle("agents:delete", (event, name: string, opts?: AgentOptions) =>
    deps.host.callBusiness(
      "agents/delete",
      { target: agentTarget(opts), name },
      deps.host.documentSignal(event),
    ),
  );
}

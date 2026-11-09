import { BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { requireRendererOrSessionPath } from "./renderer-session-path.js";
import { readImageDataUrl } from "./image-read-service.js";
import { MediaPreviewService } from "./media-preview-service.js";
import { listAgents, readAgentBody, saveAgent, deleteAgent } from "./agents-service.js";
import type { AgentDefinition } from "@cjhyy/code-shell-core";
import { parseDataUrl, suggestImageFilename } from "./image-save.js";
import { type RendererConfigurationTarget } from "./renderer-configuration-authority.js";
import {
  rendererConfigurationCwd,
  rendererOptionalConfigurationCwd,
  rejectUnexpectedRendererKeys,
  requireRendererListedAgentPath,
} from "./renderer-configuration-helpers.js";

export interface AgentsMediaIpcDeps {
  mainWindows: Set<BrowserWindow>;
  mediaPreviewService: MediaPreviewService;
}

/** Agent definition routes plus media preview and image read/save routes. */
export function registerAgentsMediaIpc(deps: AgentsMediaIpcDeps) {
  const { mainWindows, mediaPreviewService } = deps;
  ipcMain.handle("agents:list", async (_e, target: RendererConfigurationTarget | null) =>
    listAgents(await rendererOptionalConfigurationCwd(target, "")),
  );
  ipcMain.handle(
    "agents:read",
    async (_e, target: RendererConfigurationTarget | null, filePath: unknown) =>
      readAgentBody(await requireRendererListedAgentPath(target, filePath)),
  );

  ipcMain.handle("media:getPreview", async (event, input: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      ![...mainWindows].some(
        (window) => !window.isDestroyed() && window.webContents === event.sender,
      )
    )
      return null;
    return mediaPreviewService.create(event.sender.id, input);
  });
  ipcMain.handle("media:releasePreview", (event, url: unknown) => {
    if (event.senderFrame === event.sender.mainFrame && typeof url === "string")
      mediaPreviewService.release(event.sender.id, url);
  });

  ipcMain.handle(
    "images:readDataUrl",
    async (
      _e,
      payload: { absPath?: unknown; cwd?: unknown; sessionId?: unknown },
    ): Promise<string | null> => {
      const cwd =
        typeof payload?.cwd === "string" && payload.cwd
          ? await requireRendererOrSessionPath(payload.cwd, payload.sessionId)
          : undefined;
      return readImageDataUrl(typeof payload?.absPath === "string" ? payload.absPath : "", {
        cwd,
        sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : undefined,
      });
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
      const parsed = parseDataUrl(src);
      if (!parsed) throw new Error("images:save: src is not a data URL");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const suggested = suggestImageFilename({
        name: opts?.name ?? null,
        mime: opts?.mime ?? parsed.mime,
        stamp,
      });
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: suggested })
        : await dialog.showSaveDialog({ defaultPath: suggested });
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, parsed.buffer);
      return result.filePath;
    },
  );
  ipcMain.handle(
    "agents:save",
    async (
      _e,
      def: AgentDefinition,
      opts?: { scope?: "user" | "project"; target?: RendererConfigurationTarget },
    ) => {
      if (!def || typeof def !== "object") throw new Error("agents:save requires def");
      if (typeof def.name !== "string" || typeof def.description !== "string")
        throw new Error("agents:save: name and description are required");
      if (opts?.scope !== undefined && opts.scope !== "user" && opts.scope !== "project") {
        throw new Error("invalid agent scope");
      }
      if (opts) {
        rejectUnexpectedRendererKeys(
          opts as Record<string, unknown>,
          ["scope", "target"],
          "agents:save",
        );
      }
      if (opts?.scope === "project" && !opts.target) {
        throw new Error("project agent save requires stable authority");
      }
      if (opts?.scope !== "project" && opts?.target) {
        throw new Error("user agent save does not accept project authority");
      }
      const cwd = opts?.target ? await rendererConfigurationCwd(opts.target) : undefined;
      return saveAgent(def, { scope: opts?.scope, cwd });
    },
  );
  ipcMain.handle(
    "agents:delete",
    async (
      _e,
      name: string,
      opts?: { scope?: "user" | "project"; target?: RendererConfigurationTarget },
    ) => {
      if (typeof name !== "string" || !name) throw new Error("agents:delete requires name");
      if (opts?.scope !== undefined && opts.scope !== "user" && opts.scope !== "project") {
        throw new Error("invalid agent scope");
      }
      if (opts) {
        rejectUnexpectedRendererKeys(
          opts as Record<string, unknown>,
          ["scope", "target"],
          "agents:delete",
        );
      }
      if (opts?.scope === "project" && !opts.target) {
        throw new Error("project agent delete requires stable authority");
      }
      if (opts?.scope !== "project" && opts?.target) {
        throw new Error("user agent delete does not accept project authority");
      }
      const cwd = opts?.target ? await rendererConfigurationCwd(opts.target) : undefined;
      return deleteAgent(name, { scope: opts?.scope, cwd });
    },
  );
}

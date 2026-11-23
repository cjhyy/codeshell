import { randomUUID } from "node:crypto";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import {
  type IpcMainInvokeEvent,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { WORKSPACE_PROFILE_NAME_RE } from "@cjhyy/code-shell-core";
import { assertDesktopSessionId } from "./session-validation.js";
import { type RendererConfigurationTarget } from "./renderer-configuration-authority.js";
import { rejectUnexpectedRendererKeys } from "./renderer-configuration-helpers.js";

/** Profile catalog, repositories, definition import/export and digital-human team routes. */
export function registerProfileCatalogIpc(host: {
  callBusiness: CallShellBusiness;
  documentSignal(event: IpcMainInvokeEvent): AbortSignal;
}) {
  const owners = new WeakMap<AbortSignal, string>();
  function reviewOwner(signal: AbortSignal) {
    let id = owners.get(signal);
    if (!id) {
      id = randomUUID();
      owners.set(signal, id);
    }
    return id;
  }
  ipcMain.handle("profiles:list", (event, target: RendererConfigurationTarget | null) =>
    host.callBusiness("profiles/list", { target }, host.documentSignal(event)),
  );
  ipcMain.handle(
    "profiles:activate",
    async (_e, target: RendererConfigurationTarget, name: string) => {
      if (typeof name !== "string" || !name) throw new Error("profiles:activate requires name");
      return host.callBusiness("profiles/activate", { target, name }, host.documentSignal(_e));
    },
  );
  ipcMain.handle("profiles:deactivate", async (_e, target: RendererConfigurationTarget) => {
    return host.callBusiness("profiles/deactivate", { target }, host.documentSignal(_e));
  });
  ipcMain.handle("profiles:setSession", async (_e, sessionId: unknown, profileName: unknown) => {
    assertDesktopSessionId(sessionId);
    // "" is the unbind signal — a bare falsy check rejected it, so cancelling a
    // Session's digital human threw instead of clearing it.
    if (typeof profileName !== "string") {
      throw new Error("profiles:setSession requires profileName");
    }
    return host.callBusiness(
      "profiles/setSession",
      { sessionId, profileName },
      host.documentSignal(_e),
    );
  });
  ipcMain.handle("profiles:catalog", (event) =>
    host.callBusiness("profiles/catalog", {}, host.documentSignal(event)),
  );
  ipcMain.handle("profiles:install", async (event, name: string) => {
    if (typeof name !== "string" || !name) throw new Error("profiles:install requires name");
    return host.callBusiness("profiles/install", { name }, host.documentSignal(event));
  });
  ipcMain.handle("profiles:listRepos", (event) =>
    host.callBusiness("profiles/repos", {}, host.documentSignal(event)),
  );
  ipcMain.handle("profiles:addRepo", async (_e, repo: string) => {
    if (typeof repo !== "string" || !repo) throw new Error("profiles:addRepo requires repo");
    return host.callBusiness("profiles/addRepo", { repo: repo.trim() }, host.documentSignal(_e));
  });
  ipcMain.handle("profiles:removeRepo", async (_e, repo: string) => {
    if (typeof repo !== "string" || !repo) throw new Error("profiles:removeRepo requires repo");
    return host.callBusiness("profiles/removeRepo", { repo }, host.documentSignal(_e));
  });
  ipcMain.handle(
    "profiles:forceDelete",
    async (_e, name: string, target: RendererConfigurationTarget | null) => {
      if (typeof name !== "string" || !name) throw new Error("profiles:forceDelete requires name");
      return host.callBusiness("profiles/forceDelete", { name, target }, host.documentSignal(_e));
    },
  );
  ipcMain.handle(
    "profiles:previewDeletion",
    async (_e, name: string, target: RendererConfigurationTarget | null) => {
      if (typeof name !== "string" || !name)
        throw new Error("profiles:previewDeletion requires name");
      return host.callBusiness(
        "profiles/previewDeletion",
        { name, target },
        host.documentSignal(_e),
      );
    },
  );
  ipcMain.handle(
    "profiles:previewRequirements",
    async (_e, name: string, target: RendererConfigurationTarget) => {
      if (typeof name !== "string" || !name) {
        throw new Error("profiles:previewRequirements requires name");
      }
      return host.callBusiness(
        "profiles/previewRequirements",
        { name, target },
        host.documentSignal(_e),
      );
    },
  );
  ipcMain.handle(
    "profiles:installRequirements",
    async (_e, name: string, target: RendererConfigurationTarget) => {
      if (typeof name !== "string" || !name) {
        throw new Error("profiles:installRequirements requires name");
      }
      return host.callBusiness(
        "profiles/installRequirements",
        { name, target },
        host.documentSignal(_e),
      );
    },
  );
  ipcMain.handle(
    "profiles:save",
    async (_e, profile: unknown, target: RendererConfigurationTarget | null) => {
      if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
        throw new Error("profiles:save requires profile");
      }
      return host.callBusiness(
        "profiles/save",
        { profile: profile as import("@cjhyy/code-shell-core").WorkspaceProfile, target },
        host.documentSignal(_e),
      );
    },
  );
  ipcMain.handle("profiles:pickDefinitionImport", async (event) => {
    const signal = host.documentSignal(event);
    const options: OpenDialogOptions = {
      title: "Import digital-human profile definition JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return { canceled: true };
    return {
      canceled: false,
      preview: await host.callBusiness(
        "profiles/pickedDefinition",
        { path: filePath, owner: reviewOwner(signal) },
        signal,
      ),
    };
  });
  ipcMain.handle(
    "profiles:importReviewedDefinition",
    async (_e, input: unknown, target: RendererConfigurationTarget | null) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("profiles:importReviewedDefinition requires input");
      }
      const candidate = input as { reviewToken?: unknown; overwrite?: unknown };
      if (typeof candidate.reviewToken !== "string" || !candidate.reviewToken) {
        throw new Error("profiles:importReviewedDefinition requires reviewToken");
      }
      if (candidate.overwrite !== undefined && typeof candidate.overwrite !== "boolean") {
        throw new Error("profiles:importReviewedDefinition overwrite must be a boolean");
      }
      const signal = host.documentSignal(_e);
      return host.callBusiness(
        "profiles/importDefinition",
        {
          target,
          owner: reviewOwner(signal),
          reviewToken: candidate.reviewToken,
          overwrite: candidate.overwrite,
        },
        signal,
      );
    },
  );
  ipcMain.handle("profiles:exportDefinition", async (event, name: string) => {
    const signal = host.documentSignal(event);
    if (typeof name !== "string" || !WORKSPACE_PROFILE_NAME_RE.test(name)) {
      throw new Error("profiles:exportDefinition requires a valid profile name");
    }
    const options: SaveDialogOptions = {
      title: "Export digital-human profile definition JSON",
      defaultPath: `${name}.codeshell-profile.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };
    return host.callBusiness("profiles/exportDefinition", { name, path: result.filePath }, signal);
  });
  ipcMain.handle("profiles:exportRepo", async (event, names: string[]) => {
    const signal = host.documentSignal(event);
    if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string")) {
      throw new Error("profiles:exportRepo requires profile names");
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "Export digital humans as a publishable repo",
      properties: ["openDirectory", "createDirectory"] as const,
    };
    const picked = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    return host.callBusiness("profiles/exportRepo", { names, path: picked.filePaths[0]! }, signal);
  });
  ipcMain.handle(
    "profiles:delete",
    async (
      _e,
      name: string,
      options?: {
        target?: RendererConfigurationTarget | null;
        clearActiveProject?: boolean;
      },
    ) => {
      if (typeof name !== "string" || !name) throw new Error("profiles:delete requires name");
      if (options !== undefined && (typeof options !== "object" || options === null)) {
        throw new Error("profiles:delete options must be an object");
      }
      if (options) {
        rejectUnexpectedRendererKeys(
          options as Record<string, unknown>,
          ["target", "clearActiveProject"],
          "profiles:delete",
        );
      }
      if (
        options?.clearActiveProject !== undefined &&
        typeof options.clearActiveProject !== "boolean"
      ) {
        throw new Error("profiles:delete clearActiveProject must be a boolean");
      }
      return host.callBusiness(
        "profiles/delete",
        { name, target: options?.target ?? null, clearActiveProject: options?.clearActiveProject },
        host.documentSignal(_e),
      );
    },
  );
  ipcMain.handle("digital-human-teams:list", (event) =>
    host.callBusiness("profiles/teams", {}, host.documentSignal(event)),
  );
  ipcMain.handle(
    "digital-human-teams:save",
    (event, team: import("../shared/digital-human-team.js").DigitalHumanTeam) =>
      host.callBusiness("profiles/saveTeam", { team }, host.documentSignal(event)),
  );
  ipcMain.handle("digital-human-teams:delete", (event, id: string) => {
    if (typeof id !== "string" || !id) throw new Error("digital-human-teams:delete requires id");
    return host.callBusiness("profiles/deleteTeam", { id }, host.documentSignal(event));
  });
}

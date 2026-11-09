import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { WORKSPACE_PROFILE_NAME_RE } from "@cjhyy/code-shell-core";
import { dlog } from "./desktop-logger.js";
import { assertDesktopSessionId } from "./session-validation.js";
import {
  activateProfile,
  addProfileRepo,
  deleteProfile,
  deactivateProfile,
  exportProfileDefinition,
  exportProfileRepo,
  forceDeleteProfile,
  importReviewedProfileDefinition,
  installCatalogProfile,
  installProfileRequirements,
  listProfileCatalog,
  listProfileRepos,
  listProfiles,
  previewProfileDefinitionImport,
  previewProfileDeletion,
  previewProfileRequirements,
  removeProfileRepo,
  saveProfile,
  setSessionWorkspaceProfile,
} from "./profiles-service.js";
import {
  deleteDigitalHumanTeam,
  listDigitalHumanTeams,
  saveDigitalHumanTeam,
} from "./digital-human-team-service.js";
import { type RendererConfigurationTarget } from "./renderer-configuration-authority.js";
import {
  rendererConfigurationCwd,
  rejectUnexpectedRendererKeys,
} from "./renderer-configuration-helpers.js";

/** Profile catalog, repositories, definition import/export and digital-human team routes. */
export function registerProfileCatalogIpc() {
  ipcMain.handle("profiles:list", async (_e, target: RendererConfigurationTarget | null) =>
    listProfiles(target === null ? undefined : await rendererConfigurationCwd(target)),
  );
  ipcMain.handle(
    "profiles:activate",
    async (_e, target: RendererConfigurationTarget, name: string) => {
      const cwd = await rendererConfigurationCwd(target);
      if (typeof name !== "string" || !name) throw new Error("profiles:activate requires name");
      activateProfile(cwd, name);
    },
  );
  ipcMain.handle("profiles:deactivate", async (_e, target: RendererConfigurationTarget) => {
    const cwd = await rendererConfigurationCwd(target);
    deactivateProfile(cwd);
  });
  ipcMain.handle("profiles:setSession", async (_e, sessionId: unknown, profileName: unknown) => {
    assertDesktopSessionId(sessionId);
    // "" is the unbind signal — a bare falsy check rejected it, so cancelling a
    // Session's digital human threw instead of clearing it.
    if (typeof profileName !== "string") {
      throw new Error("profiles:setSession requires profileName");
    }
    return setSessionWorkspaceProfile(sessionId, profileName);
  });
  ipcMain.handle("profiles:catalog", async () => listProfileCatalog());
  ipcMain.handle("profiles:install", async (_e, name: string) => {
    if (typeof name !== "string" || !name) throw new Error("profiles:install requires name");
    installCatalogProfile(name);
  });
  ipcMain.handle("profiles:listRepos", async () => listProfileRepos());
  ipcMain.handle("profiles:addRepo", async (_e, repo: string) => {
    if (typeof repo !== "string" || !repo) throw new Error("profiles:addRepo requires repo");
    return addProfileRepo(repo.trim());
  });
  ipcMain.handle("profiles:removeRepo", async (_e, repo: string) => {
    if (typeof repo !== "string" || !repo) throw new Error("profiles:removeRepo requires repo");
    removeProfileRepo(repo);
  });
  ipcMain.handle(
    "profiles:forceDelete",
    async (_e, name: string, target: RendererConfigurationTarget | null) => {
      if (typeof name !== "string" || !name) throw new Error("profiles:forceDelete requires name");
      const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
      return forceDeleteProfile(name, authorizedCwd ? { cwd: authorizedCwd } : {});
    },
  );
  ipcMain.handle(
    "profiles:previewDeletion",
    async (_e, name: string, target: RendererConfigurationTarget | null) => {
      if (typeof name !== "string" || !name)
        throw new Error("profiles:previewDeletion requires name");
      return previewProfileDeletion(
        name,
        target === null ? undefined : await rendererConfigurationCwd(target),
      );
    },
  );
  ipcMain.handle(
    "profiles:previewRequirements",
    async (_e, name: string, target: RendererConfigurationTarget) => {
      if (typeof name !== "string" || !name) {
        throw new Error("profiles:previewRequirements requires name");
      }
      const cwd = await rendererConfigurationCwd(target);
      return previewProfileRequirements(name, cwd);
    },
  );
  ipcMain.handle(
    "profiles:installRequirements",
    async (_e, name: string, target: RendererConfigurationTarget) => {
      if (typeof name !== "string" || !name) {
        throw new Error("profiles:installRequirements requires name");
      }
      const cwd = await rendererConfigurationCwd(target);
      return installProfileRequirements(name, cwd);
    },
  );
  ipcMain.handle(
    "profiles:save",
    async (_e, profile: unknown, target: RendererConfigurationTarget | null) => {
      if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
        throw new Error("profiles:save requires profile");
      }
      const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
      saveProfile(profile as Parameters<typeof saveProfile>[0], authorizedCwd);
    },
  );
  ipcMain.handle("profiles:pickDefinitionImport", async (event) => {
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
    return { canceled: false, preview: previewProfileDefinitionImport(filePath) };
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
      const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
      return importReviewedProfileDefinition(
        {
          reviewToken: candidate.reviewToken,
          ...(candidate.overwrite === undefined ? {} : { overwrite: candidate.overwrite }),
        },
        authorizedCwd,
      );
    },
  );
  ipcMain.handle("profiles:exportDefinition", async (event, name: string) => {
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
    return exportProfileDefinition(name, result.filePath);
  });
  ipcMain.handle("profiles:exportRepo", async (event, names: string[]) => {
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
    return exportProfileRepo(names, picked.filePaths[0]);
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
      const cwd =
        options?.target == null ? undefined : await rendererConfigurationCwd(options.target);
      deleteProfile(name, {
        ...(cwd ? { cwd } : {}),
        ...(options?.clearActiveProject === undefined
          ? {}
          : { clearActiveProject: options.clearActiveProject }),
      });
    },
  );
  ipcMain.handle("digital-human-teams:list", async () =>
    listDigitalHumanTeams({
      onInvalidTeam: (issue) => dlog("main", "digital_human_team.invalid", { ...issue }),
    }),
  );
  ipcMain.handle("digital-human-teams:save", async (_e, team: unknown) =>
    saveDigitalHumanTeam(team as Parameters<typeof saveDigitalHumanTeam>[0]),
  );
  ipcMain.handle("digital-human-teams:delete", async (_e, id: string) => {
    if (typeof id !== "string" || !id) throw new Error("digital-human-teams:delete requires id");
    deleteDigitalHumanTeam(id);
  });
}

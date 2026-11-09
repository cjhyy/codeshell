import { BrowserWindow, ipcMain } from "electron";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { registerProfileMemoryPromotionIpc } from "./profile-memory-promotion-ipc.js";
import {
  listMemory,
  readMemory,
  saveMemory,
  deleteMemory,
  listPendingMemory,
  approvePendingMemory,
  demotePendingMemory,
  rejectPendingMemory,
  promoteMemoryToGlobal,
  type MemoryLevel,
  type SaveMemoryInput,
} from "./memory-service.js";
import { runDream } from "./dream-service.js";
import type { MemoryScope } from "@cjhyy/code-shell-core";

export interface MemoryIpcDeps {
  mainWindows: Set<BrowserWindow>;
}

/** Memory list/read/save/delete, pending review, promotion and dream routes. */
export function registerMemoryIpc(deps: MemoryIpcDeps) {
  const { mainWindows } = deps;
  const VALID_MEMORY_LEVELS = new Set<MemoryLevel>(["user", "project", "profile"]);
  const VALID_MEMORY_SCOPES = new Set<MemoryScope>(["user", "dream"]);

  function validateMemoryArgs(
    level: unknown,
    scope: unknown,
  ): { level: MemoryLevel; scope: MemoryScope } {
    if (typeof level !== "string" || !VALID_MEMORY_LEVELS.has(level as MemoryLevel)) {
      throw new Error(`memory level must be "user", "project", or "profile", got ${String(level)}`);
    }
    if (typeof scope !== "string" || !VALID_MEMORY_SCOPES.has(scope as MemoryScope)) {
      throw new Error(`memory scope must be "user" or "dream", got ${String(scope)}`);
    }
    return { level: level as MemoryLevel, scope: scope as MemoryScope };
  }

  ipcMain.handle(
    "memory:list",
    async (_e, level: unknown, scope: unknown, cwd?: string, profileName?: string) => {
      const v = validateMemoryArgs(level, scope);
      const authorizedCwd =
        v.level === "project"
          ? await requireRendererProjectPath(cwd)
          : typeof cwd === "string" && cwd
            ? await requireRendererProjectPath(cwd)
            : undefined;
      return listMemory(
        v.level,
        v.scope,
        authorizedCwd,
        typeof profileName === "string" ? profileName : undefined,
      );
    },
  );

  ipcMain.handle(
    "memory:read",
    async (
      _e,
      level: unknown,
      scope: unknown,
      name: unknown,
      cwd?: string,
      profileName?: string,
    ) => {
      const v = validateMemoryArgs(level, scope);
      if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
        throw new Error("bounded memory name required");
      }
      const authorizedCwd =
        v.level === "project"
          ? await requireRendererProjectPath(cwd)
          : typeof cwd === "string" && cwd
            ? await requireRendererProjectPath(cwd)
            : undefined;
      return readMemory(
        v.level,
        v.scope,
        name,
        authorizedCwd,
        typeof profileName === "string" ? profileName : undefined,
      );
    },
  );

  ipcMain.handle("memory:save", async (_e, input: SaveMemoryInput) => {
    if (!input || typeof input !== "object") throw new Error("memory:save requires input");
    const v = validateMemoryArgs(input.level, input.scope);
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 512 ||
      typeof input.description !== "string" ||
      input.description.length > 4_096 ||
      typeof input.content !== "string" ||
      input.content.length > 1024 * 1024 ||
      (input.type !== "user" &&
        input.type !== "feedback" &&
        input.type !== "project" &&
        input.type !== "reference")
    ) {
      throw new Error("invalid memory payload");
    }
    const cwd =
      v.level === "project"
        ? await requireRendererProjectPath(input.cwd)
        : typeof input.cwd === "string" && input.cwd
          ? await requireRendererProjectPath(input.cwd)
          : undefined;
    return saveMemory({ ...input, level: v.level, scope: v.scope, cwd });
  });

  ipcMain.handle(
    "memory:delete",
    async (
      _e,
      level: unknown,
      scope: unknown,
      name: unknown,
      cwd?: string,
      profileName?: string,
    ) => {
      const v = validateMemoryArgs(level, scope);
      if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
        throw new Error("bounded memory name required");
      }
      const authorizedCwd =
        v.level === "project"
          ? await requireRendererProjectPath(cwd)
          : typeof cwd === "string" && cwd
            ? await requireRendererProjectPath(cwd)
            : undefined;
      return deleteMemory(
        v.level,
        v.scope,
        name,
        authorizedCwd,
        typeof profileName === "string" ? profileName : undefined,
      );
    },
  );

  // 审批门 (pending global memories)
  ipcMain.handle("memory:pending:list", async () => listPendingMemory());
  ipcMain.handle("memory:pending:approve", async (_e, name: unknown) => {
    if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
      throw new Error("bounded memory name required");
    }
    return approvePendingMemory(name);
  });
  ipcMain.handle("memory:pending:demote", async (_e, name: unknown) => {
    if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
      throw new Error("bounded memory name required");
    }
    return demotePendingMemory(name);
  });
  ipcMain.handle("memory:pending:reject", async (_e, name: unknown) => {
    if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
      throw new Error("bounded memory name required");
    }
    return rejectPendingMemory(name);
  });
  registerProfileMemoryPromotionIpc(
    ipcMain,
    (sender) =>
      [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
    requireRendererProjectPath,
  );
  ipcMain.handle("memory:promote", async (_e, cwd: unknown, name: unknown) => {
    const authorizedCwd = await requireRendererProjectPath(cwd);
    if (typeof name !== "string" || !name || name.length > 512 || name.includes("\0")) {
      throw new Error("bounded memory name required");
    }
    return promoteMemoryToGlobal(authorizedCwd, name);
  });

  ipcMain.handle("memory:dream", async (_e, level: unknown, cwd?: string) => {
    if (level !== "user" && level !== "project") {
      throw new Error(`dream level must be "user" or "project", got ${String(level)}`);
    }
    const authorizedCwd =
      level === "project"
        ? await requireRendererProjectPath(cwd)
        : typeof cwd === "string" && cwd
          ? await requireRendererProjectPath(cwd)
          : undefined;
    return runDream(level, authorizedCwd);
  });
}

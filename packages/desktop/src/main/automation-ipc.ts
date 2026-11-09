import { ipcMain } from "electron";
import {
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  cancelAutomationRun,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from "./automation-service.js";
import { desktopAutomationAuthorityDeps } from "./automation-authority.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { deleteRunDir } from "./runs-service.js";

/** Run deletion and automation CRUD/scheduling routes with bounded payload validation. */
export function registerAutomationIpc() {
  ipcMain.handle("runs:delete", async (_e, runId: string) => {
    if (typeof runId !== "string") throw new Error("runId required");
    await deleteRunDir(runId);
  });

  // ─── Automation (Phase 3 UI) ─────────────────────────────────────
  function assertAutomationId(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 128 ||
      value.includes("\0") ||
      value.includes("/") ||
      value.includes("\\")
    ) {
      throw new Error("bounded automation id required");
    }
  }

  function validAutomationBindingId(value: unknown): boolean {
    return (
      value === undefined ||
      value === null ||
      (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        !value.includes("\0"))
    );
  }

  ipcMain.handle("automation:list", async () => listAutomations());
  ipcMain.handle("automation:get", async (_e, id: string) => {
    assertAutomationId(id);
    return getAutomation(id);
  });
  ipcMain.handle("automation:create", async (_e, input: CreateAutomationInput) => {
    if (
      !input ||
      typeof input.name !== "string" ||
      typeof input.schedule !== "string" ||
      typeof input.prompt !== "string"
    ) {
      throw new Error("name, schedule and prompt are required");
    }
    if (
      !input.name.trim() ||
      input.name.length > 512 ||
      !input.schedule.trim() ||
      input.schedule.length > 512 ||
      input.prompt.length > 1024 * 1024 ||
      (input.timezone !== undefined &&
        (typeof input.timezone !== "string" || input.timezone.length > 128)) ||
      (input.permissionLevel !== undefined &&
        input.permissionLevel !== "read-only" &&
        input.permissionLevel !== "workspace-write" &&
        input.permissionLevel !== "full") ||
      !validAutomationBindingId(input.projectId) ||
      !validAutomationBindingId(input.rootId)
    ) {
      throw new Error("invalid automation payload");
    }
    if (input.resumeSessionId !== undefined) assertDesktopSessionId(input.resumeSessionId);
    if (Object.prototype.hasOwnProperty.call(input, "authoritySessionId")) {
      throw new Error("renderer cannot submit automation Session authority");
    }
    return createAutomation(input, desktopAutomationAuthorityDeps());
  });
  ipcMain.handle("automation:update", async (_e, id: string, patch: UpdateAutomationInput) => {
    assertAutomationId(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new Error("patch required");
    if (
      (patch.name !== undefined &&
        (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 512)) ||
      (patch.prompt !== undefined &&
        (typeof patch.prompt !== "string" || patch.prompt.length > 1024 * 1024)) ||
      (patch.schedule !== undefined &&
        (typeof patch.schedule !== "string" ||
          !patch.schedule.trim() ||
          patch.schedule.length > 512)) ||
      (patch.timezone !== undefined &&
        (typeof patch.timezone !== "string" || patch.timezone.length > 128)) ||
      (patch.permissionLevel !== undefined &&
        patch.permissionLevel !== "read-only" &&
        patch.permissionLevel !== "workspace-write" &&
        patch.permissionLevel !== "full") ||
      !validAutomationBindingId(patch.projectId) ||
      !validAutomationBindingId(patch.rootId)
    ) {
      throw new Error("invalid automation patch");
    }
    return updateAutomation(id, patch, desktopAutomationAuthorityDeps());
  });
  ipcMain.handle("automation:delete", async (_e, id: string) => {
    assertAutomationId(id);
    return deleteAutomation(id);
  });
  ipcMain.handle("automation:pause", async (_e, id: string) => {
    assertAutomationId(id);
    return pauseAutomation(id);
  });
  ipcMain.handle("automation:resume", async (_e, id: string) => {
    assertAutomationId(id);
    return resumeAutomation(id);
  });
  ipcMain.handle("automation:runNow", async (_e, id: string) => {
    assertAutomationId(id);
    return runAutomationNow(id);
  });
  ipcMain.handle("automation:cancelRun", async (_e, id: string) => {
    assertAutomationId(id);
    return cancelAutomationRun(id);
  });
}

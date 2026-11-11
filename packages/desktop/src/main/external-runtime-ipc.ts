import { BrowserWindow, ipcMain } from "electron";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import { assertWorkspaceProfileName } from "./external-runtime-profile.js";
import { parseExternalGoalInput } from "./external-runtime-goal-rpc.js";
import {
  ExternalRuntimeApprovals,
  parseExternalApprovalDecision,
} from "./external-runtime-approvals.js";
import { availableExternalRuntimes } from "./external-runtime-availability.js";
import { ExternalRuntimeModelService } from "./external-runtime-model-service.js";
import type { ExternalRuntimeAttachment } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";
import { requireRendererProjectEntryPath } from "./renderer-project-path.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { resolveExternalRuntimeStartWorkspace } from "./external-runtime-start-workspace.js";

// ─── External Agent Runtimes (Codex / Claude Code) ────────────────
// The renderer picks these like any other model (`codex/gpt-5.6-sol`); these
// handlers are what makes such a key actually run something.
export const MAX_EXTERNAL_RUNTIME_TEXT_CHARS = 512 * 1024;
export const MAX_EXTERNAL_RUNTIME_CONTEXT_CHARS = 512 * 1024;
export const MAX_EXTERNAL_RUNTIME_ATTACHMENTS = 32;
export const MAX_EXTERNAL_RUNTIME_ID_CHARS = 512;

export interface ExternalRuntimeIpcDeps {
  externalRuntimeService: () => ExternalRuntimeService | null;
  externalRuntimeApprovals: () => ExternalRuntimeApprovals | null;
}

/** External Agent Runtime (Codex / Claude Code) session routes; ownership comes from the sender. */
export function registerExternalRuntimeIpc(deps: ExternalRuntimeIpcDeps) {
  /** Which runtimes this machine can run — gates the model picker entries. */
  ipcMain.handle("externalRuntime:available", () => {
    if (!deps.externalRuntimeService()?.isEnabled()) return [];
    return availableExternalRuntimes();
  });

  const externalRuntimeModelService = new ExternalRuntimeModelService({
    isEnabled: () => deps.externalRuntimeService()?.isEnabled() ?? false,
  });
  ipcMain.handle("externalRuntime:models", () => externalRuntimeModelService.list());

  /**
   * Start (or restart) a session on an external runtime.
   *
   * The owning window comes from the SENDER, never from the payload: it decides
   * where this session's host-loopback tools are routed, so letting the renderer
   * name an arbitrary window id would let one window drive another's panels.
   */
  ipcMain.handle(
    "externalRuntime:start",
    async (
      event,
      payload: {
        sessionId?: unknown;
        cwd?: unknown;
        modelKey?: unknown;
        permissionMode?: unknown;
        planMode?: unknown;
        hasGoal?: unknown;
        initialContext?: unknown;
        developerInstructions?: unknown;
        workspaceProfile?: unknown;
      },
    ) => {
      const service = deps.externalRuntimeService();
      if (!service) throw new Error("external runtime service is unavailable");
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      assertDesktopSessionId(sessionId);
      const modelKey = typeof payload?.modelKey === "string" ? payload.modelKey : "";
      if (!modelKey || modelKey.length > MAX_EXTERNAL_RUNTIME_ID_CHARS) {
        throw new Error("a bounded modelKey is required");
      }
      const parsed = parseExternalRuntimeModelKey(modelKey);
      if (!parsed) throw new Error(`not an external runtime model: ${modelKey}`);
      const permissionMode =
        payload?.permissionMode === "default" ||
        payload?.permissionMode === "acceptEdits" ||
        payload?.permissionMode === "bypassPermissions" ||
        payload?.permissionMode === "dontAsk"
          ? payload.permissionMode
          : "default";

      const initialContext =
        typeof payload?.initialContext === "string" ? payload.initialContext : undefined;
      const developerInstructions =
        typeof payload?.developerInstructions === "string"
          ? payload.developerInstructions
          : undefined;
      if (
        (initialContext?.length ?? 0) > MAX_EXTERNAL_RUNTIME_CONTEXT_CHARS ||
        (developerInstructions?.length ?? 0) > MAX_EXTERNAL_RUNTIME_CONTEXT_CHARS
      ) {
        throw new Error("external runtime context is too large");
      }
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        throw new Error("external runtime requires a live owner window");
      }
      const workspace = await resolveExternalRuntimeStartWorkspace(sessionId, payload?.cwd);
      const session = await service.ensure({
        kind: parsed.kind,
        sessionId,
        ...workspace,
        modelKey,
        permissionMode,
        planMode: payload?.planMode === true,
        hasGoal: payload?.hasGoal === true,
        ...(initialContext ? { initialContext } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        workspaceProfile: assertWorkspaceProfileName(payload?.workspaceProfile),
        ownerWindow,
      });
      return {
        kind: session.kind,
        runtimeSessionId: session.runtimeSessionId ?? null,
        tools: session.listTools().map((tool) => tool.name),
      };
    },
  );

  ipcMain.handle(
    "externalRuntime:send",
    async (
      event,
      payload: {
        sessionId?: unknown;
        text?: unknown;
        clientMessageId?: unknown;
        attachments?: unknown;
        goal?: unknown;
        disableGoal?: unknown;
      },
    ) => {
      const service = deps.externalRuntimeService();
      if (!service) throw new Error("external runtime service is unavailable");
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
      assertDesktopSessionId(sessionId);
      const text = typeof payload?.text === "string" ? payload.text : "";
      const goal = parseExternalGoalInput(payload?.goal);
      if (payload?.disableGoal !== undefined && typeof payload.disableGoal !== "boolean") {
        throw new Error("disableGoal must be a boolean");
      }
      if (text.length > MAX_EXTERNAL_RUNTIME_TEXT_CHARS) {
        throw new Error("external runtime message is too large");
      }
      const clientMessageId =
        typeof payload?.clientMessageId === "string" ? payload.clientMessageId : undefined;
      if (
        clientMessageId !== undefined &&
        (!clientMessageId ||
          clientMessageId.length > MAX_EXTERNAL_RUNTIME_ID_CHARS ||
          clientMessageId.includes("\0"))
      ) {
        throw new Error("invalid external runtime clientMessageId");
      }
      if (payload?.attachments !== undefined && !Array.isArray(payload.attachments)) {
        throw new Error("external runtime attachments must be an array");
      }
      const attachmentValues = payload?.attachments ?? [];
      if (attachmentValues.length > MAX_EXTERNAL_RUNTIME_ATTACHMENTS) {
        throw new Error("too many external runtime attachments");
      }
      // The service owns the canonical cwd; use the renderer payload only for
      // turn content, never to retarget an existing runtime.
      const entryCwd = service.getCwd(sessionId, event.sender.id);
      if (!entryCwd) throw new Error("external runtime session has no authorized project");
      const attachments: ExternalRuntimeAttachment[] = await Promise.all(
        attachmentValues.map(async (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("invalid external runtime attachment");
          }
          const attachment = value as Record<string, unknown>;
          const path =
            typeof attachment.absPath === "string"
              ? attachment.absPath
              : typeof attachment.path === "string"
                ? attachment.path
                : "";
          const authorizedPath = await requireRendererProjectEntryPath(path, entryCwd);
          const detail =
            attachment.vision && typeof attachment.vision === "object"
              ? (attachment.vision as { detail?: unknown }).detail
              : undefined;
          if (
            attachment.mime !== undefined &&
            (typeof attachment.mime !== "string" || attachment.mime.length > 256)
          ) {
            throw new Error("invalid external runtime attachment MIME");
          }
          return {
            path: authorizedPath,
            ...(attachment.kind === "image" ||
            attachment.kind === "file" ||
            attachment.kind === "directory"
              ? { kind: attachment.kind }
              : {}),
            ...(typeof attachment.mime === "string" ? { mime: attachment.mime } : {}),
            ...(detail === "low" || detail === "standard" || detail === "high" ? { detail } : {}),
          } satisfies ExternalRuntimeAttachment;
        }),
      );
      if (!text.trim() && attachments.length === 0) {
        throw new Error("external runtime message or attachment is required");
      }
      return await service.send(
        sessionId,
        {
          text,
          ...(goal ? { goal } : {}),
          ...(payload.disableGoal === true ? { disableGoal: true } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        event.sender.id,
      );
    },
  );

  ipcMain.handle(
    "externalRuntime:interrupt",
    async (event, sessionId: unknown, options?: { keepGoal?: unknown; ifOwned?: unknown }) => {
      assertDesktopSessionId(sessionId);
      // Stop asks with ifOwned: Main, not preload memory, decides which backend
      // runs the session, so a reloaded renderer still interrupts the provider.
      const service = deps.externalRuntimeService();
      if (!service || (options?.ifOwned === true && !service.hasSession(sessionId)))
        return { handled: false };
      await service.interrupt(sessionId, event.sender.id, undefined, {
        keepGoal: options?.keepGoal === true,
      });
      return { handled: true };
    },
  );

  /** A queued chat message asks the running Goal to yield after this provider turn. */
  ipcMain.handle("externalRuntime:yieldGoal", (event, sessionId: unknown) => {
    assertDesktopSessionId(sessionId);
    return deps.externalRuntimeService()?.yieldGoal(sessionId, event.sender.id) ?? false;
  });

  /** The renderer answering a prompt this session's runtime is parked on. */
  ipcMain.handle(
    "externalRuntime:approvalDecision",
    (event, payload: { requestId?: unknown; approved?: unknown; [key: string]: unknown }) => {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
      const settled =
        requestId &&
        deps
          .externalRuntimeApprovals()
          ?.settle(requestId, parseExternalApprovalDecision(payload), event.sender.id);
      return settled
        ? { ok: true }
        : { ok: false, error: { message: "This prompt is no longer pending in this window." } };
    },
  );

  ipcMain.handle("externalRuntime:stop", async (event, sessionId: unknown) => {
    assertDesktopSessionId(sessionId);
    await deps.externalRuntimeService()?.stop(sessionId, event.sender.id);
  });
  return { externalRuntimeModelService };
}

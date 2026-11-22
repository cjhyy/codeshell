import { stat } from "node:fs/promises";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { QuickChatOwnershipRegistry } from "./quick-chat-ownership.js";

export interface AttachmentsIpcDeps {
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal };
  quickChatOwnership: QuickChatOwnershipRegistry;
  deleteDesktopSession: (id: string) => Promise<void>;
  assertQuickChatClaim: (id: unknown, claimId: unknown) => asserts id is string;
}

/** Attachment save/inspect/cleanup routes, including quick-chat claim-bound operations. */
export function registerAttachmentsIpc(deps: AttachmentsIpcDeps) {
  const { quickChatOwnership, deleteDesktopSession, host } = deps;
  const assertQuickChatClaim: AttachmentsIpcDeps["assertQuickChatClaim"] =
    deps.assertQuickChatClaim;
  async function runClaimBoundAttachmentOperation<T>(
    ownerId: number,
    payload: { cwd?: string; sessionId?: string; quickChatClaimId?: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const sessionId = payload.sessionId!;
    if (!sessionId.startsWith("qchat-")) return operation();

    // Quick-chat disk writes share the same ownership generation as fork/GC.
    // Missing/stale claims fail before IO; cleanup tombstones the claim and waits
    // for already-started operations to settle before deleting the session.
    assertQuickChatClaim(sessionId, payload.quickChatClaimId);
    const cwd = payload.cwd!;
    const directory = await stat(cwd);
    const claimId = payload.quickChatClaimId!;
    if (!quickChatOwnership.beginOperation(sessionId, ownerId, claimId)) {
      throw new Error("quick-chat attachment claim is no longer active");
    }

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    const settled = await quickChatOwnership.settleOperation(
      sessionId,
      ownerId,
      claimId,
      async () => {
        await deleteDesktopSession(sessionId);
        // The project may have been unmounted. Bind late cleanup to the
        // directory identity already authorized before this claim began.
        await host
          .callBusiness("attachments/cleanupQuickChat", {
            cwd,
            sessionId,
            device: directory.dev,
            inode: directory.ino,
          })
          .catch(() => undefined);
      },
    );
    if (operationError) throw operationError;
    if (!settled.active) {
      throw new Error("quick-chat attachment result arrived after cleanup");
    }
    return result as T;
  }

  ipcMain.handle(
    "attachments:stageImageDataUrl",
    async (
      event,
      payload: {
        cwd?: string;
        sessionId?: string;
        name?: string;
        mime?: string;
        dataUrl?: string;
        origin?: string;
        quickChatClaimId?: string;
      },
    ) => {
      const signal = host.documentSignal(event);
      if (!payload || typeof payload !== "object") {
        throw new Error("attachments:stageImageDataUrl requires payload");
      }
      if (typeof payload.cwd !== "string")
        throw new Error("attachments:stageImageDataUrl requires cwd");
      if (typeof payload.sessionId !== "string") {
        throw new Error("attachments:stageImageDataUrl requires sessionId");
      }
      if (typeof payload.dataUrl !== "string") {
        throw new Error("attachments:stageImageDataUrl requires dataUrl");
      }
      const cwd = await requireRendererProjectPath(payload.cwd);
      if (payload.dataUrl.length > Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1_024) {
        throw new Error("attachments:stageImageDataUrl exceeds the encoded size limit");
      }
      const origin =
        payload.origin === "paste" ||
        payload.origin === "os-drop" ||
        payload.origin === "file-panel" ||
        payload.origin === "picker" ||
        payload.origin === "mention" ||
        payload.origin === "generated" ||
        payload.origin === "tool"
          ? payload.origin
          : "paste";
      const authorizedPayload = { ...payload, cwd };
      return runClaimBoundAttachmentOperation(event.sender.id, authorizedPayload, () =>
        host.callBusiness(
          "attachments/stage",
          {
            cwd,
            sessionId: payload.sessionId!,
            name: payload.name,
            mime: payload.mime,
            dataUrl: payload.dataUrl!,
            origin,
          },
          signal,
        ),
      );
    },
  );
  ipcMain.handle(
    "attachments:cleanup",
    async (event, payload: { cwd?: string; sessionId?: string; now?: number }) => {
      const signal = host.documentSignal(event);
      if (!payload || typeof payload.cwd !== "string") {
        throw new Error("attachments:cleanup requires cwd");
      }
      const cwd = await requireRendererProjectPath(payload.cwd);
      return host.callBusiness(
        "attachments/cleanup",
        {
          cwd,
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
        },
        signal,
      );
    },
  );
  ipcMain.handle(
    "attachments:inspect",
    async (event, payload: { cwd?: string; sessionId?: string }) => {
      const signal = host.documentSignal(event);
      if (!payload || typeof payload.cwd !== "string") {
        throw new Error("attachments:inspect requires cwd");
      }
      const cwd = await requireRendererProjectPath(payload.cwd);
      return host.callBusiness(
        "attachments/inspect",
        {
          cwd,
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
        },
        signal,
      );
    },
  );
  ipcMain.handle(
    "attachments:markSent",
    async (
      event,
      payload: {
        cwd?: string;
        sessionId?: string;
        attachments?: InputAttachmentMeta[];
        quickChatClaimId?: string;
      },
    ) => {
      const signal = host.documentSignal(event);
      if (!payload || typeof payload.cwd !== "string" || typeof payload.sessionId !== "string") {
        throw new Error("attachments:markSent requires cwd and sessionId");
      }
      const cwd = await requireRendererProjectPath(payload.cwd);
      const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
      if (attachments.length > 32) throw new Error("too many attachments to mark sent");
      const authorizedPayload = { ...payload, cwd };
      return runClaimBoundAttachmentOperation(event.sender.id, authorizedPayload, async () => {
        await host.callBusiness(
          "attachments/markSent",
          { cwd, sessionId: payload.sessionId!, attachments },
          signal,
        );
        return { ok: true } as const;
      });
    },
  );
}

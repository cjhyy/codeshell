import { ipcMain, session } from "electron";
import type { AgentBridge } from "../agent-bridge.js";
import type { createDesktopHost } from "../desktop-host/main.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import type { NativeMediaProtocol } from "../hosted-media-protocol.js";
import type { QuickChatOwnershipRegistry } from "../quick-chat-ownership.js";
import type { RendererBrowserSessionAccess } from "../renderer-browser-session-access.js";
import { partitionForSession } from "../browser-driver/active-guest.js";
import {
  builtInBrowserHandoffGrants,
  chromeExtensionRuntimeService,
  panelAccessRequests,
} from "../browser-runtime/index.js";
import { cookieCredentialAutoRefresh } from "../cookie-credential-auto-refresh.js";
import { isBrowserPartition } from "../../shared/browser-partition.js";
import { assertDesktopSessionId } from "../session-validation.js";
import { dlog } from "../desktop-logger.js";

export function assertQuickChatClaim(id: unknown, claimId: unknown): asserts id is string {
  if (typeof id !== "string" || !/^qchat-[A-Za-z0-9.-]+$/.test(id)) {
    throw new Error("quick-chat session id required");
  }
  if (typeof claimId !== "string" || !/^[A-Za-z0-9.-]{1,128}$/.test(claimId)) {
    throw new Error("quick-chat claim id required");
  }
}

/** Serialize deletion across windows and retire each native and durable owner before reusing an id. */
export function registerSessionLifecycle({
  desktopHost,
  deletingBrowserSessions,
  rendererBrowserSessionAccess,
  mediaPreviewService,
  bridge,
  external,
  deleted,
  quickChatOwnership,
  quickChatsReady,
}: {
  desktopHost: Pick<
    ReturnType<typeof createDesktopHost>,
    "setStreamView" | "setDeleting" | "callBusiness" | "documentSignal"
  >;
  deletingBrowserSessions: Set<string>;
  rendererBrowserSessionAccess: Pick<RendererBrowserSessionAccess, "forgetSession">;
  mediaPreviewService: Pick<NativeMediaProtocol, "releaseSession">;
  bridge(): AgentBridge | null;
  external(): ExternalRuntimeService | null;
  deleted(id: string): Promise<unknown>;
  quickChatOwnership: QuickChatOwnershipRegistry;
  quickChatsReady: Promise<unknown>;
}) {
  const quickChatOwnerCleanupRegistered = new Set<number>();
  const sessionDeletions = new Map<string, Promise<void>>();
  function deleteDesktopSession(id: string): Promise<void> {
    const existing = sessionDeletions.get(id);
    if (existing) return existing;
    deletingBrowserSessions.add(id);
    desktopHost.setStreamView(id, false);
    desktopHost.setDeleting(id, true);
    rendererBrowserSessionAccess.forgetSession(id);
    const pending = Promise.resolve()
      .then(() => deleteDesktopSessionResources(id))
      .finally(() => {
        // Invalidate any authorization captured before deletion started, including
        // in-flight durable reads, before allowing this ID to be opened again.
        rendererBrowserSessionAccess.forgetSession(id);
        deletingBrowserSessions.delete(id);
        desktopHost.setDeleting(id, false);
        sessionDeletions.delete(id);
      });
    sessionDeletions.set(id, pending);
    return pending;
  }

  async function deleteDesktopSessionResources(id: string): Promise<void> {
    mediaPreviewService.releaseSession(id);
    builtInBrowserHandoffGrants.clearSession(id);
    panelAccessRequests.forgetSession(id);
    chromeExtensionRuntimeService.forgetSession(id);
    const browserPartition = partitionForSession(id);
    const ephemeralBrowserPartition = id.startsWith("qchat-") ? browserPartition : null;
    if (browserPartition && isBrowserPartition(browserPartition)) {
      cookieCredentialAutoRefresh.unbind(session.fromPartition(browserPartition));
    }
    // Reap the session's background shells (if any) before dropping it —
    // explicit delete is the one tab-close path that DOES kill (core §6).
    await bridge()?.closeSession(id);
    // An external runtime is a child process plus a listening port; neither is
    // owned by the worker, so closeSession above does not touch them. Without
    // this a deleted session leaves both alive for the rest of the app's life.
    await external()
      ?.stop(id)
      .catch((error) => {
        dlog("external-runtime", "session.delete.stop_failed", { id, error: String(error) });
      });
    // The external binding is a file inside the Session directory.
    await desktopHost.callBusiness("sessions/deleteFiles", { sessionId: id });
    await deleted(id);
    await desktopHost.callBusiness("startup/cleanupAttachments", { sessionId: id });
    // Drop any in-memory snapshot for the deleted session so it can't be
    // replayed into a fresh tab that happens to reuse the id.
    await bridge()?.forgetSession(id);
    if (ephemeralBrowserPartition?.startsWith("browser:qchat:")) {
      const ephemeralSession = session.fromPartition(ephemeralBrowserPartition);
      await Promise.all([ephemeralSession.clearStorageData(), ephemeralSession.clearCache()]).catch(
        (error) => {
          dlog("browser", "quick_chat.partition_cleanup_failed", {
            id,
            partition: ephemeralBrowserPartition,
            error: String(error),
          });
        },
      );
    }
  }

  ipcMain.handle("sessions:delete", async (event, id: string) => {
    desktopHost.documentSignal(event).throwIfAborted();
    assertDesktopSessionId(id);
    await deleteDesktopSession(id);
  });

  ipcMain.handle("quickChat:claimSession", async (event, id: unknown, claimId: unknown) => {
    assertQuickChatClaim(id, claimId);
    const document = desktopHost.documentSignal(event);
    await quickChatsReady;
    document.throwIfAborted();
    const ownerId = event.sender.id;
    quickChatOwnership.claim(id, ownerId, claimId as string);
    if (!quickChatOwnerCleanupRegistered.has(ownerId)) {
      quickChatOwnerCleanupRegistered.add(ownerId);
      event.sender.once("destroyed", () => {
        quickChatOwnerCleanupRegistered.delete(ownerId);
        void quickChatOwnership
          .releaseOwner(ownerId, deleteDesktopSession)
          .catch((error) =>
            dlog("main", "quick_chat.owner_cleanup_failed", { ownerId, error: String(error) }),
          );
      });
    }
  });
  ipcMain.handle("quickChat:isClaimActive", async (event, id: unknown, claimId: unknown) => {
    assertQuickChatClaim(id, claimId);
    return quickChatOwnership.isClaimActive(id, event.sender.id, claimId as string);
  });
  ipcMain.handle("quickChat:cleanupSession", async (event, id: unknown, claimId: unknown) => {
    assertQuickChatClaim(id, claimId);
    return quickChatOwnership.cleanup(id, event.sender.id, claimId as string, () =>
      deleteDesktopSession(id),
    );
  });

  return deleteDesktopSession;
}

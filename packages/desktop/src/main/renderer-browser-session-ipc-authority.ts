import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { basename } from "node:path";
import { mobileSessionCommandAuthority } from "./mobile-remote/output-recovery-authority.js";
import { getProjectStore } from "./project-store.js";
import { SessionCatalogStore } from "./session-catalog-store.js";
import { resolvePersistedBrowserBucket } from "./persisted-browser-bucket.js";
import type { RendererBrowserSessionAccess } from "./renderer-browser-session-access.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { browserPartitionForBucket as registryPartitionForBucket } from "./browser-driver/active-guest.js";

export function browserPartitionForBucket(bucket: unknown): string | undefined {
  if (typeof bucket !== "string" || !bucket || bucket.length > 512 || bucket.includes("\0")) {
    return undefined;
  }
  // Keep the exact PanelArea/WebviewHost partition; never trim a cookie-jar key.
  return registryPartitionForBucket(bucket);
}

/**
 * A new conversation registers its browser with its first message, before the
 * Session directory exists. Main binds the same bucket when it admits the run
 * (or starts the external runtime), so that miss is expected, not a failure.
 */
export function sessionNotCreatedYet(error: unknown, sessionId: string): boolean {
  const cause = error as NodeJS.ErrnoException | undefined;
  return (
    cause?.code === "ENOENT" && typeof cause.path === "string" && basename(cause.path) === sessionId
  );
}

export async function resolvePersistedBrowserSession(sessionId: string, requestedBucket?: string) {
  // Reuse durable Session/project checks without reserving or starting a task.
  const authority = await mobileSessionCommandAuthority(sessionId);
  const store = getProjectStore();
  const projectId =
    authority.projectId ?? store.resolveExactRootSync(authority.mainRoot)?.project.id;
  if (!projectId && !store.isNoRepoCwd(authority.mainRoot))
    throw new Error("Session project is not mounted");
  const catalog = new SessionCatalogStore();
  const binding = resolvePersistedBrowserBucket({
    sessionId,
    projectKey: projectId ?? "__no_repo__",
    requestedBucket,
    readCatalog: () => catalog.snapshotSync(),
  });
  return {
    bucket: binding.bucket,
    assertCurrent: () => {
      authority.assertCurrent();
      binding.assertCurrent();
    },
  };
}

export function createRendererBrowserSessionEventAccess(
  sessionAccess: Pick<RendererBrowserSessionAccess, "prepare">,
  isDeleting: (sessionId: string) => boolean,
) {
  return async (
    event: IpcMainEvent | IpcMainInvokeEvent,
    rawSessionId: unknown,
    requestedBucket?: string,
  ) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame)
      throw new Error("browser operation requires the current Desktop main window");
    assertDesktopSessionId(rawSessionId);
    if (isDeleting(rawSessionId)) throw new Error("Session is being deleted");
    const access = await sessionAccess.prepare(rawSessionId, event.sender.id, requestedBucket);
    const assertCurrent = () => {
      if (
        event.sender.isDestroyed() ||
        event.sender.mainFrame !== frame ||
        isDeleting(access.sessionId)
      )
        throw new Error("browser conversation window changed");
      access.assertCurrent();
    };
    assertCurrent();
    return { ...access, assertCurrent };
  };
}

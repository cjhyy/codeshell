import type { BrowserPartition } from "./browser-driver/active-guest.js";
import {
  activeGuestForSession,
  bucketsWithLiveGuestsForPartition,
  partitionForSession,
} from "./browser-driver/active-guest.js";
import {
  restoreCookieCredentialToBrowser,
  type RestoreCookieCredentialInput,
} from "./cookie-credential-browser.js";
import type { CookieRestoreResult } from "./credentials-service.js";

/** What the agent's InjectCredential call is told about the restore. */
export interface CredentialInjectReport extends CookieRestoreResult {
  ok: true;
  /** The cookie jar actually written. */
  partition: BrowserPartition;
  /** "panel-tab": written through a mounted BrowserPanel tab; otherwise the jar alone. */
  target: "panel-tab" | "partition-only";
  /** Chat workspaces whose mounted panel tabs on this jar were told to reload. */
  reloadedPanels: number;
}

export interface InjectCredentialIntoSessionInput extends Omit<
  RestoreCookieCredentialInput,
  "targetSession"
> {
  sessionId: string;
  /** The caller's own bucket; always reloaded, as before. */
  bucket: string;
  /** Broadcast `browser:reload` for one bucket to every window. */
  reloadBucket: (bucket: string) => void;
}

export interface InjectCredentialIntoSessionDeps {
  activeGuestForSession: typeof activeGuestForSession;
  partitionForSession: typeof partitionForSession;
  bucketsWithLiveGuestsForPartition: typeof bucketsWithLiveGuestsForPartition;
  restore: (input: RestoreCookieCredentialInput) => Promise<CookieRestoreResult>;
}

const defaultDeps: InjectCredentialIntoSessionDeps = {
  activeGuestForSession,
  partitionForSession,
  bucketsWithLiveGuestsForPartition,
  restore: (input) => restoreCookieCredentialToBrowser(input),
};

/**
 * Restore a Cookie credential into the jar this engine session browses with
 * and report exactly where it went. The project profile is shared, so every
 * mounted panel on that jar is reloaded, not only the caller's.
 */
export async function injectCredentialIntoSessionBrowser(
  input: InjectCredentialIntoSessionInput,
  deps: InjectCredentialIntoSessionDeps = defaultDeps,
): Promise<CredentialInjectReport> {
  const { sessionId, bucket, reloadBucket, ...restore } = input;
  // Inject into the exact bucket this engine session owns. If no live guest is
  // mounted, write the persistent partition directly so the next panel open /
  // app restart still sees the restored login state.
  const guest = deps.activeGuestForSession(sessionId);
  const partition = guest?.partition ?? deps.partitionForSession(sessionId);
  if (!partition) throw new Error(`no browser partition registered for session ${sessionId}`);
  const result = await deps.restore({
    ...restore,
    targetSession: guest?.guest.session ?? partition,
  });
  const panels = deps.bucketsWithLiveGuestsForPartition(partition);
  for (const target of new Set([bucket, ...panels])) reloadBucket(target);
  return {
    ok: true,
    ...result,
    partition,
    target: guest ? "panel-tab" : "partition-only",
    reloadedPanels: panels.length,
  };
}

import {
  resolveCookieCredentialForBrowser,
  type DesktopCredentialScope,
  type ResolvedCookieCredential,
} from "./credential-action.js";
import {
  cookieCredentialAutoRefresh,
  type CookieCredentialAutoRefresh,
} from "./cookie-credential-auto-refresh.js";
import {
  browserSessionForCookies,
  restoreCookiesToBrowser,
  type ElectronCookieLike,
} from "./credentials-service.js";

export interface RestoreCookieCredentialInput {
  sessionCwd?: string;
  credentialId: string;
  credentialScope: DesktopCredentialScope;
  resolved: Extract<ResolvedCookieCredential, { ok: true }>;
  targetSession?: string | Electron.Session;
}

export interface RestoreCookieCredentialDeps {
  resolveSession: typeof browserSessionForCookies;
  readCredential: (input: RestoreCookieCredentialInput) => ResolvedCookieCredential;
  restore: typeof restoreCookiesToBrowser;
  autoRefresh: Pick<CookieCredentialAutoRefresh, "prepareRestore" | "detachForCredential" | "bind">;
}

const restoreBySession = new WeakMap<Electron.Session, Promise<void>>();
const restoreByCredential = new Map<string, Promise<void>>();

function readExactCredential(input: RestoreCookieCredentialInput): ResolvedCookieCredential {
  const project = input.resolved.storeScope === "project";
  const current = resolveCookieCredentialForBrowser(
    project ? input.sessionCwd : undefined,
    input.credentialId,
    project ? "project" : "full",
  );
  if (current.ok && current.storeScope !== input.resolved.storeScope) {
    return { ok: false, error: "Cookie credential storage scope changed" };
  }
  return current;
}

/**
 * Restore an explicitly selected login and transfer its refresh ownership before
 * the first Cookie write. Old listeners must never capture a partially restored
 * account while cookies.set is still in progress.
 */
export async function restoreCookieCredentialToBrowser(
  input: RestoreCookieCredentialInput,
  deps: RestoreCookieCredentialDeps = {
    resolveSession: browserSessionForCookies,
    readCredential: readExactCredential,
    restore: restoreCookiesToBrowser,
    autoRefresh: cookieCredentialAutoRefresh,
  },
): Promise<{ count: number }> {
  const { resolved } = input;
  if (resolved.jar.length === 0) throw new Error("Cannot restore an empty Cookie credential");

  const target = await deps.resolveSession(input.targetSession);
  const credentialKey = JSON.stringify([
    resolved.storeScope,
    resolved.storeScope === "project" ? input.sessionCwd : null,
    input.credentialId,
  ]);
  // Reserve both queues together, before awaiting either one. This prevents
  // interleaved cookie writes on a shared Session and competing transfers of
  // one credential to different Sessions, without blocking unrelated logins.
  const pending = Promise.all([
    restoreBySession.get(target),
    restoreByCredential.get(credentialKey),
  ]).then(async () => {
    // The request can wait behind another restore. Read the same authorized
    // storage layer again so a newer login is used and a deletion is respected.
    const current = deps.readCredential(input);
    if (!current.ok) throw new Error(current.error);
    if (current.storeScope !== resolved.storeScope) {
      throw new Error("Cookie credential storage scope changed");
    }
    if (current.jar.length === 0) throw new Error("Cannot restore an empty Cookie credential");
    deps.autoRefresh.prepareRestore(target, current.jar, current.switchMode);
    deps.autoRefresh.detachForCredential(input.sessionCwd, input.credentialId, current.storeScope);
    const result = await deps.restore(
      current.jar as ElectronCookieLike[],
      current.switchMode,
      target,
    );
    // A partially restored jar may contain a mixture of old and new accounts.
    // Keep the saved snapshot intact until a complete explicit restore succeeds.
    if (result.count === current.jar.length) {
      // Toggles, deletions and manual re-login can occur during cookies.set.
      // Use the current switch value, but never bind an old login to a newly
      // replaced credential after that asynchronous boundary.
      const afterRestore = deps.readCredential(input);
      if (
        !afterRestore.ok ||
        afterRestore.storeScope !== current.storeScope ||
        afterRestore.sourceSecret !== current.sourceSecret
      ) {
        return result;
      }
      deps.autoRefresh.bind({
        session: target,
        sessionCwd: input.sessionCwd,
        credentialId: input.credentialId,
        credentialScope: input.credentialScope,
        storeScope: current.storeScope,
        captureScope: current.captureScope,
        ...(current.domain ? { domain: current.domain } : {}),
        seedJar: current.jar,
        sourceSecret: current.sourceSecret,
        enabled: afterRestore.autoRefreshEnabled,
      });
    }
    return result;
  });
  const tail = pending.then(
    () => undefined,
    () => undefined,
  );
  restoreBySession.set(target, tail);
  restoreByCredential.set(credentialKey, tail);
  void tail.then(() => {
    if (restoreBySession.get(target) === tail) restoreBySession.delete(target);
    if (restoreByCredential.get(credentialKey) === tail) restoreByCredential.delete(credentialKey);
  });
  return pending;
}

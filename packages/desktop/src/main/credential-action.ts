import { CredentialStore, type Credential, type CredentialScope } from "@cjhyy/code-shell-core";
import { isRestorableCookieJar } from "./credentials-service.js";

export type DesktopCredentialScope = "full" | "project";

export type ResolvedCookieCredential =
  | {
      ok: true;
      label: string;
      jar: unknown[];
      sourceSecret: string;
      autoRefreshEnabled: boolean;
      switchMode: "clear" | "merge";
      captureScope: "domain" | "all";
      domain?: string;
      storeScope: CredentialScope;
    }
  | { ok: false; error: string };

function storedCookieCredential(
  sessionCwd: string | undefined,
  credentialId: string,
  credentialScope: DesktopCredentialScope,
): { credential: Credential; storeScope: CredentialScope } | null {
  // Determine ownership from the same record read, not a second list that may
  // observe a later project shadow being created/deleted in another process.
  const project = new CredentialStore(sessionCwd).resolve(credentialId, "project");
  const credential =
    project ??
    (credentialScope === "full" ? new CredentialStore().resolve(credentialId) : undefined);
  if (!credential || credential.type !== "cookie") return null;
  return { credential, storeScope: project ? "project" : "user" };
}

export function resolveCookieCredentialForBrowser(
  sessionCwd: string | undefined,
  credentialId: string,
  credentialScope: DesktopCredentialScope,
): ResolvedCookieCredential {
  const stored = storedCookieCredential(sessionCwd, credentialId, credentialScope);
  if (!stored) {
    return { ok: false, error: `无 cookie 凭证: "${credentialId}"` };
  }
  const cred = stored.credential;

  let jar: unknown[] = [];
  try {
    const arr = JSON.parse(cred.secret ?? "[]");
    if (Array.isArray(arr)) jar = arr;
  } catch {
    jar = [];
  }
  if (!isRestorableCookieJar(jar)) {
    return { ok: false, error: `凭证「${cred.label}」cookie 为空或损坏` };
  }

  return {
    ok: true,
    label: cred.label,
    jar,
    sourceSecret: cred.secret!,
    autoRefreshEnabled: cred.meta?.autoRefreshFromBrowser === true,
    switchMode: cred.meta?.switchMode === "clear" ? "clear" : "merge",
    captureScope: cred.meta?.scope === "domain" ? "domain" : "all",
    ...(cred.meta?.domain ? { domain: cred.meta.domain } : {}),
    storeScope: stored.storeScope,
  };
}

export type RefreshCookieCredentialResult =
  | "updated"
  | "unchanged"
  | "missing"
  | "empty"
  | "disabled"
  | "conflict";

/** Compare cookie contents independently of Chromium's enumeration/property order. */
function cookieSnapshot(secret: string): string {
  try {
    const jar = JSON.parse(secret);
    if (!Array.isArray(jar)) return secret;
    return JSON.stringify(
      jar
        .map((cookie) =>
          cookie && typeof cookie === "object" && !Array.isArray(cookie)
            ? JSON.stringify(
                Object.fromEntries(Object.entries(cookie).sort(([a], [b]) => a.localeCompare(b))),
              )
            : JSON.stringify(cookie),
        )
        .sort(),
    );
  } catch {
    return secret;
  }
}

/**
 * Persist a browser-refreshed cookie jar back to the exact credential layer it
 * came from. Read/check/write all run under the credential store lock. A manual
 * re-login, deletion, or toggle change cannot be undone by a delayed snapshot.
 */
export function refreshCookieCredentialFromBrowser(
  sessionCwd: string | undefined,
  credentialId: string,
  storeScope: CredentialScope,
  jar: unknown[],
  expectedSecret: string,
): RefreshCookieCredentialResult {
  if (!Array.isArray(jar) || jar.length === 0) return "empty";
  const secret = JSON.stringify(jar);
  const outcome: { result: RefreshCookieCredentialResult } = { result: "missing" };
  new CredentialStore(sessionCwd).updateExisting(storeScope, credentialId, (current) => {
    if (current.type !== "cookie") return undefined;
    if (current.meta?.autoRefreshFromBrowser !== true) {
      outcome.result = "disabled";
      return undefined;
    }
    if (current.secret !== expectedSecret) {
      outcome.result = "conflict";
      return undefined;
    }
    if (cookieSnapshot(current.secret) === cookieSnapshot(secret)) {
      outcome.result = "unchanged";
      return undefined;
    }
    outcome.result = "updated";
    return { ...current, secret };
  });
  return outcome.result;
}

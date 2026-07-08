import { CredentialStore } from "@cjhyy/code-shell-core";

export type DesktopCredentialScope = "full" | "project";

export type ResolvedCookieCredential =
  | {
      ok: true;
      label: string;
      jar: unknown[];
      switchMode: "clear" | "merge";
    }
  | { ok: false; error: string };

export function resolveCookieCredentialForBrowser(
  sessionCwd: string | undefined,
  credentialId: string,
  credentialScope: DesktopCredentialScope,
): ResolvedCookieCredential {
  const cred = new CredentialStore(sessionCwd).resolve(credentialId, credentialScope);
  if (!cred || cred.type !== "cookie") {
    return { ok: false, error: `无 cookie 凭证: "${credentialId}"` };
  }

  let jar: unknown[] = [];
  try {
    const arr = JSON.parse(cred.secret ?? "[]");
    if (Array.isArray(arr)) jar = arr;
  } catch {
    jar = [];
  }
  if (jar.length === 0) {
    return { ok: false, error: `凭证「${cred.label}」cookie 为空或损坏` };
  }

  return {
    ok: true,
    label: cred.label,
    jar,
    switchMode: cred.meta?.switchMode === "clear" ? "clear" : "merge",
  };
}

import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { isCredentialSecretAvailable } from "@cjhyy/code-shell-core";
import type { CookieFileOperations } from "../shared/cookie-files.js";
import { cookieLeasePath } from "../host/cookie-lease-path.js";
import { desktopCookieHost, runDesktopCredentialOperation } from "./credential-file-client.js";

export async function createDesktopCookieLease(
  secret: string,
  checks: { assertCurrent(): void; confirmCredential(): Promise<void> },
  call: (
    method: "cookies/materialize",
    input: CookieFileOperations["cookies/materialize"]["input"],
  ) => Promise<number> = desktopCookieHost(),
) {
  const token = randomUUID();
  const cookiesFile = cookieLeasePath(token);
  const file = await open(cookiesFile, "wx", 0o600);
  try {
    const stat = await file.stat({ bigint: true }).finally(() => file.close());
    checks.assertCurrent();
    const count = await call("cookies/materialize", {
      lease: { token, device: stat.dev.toString(), inode: stat.ino.toString() },
      secret,
    });
    await checks.confirmCredential();
    checks.assertCurrent();
    return { cookiesFile, count };
  } catch (cause) {
    // If the Host was restarted or the owner changed during the write, revoke the
    // original file. The writer cannot create it again after RPC cancellation.
    await rm(cookiesFile, { force: true });
    throw cause;
  }
}

export async function materializeDesktopCookie(
  cwd: string | undefined,
  id: string,
  scope: "full" | "project",
  expectedApprovalIdentity?: string,
  assertCurrent: () => void = () => {},
) {
  const scopes = scope === "project" ? (["project"] as const) : (["user", "project"] as const);
  const read = () =>
    runDesktopCredentialOperation(cwd, scopes, undefined, (store) => {
      assertCurrent();
      const record = store.resolveForApproval(id, scope);
      if (expectedApprovalIdentity && record?.approvalIdentity !== expectedApprovalIdentity)
        throw Error("credential changed after approval");
      if (
        !record ||
        record.credential.type !== "cookie" ||
        !isCredentialSecretAvailable(record.credential.secret)
      )
        throw Error(`cookie credential "${id}" is unavailable`);
      return { secret: record.credential.secret, identity: record.approvalIdentity };
    });
  const approved = await read();
  return createDesktopCookieLease(approved.secret, {
    assertCurrent,
    async confirmCredential() {
      if ((await read()).identity !== approved.identity)
        throw Error("credential changed after approval");
    },
  });
}

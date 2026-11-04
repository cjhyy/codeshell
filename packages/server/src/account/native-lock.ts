import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireWorkspaceWriteLock } from "@cjhyy/code-shell-core/internal";
import { accountRegistrationUrl } from "@cjhyy/code-shell-web/account";

/**
 * Native credential stores are shared by all TUI/serve processes for this OS
 * user. Lock the whole read/refresh/save/logout lifecycle, including prompts.
 * No age-based recovery: a suspended process may still own a rotating token.
 */
export async function acquireNativeAccountLock(
  origin: string,
  directory = join(homedir(), ".code-shell", "accounts", "locks"),
): Promise<() => Promise<void>> {
  accountRegistrationUrl(origin);
  const key = createHash("sha256").update(origin).digest("hex");
  const parent = join(directory, key);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    return await acquireWorkspaceWriteLock(parent, "session");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ELOCKED") throw cause;
    throw Object.assign(
      new Error(
        "Another native account command owns this account service. Finish that command and retry. " +
          `If it crashed, first stop all account commands for this origin, then remove the empty .lock directory inside ${parent}.`,
        { cause },
      ),
      { code: "ELOCKED" },
    );
  }
}

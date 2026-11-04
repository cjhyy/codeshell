import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureCipher } from "./native-account-fixture-store.js";

const [directory, endpoint, origin, action, role] = process.argv.slice(2);
if (!directory || !endpoint || !origin || !action || !role)
  throw new Error("Missing fixture input");
const guardedFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).origin !== new URL(endpoint).origin)
    throw new Error("Fixture denied an unexpected network origin");
  return guardedFetch(input, { ...init, redirect: "error" });
}) as typeof fetch;
// Install the network guard before importing Host/Core modules.
const { runAccountCli } = await import("../cli.js");
const { acquireNativeAccountLock } = await import("../native-lock.js");
const { CloudAccountManager } = await import("../manager.js");
const { CloudAccountStore } = await import("../store.js");
const { CloudAccountHttpError } = await import("../http.js");
writeFileSync(join(directory, role + ".started"), "started");
await runAccountCli(
  [
    action,
    "--origin",
    origin,
    ...(action === "login" ? ["--username", "member", "--password-stdin"] : []),
  ],
  {
    acquireLock: (origin) => acquireNativeAccountLock(origin, join(directory, "locks")),
    readPassword: async () => "fixture-password-123",
    createManager() {
      writeFileSync(join(directory, role + ".manager"), "manager created under lock");
      return new CloudAccountManager({
        store: new CloudAccountStore(join(directory, "credentials.enc"), fixtureCipher()),
        changed() {},
        openExternal: async () => {},
        request: async (input) => {
          if (
            input.origin !== origin ||
            !/^\/api\/v1\/account\/(?:login|refresh|logout|status|overview)$/.test(input.path)
          )
            throw new Error("Fixture denied an unexpected account request");
          const response = await fetch(new URL(input.path, endpoint), {
            method: input.method ?? "POST",
            signal: input.signal,
            headers: input.token ? { authorization: "Bearer " + input.token } : {},
            body: input.body === undefined ? undefined : JSON.stringify(input.body),
          });
          if (!response.ok) throw new CloudAccountHttpError(response.status, input.path);
          return response.json();
        },
      });
    },
  },
);

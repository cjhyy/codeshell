import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { createDesktopCookieLease } from "./desktop-cookie-lease.js";
import { cookieFileOperations } from "../host/composition/cookie-files.js";
import { HostBusinessCalls } from "../host/composition/business-calls.js";
import { cookieLeasePath } from "../host/cookie-lease-path.js";
import type { CookieFileOperations } from "../shared/cookie-files.js";

test("storage worker writes only an approved live Cookie lease and returns no cookie values in metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-cookie-files-"));
  const storage = openStateStorage(join(root, "sessions"), {
    workerUrl: new URL("./task-inbox/task-storage-worker.ts", import.meta.url),
    workerConfig: { taskInboxDirectory: join(root, "task-inbox") },
  });
  const host = new HostBusinessCalls(cookieFileOperations(storage));
  let seq = 0;
  const request = <K extends keyof CookieFileOperations>(
    method: K,
    input: CookieFileOperations[K]["input"],
  ) => host.run(String(++seq), method, input) as Promise<CookieFileOperations[K]["result"]>;
  const secret = JSON.stringify([
    { name: "fixture", value: "x".repeat(1024 * 1024), domain: ".example.test" },
  ]);
  const checks = { assertCurrent() {}, confirmCredential: async () => {} };
  let resultPath: string | undefined;
  try {
    const lease = await createDesktopCookieLease(secret, checks, request);
    resultPath = lease.cookiesFile;
    expect(lease.count).toBe(1);
    expect(
      (await readFile(lease.cookiesFile, "utf8")).startsWith(
        "# Netscape HTTP Cookie File\n.example.test\tTRUE",
      ),
    ).toBe(true);
    if (process.platform !== "win32")
      expect((await stat(lease.cookiesFile)).mode & 0o777).toBe(0o600);
    const metadata = await request("cookies/inspect", { secrets: [secret, "broken"] });
    expect(metadata.map(({ health }) => health)).toEqual(["ready", "corrupted"]);
    expect(metadata[0].cookieExpiry.sessionCount).toBe(1);
    expect(JSON.stringify(metadata)).not.toContain("fixture");

    let submitted: CookieFileOperations["cookies/materialize"]["input"] | undefined;
    await rejects(
      createDesktopCookieLease(
        secret,
        {
          ...checks,
          confirmCredential: async () => {
            throw Error("original owner was revoked");
          },
        },
        async (method, input) => {
          if (method !== "cookies/materialize") throw Error("Unexpected method");
          submitted = input;
          return request(method, input);
        },
      ),
      /revoked/,
    );
    expect(submitted).toBeDefined();
    await rejects(stat(cookieLeasePath(submitted!.lease.token)), {
      code: "ENOENT",
    });
    await rejects(request("cookies/materialize", submitted!));
    await rejects(stat(cookieLeasePath(submitted!.lease.token)), {
      code: "ENOENT",
    });
  } finally {
    host.close();
    await (await storage).close();
    if (resultPath) await rm(resultPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

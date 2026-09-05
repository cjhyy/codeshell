/** Real Electron Cookie events + temporary project credential store; no network/login needed. */
import { app, session } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "@cjhyy/code-shell-core";
import { CookieCredentialAutoRefresh } from "../src/main/cookie-credential-auto-refresh.js";
import { resolveCookieCredentialForBrowser } from "../src/main/credential-action.js";
import { restoreCookieCredentialToBrowser } from "../src/main/cookie-credential-browser.js";
import {
  browserSessionForCookies,
  restoreCookiesToBrowser,
} from "../src/main/credentials-service.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "codeshell-cookie-sync-smoke-"));
app.setPath("userData", join(fixtureRoot, "browser"));
const refresh = new CookieCredentialAutoRefresh({ debounceMs: 60_000 });
let stage = "Electron startup";
const deadline = setTimeout(() => {
  console.error(`Cookie sync smoke timed out at ${stage}`);
  app.exit(1);
}, 20_000);

async function run(): Promise<void> {
  await app.whenReady();
  let exitCode = 0;
  try {
    stage = "initial Cookie write";
    const partition = "browser:qchat:cookie-sync-smoke";
    const target = session.fromPartition(partition);
    assert.equal(await browserSessionForCookies(partition), target);
    const url = "https://cookie-sync.invalid/";
    const setCookie = async (name: string, value: string) => {
      const observed = new Promise<void>((resolve) => {
        const listener: Parameters<typeof target.cookies.on>[1] = (
          _event,
          cookie,
          _cause,
          removed,
        ) => {
          if (!removed && cookie.name === name && cookie.value === value) {
            target.cookies.removeListener("changed", listener);
            resolve();
          }
        };
        target.cookies.on("changed", listener);
      });
      await target.cookies.set({ url, name, value, path: "/", secure: true });
      await observed;
    };
    await setCookie("sid", "initial");
    stage = "credential restore";
    const store = new CredentialStore(fixtureRoot);
    store.save("project", {
      id: "smoke-login",
      type: "cookie",
      label: "Synthetic smoke login",
      secret: JSON.stringify(await target.cookies.get({})),
      meta: { autoRefreshFromBrowser: true },
    });
    const resolved = resolveCookieCredentialForBrowser(fixtureRoot, "smoke-login", "project");
    assert.ok(resolved.ok);
    await restoreCookieCredentialToBrowser(
      {
        sessionCwd: fixtureRoot,
        credentialId: "smoke-login",
        credentialScope: "project",
        targetSession: target,
        resolved,
      },
      {
        resolveSession: browserSessionForCookies,
        restore: restoreCookiesToBrowser,
        autoRefresh: refresh,
        readCredential: () =>
          resolveCookieCredentialForBrowser(fixtureRoot, "smoke-login", "project"),
      },
    );
    const savedSid = () =>
      JSON.parse(store.resolve("smoke-login", "project")!.secret!).find(
        (cookie: { name: string }) => cookie.name === "sid",
      )?.value;

    stage = "rotation";
    await setCookie("sid", "rotated");
    await refresh.flushNow(target);
    assert.equal(savedSid(), "rotated");

    stage = "toggle off/on";
    store.patch("project", "smoke-login", { meta: { autoRefreshFromBrowser: false } });
    refresh.cancelRefreshForCredential(fixtureRoot, "smoke-login", "project");
    await setCookie("sid", "while-disabled");
    await refresh.flushNow(target);
    assert.equal(savedSid(), "rotated");

    store.patch("project", "smoke-login", { meta: { autoRefreshFromBrowser: true } });
    refresh.requestRefreshForCredential(fixtureRoot, "smoke-login", "project");
    await refresh.flushNow(target);
    assert.equal(savedSid(), "while-disabled");

    stage = "logout guard";
    await setCookie("telemetry", "anonymous");
    await target.cookies.remove(url, "sid");
    await setCookie("telemetry", "anonymous-updated");
    await refresh.flushNow(target);
    assert.equal(savedSid(), "while-disabled");

    stage = "shutdown flush";
    await setCookie("sid", "final-rotation");
    await refresh.shutdown();
    assert.equal(savedSid(), "final-rotation");
    console.log(
      "PASS: Electron rotation, profile reuse, toggle pause/resume, logout guard, shutdown flush",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    refresh.closeAll();
    // Only this smoke's generated fixture tree is removed.
    rmSync(fixtureRoot, { recursive: true, force: true });
    app.exit(exitCode);
  }
}

// Let Electron finish evaluating the entry module before waiting for ready.
void run();

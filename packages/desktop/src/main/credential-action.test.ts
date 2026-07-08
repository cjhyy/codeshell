import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "@cjhyy/code-shell-core";
import { resolveCookieCredentialForBrowser } from "./credential-action.js";

const tempDirs: string[] = [];
let previousHome: string | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  previousHome = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveCookieCredentialForBrowser", () => {
  test("project scope does not fall back to a same-id user credential", () => {
    previousHome = process.env.HOME;
    process.env.HOME = tempDir("cs-desktop-cred-home-");
    const cwd = tempDir("cs-desktop-cred-cwd-");
    const store = new CredentialStore(cwd);
    store.save("user", {
      id: "browser-login",
      type: "cookie",
      label: "User Browser Login",
      secret: JSON.stringify([{ name: "sid", value: "user", domain: "example.com", path: "/" }]),
    });

    const projectScoped = resolveCookieCredentialForBrowser(cwd, "browser-login", "project");
    expect(projectScoped).toEqual({ ok: false, error: '无 cookie 凭证: "browser-login"' });

    const fullScoped = resolveCookieCredentialForBrowser(cwd, "browser-login", "full");
    expect(fullScoped.ok).toBe(true);
  });
});

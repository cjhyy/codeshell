import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Credential } from "@cjhyy/code-shell-core";
import { PanelTaskCookieService, taskCookieSelection } from "./task-cookies.js";

const scope = { appId: "fixture", projectPath: "/project-a", revision: "package-1" };
const jar = [
  { domain: ".example.com", name: "session", value: "private-cookie", path: "/", secure: true },
  { domain: "video.example.com", name: "secondary", value: "also-private", hostOnly: true },
  { domain: ".another.com", name: "other", value: "must-not-leave-vault" },
];
const credential = (): Credential => ({
  id: "selected-account",
  type: "cookie",
  label: "Fixture account",
  meta: { domain: "example.com", scope: "all" },
  secret: JSON.stringify(jar),
});
describe("background task Cookie custody", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "panel-task-cookies-"));
    directories.push(root);
    const state = { credentials: [credential()], allowed: true, reads: 0 };
    const options = {
      rootDirectory: join(root, "private"),
      revisionKey: randomBytes(32),
      authorize: async () => {
        if (!state.allowed) throw new Error("revoked");
      },
      credentials: async () => {
        state.reads++;
        return structuredClone(state.credentials);
      },
      now: () => 1000000,
    };
    const service = new PanelTaskCookieService(options);
    const account = (await service.list(scope, "https://video.example.com/watch")).accounts[0];
    const selection = {
      credentialId: account.id,
      url: "https://video.example.com/watch",
      revision: account.revision,
    };
    return { root, state, options, service, selection, account };
  }
  test("safe scoped metadata, stable private-key versions and private filtered files", async () => {
    const f = await fixture();
    expect(Object.keys(f.account).sort()).toEqual(["domain", "id", "label", "revision"]);
    expect(JSON.stringify(f.account)).not.toContain("private-cookie");
    expect(
      (await new PanelTaskCookieService(f.options).list(scope, f.selection.url)).accounts[0],
    ).toEqual(f.account);
    const sealed = await f.service.materialize(scope, f.selection);
    expect(sealed.count).toBe(2);
    const text = await readFile(sealed.path, "utf8");
    expect(text).toContain("private-cookie");
    expect(text).not.toContain("must-not-leave-vault");
    expect((await stat(sealed.path)).mode & 0o777).toBe(0o600);
    expect((await stat(f.options.rootDirectory)).mode & 0o777).toBe(0o700);
    await sealed.cleanup();
    await sealed.cleanup();
    expect(await readdir(f.options.rootDirectory)).toEqual([]);
  });
  test("another app, project, package or Host cannot reuse a revision", async () => {
    const f = await fixture();
    for (const other of [
      { ...scope, appId: "other" },
      { ...scope, projectPath: "/other" },
      { ...scope, revision: "package-2" },
    ])
      await expect(f.service.check(other, f.selection)).rejects.toThrow(
        "changed or is unavailable",
      );
    await expect(
      new PanelTaskCookieService({ ...f.options, revisionKey: randomBytes(32) }).check(
        scope,
        f.selection,
      ),
    ).rejects.toThrow("changed or is unavailable");
  });
  test("domain matching is one-way and does not accept sibling or suffix impersonation", async () => {
    const f = await fixture();
    for (const url of ["https://com", "https://notexample.com", "https://example.com.evil.test"])
      expect((await f.service.list(scope, url)).accounts).toEqual([]);
    f.state.credentials[0].meta!.domain = "video.example.com";
    expect((await f.service.list(scope, "https://example.com")).accounts).toEqual([]);
    f.state.credentials[0].meta!.domain = "com";
    expect((await f.service.list(scope, "https://example.com")).accounts).toEqual([]);
  });
  test("changed, missing, duplicate or corrupted accounts cannot silently replace the selected login", async () => {
    const f = await fixture();
    for (const credentials of [
      [{ ...credential(), secret: JSON.stringify([{ ...jar[0], value: "replacement" }]) }],
      [{ ...credential(), label: "Another account" }],
      [],
      [credential(), credential()],
      [{ ...credential(), secret: "enc:unreadable" }],
      [{ ...credential(), type: "token" as const }],
    ]) {
      f.state.credentials = credentials;
      await expect(f.service.check(scope, f.selection)).rejects.toThrow(
        "changed or is unavailable",
      );
    }
  });
  test("rejects malformed URLs, arbitrary paths and secret-shaped extra fields", async () => {
    const f = await fixture();
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "file:///secret",
      "not a URL",
    ])
      await expect(f.service.list(scope, url)).rejects.toThrow("HTTPS URL");
    for (const input of [
      null,
      [],
      { ...f.selection, path: "/secret" },
      { ...f.selection, secret: "cookie" },
      { ...f.selection, revision: "bad" },
      { ...f.selection, credentialId: "x\ny" },
    ])
      expect(() => taskCookieSelection(input)).toThrow();
  });
  test("expired and malformed Cookie rows never become native file contents", async () => {
    const f = await fixture();
    f.state.credentials[0].secret = JSON.stringify([
      jar[0],
      null,
      {},
      { ...jar[0], expirationDate: 500 },
      { ...jar[0], name: "line\nbreak" },
      { ...jar[0], path: "/\n.other.com\tTRUE\t/\tFALSE\t0\tx\ty" },
      { ...jar[0], path: {} },
      { ...jar[0], expirationDate: "2000" },
      { ...jar[0], domain: ".com" },
    ]);
    const account = (await f.service.list(scope, f.selection.url)).accounts[0];
    const sealed = await f.service.materialize(scope, {
      ...f.selection,
      revision: account.revision,
    });
    expect(sealed.count).toBe(1);
    expect((await readFile(sealed.path, "utf8")).trim().split("\n")).toHaveLength(2);
    await sealed.cleanup();
  });
  test("permission revocation gates listing, checking and materialization", async () => {
    const f = await fixture();
    f.state.allowed = false;
    await expect(f.service.list(scope, f.selection.url)).rejects.toThrow("revoked");
    await expect(f.service.check(scope, f.selection)).rejects.toThrow("revoked");
    await expect(f.service.materialize(scope, f.selection)).rejects.toThrow("revoked");
    expect(await readdir(f.root)).toEqual([]);
  });
  test("revocation during file creation removes the file before returning", async () => {
    const f = await fixture();
    let reads = 0;
    const service = new PanelTaskCookieService({
      ...f.options,
      credentials: async () => {
        if (++reads === 2) return [];
        return [credential()];
      },
    });
    await expect(service.materialize(scope, f.selection)).rejects.toThrow(
      "changed or is unavailable",
    );
    expect(await readdir(f.options.rootDirectory)).toEqual([]);
  });
  test("requires a Host key and refuses a symlink used as the private root", async () => {
    const f = await fixture();
    expect(
      () => new PanelTaskCookieService({ ...f.options, revisionKey: new Uint8Array(8) }),
    ).toThrow("private Host key");
    expect(() => new PanelTaskCookieService({ ...f.options, rootDirectory: "relative" })).toThrow(
      "absolute",
    );
    await symlink(f.root, f.options.rootDirectory);
    await expect(f.service.materialize(scope, f.selection)).rejects.toThrow(
      "Invalid task Cookie root",
    );
    expect((await lstat(f.options.rootDirectory)).isSymbolicLink()).toBe(true);
  });
});

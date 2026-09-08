import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installReviewedLocalPanelApp,
  listInstalledPanelApps,
  previewLocalPanelApp,
  previewInstalledPanelAppUpdate,
} from "@cjhyy/code-shell-core";
import { createPanelManagement } from "./management.js";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
}

describe("shared Web panel management with the real Core installer", () => {
  let root: string;
  let cwd: string;
  let repo: string;
  let previousHome: string | undefined;
  let previousFetch: typeof fetch;
  let commit: string;
  let fetches: string[];
  const owner = { ownerId: "owner-a", authorize: () => true };
  const input = { kind: "git", url: "https://github.com/codeshell-tests/panels", ref: "main" };
  const services: Array<ReturnType<typeof createPanelManagement>> = [];

  function writePanel(version = "1.0.0", permissions = ["storage"]) {
    mkdirSync(join(repo, ".codeshell-panel"), { recursive: true });
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(
      join(repo, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "test-panel",
        title: { default: "Test panel" },
        version,
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions,
      }),
    );
    writeFileSync(join(repo, "app/index.html"), `<!doctype html><body>Version ${version}</body>`);
    git(repo, "add", ".");
    git(repo, "commit", "-m", `version ${version}`);
    commit = git(repo, "rev-parse", "HEAD");
  }

  function service(options: Partial<Parameters<typeof createPanelManagement>[0]> = {}) {
    const value = createPanelManagement({ cwd, resolveCommit: async () => commit, ...options });
    services.push(value);
    return value;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-web-panel-management-"));
    previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    cwd = join(root, "workspace %20");
    repo = join(root, "repository");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.email", "panel-test@codeshell.local");
    git(repo, "config", "user.name", "Panel test");
    writePanel();
    previousFetch = globalThis.fetch;
    fetches = [];
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        const target = new URL(String(url));
        expect(target.origin).toBe("https://codeload.github.com");
        const ref = decodeURIComponent(target.pathname.split("/zip/")[1]!);
        fetches.push(ref);
        const result = spawnSync(
          "git",
          ["archive", "--format=zip", "--prefix=panels-source/", ref],
          { cwd: repo, maxBuffer: 4 * 1024 * 1024 },
        );
        if (result.status !== 0) return new Response("missing ref", { status: 404 });
        return new Response(result.stdout, {
          headers: {
            "content-type": "application/zip",
            "content-length": String(result.stdout.length),
          },
        });
      },
      { preconnect: previousFetch.preconnect },
    ) as typeof fetch;
  });

  afterEach(() => {
    for (const instance of services.splice(0)) instance.close();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("installs the reviewed commit after HEAD moves and keeps Desktop updates on the original branch", async () => {
    const api = service();
    const reviewedCommit = commit;
    const discovery = await api.discover(owner, input);
    expect(discovery.source.commit).toBe(reviewedCommit);
    expect(discovery.panels[0]?.source.ref).toBe("main");
    const reviewed = await api.preview(owner, input);
    expect(reviewed.reviewToken).not.toMatch(/^[a-f0-9]{64}$/);
    writePanel("2.0.0");
    await api.install(owner, reviewed.reviewToken);
    const installed = (await api.snapshot()).panels[0]!;
    expect(installed).toMatchObject({
      version: "1.0.0",
      bound: true,
      enabled: true,
      source: { ref: "main", commit: reviewedCommit },
    });
    expect(
      readFileSync(
        join(process.env.HOME!, ".code-shell/panel-apps/test-panel/app/index.html"),
        "utf8",
      ),
    ).toContain("Version 1.0.0");
    expect(fetches.every((ref) => ref === reviewedCommit)).toBe(true);
    expect((await listInstalledPanelApps())[0]?.source).toMatchObject({ ref: "main" });
    expect((await previewInstalledPanelAppUpdate("test-panel")).version).toBe("2.0.0");
    const update = await api.previewUpdate(owner, installed.id, installed.revision);
    expect(update.source.commit).toBe(commit);
    await api.install(owner, update.reviewToken);
    expect((await api.snapshot()).panels[0]?.version).toBe("2.0.0");
  });

  test("owner-bound reviews expire on logout and pending network work cannot issue another review", async () => {
    const api = service();
    const reviewed = await api.preview(owner, input);
    await expect(
      api.install({ ownerId: "owner-b", authorize: () => true }, reviewed.reviewToken),
    ).rejects.toMatchObject({ status: 403 });
    api.cancelOwner(owner.ownerId);
    await expect(api.install(owner, reviewed.reviewToken)).rejects.toMatchObject({ status: 409 });
    let release!: (value: string) => void;
    const delayed = service({
      resolveCommit: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = delayed.preview(owner, input);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    delayed.cancelOwner(owner.ownerId);
    release(commit);
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(await listInstalledPanelApps()).toEqual([]);
  });

  test("rechecks authorization after Core staging and removes uncommitted files", async () => {
    const api = service();
    const reviewed = await api.preview(owner, input);
    const appRoot = join(process.env.HOME!, ".code-shell/panel-apps");
    const revokingOwner = {
      ownerId: owner.ownerId,
      authorize: () =>
        !existsSync(appRoot) ||
        !readdirSync(appRoot).some((name) => name.startsWith(".tmp-test-panel-")),
    };
    await expect(api.install(revokingOwner, reviewed.reviewToken)).rejects.toMatchObject({
      status: 401,
    });
    expect(await listInstalledPanelApps()).toEqual([]);
    expect(readdirSync(appRoot).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(existsSync(join(cwd, ".code-shell/settings.json"))).toBe(false);
  });

  test("binding CAS spans workspace services and never changes another workspace", async () => {
    const first = service();
    const second = service();
    const elsewhere = join(root, "other-workspace");
    mkdirSync(elsewhere);
    const other = service({ cwd: elsewhere });
    await first.install(owner, (await first.preview(owner, input)).reviewToken);
    const old = (await second.snapshot()).panels[0]!;
    await first.binding(owner, old.id, false, old.revision);
    await expect(second.binding(owner, old.id, true, old.revision)).rejects.toMatchObject({
      status: 409,
    });
    expect((await other.snapshot()).panels[0]).toMatchObject({ bound: false, enabled: false });
    expect(existsSync(join(elsewhere, ".code-shell/settings.json"))).toBe(false);
    const latest = (await second.snapshot()).panels[0]!;
    await second.binding(owner, latest.id, true, latest.revision);
    expect((await first.snapshot()).panels[0]?.bound).toBe(true);
  });

  test("stale reviewed updates cannot overwrite an independently changed installation", async () => {
    const api = service();
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const old = (await api.snapshot()).panels[0]!;
    writePanel("2.0.0");
    const reviewed = await api.previewUpdate(owner, old.id, old.revision);
    writePanel("3.0.0");
    const replacement = join(root, "replacement");
    mkdirSync(replacement);
    cpSync(join(repo, ".codeshell-panel"), join(replacement, ".codeshell-panel"), {
      recursive: true,
    });
    cpSync(join(repo, "app"), join(replacement, "app"), { recursive: true });
    const local = await previewLocalPanelApp({ kind: "dir", path: replacement });
    await installReviewedLocalPanelApp(
      { kind: "dir", path: replacement },
      local.reviewToken,
      new Date().toISOString(),
      { overwrite: true },
    );
    await expect(api.install(owner, reviewed.reviewToken)).rejects.toMatchObject({ status: 409 });
    expect((await api.snapshot()).panels[0]?.version).toBe("3.0.0");
  });

  test("unsafe source paths and symlinked workspace state cannot cross the selected workspace", async () => {
    const api = service();
    for (const source of [
      { kind: "dir", path: repo },
      { ...input, url: "https://example.com/panel" },
      { ...input, subdir: "../outside" },
      { ...input, url: "https://github.com/codeshell-tests/panels/tree/main/%2e%2e/private" },
    ])
      await expect(api.preview(owner, source)).rejects.toMatchObject({ status: 400 });
    await api.install(owner, (await api.preview(owner, input)).reviewToken, false);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), '{"custom":"preserve"}');
    symlinkSync(outside, join(cwd, ".code-shell"));
    const app = (await api.snapshot()).panels[0]!;
    await expect(api.binding(owner, app.id, true, app.revision)).rejects.toThrow();
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe('{"custom":"preserve"}');
  });

  test("unsupported panels remain installed without exposing them to the workspace", async () => {
    const api = service({ compatibility: () => ({ supported: false, reasons: ["需要桌面进程"] }) });
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const app = (await api.snapshot()).panels[0]!;
    expect(app).toMatchObject({
      bound: false,
      enabled: false,
      compatibility: { supported: false },
    });
    await expect(api.binding(owner, app.id, true, app.revision)).rejects.toMatchObject({
      code: "unsupported",
    });
    await api.remove(owner, app.id, app.revision);
    expect((await api.snapshot()).panels).toEqual([]);
  });
});

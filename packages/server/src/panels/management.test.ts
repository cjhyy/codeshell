import { panelExecutionGate } from "./execution-gate.js";
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
  listProjectPanelApps,
  projectPanelAppPackagePins,
  SettingsManager,
  previewLocalPanelApp,
  previewInstalledPanelAppUpdate,
  panelAppPackageDir,
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

  test("scoped management snapshots keep current authorization and do not return another app", async () => {
    const api = service({ projectPackages: true });
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const full = await api.snapshot();
    expect(await api.snapshot("test-panel")).toEqual(full);
    expect((await api.snapshot("absent-panel")).panels).toEqual([]);
    const current = full.panels[0]!;
    await api.binding(owner, current.id, false, current.revision);
    expect((await api.snapshot(current.id)).panels[0]?.enabled).toBe(false);
    await expect(api.snapshot("../test-panel")).rejects.toThrow();
  });

  test("project bindings retain independent versions and revisions through another project's update", async () => {
    const first = service({ projectPackages: true });
    const elsewhere = join(root, "other-project");
    mkdirSync(elsewhere);
    const second = service({ cwd: elsewhere, projectPackages: true });
    await first.install(owner, (await first.preview(owner, input)).reviewToken);
    const available = (await second.snapshot()).panels[0]!;
    await second.binding(owner, available.id, true, available.revision);
    const old = (await second.snapshot()).panels[0]!;
    const selected = (await listProjectPanelApps(elsewhere))[0]!;
    expect(selected.installPath).toContain("/.versions/test-panel/");
    expect(projectPanelAppPackagePins(elsewhere)[old.id]).toEqual({
      version: "1.0.0",
      packageDigest: old.packageDigest!,
    });
    writePanel("2.0.0");
    const firstOld = (await first.snapshot()).panels[0]!;
    const update = await first.previewUpdate(owner, firstOld.id, firstOld.revision);
    await first.install(owner, update.reviewToken);
    expect((await first.snapshot()).panels[0]?.version).toBe("2.0.0");
    expect((await second.snapshot()).panels[0]).toMatchObject({
      version: "1.0.0",
      revision: old.revision,
      packageDigest: old.packageDigest,
      enabled: true,
    });
    expect(readFileSync(join(selected.installPath, "app/index.html"), "utf8")).toContain("1.0.0");
    // Another device can still change this project's binding using its old revision.
    await second.binding(owner, old.id, false, old.revision);
    expect(projectPanelAppPackagePins(elsewhere)[old.id]).toBeUndefined();
    const latest = (await second.snapshot()).panels[0]!;
    expect(latest.version).toBe("2.0.0");
    await second.binding(owner, latest.id, true, latest.revision);
    expect((await second.snapshot()).panels[0]).toMatchObject({ version: "2.0.0", bound: true });
  });

  test("reviewed updates block affected work, allow other pinned projects and close admission during commit", async () => {
    let checkWrite: (() => Promise<void>) | undefined;
    const api = service({
      projectPackages: true,
      withMutation: async (write) => {
        await checkWrite?.();
        return write();
      },
    });
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const old = (await api.snapshot()).panels[0]!;
    const elsewhere = join(root, "pinned-project");
    mkdirSync(elsewhere);
    const other = service({ cwd: elsewhere, projectPackages: true });
    const available = (await other.snapshot()).panels[0]!;
    await other.binding(owner, available.id, true, available.revision);
    writePanel("2.0.0");
    const review = await api.previewUpdate(owner, old.id, old.revision);
    const release = panelExecutionGate.enter({ appId: old.id, projectPath: cwd });
    try {
      await expect(api.install(owner, review.reviewToken)).rejects.toMatchObject({ status: 409 });
      expect((await api.snapshot()).panels[0]!.version).toBe("1.0.0");
    } finally {
      release();
    }
    const releaseLegacy = panelExecutionGate.enter({
      appId: old.id,
      projectPath: join(root, "legacy"),
    });
    try {
      await expect(api.install(owner, review.reviewToken)).rejects.toMatchObject({ status: 409 });
    } finally {
      releaseLegacy();
    }
    const releaseOther = panelExecutionGate.enter({ appId: old.id, projectPath: elsewhere });
    checkWrite = async () => {
      expect(() => panelExecutionGate.enter({ appId: old.id, projectPath: cwd })).toThrow(
        "正在更新",
      );
      // This project's retained bytes do not change during the catalog update.
      panelExecutionGate.enter({ appId: old.id, projectPath: elsewhere })();
    };
    try {
      await api.install(owner, review.reviewToken);
      expect((await api.snapshot()).panels[0]!.version).toBe("2.0.0");
      expect((await other.snapshot()).panels[0]!.version).toBe("1.0.0");
      checkWrite = undefined;
      const updated = (await api.snapshot()).panels[0]!;
      await expect(api.remove(owner, old.id, updated.revision)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      releaseOther();
    }
  });

  test("project update review rejects a changed catalog without moving the old project pin", async () => {
    const first = service({ projectPackages: true });
    const second = service({ cwd: join(root, "other-project"), projectPackages: true });
    mkdirSync(join(root, "other-project"));
    await first.install(owner, (await first.preview(owner, input)).reviewToken);
    const available = (await second.snapshot()).panels[0]!;
    await second.binding(owner, available.id, true, available.revision);
    const one = (await first.snapshot()).panels[0]!;
    const two = (await second.snapshot()).panels[0]!;
    writePanel("2.0.0");
    const stale = await second.previewUpdate(owner, two.id, two.revision);
    await first.install(
      owner,
      (await first.previewUpdate(owner, one.id, one.revision)).reviewToken,
    );
    await expect(second.install(owner, stale.reviewToken)).rejects.toMatchObject({ status: 409 });
    expect((await second.snapshot()).panels[0]).toMatchObject({
      version: "1.0.0",
      revision: two.revision,
    });
    // Refreshing the review explicitly upgrades this project to the already installed bytes.
    await second.install(
      owner,
      (await second.previewUpdate(owner, two.id, two.revision)).reviewToken,
    );
    expect((await second.snapshot()).panels[0]?.version).toBe("2.0.0");
  });

  test("post-install binding CAS preserves a concurrent device's unbind and old package pin", async () => {
    const api = service({ projectPackages: true });
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const old = (await api.snapshot()).panels[0]!;
    const oldPins = projectPanelAppPackagePins(cwd);
    writePanel("2.0.0");
    const update = await api.previewUpdate(owner, old.id, old.revision);
    let changed = false;
    const otherDevice = {
      ownerId: owner.ownerId,
      authorize() {
        const page = join(process.env.HOME!, ".code-shell/panel-apps/test-panel/app/index.html");
        if (!changed && readFileSync(page, "utf8").includes("2.0.0")) {
          changed = true;
          new SettingsManager(cwd, "full").mutateSettingsForScope("project", cwd, (settings) => {
            settings.panelAppBindings = [];
          });
        }
        return true;
      },
    };
    await expect(api.install(otherDevice, update.reviewToken)).rejects.toMatchObject({
      status: 409,
    });
    expect(changed).toBe(true);
    expect(projectPanelAppPackagePins(cwd)).toEqual(oldPins);
    expect((await api.snapshot()).panels[0]).toMatchObject({ version: "1.0.0", bound: false });
  });

  test("missing pinned package and invalid project settings never fall through to the catalog", async () => {
    const api = service({ projectPackages: true });
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const selected = (await listProjectPanelApps(cwd))[0]!;
    rmSync(selected.installPath, { recursive: true });
    const broken = await api.snapshot();
    expect(broken.panels).toEqual([]);
    expect(broken.issues).toMatchObject([
      { id: selected.id, version: "1.0.0", code: "package_unavailable" },
    ]);
    expect((await listInstalledPanelApps())[0]?.version).toBe("1.0.0");
    writeFileSync(join(cwd, ".code-shell/settings.json"), '{"panelAppPins":null}');
    await expect(api.snapshot()).rejects.toThrow();
  });

  async function restorationFixture(
    options: Partial<Parameters<typeof createPanelManagement>[0]> = {},
  ) {
    const api = service({ projectPackages: true, ...options });
    await api.install(owner, (await api.preview(owner, input)).reviewToken);
    const old = (await api.snapshot()).panels[0]!;
    writePanel("2.0.0", []);
    await api.install(owner, (await api.previewUpdate(owner, old.id, old.revision)).reviewToken);
    const current = (await api.snapshot()).panels[0]!;
    return { api, old, current };
  }

  test("reviewed restoration changes only the project pin, preserves data and checks additional permissions", async () => {
    const { api, old, current } = await restorationFixture();
    const peerCwd = join(root, "second-project");
    mkdirSync(peerCwd);
    const peer = service({ cwd: peerCwd, projectPackages: true });
    const peerPanel = (await peer.snapshot()).panels[0]!;
    await peer.binding(owner, peerPanel.id, true, peerPanel.revision);
    writeFileSync(join(cwd, "project-data.json"), '{"documentVersion":2}');
    const history = await api.packageHistory(owner, old.id, current.revision);
    expect(history.current.version).toBe("2.0.0");
    expect(history.versions.map((app) => app.version).sort()).toEqual(["1.0.0", "2.0.0"]);
    const preview = await api.previewRestore(owner, old.id, old.packageDigest, current.revision);
    expect(preview.addedPermissions).toEqual(["storage"]);
    expect(preview.current.version).toBe("2.0.0");
    preview.version = "forged"; // Caller cannot change a held review.
    await api.restore(owner, preview.reviewToken);
    expect((await api.snapshot()).panels[0]).toMatchObject({
      version: "1.0.0",
      revision: old.revision,
    });
    expect((await peer.snapshot()).panels[0]?.version).toBe("2.0.0");
    expect((await listInstalledPanelApps())[0]?.version).toBe("2.0.0");
    expect(readFileSync(join(cwd, "project-data.json"), "utf8")).toBe('{"documentVersion":2}');
    await expect(api.restore(owner, preview.reviewToken)).rejects.toMatchObject({ status: 409 });
  });

  test("missing selected bytes can be explicitly repaired without changing project data", async () => {
    const { api, old, current } = await restorationFixture();
    const config = join(cwd, ".code-shell/settings.json");
    const original = readFileSync(config, "utf8");
    rmSync(panelAppPackageDir(current.id, current.packageDigest!), { recursive: true });
    const broken = await api.snapshot();
    expect(broken.panels).toEqual([]);
    expect(broken.issues).toMatchObject([{ id: current.id, version: "2.0.0", bound: true }]);
    expect(readFileSync(config, "utf8")).toBe(original);
    const issue = broken.issues![0]!;
    const history = await api.packageHistory(owner, issue.id, issue.revision);
    expect(history.current).toMatchObject({ version: "2.0.0", unavailable: true });
    expect(history.versions.map((app) => app.version)).toEqual(["1.0.0"]);
    const preview = await api.previewRestore(owner, issue.id, old.packageDigest, issue.revision);
    expect(preview.addedPermissions).toEqual(preview.permissions);
    writeFileSync(join(cwd, "project-data.json"), '{"documentVersion":2}');
    await api.restore(owner, preview.reviewToken);
    expect((await api.snapshot()).issues).toBeUndefined();
    expect((await api.snapshot()).panels[0]?.version).toBe("1.0.0");
    expect(readFileSync(join(cwd, "project-data.json"), "utf8")).toBe('{"documentVersion":2}');
  });

  test("a broken legacy baseline is repaired without inventing the original version", async () => {
    const { api, old } = await restorationFixture();
    new SettingsManager(cwd, "full").mutateSettingsForScope("project", cwd, (settings) => {
      settings.panelAppPins = {};
    });
    writeFileSync(
      join(panelAppPackageDir(old.id, old.packageDigest!), "..", "legacy-projects.json"),
      "damaged",
    );
    const issue = (await api.snapshot()).issues![0]!;
    expect(issue.version).toBeUndefined();
    const history = await api.packageHistory(owner, issue.id, issue.revision);
    expect(history.current).toEqual({
      version: "未记录",
      packageDigest: undefined,
      unavailable: true,
    });
    const preview = await api.previewRestore(owner, issue.id, old.packageDigest, issue.revision);
    expect(preview.addedPermissions).toEqual(preview.permissions);
    await api.restore(owner, preview.reviewToken);
    expect((await api.snapshot()).panels[0]?.version).toBe("1.0.0");
  });

  test("repair reviews reject concurrent project edits and corrupt configuration", async () => {
    const { api, old, current } = await restorationFixture();
    writeFileSync(
      join(panelAppPackageDir(current.id, current.packageDigest!), "app/index.html"),
      "damaged",
    );
    const issue = (await api.snapshot()).issues![0]!;
    const preview = await api.previewRestore(owner, issue.id, old.packageDigest, issue.revision);
    new SettingsManager(cwd, "full").mutateSettingsForScope("project", cwd, (settings) => {
      settings.panelAppBindings = [];
    });
    await expect(api.restore(owner, preview.reviewToken)).rejects.toMatchObject({ status: 409 });
    writeFileSync(join(cwd, ".code-shell/settings.json"), '{"panelAppPins":null}');
    await expect(api.restore(owner, preview.reviewToken)).rejects.toThrow();
  });

  test("restore reviews enforce owner, expiration, revocation and concurrent project edits", async () => {
    let now = Date.now();
    const { api, old, current } = await restorationFixture({ now: () => now });
    const preview = () => api.previewRestore(owner, old.id, old.packageDigest, current.revision);
    const first = await preview();
    await expect(
      api.restore({ ...owner, ownerId: "other" }, first.reviewToken),
    ).rejects.toMatchObject({ status: 403 });
    now += 9 * 60_000;
    await expect(api.restore(owner, first.reviewToken)).rejects.toMatchObject({ status: 409 });
    const expiredOnLogout = await preview();
    api.cancelOwner(owner.ownerId);
    await expect(api.restore(owner, expiredOnLogout.reviewToken)).rejects.toMatchObject({
      status: 409,
    });
    const stale = await preview();
    await api.binding(owner, current.id, false, current.revision);
    await expect(api.restore(owner, stale.reviewToken)).rejects.toMatchObject({ status: 409 });
    expect((await api.snapshot()).panels[0]?.bound).toBe(false);
  });

  test("restore refuses live execution and rechecks target bytes after review", async () => {
    const { api, old, current } = await restorationFixture();
    const preview = await api.previewRestore(owner, old.id, old.packageDigest, current.revision);
    const release = panelExecutionGate.enter({ appId: old.id, projectPath: cwd });
    try {
      await expect(api.restore(owner, preview.reviewToken)).rejects.toThrow("任务");
    } finally {
      release();
    }
    writeFileSync(
      join(panelAppPackageDir(old.id, old.packageDigest!), "app/index.html"),
      "changed after review",
    );
    await expect(api.restore(owner, preview.reviewToken)).rejects.toThrow("content has changed");
    expect((await api.snapshot()).panels[0]?.version).toBe("2.0.0");
    const inventory = await api.packageHistory(owner, old.id, current.revision);
    expect(inventory.unavailablePackages).toBe(1);
    expect(inventory.versions.map((app) => app.version)).toEqual(["2.0.0"]);
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
    const app = (await api.snapshot()).panels[0]!;
    symlinkSync(outside, join(cwd, ".code-shell"));
    await expect(api.snapshot()).rejects.toThrow();
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

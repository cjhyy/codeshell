import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { createPanelManagement } from "./management.js";
import { panelExecutionGate, type PanelExecutionScope } from "./execution-gate.js";

const owner = { ownerId: "desktop:1", authorize: () => true };
let directory: string;
let originalHome: string | undefined;
let originalFetch: typeof fetch;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "panel-force-update-")));
  originalHome = process.env.HOME;
  process.env.HOME = join(directory, "home");
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected network in local Panel update test");
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const cwd = join(directory, "project");
  const source = join(directory, "source");
  mkdirSync(cwd);
  mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
  mkdirSync(join(source, "app"));
  const write = (version: string) => {
    writeFileSync(
      join(source, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "fixture-panel",
        version,
        title: { default: "Fixture" },
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions: ["storage"],
      }),
    );
    writeFileSync(join(source, "app/index.html"), version);
  };
  let clock = Date.now();
  const api = createPanelManagement({
    cwd,
    projectPackages: true,
    allowLocalSources: true,
    now: () => clock,
  });
  cleanups.push(() => api.close());
  write("1.0.0");
  const initial = await api.previewProjectSource(owner, { kind: "dir", path: source });
  await api.install(owner, initial.reviewToken);
  const installed = (await api.snapshot()).panels[0]!;
  write("2.0.0");
  const review = await api.previewProjectUpdate(owner, installed.id, installed.revision);
  const scope = { appId: installed.id, projectPath: cwd };
  const release = panelExecutionGate.enter(scope);
  cleanups.push(release);
  let cancellations = 0;
  const releaseExecutions = async (
    _id: string,
    matches: (scope: PanelExecutionScope) => boolean,
  ) => {
    cancellations++;
    if (matches(scope)) release();
  };
  return {
    api,
    cwd,
    installed,
    review,
    scope,
    write,
    release,
    releaseExecutions,
    cancellations: () => cancellations,
    advance: () => {
      clock += 9 * 60_000;
    },
    approval: { overwrite: true, expectedId: installed.id, releaseExecutions },
  };
}

for (const invalid of [
  "missing",
  "expired",
  "owner",
  "id",
  "revoked",
  "project",
  "source",
] as const) {
  test(`a ${invalid} review cannot cancel holders`, async () => {
    const f = await fixture();
    let context = owner;
    let token = f.review.reviewToken;
    const approval = { ...f.approval };
    if (invalid === "missing") token = "not-a-review";
    if (invalid === "expired") f.advance();
    if (invalid === "owner") context = { ...owner, ownerId: "desktop:other" };
    if (invalid === "id") approval.expectedId = "another-panel";
    if (invalid === "revoked") f.api.cancelOwner(owner.ownerId);
    if (invalid === "project")
      new SettingsManager(f.cwd, "full").mutateSettingsForScope("project", f.cwd, (settings) => {
        settings.panelAppBindings = [];
      });
    if (invalid === "source") f.write("3.0.0");
    await expect(f.api.install(context, token, true, approval)).rejects.toThrow();
    expect(f.cancellations()).toBe(0);
    expect(panelExecutionGate.blockers((scope) => scope.appId === f.scope.appId)).toHaveLength(1);
    expect((await f.api.snapshot()).panels[0]!.version).toBe("1.0.0");
  });
}

test("a valid forced update fences admission in every project using the app and survives TTL during cancellation", async () => {
  const f = await fixture();
  const elsewhere = join(directory, "other-project");
  mkdirSync(elsewhere);
  const other = createPanelManagement({ cwd: elsewhere, projectPackages: true });
  cleanups.push(() => other.close());
  const app = (await other.snapshot()).panels[0]!;
  await other.binding(owner, app.id, true, app.revision);
  const otherScope = { appId: app.id, projectPath: elsewhere };
  const otherRelease = panelExecutionGate.enter(otherScope);
  let otherReleased = false;
  const releaseOther = () => {
    if (!otherReleased) otherRelease();
    otherReleased = true;
  };
  cleanups.push(releaseOther);
  let closed = 0;
  const result = await f.api.install(owner, f.review.reviewToken, true, {
    ...f.approval,
    releaseExecutions: async (id, matches) => {
      closed++;
      expect(id).toBe(app.id);
      // A catalog update supersedes every project's pin, so it reaches every project.
      expect(matches(f.scope)).toBe(true);
      expect(matches(otherScope)).toBe(true);
      expect(() => panelExecutionGate.enter(f.scope)).toThrow("正在更新");
      expect(() => panelExecutionGate.enter(otherScope)).toThrow("正在更新");
      f.advance();
      f.release();
      releaseOther();
      await Promise.resolve();
    },
  });
  expect(result.id).toBe(app.id);
  expect(closed).toBe(1);
  expect((await f.api.snapshot()).panels[0]!.version).toBe("2.0.0");
  expect((await other.snapshot()).panels[0]!.version).toBe("2.0.0");
  expect(panelExecutionGate.blockers((scope) => scope.projectPath === elsewhere)).toHaveLength(0);
  await expect(f.api.install(owner, f.review.reviewToken, true, f.approval)).rejects.toThrow(
    "预览已失效",
  );
  expect(f.cancellations()).toBe(0);
});

test("source mutation while holders close is still rejected before package commit", async () => {
  const f = await fixture();
  await expect(
    f.api.install(owner, f.review.reviewToken, true, {
      ...f.approval,
      releaseExecutions: async () => {
        f.release();
        f.write("3.0.0");
      },
    }),
  ).rejects.toThrow();
  expect((await f.api.snapshot()).panels[0]!.version).toBe("1.0.0");
});

for (const changed of ["owner", "project"] as const) {
  test(`a ${changed} change while holders close still invalidates the admitted operation`, async () => {
    const f = await fixture();
    await expect(
      f.api.install(owner, f.review.reviewToken, true, {
        ...f.approval,
        releaseExecutions: async () => {
          f.release();
          f.advance();
          if (changed === "owner") f.api.cancelOwner(owner.ownerId);
          else
            new SettingsManager(f.cwd, "full").mutateSettingsForScope(
              "project",
              f.cwd,
              (settings) => {
                settings.panelAppBindings = [];
              },
            );
        },
      }),
    ).rejects.toThrow();
    expect((await f.api.snapshot()).panels[0]!.version).toBe("1.0.0");
  });
}

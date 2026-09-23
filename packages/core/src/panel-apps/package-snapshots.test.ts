import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installReviewedLocalPanelApp,
  listInstalledPanelApps,
  listRetainedPanelAppPackages,
  listProjectPanelApps,
  inspectProjectPanelApps,
  migrateProjectPanelAppPackagePins,
  projectPanelAppPackagePins,
  panelAppPackageDir,
  previewLocalPanelApp,
  resolvePanelAppPackage,
  retainInstalledPanelApp,
  uninstallPanelApp,
} from "./index.js";
import { scanSkills, invalidateSkillCache } from "../skills/scanner.js";

let root: string;
let source: string;
let previousHome: string | undefined;
const id = "snapshot-panel";

async function writePackage(version: string, label = version) {
  const native = `process.stdout.write(${JSON.stringify(label)});`;
  await writeFile(join(source, "app/index.html"), `<body>${label}</body>`);
  await writeFile(join(source, "app/tools/check.mjs"), native);
  await writeFile(
    join(source, "agent/skills/check/SKILL.md"),
    `---\nname: check\ndescription: Check ${label}\n---\n${label}`,
  );
  await writeFile(
    join(source, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 2,
      id,
      version,
      title: { default: "Snapshot" },
      entry: "app/index.html",
      permissions: ["process"],
      icon: "panel",
      placement: "right-dock",
      singleton: true,
      nativeEntries: {
        check: {
          entry: "app/tools/check.mjs",
          sha256: createHash("sha256").update(native).digest("hex"),
        },
      },
      agent: { tools: [], skills: ["agent/skills/check/SKILL.md"] },
    }),
  );
}

async function install(overwrite = false, date = "2026-09-23T00:00:00.000Z") {
  const input = { kind: "dir" as const, path: source };
  const preview = await previewLocalPanelApp(input);
  return installReviewedLocalPanelApp(input, preview.reviewToken, date, { overwrite });
}

beforeEach(async () => {
  previousHome = process.env.HOME;
  root = await mkdtemp(join(tmpdir(), "cs-panel-packages-"));
  process.env.HOME = join(root, "home");
  source = join(root, "source");
  for (const dir of ["app/tools", ".codeshell-panel", "agent/skills/check"])
    await mkdir(join(source, dir), { recursive: true });
  await writePackage("1.0.0");
});
afterEach(async () => {
  invalidateSkillCache();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

async function pinProject(name: string, pin: { version: string; packageDigest?: string }) {
  const project = join(root, name);
  await mkdir(join(project, ".code-shell"), { recursive: true });
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [id], panelAppPins: { [id]: pin } }),
  );
  return project;
}

test("retained inventory verifies each package, reports damaged addresses and never authorizes an uninstalled app", async () => {
  const first = await install();
  await writePackage("2.0.0");
  const second = await install(true);
  const listed = await listRetainedPanelAppPackages(id);
  expect(listed.packages.map((app) => app.version).sort()).toEqual(["1.0.0", "2.0.0"]);
  expect(listed.unavailableDigests).toEqual([]);
  await writeFile(join(panelAppPackageDir(id, first.packageDigest!), "app/index.html"), "damaged");
  const linkedDigest = "f".repeat(64);
  await symlink(source, panelAppPackageDir(id, linkedDigest));
  const verified = await listRetainedPanelAppPackages(id);
  expect(verified.packages.map((app) => app.packageDigest)).toEqual([second.packageDigest!]);
  expect(verified.unavailableDigests.sort()).toEqual([first.packageDigest!, linkedDigest].sort());
  await uninstallPanelApp(id);
  await expect(listRetainedPanelAppPackages(id)).rejects.toThrow("not installed");
});

test("two projects select independent package payloads and matching Skill content after an update", async () => {
  const first = await install();
  const a = await pinProject("project-a", {
    version: first.version,
    packageDigest: first.packageDigest,
  });
  const before = scanSkills(a).find((skill) => skill.name === `${id}:check`);
  expect(before?.content).toContain("1.0.0");
  await writePackage("2.0.0");
  const second = await install(true);
  const b = await pinProject("project-b", {
    version: second.version,
    packageDigest: second.packageDigest,
  });
  expect((await listProjectPanelApps(a))[0]?.version).toBe("1.0.0");
  expect((await listProjectPanelApps(b))[0]?.version).toBe("2.0.0");
  expect(scanSkills(a).find((skill) => skill.name === `${id}:check`)?.content).toContain("1.0.0");
  expect(scanSkills(b).find((skill) => skill.name === `${id}:check`)?.content).toContain("2.0.0");
  // Changing the project pin invalidates only that project's skill-cache key.
  await pinProject("project-a", { version: second.version, packageDigest: second.packageDigest });
  expect(scanSkills(a).find((skill) => skill.name === `${id}:check`)?.content).toContain("2.0.0");
});

test("pinned Skills inherit the main project's package from a Git worktree", async () => {
  const installed = await install();
  const project = await pinProject("main", {
    version: installed.version,
    packageDigest: installed.packageDigest,
  });
  await mkdir(join(project, ".git/worktrees/task"), { recursive: true });
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, ".git"), `gitdir: ${join(project, ".git/worktrees/task")}\n`);
  await writePackage("2.0.0");
  await install(true);
  expect(scanSkills(worktree).find((skill) => skill.name === `${id}:check`)?.content).toContain(
    "1.0.0",
  );
});

test("invalid, mismatched, missing and tampered project pins never substitute latest Skills", async () => {
  const installed = await install();
  const project = await pinProject("broken", {
    version: "wrong",
    packageDigest: installed.packageDigest,
  });
  await expect(listProjectPanelApps(project)).rejects.toThrow("pinned version");
  expect(
    scanSkills(project, { includeDisabledPanelApps: true }).filter(
      (skill) => skill.source === "panel-app",
    ),
  ).toEqual([]);
  await pinProject("broken", { version: installed.version, packageDigest: "0".repeat(64) });
  await expect(listProjectPanelApps(project)).rejects.toThrow();
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [id], panelAppPins: null }),
  );
  expect(
    scanSkills(project, { includeDisabledPanelApps: true }).filter(
      (skill) => skill.source === "panel-app",
    ),
  ).toEqual([]);
  await pinProject("broken", {
    version: installed.version,
    packageDigest: installed.packageDigest,
  });
  const retained = await resolvePanelAppPackage(id, installed.packageDigest!);
  await writeFile(
    join(retained.installPath, "agent/skills/check/SKILL.md"),
    "tampered instructions",
  );
  invalidateSkillCache();
  await expect(listProjectPanelApps(project)).rejects.toThrow("content has changed");
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
});

test("retained payloads preserve UI, native tools and Skills across catalog update and removal", async () => {
  const first = await install();
  const old = await resolvePanelAppPackage(id, first.packageDigest!);
  expect(old.installPath).not.toBe(first.installPath);
  await writePackage("2.0.0");
  const next = await install(true);
  const latest = await resolvePanelAppPackage(id, next.packageDigest!);
  expect(next.packageDigest).not.toBe(first.packageDigest);
  expect((await listInstalledPanelApps())[0]?.packageDigest).toBe(next.packageDigest);
  await uninstallPanelApp(id);
  expect(await listInstalledPanelApps()).toEqual([]);
  for (const [app, version] of [
    [old, "1.0.0"],
    [latest, "2.0.0"],
  ] as const) {
    const recovered = await resolvePanelAppPackage(id, app.packageDigest!);
    expect(recovered.version).toBe(version);
    expect(await readFile(join(recovered.installPath, "app/index.html"), "utf8")).toContain(
      version,
    );
    expect(await readFile(join(recovered.installPath, "app/tools/check.mjs"), "utf8")).toContain(
      version,
    );
    expect(
      await readFile(join(recovered.installPath, "agent/skills/check/SKILL.md"), "utf8"),
    ).toContain(version);
  }
});

test("same payload reuses its immutable directory despite changed installation metadata", async () => {
  const first = await install();
  const retained = await resolvePanelAppPackage(id, first.packageDigest!);
  const before = await stat(retained.installPath);
  const metadata = await readFile(join(retained.installPath, ".cs-panel-app-meta.json"));
  const next = await install(true, "2026-09-24T00:00:00.000Z");
  expect(next.packageDigest).toBe(first.packageDigest);
  expect((await stat(retained.installPath)).ino).toBe(before.ino);
  expect(await readFile(join(retained.installPath, ".cs-panel-app-meta.json"))).toEqual(metadata);
  expect((await readdir(join(retained.installPath, ".."))).sort()).toEqual(
    [first.packageDigest!, "legacy-projects.json"].sort(),
  );
});

test("content changes cannot hide behind an unchanged semantic version", async () => {
  const first = await install();
  await writePackage("1.0.0", "different reviewed payload");
  const next = await install(true);
  expect(next.version).toBe(first.version);
  expect(next.packageDigest).not.toBe(first.packageDigest);
  await expect(retainInstalledPanelApp(id, first.packageDigest!)).rejects.toThrow(
    "changed after review",
  );
  expect((await resolvePanelAppPackage(id, first.packageDigest!)).version).toBe("1.0.0");
});

test("legacy catalog packages are retained before replacement and concurrent pin requests share one snapshot", async () => {
  const first = await install();
  await rm(join(first.installPath, "..", ".versions"), { recursive: true });
  const results = await Promise.all([
    retainInstalledPanelApp(id, first.packageDigest!),
    retainInstalledPanelApp(id, first.packageDigest!),
  ]);
  expect(results[0]?.installPath).toBe(results[1]?.installPath);
  await rm(join(first.installPath, "..", ".versions"), { recursive: true });
  await writePackage("2.0.0");
  await install(true);
  expect((await resolvePanelAppPackage(id, first.packageDigest!)).version).toBe("1.0.0");
});

test("missing or tampered pins fail instead of following the current installed version", async () => {
  const installed = await install();
  const retained = await resolvePanelAppPackage(id, installed.packageDigest!);
  await expect(resolvePanelAppPackage(id, "0".repeat(64))).rejects.toThrow();
  await writeFile(join(retained.installPath, "app/index.html"), "tampered");
  await expect(resolvePanelAppPackage(id, installed.packageDigest!)).rejects.toThrow(
    "content has changed",
  );
  await expect(retainInstalledPanelApp(id, installed.packageDigest!)).rejects.toThrow(
    "content has changed",
  );
  expect(await readFile(join(retained.installPath, "app/index.html"), "utf8")).toBe("tampered");
  expect((await listInstalledPanelApps())[0]?.packageDigest).toBe(installed.packageDigest);
});

test("package addresses reject path traversal, linked stores and linked payload roots", async () => {
  const installed = await install();
  const directory = panelAppPackageDir(id, installed.packageDigest!);
  expect(() => panelAppPackageDir("../escape", installed.packageDigest!)).toThrow();
  expect(() => panelAppPackageDir(id, "../escape")).toThrow();
  await rm(directory, { recursive: true });
  await symlink(installed.installPath, directory, "dir");
  await expect(resolvePanelAppPackage(id, installed.packageDigest!)).rejects.toThrow(
    "ordinary directory",
  );
  await rm(join(directory, ".."), { recursive: true });
  await symlink(source, join(directory, ".."), "dir");
  await expect(retainInstalledPanelApp(id, installed.packageDigest!)).rejects.toThrow(
    "ordinary directories",
  );
  expect((await readdir(source)).sort()).toEqual([".codeshell-panel", "agent", "app"]);
});

test("repairing a broken legacy catalog does not replace an existing retained package", async () => {
  const first = await install();
  await rm(join(first.installPath, "app/index.html"));
  await writePackage("2.0.0");
  const next = await install(true);
  expect(next.version).toBe("2.0.0");
  const original = await resolvePanelAppPackage(id, first.packageDigest!);
  expect(await readFile(join(original.installPath, "app/index.html"), "utf8")).toContain("1.0.0");
});

test("a rejected duplicate installation does not retain an uninstalled new payload", async () => {
  const first = await install();
  await writePackage("2.0.0");
  await expect(install()).rejects.toThrow("already installed");
  const directory = panelAppPackageDir(id, first.packageDigest!);
  expect(await readdir(join(directory, ".."))).toEqual([first.packageDigest!]);
  expect((await listInstalledPanelApps())[0]?.version).toBe("1.0.0");
});

test("corrupt and linked project settings cannot silently remove a package pin", async () => {
  const installed = await install();
  const project = await pinProject("invalid-settings", {
    version: installed.version,
    packageDigest: installed.packageDigest,
  });
  const settings = join(project, ".code-shell/settings.json");
  await writeFile(settings, "{broken json");
  await expect(listProjectPanelApps(project)).rejects.toThrow();
  expect(
    scanSkills(project, { includeDisabledPanelApps: true }).filter(
      (skill) => skill.source === "panel-app",
    ),
  ).toEqual([]);
  await rm(settings);
  await symlink(join(root, "missing-settings.json"), settings);
  await expect(listProjectPanelApps(project)).rejects.toThrow();
  await rm(join(project, ".code-shell"), { recursive: true });
  await symlink(join(root, "missing-state"), join(project, ".code-shell"));
  await expect(listProjectPanelApps(project)).rejects.toThrow();
  expect(
    scanSkills(project, { includeDisabledPanelApps: true }).filter(
      (skill) => skill.source === "panel-app",
    ),
  ).toEqual([]);
});

test("a package pin alone grants no Skill binding and user pins cannot select a project's code", async () => {
  const first = await install();
  const project = await pinProject("authorization", {
    version: first.version,
    packageDigest: first.packageDigest,
  });
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({
      panelAppPins: { [id]: { version: first.version, packageDigest: first.packageDigest } },
    }),
  );
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
  await writeFile(
    join(root, "home/.code-shell/settings.json"),
    JSON.stringify({
      panelAppPins: { [id]: { version: "99.0.0", packageDigest: "f".repeat(64) } },
    }),
  );
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [id] }),
  );
  await writePackage("2.0.0");
  await install(true);
  // The user-scope pin is ignored; this legacy binding keeps the pre-update package.
  expect((await listProjectPanelApps(project))[0]?.version).toBe("1.0.0");
  expect(scanSkills(project).find((skill) => skill.name === `${id}:check`)?.content).toContain(
    "1.0.0",
  );
});

test("another project's catalog directory swap does not hide pinned packages or Skills", async () => {
  const first = await install();
  const project = await pinProject("stable", {
    version: first.version,
    packageDigest: first.packageDigest,
  });
  await writePackage("2.0.0");
  const latest = await install(true);
  const backup = join(root, "catalog-swap");
  await rename(latest.installPath, backup);
  expect(await listInstalledPanelApps()).toEqual([]);
  expect((await listProjectPanelApps(project))[0]?.version).toBe("1.0.0");
  expect(scanSkills(project).find((skill) => skill.name === `${id}:check`)?.content).toContain(
    "1.0.0",
  );
  await rename(backup, latest.installPath);
  await uninstallPanelApp(id);
  expect(await listProjectPanelApps(project)).toEqual([]);
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
});

test("a dormant legacy project preserves its pre-update package before and after migration", async () => {
  const first = await install();
  const project = join(root, "dormant");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  const settingsPath = join(project, ".code-shell/settings.json");
  const settings = {
    panelAppOverrides: { [id]: "on", "another-app": "off" },
    customProjectNote: "keep me",
  };
  await writeFile(settingsPath, JSON.stringify(settings));
  await writePackage("2.0.0");
  await install(true);
  // No project discovery or migration took place before the global update.
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(settings);
  expect(scanSkills(project).find((skill) => skill.name === `${id}:check`)?.content).toContain(
    "1.0.0",
  );
  expect(projectPanelAppPackagePins(project)[id]).toEqual({
    version: "1.0.0",
    packageDigest: first.packageDigest!,
  });
  expect(await migrateProjectPanelAppPackagePins(project)).toEqual([id]);
  const migrated = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(migrated).toMatchObject(settings);
  expect(migrated.panelAppPins[id]).toEqual({
    version: "1.0.0",
    packageDigest: first.packageDigest!,
  });
  expect(await migrateProjectPanelAppPackagePins(project)).toEqual([]);
  expect((await listProjectPanelApps(project))[0]!.version).toBe("1.0.0");
  await writePackage("3.0.0");
  await install(true);
  expect((await listProjectPanelApps(project))[0]!.version).toBe("1.0.0");
});

test("migration preserves another device's explicit upgrade or unbind while package inspection awaits", async () => {
  await install();
  await writePackage("2.0.0");
  const next = await install(true);
  const project = join(root, "concurrent");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  const file = join(project, ".code-shell/settings.json");
  writeFileSync(file, JSON.stringify({ panelAppBindings: [id] }));
  const upgrading = migrateProjectPanelAppPackagePins(project);
  // The async migration captured the legacy binding and yielded for package IO.
  writeFileSync(
    file,
    JSON.stringify({
      panelAppBindings: [id],
      panelAppPins: {
        [id]: { version: next.version, packageDigest: next.packageDigest! },
      },
      concurrentValue: "preserved",
    }),
  );
  expect(await upgrading).toEqual([]);
  expect((await listProjectPanelApps(project))[0]!.version).toBe("2.0.0");
  expect(JSON.parse(await readFile(file, "utf8")).concurrentValue).toBe("preserved");
  writeFileSync(file, JSON.stringify({ panelAppOverrides: { [id]: "on" } }));
  const unbinding = migrateProjectPanelAppPackagePins(project);
  writeFileSync(file, JSON.stringify({ panelAppOverrides: { [id]: "off" } }));
  expect(await unbinding).toEqual([]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ panelAppOverrides: { [id]: "off" } });
});

test("migration racing a catalog upgrade keeps the actual old package and does not bind unused apps", async () => {
  const first = await install();
  const project = join(root, "race");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [id] }),
  );
  await writePackage("2.0.0");
  await Promise.all([install(true), migrateProjectPanelAppPackagePins(project)]);
  expect(projectPanelAppPackagePins(project)[id]).toEqual({
    version: first.version,
    packageDigest: first.packageDigest!,
  });
  const unused = join(root, "unused");
  await mkdir(unused);
  expect(await migrateProjectPanelAppPackagePins(unused)).toEqual([]);
  expect(projectPanelAppPackagePins(unused)).toEqual({});
  expect((await listProjectPanelApps(unused))[0]!.version).toBe("2.0.0");
});

test("uninstall and reinstall do not silently upgrade dormant legacy bindings", async () => {
  const first = await install();
  const project = join(root, "reinstall");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [id] }),
  );
  await uninstallPanelApp(id);
  expect(await listProjectPanelApps(project)).toEqual([]);
  await writePackage("2.0.0");
  await install();
  expect((await listProjectPanelApps(project))[0]!.packageDigest).toBe(first.packageDigest);
});

test("an unsafe or missing legacy baseline package never falls through to new catalog bytes", async () => {
  const first = await install();
  const project = join(root, "damaged-baseline");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  const settings = join(project, ".code-shell/settings.json");
  await writeFile(settings, JSON.stringify({ panelAppBindings: [id] }));
  await writePackage("2.0.0");
  await install(true);
  const baseline = join(panelAppPackageDir(id, first.packageDigest!), "..", "legacy-projects.json");
  const original = await readFile(baseline);
  await writeFile(baseline, "{bad json");
  await expect(migrateProjectPanelAppPackagePins(project)).rejects.toThrow();
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
  await rm(baseline);
  await symlink(settings, baseline);
  await expect(migrateProjectPanelAppPackagePins(project)).rejects.toThrow("bounded regular file");
  await rm(baseline);
  await writeFile(baseline, original);
  await rm(panelAppPackageDir(id, first.packageDigest!), { recursive: true });
  await expect(listProjectPanelApps(project)).rejects.toThrow();
  expect(JSON.parse(await readFile(settings, "utf8")).panelAppPins).toBeUndefined();
});

test("a partial restore missing the baseline ledger still cannot adopt the latest catalog", async () => {
  const first = await install();
  const project = join(root, "partial-restore");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  await writeFile(
    join(project, ".code-shell/settings.json"),
    JSON.stringify({ panelAppBindings: [id] }),
  );
  await writePackage("2.0.0");
  await install(true);
  const oldDirectory = panelAppPackageDir(id, first.packageDigest!);
  await rm(join(oldDirectory, "..", "legacy-projects.json"));
  expect(projectPanelAppPackagePins(project)[id]?.version).toBe("1.0.0");
  await rm(oldDirectory, { recursive: true });
  await expect(migrateProjectPanelAppPackagePins(project)).rejects.toThrow();
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
});

test("batch migration pins all existing bound packages without enabling disabled, off or missing apps", async () => {
  await install();
  const manifestPath = join(source, ".codeshell-panel/panel.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const nextId of ["second-panel", "off-panel"]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, id: nextId }));
    await install();
  }
  const project = join(root, "batch-migration");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  await writeFile(
    join(root, "home/.code-shell/settings.json"),
    JSON.stringify({ disabledPanelApps: [id] }),
  );
  const settingsFile = join(project, ".code-shell/settings.json");
  const original = {
    panelAppBindings: [id, "second-panel", "off-panel", "missing-panel"],
    panelAppOverrides: { "off-panel": "off" },
    unrelatedSetting: "keep",
  };
  await writeFile(settingsFile, JSON.stringify(original));
  expect(await migrateProjectPanelAppPackagePins(project)).toEqual([id, "second-panel"]);
  const current = JSON.parse(await readFile(settingsFile, "utf8"));
  expect(current).toMatchObject(original);
  expect(Object.keys(current.panelAppPins).sort()).toEqual([id, "second-panel"].sort());
  expect(
    scanSkills(project)
      .filter((skill) => skill.source === "panel-app")
      .map((skill) => skill.name),
  ).toEqual(["second-panel:check"]);
});

test("a damaged project package is isolated while healthy packages and Skills keep their selection", async () => {
  const first = await install();
  const project = await pinProject("fault-isolation", {
    version: first.version,
    packageDigest: first.packageDigest,
  });
  const manifestPath = join(source, ".codeshell-panel/panel.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id: "healthy-panel" }));
  const healthy = await install();
  const settingsFile = join(project, ".code-shell/settings.json");
  const raw = JSON.parse(await readFile(settingsFile, "utf8"));
  raw.panelAppBindings.push(healthy.id);
  await writeFile(settingsFile, JSON.stringify(raw));
  await rm(panelAppPackageDir(id, first.packageDigest!), { recursive: true });
  const result = await inspectProjectPanelApps(project);
  expect(result.apps.map((app) => app.id)).toEqual([healthy.id]);
  expect(result.issues).toMatchObject([
    { id, code: "package_unavailable", pin: raw.panelAppPins[id] },
  ]);
  expect(JSON.parse(await readFile(settingsFile, "utf8")).panelAppPins[id]).toEqual(
    raw.panelAppPins[id],
  );
  expect(
    scanSkills(project)
      .filter((skill) => skill.source === "panel-app")
      .map((skill) => skill.name),
  ).toEqual(["healthy-panel:check"]);
  await uninstallPanelApp(id);
  expect((await inspectProjectPanelApps(project)).issues).toEqual([]);
});

test("an unreadable legacy baseline does not prevent other bindings from migrating or exposing Skills", async () => {
  const first = await install();
  const manifestPath = join(source, ".codeshell-panel/panel.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id: "healthy-panel" }));
  await install();
  const project = join(root, "legacy-fault");
  await mkdir(join(project, ".code-shell"), { recursive: true });
  const settingsFile = join(project, ".code-shell/settings.json");
  await writeFile(settingsFile, JSON.stringify({ panelAppBindings: [id, "healthy-panel"] }));
  await writeFile(
    join(panelAppPackageDir(id, first.packageDigest!), "..", "legacy-projects.json"),
    "broken",
  );
  expect(
    scanSkills(project)
      .filter((skill) => skill.source === "panel-app")
      .map((skill) => skill.name),
  ).toEqual(["healthy-panel:check"]);
  const inspected = await inspectProjectPanelApps(project);
  expect(inspected.apps.map((app) => app.id)).toEqual(["healthy-panel"]);
  expect(inspected.issues).toMatchObject([{ id, code: "package_unavailable" }]);
  const saved = JSON.parse(await readFile(settingsFile, "utf8"));
  expect(saved.panelAppPins[id]).toBeUndefined();
  expect(saved.panelAppPins["healthy-panel"].version).toBe("1.0.0");
  await writeFile(settingsFile, '{"panelAppPins":null}');
  await expect(inspectProjectPanelApps(project)).rejects.toThrow();
  expect(scanSkills(project).filter((skill) => skill.source === "panel-app")).toEqual([]);
});

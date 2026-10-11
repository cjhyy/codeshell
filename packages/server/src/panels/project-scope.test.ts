import { afterAll, afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardProjectScopeNetwork } from "./__fixtures__/project-scope-network.js";

const deniedNetworkProbes = guardProjectScopeNetwork(afterAll);
const { capturePanelProjectScope } = await import("./project-scope.js");
const { environmentIdentity } = await import("../environment-identity.js");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "panel-project-scope-"));
  roots.push(root);
  const projectPath = join(root, "project %20");
  const cwd = join(root, "execution");
  mkdirSync(projectPath);
  mkdirSync(cwd);
  return {
    root,
    projectPath,
    cwd,
    environmentDir: join(root, "environment"),
    assertAuthority() {},
  };
}

test("scope is stable across fresh Host captures and ordinary root contents change", async () => {
  const f = fixture();
  const first = await capturePanelProjectScope(f);
  writeFileSync(join(f.cwd, "ordinary.txt"), "content does not change root identity");
  expect((await capturePanelProjectScope(f)).scope).toEqual(first.scope);
  expect(Object.keys(first.scope).sort()).toEqual([
    "environmentId",
    "projectId",
    "rootId",
    "version",
  ]);
  expect(first.scope.version).toBe(1);
  expect(first.scope.projectId).toMatch(/^[a-f0-9]{64}$/);
  expect(first.scope.rootId).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first.scope)).not.toContain(f.root);
  first.assertCurrent();
});

test("execution roots, registry root IDs, projects and environments remain distinct", async () => {
  const f = fixture();
  const one = await capturePanelProjectScope({
    ...f,
    projectId: "registered-project",
    rootId: "main",
  });
  const two = await capturePanelProjectScope({
    ...f,
    projectId: "registered-project",
    rootId: "other",
  });
  expect(two.scope.projectId).toBe(one.scope.projectId);
  expect(two.scope.rootId).not.toBe(one.scope.rootId);
  const nested = join(f.cwd, "nested");
  mkdirSync(nested);
  expect((await capturePanelProjectScope({ ...f, cwd: nested })).scope.rootId).not.toBe(
    one.scope.rootId,
  );
  const other = await capturePanelProjectScope({
    ...f,
    environmentDir: join(f.root, "other-environment"),
  });
  expect(other.scope.environmentId).not.toBe(one.scope.environmentId);
});

test("same-path root replacement invalidates an old binding and gives fresh scope a new root ID", async () => {
  const f = fixture();
  const old = await capturePanelProjectScope(f);
  renameSync(f.cwd, f.cwd + "-original");
  mkdirSync(f.cwd);
  expect(() => old.assertCurrent()).toThrow("scope changed");
  expect((await capturePanelProjectScope(f)).scope.rootId).not.toBe(old.scope.rootId);
  rmSync(f.cwd, { recursive: true });
  renameSync(f.cwd + "-original", f.cwd);
  expect(() => old.assertCurrent()).toThrow("revoked");
});

test("project directory replacement and authority revocation are sticky", async () => {
  const f = fixture();
  let valid = true;
  const old = await capturePanelProjectScope({
    ...f,
    assertAuthority() {
      if (!valid) throw Error("revoked");
    },
  });
  valid = false;
  expect(() => old.assertCurrent()).toThrow();
  valid = true;
  expect(() => old.assertCurrent()).toThrow("revoked");
  const project = await capturePanelProjectScope(f);
  renameSync(f.projectPath, f.projectPath + "-original");
  mkdirSync(f.projectPath);
  expect(() => project.assertCurrent()).toThrow();
  expect((await capturePanelProjectScope(f)).scope.projectId).not.toBe(project.scope.projectId);
});

test("environment deletion, replacement and descriptor mismatch cannot silently change identity", async () => {
  const f = fixture();
  const old = await capturePanelProjectScope(f);
  const path = join(f.environmentDir, "environment.json");
  const original = readFileSync(path);
  renameSync(path, path + ".old");
  writeFileSync(path, original);
  expect(() => old.assertCurrent()).toThrow();
  await expect(
    capturePanelProjectScope({ ...f, environmentId: "wrong-descriptor" }),
  ).rejects.toThrow();
  rmSync(path);
  expect(() => old.assertCurrent()).toThrow("revoked");
});

test("nonregular environment metadata is refused without blocking", async () => {
  if (process.platform === "win32") return;
  const f = fixture();
  const id = await environmentIdentity(f.environmentDir);
  const path = join(f.environmentDir, "environment.json");
  rmSync(path);
  execFileSync("mkfifo", [path], { timeout: 2_000 });
  await expect(capturePanelProjectScope({ ...f, environmentId: id })).rejects.toThrow();
});

test("network guard denies both probes before Host imports", () => {
  expect(deniedNetworkProbes).toBe(2);
});

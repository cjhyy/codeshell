import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, projectView } from "./registry.js";

const directories: string[] = [];
const registries: ProjectRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(io?: { rename?: typeof renameSync }) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-project-registry-"));
  directories.push(root);
  const registry = new ProjectRegistry(root, () => 1000, io);
  registries.push(registry);
  return {
    root,
    registry,
    directory: join(root, "project-control"),
    file: join(root, "project-control/registry.json"),
  };
}

test("project registry persists private identities and grants owner-scoped credential-free views", () => {
  const { root, registry, directory, file } = fixture();
  const first = registry.create("alice", " First project ");
  const second = registry.create("bob", "Second project");
  expect(first.runtimePassword).not.toBe(second.runtimePassword);
  expect(first.id).not.toBe(second.id);
  expect(first.ownerId).not.toBe(second.ownerId);
  expect(first.generation).toBe(0);
  expect(registry.list("alice")).toEqual([projectView(first)]);
  expect(registry.list("nobody")).toEqual([]);
  expect(() => registry.get("bob", first.id)).toThrow("找不到这个项目");
  const dto = JSON.stringify(registry.list("alice"));
  for (const privateValue of [
    first.runtimePassword,
    first.ownerId,
    "runtimePassword",
    "runtimeUsername",
    "ownerId",
  ])
    expect(dto).not.toContain(privateValue);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const installationId = registry.installationId;
  registry.close();
  const reopened = new ProjectRegistry(root);
  registries.push(reopened);
  expect(reopened.installationId).toBe(installationId);
  expect(reopened.get("alice", first.id)).toEqual(first);
  first.runtimePassword = "caller mutation";
  expect(reopened.get("alice", first.id).runtimePassword).not.toBe(first.runtimePassword);
});

test("same-process and second-process controllers cannot own the same directory until explicit release", () => {
  const { root, registry } = fixture();
  expect(() => new ProjectRegistry(root)).toThrow("Another project controller");
  const code = `import { ProjectRegistry } from ${JSON.stringify(import.meta.resolve("./registry.ts"))};
try { const registry = new ProjectRegistry(process.env.PROJECT_REGISTRY_FIXTURE); registry.close(); process.exit(2); }
catch (error) { if (!String(error).includes("Another project controller")) throw error; console.log("locked"); }`;
  const child = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, PROJECT_REGISTRY_FIXTURE: root },
    encoding: "utf8",
    timeout: 5000,
  });
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toBe("locked");
  registry.close();
  expect(() => registry.list("alice")).toThrow("lock is no longer held");
  const next = new ProjectRegistry(root);
  registries.push(next);
  expect(next.list("alice")).toEqual([]);
});

test("failed atomic writes retain both prior disk bytes and prior in-memory owner/project state", () => {
  let fail = false;
  const { registry, file, directory } = fixture({
    rename: (...args) => {
      if (fail) throw Object.assign(new Error("simulated disk failure"), { code: "EIO" });
      renameSync(...args);
    },
  });
  const empty = readFileSync(file, "utf8");
  fail = true;
  expect(() => registry.create("alice", "Uncommitted")).toThrow("simulated disk failure");
  expect(registry.all()).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe(empty);
  expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  fail = false;
  const saved = registry.create("alice", "Saved");
  const before = readFileSync(file, "utf8");
  fail = true;
  expect(() => registry.update(saved.id, { generation: 1, status: "starting" })).toThrow(
    "simulated disk failure",
  );
  expect(registry.get("alice", saved.id)).toEqual(saved);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("missing/corrupt/replaced active storage fails closed without returning cached credentials", () => {
  for (const mutate of [
    (file: string) => rmSync(file),
    (file: string) => writeFileSync(file, "{broken"),
    (file: string) => {
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.projects = [];
      writeFileSync(file, JSON.stringify(data));
    },
  ]) {
    const { registry, file } = fixture();
    const project = registry.create("alice", "Private");
    mutate(file);
    expect(() => registry.get("alice", project.id)).toThrow();
    expect(() => registry.list("alice")).toThrow();
    expect(() => registry.create("alice", "Must not recover")).toThrow();
  }
});

test("existing directory and initialization marker prevent accidental new identity after registry loss", () => {
  const { root, registry, file, directory } = fixture();
  registry.create("alice", "Saved");
  registry.close();
  rmSync(file);
  expect(() => new ProjectRegistry(root)).toThrow("registry is missing");
  rmSync(join(directory, "initialized"));
  expect(() => new ProjectRegistry(root)).toThrow("registry is missing");
});

test("symlink/hardlink/public registry files and invalid owner references cannot be loaded", () => {
  for (const mode of ["symlink", "hardlink", "public", "bad-owner"] as const) {
    const { root, registry, file } = fixture();
    registry.create("alice", "Saved");
    registry.close();
    if (mode === "public") chmodSync(file, 0o644);
    else if (mode === "bad-owner") {
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.projects[0].ownerId = "unknown";
      writeFileSync(file, JSON.stringify(data));
    } else {
      const outside = join(root, "other.json");
      if (mode === "hardlink") linkSync(file, outside);
      else {
        renameSync(file, outside);
        symlinkSync(outside, file);
      }
    }
    expect(() => new ProjectRegistry(root)).toThrow();
  }
});

test("updates cannot rewrite identity/credentials or decrease generation and errors redact the project secret", () => {
  const { registry } = fixture();
  const initial = registry.create("alice", "Saved");
  const updated = registry.update(initial.id, {
    status: "error",
    generation: 1,
    error: `Rejected ${initial.runtimePassword}`,
    ownerId: "intruder",
    runtimePassword: "replacement",
  } as any);
  expect(updated.ownerId).toBe(initial.ownerId);
  expect(updated.runtimePassword).toBe(initial.runtimePassword);
  expect(projectView(updated).error).toBe("Rejected [redacted]");
  expect(() => registry.update(initial.id, { status: "stopped", generation: 0 })).toThrow(
    "backwards",
  );
  expect(registry.get("alice", initial.id)).toEqual(updated);
  expect(registry.update(initial.id, { status: "stopped" }).error).toBeUndefined();
});

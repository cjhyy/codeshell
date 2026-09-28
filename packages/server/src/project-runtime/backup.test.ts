import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubAuthStore } from "../hub/auth-store.js";
import { ProjectRegistry } from "./registry.js";
import { backupProjectInstallation, restoreProjectInstallation } from "./backup.js";
import { startProjectControlServer } from "./control-server.js";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "cloud-backup-test-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
const helperImage = `sha256:${"a".repeat(64)}`;

test("backup refuses a live controller and does not create a destination", async () => {
  const dataDir = await root(),
    destination = join(await root(), "backup");
  const registry = new ProjectRegistry(dataDir);
  try {
    await expect(backupProjectInstallation({ dataDir, destination, helperImage })).rejects.toThrow(
      "Another project controller",
    );
  } finally {
    registry.close();
  }
  await expect(readFile(join(destination, "manifest.json"))).rejects.toThrow();
});

test("backup refuses running registry state before issuing Docker commands", async () => {
  const dataDir = await root();
  const registry = new ProjectRegistry(dataDir);
  const project = registry.create("owner", "example");
  registry.update(project.id, { status: "running", generation: 1 });
  registry.close();
  await expect(
    backupProjectInstallation({ dataDir, destination: join(await root(), "backup"), helperImage }),
  ).rejects.toThrow("Stop all projects");
});

test("backup cannot initialize an absent installation or pull a mutable helper image", async () => {
  const dataDir = await root();
  for (const image of ["node:latest", helperImage]) {
    await expect(
      backupProjectInstallation({
        dataDir,
        destination: join(await root(), "backup"),
        helperImage: image,
      }),
    ).rejects.toThrow();
  }
  await expect(readFile(join(dataDir, "project-control/registry.json"))).rejects.toThrow();
});

test("restore namespace renewal retains project credentials, bumps used generations and preserves unstarted projects", async () => {
  const dataDir = await root();
  const registry = new ProjectRegistry(dataDir);
  try {
    const a = registry.create("owner", "used"),
      b = registry.create("owner", "empty");
    registry.update(a.id, { status: "stopped", generation: 2 });
    const before = registry.installationId;
    registry.renewInstallationForRestore();
    expect(registry.installationId).not.toBe(before);
    expect(registry.get("owner", a.id).runtimePassword).toBe(a.runtimePassword);
    expect(registry.get("owner", a.id).generation).toBe(3);
    expect(registry.get("owner", b.id).generation).toBe(0);
    registry.update(a.id, { status: "running" });
    expect(() => registry.renewInstallationForRestore()).toThrow("Stop all projects");
  } finally {
    registry.close();
  }
});

test("offline restore revokes every old browser session but preserves administrator login", async () => {
  const store = new HubAuthStore({ dataDir: await root() });
  const token = store.initialize()!;
  const login = { username: "owner", password: "test-password-long-enough" };
  const first = await store.setup({ ...login, token });
  const second = await store.login(login);
  store.revokeAllSessions();
  expect(store.authenticate(first.token)).toBeNull();
  expect(store.authenticate(second.token)).toBeNull();
  expect(store.isInitialized()).toBe(true);
  const fresh = await store.login(login);
  expect(store.authenticate(fresh.token)?.username).toBe("owner");
});

test("incomplete restores cannot start the Cloud controller", async () => {
  const dataDir = await root();
  await writeFile(join(dataDir, "restore-in-progress"), "1\n");
  await expect(startProjectControlServer({ dataDir, host: "127.0.0.1", port: 0 })).rejects.toThrow(
    "restore is incomplete",
  );
  await expect(readFile(join(dataDir, "project-control/registry.json"))).rejects.toThrow();
});

test("unsupported manifests and traversal inventories fail before Docker or destination writes", async () => {
  const source = await root();
  await mkdir(join(source, "control"));
  await mkdir(join(source, "volumes"));
  const destination = join(await root(), "restored");
  for (const value of [
    null,
    { version: 999 },
    {
      format: "codeshell.project-installation-backup",
      version: 1,
      installationId: "12345678-1234-1234-1234-123456789abc",
      projects: [],
      volumes: [],
      control: { "../outside": { sha256: "a".repeat(64), bytes: 0 } },
    },
  ]) {
    await writeFile(join(source, "manifest.json"), JSON.stringify(value));
    await expect(
      restoreProjectInstallation({ source, destination, helperImage }),
    ).rejects.toThrow();
  }
  await expect(readFile(join(destination, "restore-in-progress"))).rejects.toThrow();
});

test("restore rejects symbolic-link parents in control metadata before opening external files", async () => {
  const { createHash } = await import("node:crypto");
  const { symlink } = await import("node:fs/promises");
  const source = await root(),
    external = await root();
  await mkdir(join(source, "control"));
  await mkdir(join(source, "control/project-control"));
  await mkdir(join(source, "volumes"));
  await symlink(external, join(source, "control/hub"));
  await writeFile(join(external, "auth.json"), "{}");
  await writeFile(join(source, "control/project-control/registry.json"), "{}");
  await writeFile(join(source, "control/project-control/initialized"), "{}");
  const entry = { sha256: createHash("sha256").update("{}").digest("hex"), bytes: 2 };
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      format: "codeshell.project-installation-backup",
      version: 1,
      installationId: "12345678-1234-1234-1234-123456789abc",
      projects: [],
      volumes: [],
      control: {
        "hub/auth.json": entry,
        "project-control/registry.json": entry,
        "project-control/initialized": entry,
      },
    }),
  );
  await expect(
    restoreProjectInstallation({
      source,
      destination: join(await root(), "restored"),
      helperImage,
    }),
  ).rejects.toThrow("ordinary directory");
});

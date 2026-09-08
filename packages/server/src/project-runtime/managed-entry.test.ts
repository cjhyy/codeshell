import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubAuthStore } from "../hub/auth-store.js";
import { initializeManagedProjectAuth, readManagedProjectSecret } from "./managed-entry.js";
import type { ManagedProjectSecret } from "./types.js";

const secret: ManagedProjectSecret = {
  version: 1,
  projectId: "22222222-2222-4222-8222-222222222222",
  ownerId: "owner-one",
  generation: 1,
  username: "project-admin",
  password: "only-this-project-" + "x".repeat(32),
  publicOrigin: "https://codeshell.example",
  publicPathPrefix: "/p/22222222-2222-4222-8222-222222222222",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codeshell-managed-project-"));
  roots.push(root);
  const file = join(root, "secret.json");
  await writeFile(file, JSON.stringify(secret), { mode: 0o444 });
  return { root, file };
}

test("managed secret only accepts a bounded read-only regular file scoped to its exact project path", async () => {
  const { root, file } = await fixture();
  expect(await readManagedProjectSecret(file)).toEqual(secret);
  const link = join(root, "link.json");
  await symlink(file, link);
  await expect(readManagedProjectSecret(link)).rejects.toThrow("read-only regular file");
  await chmod(file, 0o600);
  await expect(readManagedProjectSecret(file)).rejects.toThrow("read-only regular file");
  for (const bad of [
    { ...secret, publicPathPrefix: "/p/another-project" },
    { ...secret, publicOrigin: "https://codeshell.example/path" },
    { ...secret, version: 2 },
  ]) {
    await writeFile(file, JSON.stringify(bad));
    await chmod(file, 0o444);
    await expect(readManagedProjectSecret(file)).rejects.toThrow();
    await chmod(file, 0o600);
  }
});

test("initialization creates only project credentials; restart revokes old grants and preserves workspace bytes", async () => {
  const { root } = await fixture();
  const resultFile = join(root, "saved-result.txt");
  await writeFile(resultFile, "project result survives restart");
  await initializeManagedProjectAuth(secret, root);
  const auth = new HubAuthStore({ dataDir: root });
  expect(auth.isInitialized()).toBe(true);
  expect(auth.listSessions()).toEqual([]);
  const old = await auth.login({ username: secret.username, password: secret.password });
  expect(auth.authenticate(old.token)).not.toBeNull();
  await initializeManagedProjectAuth({ ...secret, generation: 2 }, root);
  expect(auth.authenticate(old.token)).toBeNull();
  expect(auth.listSessions()).toEqual([]);
  expect(await readFile(resultFile, "utf8")).toBe("project result survives restart");
  const next = await auth.login({ username: secret.username, password: secret.password });
  expect(auth.authenticate(next.token)?.username).toBe(secret.username);
  expect(await readFile(auth.filePath, "utf8")).not.toContain(secret.password);
});

test("a different project's secret never replaces an established account", async () => {
  const { root } = await fixture();
  await initializeManagedProjectAuth(secret, root);
  const before = await readFile(new HubAuthStore({ dataDir: root }).filePath, "utf8");
  await expect(
    initializeManagedProjectAuth({ ...secret, password: "y".repeat(48) }, root),
  ).rejects.toThrow("Invalid username or password");
  expect(await readFile(new HubAuthStore({ dataDir: root }).filePath, "utf8")).toBe(before);
});

test("an incomplete persistent account does not reopen unmanaged setup", async () => {
  const { root } = await fixture();
  new HubAuthStore({ dataDir: root }).initialize();
  await expect(initializeManagedProjectAuth(secret, root)).rejects.toThrow(
    "initialization is incomplete",
  );
});

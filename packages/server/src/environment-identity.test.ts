import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentIdentity } from "./environment-identity.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "cs-environment-"));
  directories.push(path);
  return path;
}

test("concurrent first access and later restarts keep one environment identity", async () => {
  const path = await directory();
  const identities = await Promise.all(Array.from({ length: 24 }, () => environmentIdentity(path)));
  expect(new Set(identities).size).toBe(1);
  expect(await environmentIdentity(path)).toBe(identities[0]);
  expect(await readdir(path)).toEqual(["environment.json"]);
  expect(await environmentIdentity(await directory())).not.toBe(identities[0]);
});

test("corrupt and linked identity files are refused without replacing their contents", async () => {
  const root = await directory();
  await writeFile(join(root, "environment.json"), "broken");
  await expect(environmentIdentity(root)).rejects.toThrow();
  expect(await readFile(join(root, "environment.json"), "utf8")).toBe("broken");
  const linked = await directory();
  await symlink(join(root, "environment.json"), join(linked, "environment.json"));
  await expect(environmentIdentity(linked)).rejects.toThrow();
});

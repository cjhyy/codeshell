import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subscribeToLocalCredentialChanges } from "./change-subscription.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  expect(check()).toBe(true);
}

test("local subscribers observe atomic replacement, removal and recreation across processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-credential-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "credentials.json");
  writeFileSync(file, "initial");
  let changes = 0;
  const unsubscribe = subscribeToLocalCredentialChanges(() => changes++, { userDir: dir });
  cleanups.push(unsubscribe);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = changes;
  const child = Bun.spawn(
    [
      Bun.which("node") ?? process.execPath,
      "--input-type=module",
      "-e",
      "import {writeFileSync,renameSync} from 'node:fs';const p=process.argv[1];writeFileSync(p+'.next','replacement');renameSync(p+'.next',p)",
      file,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  await until(() => changes > before);
  const replaced = changes;
  rmSync(file);
  await until(() => changes > replaced);
  const removed = changes;
  writeFileSync(file, "restored");
  await until(() => changes > removed);
  unsubscribe();
  const stopped = changes;
  writeFileSync(file + ".next", "after unsubscribe");
  renameSync(file + ".next", file);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(changes).toBe(stopped);
});

test("project-only subscriptions do not observe user credential changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-credential-scope-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  writeFileSync(join(cwd, ".code-shell", "credentials.json"), "project");
  let changes = 0;
  cleanups.push(
    subscribeToLocalCredentialChanges(() => changes++, { cwd, userDir: dir, scope: "project" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = changes;
  writeFileSync(join(dir, "credentials.json"), "user");
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(changes).toBe(before);
  writeFileSync(join(cwd, ".code-shell", "credentials.json"), "changed project");
  await until(() => changes > before);
});

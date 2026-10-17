import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewLocalPanelApp } from "./installer.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panel-wasm-review-"));
  roots.push(root);
  await mkdir(join(root, ".codeshell-panel"));
  await mkdir(join(root, "app"));
  await writeFile(
    join(root, ".codeshell-panel/panel.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "wasm-test",
      version: "1.0.0",
      title: { default: "Wasm test" },
      entry: "app/index.html",
      permissions: [],
    }),
  );
  await writeFile(join(root, "app/index.html"), "<!doctype html><title>Wasm</title>");
  await writeFile(join(root, "app/engine.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  return root;
}
test("browser Wasm assets are digest reviewed without native process permission", async () => {
  const root = await fixture();
  const before = await previewLocalPanelApp({ kind: "dir", path: root });
  expect(before.permissions).toEqual([]);
  await writeFile(join(root, "app/engine.wasm"), Buffer.from([0, 97, 115, 109, 2, 0, 0, 0]));
  const after = await previewLocalPanelApp({ kind: "dir", path: root });
  expect(after.reviewToken).not.toBe(before.reviewToken);
});
test("the Wasm extension does not authorize native executables or symlink escapes", async () => {
  const root = await fixture();
  await writeFile(join(root, "app/native.exe"), "native");
  await expect(previewLocalPanelApp({ kind: "dir", path: root })).rejects.toThrow();
  await rm(join(root, "app/native.exe"));
  await rm(join(root, "app/engine.wasm"));
  await symlink(join(root, "app/index.html"), join(root, "app/engine.wasm"));
  await expect(previewLocalPanelApp({ kind: "dir", path: root })).rejects.toThrow();
});

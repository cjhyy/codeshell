import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("updater lifecycle passes in an isolated Electron mock process", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--tsconfig-override",
      "./tsconfig.json",
      "./packages/desktop/tests/updater-lifecycle.test.ts",
    ],
    {
      cwd: resolve(import.meta.dir, "../../../.."),
      env: { ...process.env, CODESHELL_UPDATER_FIXTURE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
  expect(`${stdout}\n${stderr}`).toMatch(/\n\s*1 pass/);
}, 10000);

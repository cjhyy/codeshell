import { expect, test } from "bun:test";
import { resolve } from "node:path";

const FIXTURE = "./packages/desktop/tests/.fixtures/plugin-panel-main.test.ts";

test("plugin panel protocol and bridge pass in an isolated Electron mock process", async () => {
  const child = Bun.spawn([process.execPath, "test", FIXTURE], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: { ...process.env, CODESHELL_PLUGIN_PANEL_FIXTURE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
  expect(`${stdout}\n${stderr}`).toContain("10 pass");
});

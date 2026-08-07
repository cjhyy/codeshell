import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The suite installs global Electron ESM mocks, so it must run in its own Bun
// process or those mocks leak into unrelated test modules. It used to live in
// a dot-directory (`tests/.fixtures/`) to keep the default runner from also
// collecting it — but that hid it from `bun test` and from CI's explicit path
// list, so 30 tests covering Cookie credentials and workspace writes silently
// never ran. It now sits at a normal path and opts out of double-collection
// via CODESHELL_PANEL_APP_FIXTURE instead.
const FIXTURE = "./packages/desktop/tests/panel-app-main.test.ts";

test("Panel App protocol and bridge pass in an isolated Electron mock process", async () => {
  const child = Bun.spawn([process.execPath, "test", FIXTURE], {
    cwd: resolve(import.meta.dir, "../../../.."),
    env: { ...process.env, CODESHELL_PANEL_APP_FIXTURE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  if (exitCode !== 0) throw new Error(output.trim());
  // Assert on the reported counts rather than a hardcoded total, which would
  // otherwise need a bump every time a test is added to the suite.
  expect(output).toMatch(/\n\s*0 fail/);
  const passed = Number(/\n\s*(\d+) pass/.exec(output)?.[1] ?? 0);
  expect(passed).toBeGreaterThan(0);
}, 20_000);

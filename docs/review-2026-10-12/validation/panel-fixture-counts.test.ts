import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Same child isolation as production panel-app-protocol.test.ts; outer guarded
// runner provides the real private HOME and credential-free environment.
const root = fileURLToPath(new URL("../../../", import.meta.url));
test("record the full supported Panel fixture counts after enabling its internal flag", async () => {
  const child = Bun.spawn([process.execPath, "test", "packages/desktop/tests/panel-app-main.test.ts"], {
    cwd: root,
    env: { ...process.env, CODESHELL_PANEL_APP_FIXTURE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const output = stdout + "\n" + stderr;
  console.log(output);
  expect(code).toBe(0);
  expect(output).toMatch(/\n\s*69 pass/);
  expect(output).toMatch(/\n\s*0 fail/);
  expect(output).not.toMatch(/\n\s*[1-9]\d* skip/);
}, 20_000);

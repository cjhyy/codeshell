import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
test("actual settings page, Main settings callbacks and store: leave, rejection, re-entry, retype, target capture and cancel", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "settings-lifecycle.fixture.tsx")], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 12000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  writeFileSync(join(import.meta.dir, "settings-lifecycle.fixture.log"), stdout + stderr);
  expect(code, stdout + stderr).toBe(0);
  expect(stdout).toContain("PASS settings lifecycle;");
}, 15000);

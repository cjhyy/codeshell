import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
test("actual session/project operation components, Main callbacks and durable stores: failures, restores and safe retry", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "session-operations.fixture.tsx")], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 16000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  writeFileSync(join(import.meta.dir, "session-operations.fixture.log"), stdout + stderr);
  expect(code, stdout + stderr).toBe(0);
  expect(stdout).toContain("PASS session operations;");
}, 20000);

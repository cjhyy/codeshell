import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-"))
  throw new Error("Use guarded Bun runner");
test("isolated native Node paired remote slow reader has an unbounded live-send path; selected cap/revoke/reconnect work", async () => {
  const child = Bun.spawn(["node", join(process.cwd(), "scripts/run-isolated-node-smoke.mjs"), join(import.meta.dir, "outbound-native.mjs")], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 18000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  writeFileSync(join(import.meta.dir, "outbound-native.log"), stdout + stderr);
  expect(code, stdout + stderr).toBe(0);
  expect(stdout).toContain("PASS native paired outbound backlog and recovery");
}, 20000);

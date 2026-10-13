import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw new Error("Use guarded runner");
test("native actual-auth Hub MCP normal early body abort, owner cancellation, disconnect and logout permit recovery", async () => {
  const child = Bun.spawn(["node", join(process.cwd(), "scripts/run-isolated-node-smoke.mjs"), join(import.meta.dir, "mcp-owner-controls.mjs")], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer); writeFileSync(join(import.meta.dir, "mcp-owner-controls-native.log"), stdout + stderr);
  expect(code, stdout + stderr).toBe(0); expect(stdout).toContain("PASS native actual-auth MCP early body abort/cancel/disconnect/logout recovery");
}, 18000);

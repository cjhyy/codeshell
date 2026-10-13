import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
for (const mode of ["desktop", "hub"]) {
  test(`native Node ${mode} pending download logout/revocation`, async () => {
    const root = mkdtempSync(join(evidence, `native-${mode}-`));
    try {
      const child = Bun.spawn(["node", join(repo, "scripts/run-isolated-node-smoke.mjs"), join(evidence, "download-revocation.mjs"), root, mode], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 15000);
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      clearTimeout(timer);
      writeFileSync(join(evidence, `native-${mode}-observed.log`), stdout + stderr);
      expect(exit, stdout + stderr).toBe(0);
      expect(stdout).toContain(`PASS ${mode} file revocation`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20000);
}
